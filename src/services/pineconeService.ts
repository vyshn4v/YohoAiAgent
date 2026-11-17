import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import { loadProfileSections } from './profileLoader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface RetrievedDocument {
  id: string;
  score: number;
  text: string;
  metadata?: Record<string, any>;
}

let pineconeClient: Pinecone | null = null;
let openAiClient: OpenAI | null = null;

function getOpenAiClient(): OpenAI {
  if (!openAiClient) {
    openAiClient = new OpenAI({
      apiKey: config.openrouter.apiKey || 'placeholder',
      baseURL: config.openrouter.baseUrl,
      defaultHeaders: {
        'HTTP-Referer': config.openrouter.siteUrl,
        'X-Title': config.openrouter.appName,
      },
    });
  }
  return openAiClient;
}

export function getPineconeClient(): Pinecone | null {
  if (!config.pinecone.apiKey) {
    return null;
  }
  if (!pineconeClient) {
    pineconeClient = new Pinecone({
      apiKey: config.pinecone.apiKey,
    });
  }
  return pineconeClient;
}

/**
 * Generates an embedding vector for text using OpenRouter/OpenAI API,
 * or a deterministic fallback vector if API key is not configured or text is blank.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const cleanText = (text || '').trim();

  // If input is empty or whitespace, return fallback vector directly to prevent 400 "Input is empty" error
  if (!cleanText) {
    return generateDeterministicVector('portfolio', config.pinecone.dimension);
  }

  if (config.openrouter.apiKey && config.openrouter.apiKey !== 'your_openrouter_api_key_here') {
    try {
      const openai = getOpenAiClient();
      const response = await openai.embeddings.create({
        model: 'openai/text-embedding-3-small',
        input: cleanText,
      });
      return response.data[0].embedding;
    } catch (err: any) {
      console.warn(`[Embedding] OpenRouter embedding failed (${err.message}). Using fallback vector.`);
    }
  }

  // Fallback pseudo-embedding vector for offline / test environments
  return generateDeterministicVector(cleanText, config.pinecone.dimension);
}

function generateDeterministicVector(text: string, dimension: number): number[] {
  const vec = new Array(dimension).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    vec[i % dimension] += code;
  }
  // Normalize
  const magnitude = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0)) || 1;
  return vec.map((v) => v / magnitude);
}

/**
 * Reads local profile document chunks as fallback when Pinecone is not yet initialized.
 * Seamlessly loads from profile.json (or profile.md fallback).
 */
function getLocalProfileChunks(): RetrievedDocument[] {
  try {
    const sections = loadProfileSections();
    if (sections.length > 0) {
      return sections.map((sec, idx) => ({
        id: sec.id || `chunk-local-${idx}`,
        score: 0.95 - idx * 0.05,
        text: sec.text.trim(),
        metadata: { source: 'profile.json', section: idx, title: sec.title, ...(sec.metadata || {}) },
      }));
    }
  } catch (err) {
    console.warn('[PineconeService] Could not read local profile data', err);
  }
  return [];
}

/**
 * Queries Pinecone for the most relevant profile and job chunks.
 * Seamlessly falls back to local knowledge base if Pinecone credentials are unset.
 */
export async function queryPinecone(
  query: string,
  topK: number = 4
): Promise<RetrievedDocument[]> {
  const cleanQuery = (query || '').trim() || 'Vyshnav P C professional skills and experience';
  const pinecone = getPineconeClient();

  if (!pinecone || !config.pinecone.apiKey) {
    console.log('[PineconeService] No Pinecone API key configured. Using local profile knowledge base.');
    const localChunks = getLocalProfileChunks();
    const queryLower = cleanQuery.toLowerCase();

    // Simple keyword score ranking over local chunks
    const scored = localChunks.map((chunk) => {
      let score = 0.3;
      const terms = queryLower.split(/\s+/).filter((t) => t.length > 2);
      for (const term of terms) {
        if (chunk.text.toLowerCase().includes(term)) {
          score += 0.2;
        }
      }
      return { ...chunk, score: Math.min(score, 0.99) };
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  try {
    const queryVector = await generateEmbedding(query);
    const index = pinecone.index(config.pinecone.indexName);

    const results = await index.namespace(config.pinecone.namespace).query({
      vector: queryVector,
      topK,
      includeMetadata: true,
    });

    return (results.matches || []).map((match) => ({
      id: match.id,
      score: match.score || 0,
      text: (match.metadata?.text as string) || (match.metadata?.content as string) || '',
      metadata: match.metadata,
    }));
  } catch (error: any) {
    console.error(`[PineconeService] Vector search error: ${error.message}`);
    console.log('[PineconeService] Falling back to local profile chunks.');
    return getLocalProfileChunks().slice(0, topK);
  }
}
