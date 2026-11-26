import OpenAI from 'openai';
import { config } from '../config/index.js';
import { createNodeLogger } from '../utils/nodeLogger.js';

let openAiEmbeddingClient: OpenAI | null = null;

function getEmbeddingClient(): OpenAI {
  if (!openAiEmbeddingClient) {
    const isGemini = config.llm.provider === 'gemini';
    const apiKey = isGemini ? config.gemini.apiKey : config.llm.apiKey;
    const baseURL = isGemini ? config.gemini.baseUrl : config.llm.baseUrl;

    openAiEmbeddingClient = new OpenAI({
      apiKey: apiKey || 'placeholder-key',
      baseURL: baseURL,
    });
  }
  return openAiEmbeddingClient;
}

/**
 * Deterministic pseudo-embedding for testing or offline environments.
 */
export function generateDeterministicEmbedding(text: string, dimension = 768): number[] {
  const vec = new Array(dimension).fill(0);
  const clean = text || 'empty';
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    vec[i % dimension] += code;
  }
  const magnitude = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0)) || 1;
  return vec.map((v) => Number((v / magnitude).toFixed(6)));
}

/**
 * Generates vector embeddings for a given text using gemini-embedding-2 (or configured model).
 * Automatically falls back to deterministic vector if API key is unconfigured or call fails.
 */
export async function generateTextEmbedding(text: string): Promise<number[]> {
  const cleanText = (text || '').trim();
  const dimension = config.postgres.dimension || 768;

  if (!cleanText) {
    return generateDeterministicEmbedding('portfolio resume', dimension);
  }

  const apiKey = config.gemini.apiKey || config.llm.apiKey;
  const isMockKey = !apiKey || apiKey.includes('your_') || apiKey.includes('placeholder') || apiKey === 'mock-key';

  if (!isMockKey && process.env.NODE_ENV !== 'test') {
    const log = createNodeLogger('EmbeddingService');
    const client = getEmbeddingClient();
    const candidateModels = [
      config.models.embedding || 'gemini-embedding-2',
      'gemini-embedding-001',
      'text-embedding-004',
    ];

    for (const model of candidateModels) {
      try {
        const response = await client.embeddings.create({
          model,
          input: cleanText,
          dimensions: dimension,
        });

        if (response?.data?.[0]?.embedding) {
          return response.data[0].embedding;
        }
      } catch (err: any) {
        if (err?.status === 404) {
          log.warn('Embedding model returned 404; trying next candidate', { model });
          continue; // Try next candidate
        }
        log.fail(err, { model });
        break;
      }
    }

    log.warn('Using deterministic fallback embedding vector');
  }

  return generateDeterministicEmbedding(cleanText, dimension);
}
