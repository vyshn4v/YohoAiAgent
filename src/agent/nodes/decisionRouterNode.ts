import { AIMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { traceable } from 'langsmith/traceable';
import { config } from '../../config/index.js';
import { createNodeLogger } from '../../utils/nodeLogger.js';
import { getGoogleGenAiClient } from '../llm/modelFactory.js';
import { AgentStateType } from '../state.js';
import {
  buildDecisionInput,
  getLastUserMessage,
  invokeTraceable,
} from '../utils/messageUtils.js';

const OUT_OF_SCOPE_REPLY =
  "Sorry, invalid query. I can only assist with questions about Vyshnav P C's skills, projects, experience, and background, or help schedule a consultation with him.";

export type DecisionIntent = 'greeting' | 'schedule_enquiry' | 'knowledge_query' | 'out_of_scope';

async function callDecisionModel(message: string): Promise<DecisionIntent> {
  const ai = getGoogleGenAiClient();
  const modelName = config.models.decision || 'gemini-decision-1';

  const response = await ai.decisions.create({
    model: modelName,
    input: message,
    questions: {
      intent: {
        type: 'choice',
        instructions:
          'Classify the latest user message intent using the previous assistant message (if present) as context. Choose schedule_enquiry if the user is answering the assistant\'s previous request for name, email, phone, reason, or OTP. Choose out_of_scope for math (e.g. 1+1), trivia, general knowledge, coding help, or anything unrelated to Vyshnav P C, greetings, or scheduling.',
        criteria: {
          greeting: 'Casual greeting or pleasantry like hi, hello, hey (when not answering a scheduling prompt)',
          schedule_enquiry:
            'Scheduling or requesting a meeting/consultation, sharing contact details (name, email, phone, reason), entering a 6-digit OTP verification code, or replying directly to the assistant\'s previous scheduling/OTP question',
          knowledge_query:
            'Questions asking about Vyshnav skills, experience, projects, education, or resume',
          out_of_scope:
            'Anything unrelated to Vyshnav P C or scheduling, such as math equations (1+1), trivia, weather, general Q&A, or coding tasks',
        },
      },
    },
  });

  const intentAnswer = response?.answers?.intent;
  const choice = intentAnswer?.type === 'choice' ? intentAnswer.choice : undefined;
  if (
    choice !== 'greeting' &&
    choice !== 'schedule_enquiry' &&
    choice !== 'knowledge_query' &&
    choice !== 'out_of_scope'
  ) {
    throw new Error('Decision model returned invalid response');
  }

  return choice;
}

const tracedCallDecisionModel = traceable(callDecisionModel, {
  name: 'gemini-decision-1',
  run_type: 'llm',
  metadata: {
    provider: 'google_genai',
    model: config.models.decision || 'gemini-decision-1',
  },
});

/**
 * Node 1: Decision Router (gemini-decision-1)
 * Routes user input to greeting, scheduling, RAG retrieval, or out-of-scope end state.
 */
export async function decisionRouterNode(
  state: AgentStateType,
  runConfig?: RunnableConfig
): Promise<Partial<AgentStateType>> {
  const lastMessage = getLastUserMessage(state.messages);
  const modelName = config.models.decision || 'gemini-decision-1';
  const log = createNodeLogger('DecisionRouter', runConfig);
  log.start({
    model: modelName,
    messageLen: lastMessage.length,
    historyCount: state.messages.length,
  });

  try {
    const decisionInput = buildDecisionInput(state.messages, lastMessage);
    const intent = await invokeTraceable(tracedCallDecisionModel, runConfig, decisionInput);
    const mappedIntent = intent === 'knowledge_query' ? 'profile_query' : intent;
    const nextNode =
      mappedIntent === 'greeting'
        ? 'greeting_small_model'
        : mappedIntent === 'schedule_enquiry'
        ? 'schedule_enquiry'
        : mappedIntent === 'out_of_scope'
        ? 'END'
        : 'pgvector_retriever';

    log.done({ intent: mappedIntent, rawChoice: intent, nextNode });

    if (mappedIntent === 'out_of_scope') {
      return {
        intent: 'out_of_scope',
        finalMessage: OUT_OF_SCOPE_REPLY,
        messages: [new AIMessage(OUT_OF_SCOPE_REPLY)],
        uiAction: null,
      };
    }

    return {
      intent: mappedIntent,
      extractedKeywords: lastMessage,
    };
  } catch (err: any) {
    log.fail(err, { step: 'call_decision_model', model: modelName, fallbackIntent: 'direct' });
    const errorMessage = 'An error occurred while processing your request. Please try again later.';
    return {
      intent: 'direct',
      finalMessage: errorMessage,
      messages: [new AIMessage(errorMessage)],
    };
  }
}
