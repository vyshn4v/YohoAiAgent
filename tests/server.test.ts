import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { app } from '../src/server.js';
import { redisClient } from '../src/services/redisClient.js';
import { Server } from 'http';

describe('Express REST API Endpoints', () => {
  let server: Server;
  let baseUrl: string;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string | URL | Request, opts?: any) => {
      const urlStr = String(url);
      if (urlStr.includes('createDecision')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ decisions: { intent: { choice: 'knowledge_query' } } }),
        });
      }
      return originalFetch(url, opts);
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address() as any;
        baseUrl = `http://localhost:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
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
    expect(data.services.openrouter).toBeDefined();
    expect(data.services.pinecone).toBeDefined();
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

  it('POST /api/chat/stream should stream SSE tokens with CORS headers', async () => {
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

    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const { value } = await reader!.read();
    const chunkText = new TextDecoder().decode(value);
    expect(chunkText).toContain('event: status');
    await reader?.cancel();
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
});
