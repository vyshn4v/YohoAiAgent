import express, { Request, Response } from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import swaggerUi from 'swagger-ui-express';
import { HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { config } from './config/index.js';
import { agentGraph } from './agent/graph.js';
import { LeadInfo } from './agent/state.js';
import { redisClient } from './services/redisClient.js';
import { startEmailWorker } from './workers/emailWorker.js';
import { ingestProfileData } from './scripts/ingest.js';
import { getPineconeClient } from './services/pineconeService.js';
import { swaggerDocument } from './docs/swagger.js';

export const app = express();

// Enhanced CORS supporting cross-domain frontends with OWASP best practices
const configuredOrigins =
  config.cors.origin === '*'
    ? '*'
    : config.cors.origin.split(',').map((o) => o.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl, postman)
      if (!origin) return callback(null, true);
      if (configuredOrigins === '*') return callback(null, true);
      if (configuredOrigins.includes(origin)) return callback(null, true);
      // Deny origins not listed in the whitelist
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Cache-Control',
      'X-Requested-With',
      'Accept',
    ],
    exposedHeaders: ['Content-Type'],
    credentials: configuredOrigins !== '*',
  })
);

app.use(express.json());

// Swagger OpenAPI documentation
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
app.get('/api/docs.json', (_req: Request, res: Response) => {
  res.json(swaggerDocument);
});

// Root route redirect to docs
app.get('/', (_req: Request, res: Response) => {
  res.redirect('/api/docs');
});

// Bounded in-memory conversation state store (session cache with LRU & TTL eviction)
interface SessionData {
  messages: BaseMessage[];
  leadInfo: LeadInfo;
  updatedAt: number;
}

const MAX_SESSIONS = 500;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const conversationSessions = new Map<string, SessionData>();

function getConversationSession(conversationId: string): SessionData {
  const session = conversationSessions.get(conversationId);
  if (session) {
    if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
      conversationSessions.delete(conversationId);
      return { messages: [], leadInfo: {}, updatedAt: Date.now() };
    }
    // Refresh access order (LRU)
    conversationSessions.delete(conversationId);
    conversationSessions.set(conversationId, session);
    return session;
  }
  return { messages: [], leadInfo: {}, updatedAt: Date.now() };
}

function saveConversationSession(
  conversationId: string,
  messages: BaseMessage[],
  leadInfo: LeadInfo
): void {
  // Evict oldest session if capacity reached
  if (conversationSessions.size >= MAX_SESSIONS) {
    const oldestKey = conversationSessions.keys().next().value;
    if (oldestKey) conversationSessions.delete(oldestKey);
  }
  conversationSessions.set(conversationId, {
    messages,
    leadInfo,
    updatedAt: Date.now(),
  });
}

/**
 * Health check endpoint
 */
app.get('/api/health', async (_req: Request, res: Response) => {
  let redisStatus: string = redisClient.status;
  if (redisClient.status === 'ready') {
    try {
      const pong = await redisClient.ping();
      if (pong === 'PONG') redisStatus = 'connected';
    } catch {
      redisStatus = 'disconnected';
    }
  }

  const pineconeConfigured = Boolean(
    config.pinecone.apiKey && config.pinecone.apiKey !== 'your_pinecone_api_key_here'
  );
  const openrouterConfigured = Boolean(
    config.openrouter.apiKey && config.openrouter.apiKey !== 'your_openrouter_api_key_here'
  );

  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      redis: redisStatus,
      openrouter: {
        configured: openrouterConfigured,
        model: config.openrouter.model,
      },
      pinecone: {
        configured: pineconeConfigured,
        index: config.pinecone.indexName,
      },
      langsmith: {
        configured: Boolean(config.langsmith.apiKey),
        project: config.langsmith.project,
      },
    },
    message: 'Backend is active and ready to handle chat & scheduling requests.',
  });
});

/**
 * Core SSE Chat Streaming Handler
 * Handles cross-domain headers, LangGraph event streaming, heartbeat, and final state.
 */
async function handleSseChatStream(
  req: Request,
  res: Response,
  message: string,
  conversationId: string
): Promise<void> {
  // Set SSE response headers with CORS support for cross-domain/subdomains
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Crucial: prevents Nginx/reverse proxy buffering

  const requestOrigin = req.headers.origin;
  if (requestOrigin) {
    if (configuredOrigins === '*' || configuredOrigins.includes(requestOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      if (configuredOrigins !== '*') {
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
    }
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.flushHeaders?.();

  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Heartbeat comment ping every 15s to keep connection alive across proxies
  const heartbeat = setInterval(() => {
    if (!isClientDisconnected && !res.writableEnded) {
      res.write(': ping\n\n');
    }
  }, 15000);
  heartbeat.unref();

  let isClientDisconnected = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      isClientDisconnected = true;
    }
    clearInterval(heartbeat);
  });

  try {
    sendEvent('status', { status: 'starting', conversationId });

    const session = getConversationSession(conversationId);
    const userMessage = new HumanMessage(message);
    const updatedHistory = [...session.messages, userMessage];

    let fullReply = '';
    let intent = 'profile_query';
    let tokensStreamed = 0;
    let finalLeadInfo: LeadInfo = { ...session.leadInfo };
    let finalUiAction: Record<string, any> | null = null;

    const stream = agentGraph.streamEvents(
      { messages: updatedHistory, leadInfo: session.leadInfo },
      { version: 'v2' }
    );

    for await (const event of stream) {
      if (isClientDisconnected) break;

      const node = event.metadata?.langgraph_node;

      // Status updates when nodes start
      if (event.event === 'on_chain_start') {
        if (node === 'decision_router' || node === 'first_router_and_ui' || node === 'agent1_keyword_extractor') {
          sendEvent('status', { node, status: 'understanding_query' });
        } else if (node === 'greeting_small_model') {
          sendEvent('status', { node, status: 'greeting' });
        } else if (node === 'pgvector_retriever' || node === 'second_extractor' || node === 'agent2_relevance_classifier') {
          sendEvent('status', { node, status: 'extracting_facts' });
        } else if (node === 'knowledge_big_model' || node === 'third_generator' || node === 'agent3_profile_synthesizer') {
          sendEvent('status', { node, status: 'generating_answer' });
        } else if (node === 'schedule_enquiry' || node === 'enquiry_coordinator') {
          sendEvent('status', { node, status: 'processing_enquiry' });
        }
      }

      // Capture final state from graph end
      if (event.event === 'on_chain_end' && event.name === 'LangGraph') {
        const finalState = event.data.output;
        if (finalState?.intent) {
          intent = finalState.intent;
        }
        if (finalState?.leadInfo) {
          finalLeadInfo = { ...finalLeadInfo, ...finalState.leadInfo };
        }
        if (finalState?.uiAction !== undefined) {
          finalUiAction = finalState.uiAction;
        }
        if (finalState?.messages && finalState.messages.length > 0) {
          const lastMsg = finalState.messages[finalState.messages.length - 1];
          let text =
            typeof lastMsg.content === 'string'
              ? lastMsg.content
              : JSON.stringify(lastMsg.content);

          // If text is a structured JSON string, extract the clean conversational reply
          try {
            const parsed = JSON.parse(text.trim());
            if (parsed && typeof parsed === 'object') {
              if (typeof parsed.reply === 'string') text = parsed.reply;
              else if (typeof parsed.message === 'string') text = parsed.message;
            }
          } catch {
            // Clean text already
          }

          fullReply = text;
        }
      }
    }

    // Stream the clean conversational reply in smooth tokens to client
    if (fullReply) {
      const words = fullReply.split(/(\s+)/);
      for (const word of words) {
        if (isClientDisconnected) break;
        sendEvent('token', { token: word, conversationId });
      }
    }

    // Save history and leadInfo
    saveConversationSession(
      conversationId,
      [...updatedHistory, new AIMessage(fullReply)],
      finalLeadInfo
    );

    if (finalUiAction) {
      sendEvent('ui_action', finalUiAction);
    }

    // Send completion event
    sendEvent('done', {
      conversationId,
      reply: fullReply,
      intent,
      leadInfo: finalLeadInfo,
      uiAction: finalUiAction,
    });
  } catch (err: any) {
    console.error('[SSE Stream Error]', err);
    if (!isClientDisconnected && !res.writableEnded) {
      sendEvent('error', {
        error:
          process.env.NODE_ENV === 'development'
            ? err.message || 'Stream processing failed'
            : 'Stream processing failed',
      });
    }
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) {
      res.end();
    }
  }
}

/**
 * SSE Stream Endpoint (POST)
 * POST /api/chat/stream
 * Body: { message: string, conversationId?: string }
 */
app.post('/api/chat/stream', async (req: Request, res: Response): Promise<void> => {
  const { message, conversationId = uuidv4() } = req.body;
  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'Message string is required.' });
    return;
  }
  await handleSseChatStream(req, res, message, conversationId);
});

/**
 * SSE Stream Endpoint (GET - for native browser EventSource)
 * GET /api/chat/stream?message=...&conversationId=...
 */
app.get('/api/chat/stream', async (req: Request, res: Response): Promise<void> => {
  const message = req.query.message as string;
  const conversationId = (req.query.conversationId as string) || uuidv4();

  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'Query parameter "message" is required.' });
    return;
  }

  await handleSseChatStream(req, res, message, conversationId);
});

/**
 * Standard Chat endpoint (Supports both JSON and SSE via Accept header)
 * POST /api/chat
 * Body: { message: string, conversationId?: string }
 */
app.post('/api/chat', async (req: Request, res: Response): Promise<void> => {
  try {
    const { message, conversationId = uuidv4() } = req.body;

    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Message string is required.' });
      return;
    }

    // Check if client requested SSE stream via Accept header
    if (req.headers.accept?.includes('text/event-stream')) {
      await handleSseChatStream(req, res, message, conversationId);
      return;
    }

    // Standard JSON response
    const session = getConversationSession(conversationId);
    const userMessage = new HumanMessage(message);
    const updatedHistory = [...session.messages, userMessage];

    // Execute LangGraph multi-agent pipeline
    const finalState = await agentGraph.invoke({
      messages: updatedHistory,
      leadInfo: session.leadInfo,
    });

    const lastAiMsg = finalState.messages[finalState.messages.length - 1];
    let replyText =
      typeof lastAiMsg.content === 'string'
        ? lastAiMsg.content
        : JSON.stringify(lastAiMsg.content);

    // If replyText is a raw JSON string, extract clean conversational text
    try {
      const parsed = JSON.parse(replyText.trim());
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.reply === 'string') replyText = parsed.reply;
        else if (typeof parsed.message === 'string') replyText = parsed.message;
      }
    } catch {
      // Clean text already
    }

    // Save updated history and leadInfo
    const mergedLeadInfo = { ...session.leadInfo, ...(finalState.leadInfo || {}) };
    saveConversationSession(
      conversationId,
      [...updatedHistory, new AIMessage(replyText)],
      mergedLeadInfo
    );

    const uiAction = finalState.uiAction || null;

    res.json({
      reply: replyText,
      conversationId,
      intent: finalState.intent,
      leadInfo: mergedLeadInfo,
      uiAction,
      retrievedCount: finalState.classifiedDocs?.length || finalState.retrievedDocs?.length || 0,
    });
  } catch (error: any) {
    console.error('[API Chat Error]', error);
    res.status(500).json({
      error: 'An error occurred while processing your request.',
      ...(process.env.NODE_ENV === 'development' ? { details: error.message } : {}),
    });
  }
});

/**
 * Trigger Pinecone Ingestion
 * POST /api/ingest
 */
app.post('/api/ingest', async (_req: Request, res: Response) => {
  try {
    const result = await ingestProfileData();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * List enquiries / scheduled leads
 * GET /api/enquiries
 */
app.get('/api/enquiries', async (_req: Request, res: Response) => {
  try {
    const ids = await redisClient.lrange('enquiries:list', 0, 50);
    const enquiries = [];
    for (const id of ids) {
      const data = await redisClient.get(`enquiry:${id}`);
      if (data) {
        enquiries.push(JSON.parse(data));
      }
    }
    res.json({ count: enquiries.length, enquiries });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Start BullMQ background email worker alongside server in development
if (process.env.NODE_ENV !== 'test' && !process.env.DISABLE_WORKER) {
  try {
    startEmailWorker();
    console.log('[Server] Background BullMQ email worker started.');
  } catch (err: any) {
    console.warn('[Server] Could not initialize BullMQ worker (Redis may be offline):', err.message);
  }
}

if (process.env.NODE_ENV !== 'test') {
  const PORT = config.port;
  app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 Portfolio AI Agent Backend listening on port ${PORT}`);
    console.log(`📚 Swagger UI Docs: http://localhost:${PORT}/api/docs`);
    console.log(`📡 Endpoints:`);
    console.log(`   - POST /api/chat     (Send message to LangGraph agent)`);
    console.log(`   - GET  /api/health   (Check service connections)`);
    console.log(`   - POST /api/ingest   (Index profile to Pinecone)`);
    console.log(`   - GET  /api/enquiries(View scheduled leads)`);
    console.log(`=======================================================`);
  });
}
