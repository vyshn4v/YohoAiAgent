import dotenv from 'dotenv';

const existingNodeEnv = process.env.NODE_ENV;
// Load environment variables from .env file
dotenv.config();

// Preserve NODE_ENV if it was already set (e.g., 'test' by Vitest)
if (existingNodeEnv) {
  process.env.NODE_ENV = existingNodeEnv;
}

/**
 * Normalizes LANGSMITH_* and LANGCHAIN_* environment variables so LangChain/LangGraph
 * and the LangSmith SDK share the same API key, tracing flag, project, and endpoint.
 */
export function configureLangSmithEnv(env: Record<string, string | undefined> = process.env) {
  const apiKey = env.LANGSMITH_API_KEY || env.LANGCHAIN_API_KEY || '';
  const tracing =
    env.LANGSMITH_TRACING ||
    env.LANGSMITH_TRACING_V2 ||
    env.LANGCHAIN_TRACING_V2 ||
    (apiKey ? 'true' : 'false');
  const agentProject =
    env.LANGSMITH_AGENT_ID && env.LANGSMITH_AGENT_ENVIRONMENT
      ? `${env.LANGSMITH_AGENT_ID}-${env.LANGSMITH_AGENT_ENVIRONMENT}`
      : undefined;
  const project =
    env.LANGSMITH_PROJECT ||
    env.LANGCHAIN_PROJECT ||
    agentProject ||
    'ai-portfolio-agent';
  const endpoint =
    env.LANGSMITH_ENDPOINT || env.LANGCHAIN_ENDPOINT || 'https://api.smith.langchain.com';

  if (apiKey) {
    env.LANGCHAIN_API_KEY = env.LANGCHAIN_API_KEY || apiKey;
    env.LANGCHAIN_TRACING_V2 = env.LANGCHAIN_TRACING_V2 || tracing;
    env.LANGCHAIN_PROJECT = env.LANGCHAIN_PROJECT || project;
    env.LANGCHAIN_ENDPOINT = env.LANGCHAIN_ENDPOINT || endpoint;

    env.LANGSMITH_API_KEY = env.LANGSMITH_API_KEY || apiKey;
    env.LANGSMITH_TRACING = env.LANGSMITH_TRACING || tracing;
    env.LANGSMITH_PROJECT = env.LANGSMITH_PROJECT || project;
    env.LANGSMITH_ENDPOINT = env.LANGSMITH_ENDPOINT || endpoint;
  }

  return { tracingV2: tracing, apiKey, project, endpoint };
}

const langsmithConfig = configureLangSmithEnv(process.env);

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
    model: process.env.GEMINI_MODEL || 'gemini-flash-latest',
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

  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'openrouter/free',
    siteUrl: process.env.OPENROUTER_SITE_URL || 'http://localhost:3000',
    appName: process.env.OPENROUTER_APP_NAME || 'PortfolioAIAgent',
    baseUrl: 'https://openrouter.ai/api/v1',
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
  adminApiKey: process.env.ADMIN_API_KEY || '',

  langsmith: langsmithConfig,

  cors: {
    origin: process.env.CORS_ORIGIN || '*',
  },

  postgres: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/portfolio_db',
    dimension: parseInt(process.env.PGVECTOR_DIMENSION || '768', 10),
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  },

  models: {
    decision: process.env.GEMINI_DECISION_MODEL || 'gemini-decision-1',
    greeting: process.env.GEMINI_GREETING_MODEL || 'gemini-flash-lite-latest',
    big: process.env.GEMINI_BIG_MODEL || 'gemini-3.5-flash-lite',
    embedding: process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2',
  },
};
