import type { RunnableConfig } from '@langchain/core/runnables';
import { traceable } from 'langsmith/traceable';
import { config } from '../../config/index.js';
import { generateTextEmbedding } from '../../services/embeddingService.js';
import { searchResumeChunks } from '../../services/pgVectorService.js';
import { createNodeLogger, formatErrorDetails } from '../../utils/nodeLogger.js';
import { AgentStateType, RetrievedDocument } from '../state.js';
import { getLastUserMessage, invokeTraceable } from '../utils/messageUtils.js';

const tracedGenerateQueryEmbedding = traceable(
  async (query: string) => generateTextEmbedding(query),
  {
    name: 'generateTextEmbedding',
    run_type: 'embedding',
    metadata: {
      provider: config.llm.provider,
      model: config.models.embedding || 'gemini-embedding-2',
    },
  }
);

const tracedSearchResumeChunks = traceable(
  async (queryEmbedding: number[], topK: number) => searchResumeChunks(queryEmbedding, topK),
  {
    name: 'pgvector_search_resume_chunks',
    run_type: 'retriever',
  }
);

/**
 * Node 3: PostgreSQL Vector Retriever Node
 * Embeds query keywords and retrieves top matching chunks strictly from PostgreSQL pgvector.
 */
export async function pgVectorRetrieverNode(
  state: AgentStateType,
  runConfig?: RunnableConfig
): Promise<Partial<AgentStateType>> {
  const query = state.extractedKeywords || getLastUserMessage(state.messages);
  const embeddingModel = config.models.embedding || 'gemini-embedding-2';
  const log = createNodeLogger('PgVectorRetriever', runConfig);
  log.start({
    queryLen: query.length,
    querySource: state.extractedKeywords ? 'extractedKeywords' : 'lastMessage',
  });

  let retrievedDocs: RetrievedDocument[] = [];
  let docSource: 'pgvector' | 'empty' = 'empty';

  try {
    log.step('Generating embedding and querying pgvector', { embeddingModel, topK: 4 });
    const queryEmbedding = await invokeTraceable(tracedGenerateQueryEmbedding, runConfig, query);
    const pgChunks = await invokeTraceable(tracedSearchResumeChunks, runConfig, queryEmbedding, 4);

    if (pgChunks && pgChunks.length > 0) {
      retrievedDocs = pgChunks.map((c) => ({
        id: c.id,
        score: c.similarity ?? 0.85,
        text: `### ${c.title}\n${c.content}`,
        metadata: c.metadata,
      }));
      docSource = 'pgvector';
      log.step('pgvector search returned matches', { count: retrievedDocs.length });
    } else {
      log.warn('pgvector returned 0 chunks');
    }
  } catch (err: any) {
    log.warn('Vector search exception; returning empty context', {
      error: formatErrorDetails(err),
    });
  }

  log.done({ source: docSource, docs: retrievedDocs.length });
  return {
    retrievedDocs,
  };
}
