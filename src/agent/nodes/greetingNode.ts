import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { config } from '../../config/index.js';
import { createNodeLogger } from '../../utils/nodeLogger.js';
import {
  getGreetingSmallModel,
  invokeModelWith404Fallback,
} from '../llm/modelFactory.js';
import { AgentStateType } from '../state.js';
import { getLastUserMessage } from '../utils/messageUtils.js';

/**
 * Node 2: Greeting Node (Small Model: gemini-flash-lite-latest)
 * Sends back an instant, friendly greeting with zero database lookup.
 */
export async function greetingSmallModelNode(
  state: AgentStateType,
  runConfig?: RunnableConfig
): Promise<Partial<AgentStateType>> {
  const lastMessage = getLastUserMessage(state.messages);
  const modelName = config.models?.greeting || 'gemini-flash-lite-latest';
  const log = createNodeLogger('GreetingNode', runConfig);
  log.start({ model: modelName, messageLen: lastMessage.length });

  const greetingSystemPrompt = `You are Yoho, the AI portfolio assistant for Vyshnav P C (Full-Stack & AI Engineer).
Reply warmly in 1-2 short sentences; mention you can share Vyshnav's skills, projects, experience, or help schedule a meeting.`;

  try {
    const response = await invokeModelWith404Fallback(
      getGreetingSmallModel(0.3),
      'gemini-flash-latest',
      0.3,
      [new SystemMessage(greetingSystemPrompt), new HumanMessage(lastMessage || 'Hello')],
      log,
      runConfig
    );

    const replyText =
      typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    log.done({ replyLen: replyText.length });

    return {
      finalMessage: replyText,
      messages: [new AIMessage(replyText)],
      uiAction: null,
    };
  } catch (err: any) {
    log.fail(err, { step: 'llm_invoke', model: modelName });
    throw err;
  }
}
