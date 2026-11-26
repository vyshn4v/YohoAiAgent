import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  decisionRouterNode,
  greetingSmallModelNode,
  pgVectorRetrieverNode,
} from '../src/agent/nodes.js';
import { HumanMessage } from '@langchain/core/messages';
import * as pgVectorService from '../src/services/pgVectorService.js';

describe('Decision AI & 4-Tier Model Routing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('greetingSmallModelNode (Small Model: gemini-flash-lite)', () => {
    it('should generate a friendly Yoho greeting without touching the vector database', async () => {
      const vectorSearchSpy = vi.spyOn(pgVectorService, 'searchResumeChunks');

      const state = {
        messages: [new HumanMessage('Hello! Good morning!')],
        leadInfo: {},
      };

      const result = await greetingSmallModelNode(state as any);

      expect(result.messages).toBeDefined();
      expect(result.messages!.length).toBeGreaterThan(0);
      const reply = String(result.messages![0].content);
      expect(reply.length).toBeGreaterThan(0);
      // Confirms vector database was NEVER queried for greetings
      expect(vectorSearchSpy).not.toHaveBeenCalled();
    });
  });

  describe('pgVectorRetrieverNode', () => {
    it('should retrieve top resume chunks via pgvector and format as retrievedDocs', async () => {
      vi.spyOn(pgVectorService, 'searchResumeChunks').mockResolvedValue([
        {
          id: 'chunk-1',
          chunkIndex: 0,
          title: 'Technical Skills',
          content: 'LangGraph, TypeScript, Node.js, Python, Pinecone, BullMQ',
          metadata: { page: 1 },
          similarity: 0.92,
        },
      ]);

      const state = {
        messages: [new HumanMessage('What is your tech stack?')],
        extractedKeywords: 'tech stack skills',
      };

      const result = await pgVectorRetrieverNode(state as any);

      expect(result.retrievedDocs).toBeDefined();
      expect(result.retrievedDocs!.length).toBe(1);
      expect(result.retrievedDocs![0].text).toContain('Technical Skills');
      expect(result.retrievedDocs![0].text).toContain('LangGraph');
    });

    it('should fall back gracefully to local profile sections when pgvector is empty', async () => {
      vi.spyOn(pgVectorService, 'searchResumeChunks').mockResolvedValue([]);

      const state = {
        messages: [new HumanMessage('Where did you study?')],
        extractedKeywords: 'education college degree',
      };

      const result = await pgVectorRetrieverNode(state as any);

      expect(result.retrievedDocs).toBeDefined();
      expect(result.retrievedDocs!.length).toBeGreaterThan(0);
    });
  });

  describe('decisionRouterNode (gemini-decision-1 Decision Model)', () => {
    it('should return greeting intent when decision model returns greeting', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ decisions: { intent: { choice: 'greeting' } } }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const state = {
        messages: [new HumanMessage('Hi there!')],
      };

      const result = await decisionRouterNode(state as any);
      expect(result.intent).toBe('greeting');
    });

    it('should return error message to user if decision model call fails', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });
      vi.stubGlobal('fetch', mockFetch);

      const state = {
        messages: [new HumanMessage('Book an appointment')],
      };

      const result = await decisionRouterNode(state as any);
      expect(result.intent).toBe('direct');
      expect(result.finalMessage).toContain('An error occurred');
      expect(result.messages![0].content).toContain('Please try again later.');
    });
  });
});
