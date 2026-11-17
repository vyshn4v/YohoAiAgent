import dotenv from 'dotenv';
import path from 'path';

const existingNodeEnv = process.env.NODE_ENV;
// Load environment variables from .env file
dotenv.config();

// Auto-configure LangSmith tracking if API key is provided
if (process.env.LANGCHAIN_API_KEY) {
  process.env.LANGCHAIN_TRACING_V2 = process.env.LANGCHAIN_TRACING_V2 || 'true';
  process.env.LANGCHAIN_PROJECT = process.env.LANGCHAIN_PROJECT || 'ai-portfolio-agent';
  process.env.LANGCHAIN_ENDPOINT = process.env.LANGCHAIN_ENDPOINT || 'https://api.smith.langchain.com';
}

// Preserve NODE_ENV if it was already set (e.g., 'test' by Vitest)
if (existingNodeEnv) {
  process.env.NODE_ENV = existingNodeEnv;
}

// Resolve provider selection once, preserving precedence and defaults
const resolvedProvider =
  process.env.LLM_PROVIDER ||
  (process.env.GEMINI_API_KEY
    ? 'gemini'
    : process.env.GROQ_API_KEY
    ? 'groq'
    : process.env.NVIDIA_API_KEY
    ? 'nvidia'
    : 'openrouter');

const providerConfigs: Record<string, { apiKey: string; model: string; baseUrl: string }> = {
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
    baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/',
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    baseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
  },
  nvidia: {
    apiKey: process.env.NVIDIA_API_KEY || '',
    model: process.env.NVIDIA_MODEL || 'nvidia/nemotron-3.5-lightning-30b-a3b',
    baseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'openrouter/free',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
};

const activeLlmConfig = providerConfigs[resolvedProvider] || providerConfigs.openrouter;

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  llm: {
    provider: resolvedProvider,
    apiKey: activeLlmConfig.apiKey,
    model: activeLlmConfig.model,
    baseUrl: activeLlmConfig.baseUrl,
  },

  gemini: providerConfigs.gemini,
  groq: providerConfigs.groq,
  nvidia: providerConfigs.nvidia,

  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'openrouter/free',
    siteUrl: process.env.OPENROUTER_SITE_URL || 'http://localhost:3000',
    appName: process.env.OPENROUTER_APP_NAME || 'PortfolioAIAgent',
    baseUrl: 'https://openrouter.ai/api/v1',
  },

  pinecone: {
    apiKey: process.env.PINECONE_API_KEY || '',
    indexName: process.env.PINECONE_INDEX_NAME || 'portfolio-agent',
    dimension: parseInt(process.env.PINECONE_EMBEDDING_DIMENSION || '1536', 10),
    namespace: process.env.PINECONE_NAMESPACE || 'default',
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    url: process.env.REDIS_URL || undefined,
  },

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || '"Portfolio AI Agent" <noreply@example.com>',
  },

  hostEmail: process.env.HOST_EMAIL || 'vyshnav@example.com',

  langsmith: {
    tracingV2: process.env.LANGCHAIN_TRACING_V2 || 'true',
    apiKey: process.env.LANGCHAIN_API_KEY || '',
    project: process.env.LANGCHAIN_PROJECT || 'ai-portfolio-agent',
    endpoint: process.env.LANGCHAIN_ENDPOINT || 'https://api.smith.langchain.com',
  },

  cors: {
    origin: process.env.CORS_ORIGIN || '*',
  },
};
