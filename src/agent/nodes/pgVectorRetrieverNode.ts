import type { RunnableConfig } from '@langchain/core/runnables';
import { traceable } from 'langsmith/traceable';
import { config } from '../../config/index.js';
import { generateTextEmbedding } from '../../services/embeddingService.js';
import { searchResumeChunks } from '../../services/pgVectorService.js';
import { RetrievedDocument } from '../../services/pineconeService.js';
import { loadProfileSections } from '../../services/profileLoader.js';
import { createNodeLogger, formatErrorDetails } from '../../utils/nodeLogger.js';
import { AgentStateType } from '../state.js';
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
 * Embeds query keywords and retrieves top matching chunks from pgvector,
 * falling back to local profile sections if pgvector is empty or offline.
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
  let docSource: 'pgvector' | 'local_fallback' | 'empty' = 'empty';

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
      log.warn('pgvector returned 0 chunks; falling back to local profile sections');
    }
  } catch (err: any) {
    log.warn('Vector search exception; falling back to local profile sections', {
      error: formatErrorDetails(err),
    });
  }

  if (retrievedDocs.length === 0) {
    try {
      const sections = loadProfileSections();
      const terms = query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 2);
      const scored = sections.map((sec, idx) => {
        let score = 0.4;
        const lowerText = sec.text.toLowerCase();
        for (const term of terms) {
          if (lowerText.includes(term)) score += 0.2;
        }
        return {
          id: sec.id || `chunk-fallback-${idx}`,
          score: Math.min(score, 0.95),
          text: `### ${sec.title}\n${sec.text.trim()}`,
          metadata: sec.metadata || {},
        };
      });
      scored.sort((a, b) => b.score - a.score);
      retrievedDocs = scored.slice(0, 4);
      docSource = retrievedDocs.length > 0 ? 'local_fallback' : 'empty';
      log.step('Local profile fallback completed', {
        sectionsScanned: sections.length,
        docsSelected: retrievedDocs.length,
      });
    } catch (fallbackErr: any) {
      log.fail(fallbackErr, { step: 'local_profile_fallback', docs: 0 });
    }
  }

  log.done({ source: docSource, docs: retrievedDocs.length });
  return {
    retrievedDocs,
    classifiedDocs: retrievedDocs,
  };
}
