import dotenv from 'dotenv';
import path from 'path';

const existingNodeEnv = process.env.NODE_ENV;
// Load environment variables from .env file
dotenv.config();
// Preserve NODE_ENV if it was already set (e.g., 'test' by Vitest)
if (existingNodeEnv) {
  process.env.NODE_ENV = existingNodeEnv;
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
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

  cors: {
    origin: process.env.CORS_ORIGIN || '*',
  },
};
