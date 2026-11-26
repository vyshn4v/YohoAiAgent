import { BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { ChatOpenAI } from '@langchain/openai';
import { GoogleGenAI } from '@google/genai';
import { config } from '../../config/index.js';
import { NodeLogger } from '../../utils/nodeLogger.js';

let genAiClient: GoogleGenAI | null = null;

/**
 * Creates a ChatOpenAI model instance pointing to the active provider (Gemini, OpenRouter, etc.).
 */
export function createModelInstance(modelName: string, temperature = 0): ChatOpenAI {
  const isGemini = config.llm.provider === 'gemini';
  const apiKey = isGemini ? config.gemini.apiKey : config.llm.apiKey;
  const baseUrl = isGemini ? config.gemini.baseUrl : config.llm.baseUrl;
  const isOpenRouter = config.llm.provider === 'openrouter';

  return new ChatOpenAI({
    modelName,
    apiKey: apiKey || 'mock-key',
    configuration: {
      baseURL: baseUrl,
      defaultHeaders: isOpenRouter
        ? {
            'HTTP-Referer': config.openrouter.siteUrl,
            'X-Title': config.openrouter.appName,
          }
        : undefined,
    },
    temperature,
    maxTokens: 2048,
    maxRetries: 3,
  });
}

/**
 * Returns the singleton Google GenAI SDK client used by the Decisions API.
 */
export function getGoogleGenAiClient(): GoogleGenAI {
  if (!genAiClient) {
    const apiKey = config.gemini.apiKey || config.llm.apiKey;
    if (!apiKey || apiKey === 'mock-key') {
      throw new Error('Gemini API key is not configured.');
    }
    genAiClient = new GoogleGenAI({ apiKey, apiVersion: 'v1beta' });
  }
  return genAiClient;
}

/**
 * Greeting / extraction small model (default: gemini-flash-lite-latest).
 */
export function getGreetingSmallModel(temperature = 0.3): ChatOpenAI {
  return createModelInstance(config.models?.greeting || 'gemini-flash-lite-latest', temperature);
}

/**
 * Knowledge synthesis big model (default: gemini-3.5-flash-lite).
 */
export function getKnowledgeBigModel(temperature = 0.2): ChatOpenAI {
  return createModelInstance(config.models?.big || 'gemini-3.5-flash-lite', temperature);
}

/**
 * Invokes a ChatOpenAI model and automatically retries with a fallback model on 404 / MODEL_NOT_FOUND.
 */
export async function invokeModelWith404Fallback(
  model: ChatOpenAI,
  fallbackModelName: string,
  temperature: number,
  messages: BaseMessage[],
  log?: NodeLogger,
  runConfig?: RunnableConfig
) {
  try {
    return await model.invoke(messages, runConfig);
  } catch (err: any) {
    if (err?.status === 404 || err?.lc_error_code === 'MODEL_NOT_FOUND') {
      log?.warn('Primary model returned 404/MODEL_NOT_FOUND; falling back', {
        fallbackModel: fallbackModelName,
      });
      const fallback = createModelInstance(fallbackModelName, temperature);
      return await fallback.invoke(messages, runConfig);
    }
    throw err;
  }
}
