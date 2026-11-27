import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { config } from '../../config/index.js';
import { createNodeLogger } from '../../utils/nodeLogger.js';
import {
  getKnowledgeBigModel,
  invokeModelWith404Fallback,
} from '../llm/modelFactory.js';
import { AgentStateType } from '../state.js';
import { getLastUserMessage } from '../utils/messageUtils.js';

const INSUFFICIENT_CONTEXT_REPLY =
  "I don't have enough verified information in Vyshnav P C's knowledge base to answer that reliably. Would you like to schedule a call with him? Please share your name, email address, phone number, and reason for connecting.";

/**
 * Node 4: Knowledge Node (Big Model: gemini-3.5-flash-lite)
 * Synthesizes grounded answers as Yoho using the retrieved pgvector context.
 */
export async function bigModelKnowledgeNode(
  state: AgentStateType,
  runConfig?: RunnableConfig
): Promise<Partial<AgentStateType>> {
  const lastMessage = getLastUserMessage(state.messages);
  const modelName = config.models?.big || 'gemini-3.5-flash-lite';
  const retrievedDocs = state.retrievedDocs || [];
  const docsCount = retrievedDocs.length;
  const log = createNodeLogger('KnowledgeNode', runConfig);
  log.start({ model: modelName, docs: docsCount, messageLen: lastMessage.length });

  if (docsCount === 0) {
    log.warn('No retrievedDocs provided; returning insufficient-context reply');
    log.done({ replyLen: INSUFFICIENT_CONTEXT_REPLY.length, docs: 0, fallback: 'insufficient_context' });
    return {
      finalMessage: INSUFFICIENT_CONTEXT_REPLY,
      messages: [new AIMessage(INSUFFICIENT_CONTEXT_REPLY)],
      uiAction: null,
    };
  }

  const contextText = retrievedDocs
    .map((d, i) => `[Source ${i + 1}]:\n${d.text}`)
    .join('\n\n');

  const knowledgeSystemPrompt = `You are Yoho, AI assistant for Vyshnav P C (Full-Stack & AI Engineer).
Answer concisely and professionally using ONLY the context below. Highlight concrete skills and results. If missing, state what is known and offer a call.

CONTEXT:
${contextText}`;

  try {
    const response = await invokeModelWith404Fallback(
      getKnowledgeBigModel(0.2),
      'gemini-flash-latest',
      0.2,
      [new SystemMessage(knowledgeSystemPrompt), new HumanMessage(lastMessage)],
      log,
      runConfig
    );

    const replyText =
      typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    log.done({ replyLen: replyText.length, docs: docsCount });

    return {
      finalMessage: replyText,
      messages: [new AIMessage(replyText)],
      uiAction: null,
    };
  } catch (err: any) {
    log.fail(err, { step: 'llm_invoke', model: modelName, docs: docsCount });
    throw err;
  }
}
