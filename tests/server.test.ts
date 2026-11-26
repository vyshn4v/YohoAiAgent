import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { app } from '../src/server.js';
import { agentGraph, GRAPH_RUN_NAME } from '../src/agent/graph.js';
import { redisClient } from '../src/services/redisClient.js';
import * as sessionStore from '../src/http/sessionStore.js';
import { Server } from 'http';

describe('Express REST API Endpoints', () => {
  let server: Server;
  let baseUrl: string;
  const originalAdminApiKey = process.env.ADMIN_API_KEY;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address() as any;
        baseUrl = `http://localhost:${address.port}`;
        resolve();
      });
    });
  });

  afterEach(() => {
    if (originalAdminApiKey === undefined) {
      delete process.env.ADMIN_API_KEY;
    } else {
      process.env.ADMIN_API_KEY = originalAdminApiKey;
    }
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    try {
      redisClient.disconnect();
    } catch {
      // ignore
    }
  });

  it('GET /api/docs.json should serve OpenAPI JSON schema', async () => {
    const res = await fetch(`${baseUrl}/api/docs.json`);
    expect(res.status).toBe(200);

    const doc = await res.json();
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.info.title).toContain('Portfolio AI Agent');
    expect(doc.paths['/api/chat']).toBeDefined();
    expect(doc.paths['/api/chat/stream']).toBeDefined();
    expect(doc.paths['/api/health']).toBeDefined();
    expect(doc.paths['/api/enquiries']).toBeDefined();
  });

  it('GET /api/docs should serve Swagger UI HTML', async () => {
    const res = await fetch(`${baseUrl}/api/docs/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('swagger-ui');
  });

  it('GET /api/health should return health status of services', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe('healthy');
    expect(data.services).toBeDefined();
    expect(data.services.redis).toBeDefined();
    expect(data.services.pgvector).toBeDefined();
    expect(data.services.openrouter).toBeDefined();
  });

  it('POST /api/chat should validate missing message body', async () => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Message string is required.');
  });

  it('POST /api/chat/stream should stream SSE tokens and non-empty done reply with CORS headers', async () => {
    const res = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://portfolio-frontend.example.com',
      },
      body: JSON.stringify({
        message: 'hello',
        conversationId: 'sse-session-1',
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://portfolio-frontend.example.com'
    );
    expect(res.headers.get('cache-control')).toContain('no-cache');

    const fullText = await res.text();
    expect(fullText).toContain('event: status');
    expect(fullText).toContain('event: token');
    expect(fullText).toContain('event: done');

    const doneMatch = fullText.match(/event: done\ndata: (.+)\n/);
    expect(doneMatch).toBeTruthy();
    const donePayload = JSON.parse(doneMatch![1]);
    expect(donePayload.conversationId).toBe('sse-session-1');
    expect(typeof donePayload.reply).toBe('string');
    expect(donePayload.reply.trim().length).toBeGreaterThan(0);

    await redisClient.del('session:sse-session-1');
  });

  it('GET /api/chat/stream should stream SSE for native EventSource requests with subdomain CORS', async () => {
    const res = await fetch(
      `${baseUrl}/api/chat/stream?message=hi&conversationId=sse-session-2`,
      {
        headers: {
          Origin: 'https://subdomain.mywebsite.org',
        },
      }
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://subdomain.mywebsite.org'
    );

    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const { value } = await reader!.read();
    const chunkText = new TextDecoder().decode(value);
    expect(chunkText).toContain('event: status');
    await reader?.cancel();
  });

  it('POST /api/chat should return agent reply and intent', async () => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Tell me about your tech stack',
        conversationId: 'test-session-123',
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.reply).toBeDefined();
    expect(data.reply.length).toBeGreaterThan(0);
    expect(data.conversationId).toBe('test-session-123');
    expect(data.intent).toBe('profile_query');
  });

  it('requires ADMIN_API_KEY on GET /api/enquiries and POST /api/ingest and batches enquiry reads', async () => {
    delete process.env.ADMIN_API_KEY;
    const unconfiguredRes = await fetch(`${baseUrl}/api/enquiries`);
    expect(unconfiguredRes.status).toBe(503);

    process.env.ADMIN_API_KEY = 'super-secret-admin-key';
    const unauthorizedRes = await fetch(`${baseUrl}/api/ingest`, { method: 'POST' });
    expect(unauthorizedRes.status).toBe(401);

    const wrongKeyRes = await fetch(`${baseUrl}/api/enquiries`, {
      headers: { 'x-api-key': 'wrong-key' },
    });
    expect(wrongKeyRes.status).toBe(401);

    vi.spyOn(redisClient, 'lrange').mockResolvedValueOnce(['id-1', 'id-2']);
    const mgetSpy = vi
      .spyOn(redisClient, 'mget')
      .mockResolvedValueOnce([
        JSON.stringify({ id: 'id-1', name: 'Alice' }),
        null,
      ]);

    const okRes = await fetch(`${baseUrl}/api/enquiries`, {
      headers: { 'x-api-key': 'super-secret-admin-key' },
    });
    expect(okRes.status).toBe(200);
    const body = await okRes.json();
    expect(mgetSpy).toHaveBeenCalledWith(['enquiry:id-1', 'enquiry:id-2']);
    expect(body.count).toBe(1);
    expect(body.enquiries[0].name).toBe('Alice');
  });

  it('POST /api/chat/stream emits status, tokens, ui_action, done, and saves completed session', async () => {
    vi.spyOn(sessionStore, 'getConversationSession').mockResolvedValueOnce({
      messages: [],
      leadInfo: {},
      isVerified: false,
      updatedAt: Date.now(),
    });
    const saveSpy = vi.spyOn(sessionStore, 'saveConversationSession').mockResolvedValueOnce();

    vi.spyOn(agentGraph, 'streamEvents').mockImplementationOnce(async function* () {
      yield { event: 'on_chain_start', metadata: { langgraph_node: 'decision_router' } } as any;
      yield {
        event: 'on_chain_end',
        name: 'decision_router',
        metadata: { langgraph_node: 'decision_router' },
        data: { output: { intent: 'schedule_enquiry' } },
      } as any;
      yield {
        event: 'on_chain_end',
        name: GRAPH_RUN_NAME,
        data: {
          output: {
            intent: 'schedule_enquiry',
            leadInfo: { name: 'Alex', email: 'alex@example.com' },
            isVerified: false,
            uiAction: { type: 'otp_input', email: 'alex@example.com', length: 6 },
            messages: [new AIMessage('Code sent')],
          },
        },
      } as any;
    } as any);

    const res = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Schedule call', conversationId: 'sse-complete-1' }),
    });

    expect(res.status).toBe(200);
    const fullText = await res.text();
    expect(fullText).toContain('event: status');
    expect(fullText).toContain('event: token');
    expect(fullText).toContain('event: ui_action');
    expect(fullText).toContain('event: done');
    expect(fullText).toContain('"reply":"Code sent"');
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0][1][1]).toBeInstanceOf(AIMessage);
  });

  it('POST /api/chat/stream does not persist empty turn if client disconnects mid-stream', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(sessionStore, 'getConversationSession').mockResolvedValueOnce({
      messages: [],
      leadInfo: {},
      isVerified: false,
      updatedAt: Date.now(),
    });
    const saveSpy = vi.spyOn(sessionStore, 'saveConversationSession').mockResolvedValue();

    vi.spyOn(agentGraph, 'streamEvents').mockImplementationOnce(async function* () {
      yield { event: 'on_chain_start', metadata: { langgraph_node: 'decision_router' } } as any;
      await new Promise((r) => setTimeout(r, 150));
      yield {
        event: 'on_chain_end',
        name: GRAPH_RUN_NAME,
        data: { output: { messages: [new AIMessage('Late reply')] } },
      } as any;
    } as any);

    const res = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi', conversationId: 'sse-abort-1' }),
    });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 200));

    expect(saveSpy).not.toHaveBeenCalled();
  });
});
