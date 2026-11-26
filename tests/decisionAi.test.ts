import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatOpenAI } from '@langchain/openai';
import {
  decisionRouterNode,
  getGoogleGenAiClient,
  greetingSmallModelNode,
  pgVectorRetrieverNode,
} from '../src/agent/nodes.js';
import { agentGraph } from '../src/agent/graph.js';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
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

    it('should handle empty pgvector results gracefully without crashing', async () => {
      vi.spyOn(pgVectorService, 'searchResumeChunks').mockResolvedValue([]);

      const state = {
        messages: [new HumanMessage('Where did you study?')],
        extractedKeywords: 'education college degree',
      };

      const result = await pgVectorRetrieverNode(state as any);

      expect(result.retrievedDocs).toEqual([]);
    });
  });

  describe('decisionRouterNode (gemini-decision-1 Decision Model)', () => {
    it('should return greeting intent when decision model returns greeting', async () => {
      const ai = getGoogleGenAiClient();
      vi.spyOn(ai.decisions, 'create').mockResolvedValue({
        answers: { intent: { type: 'choice', choice: 'greeting', confidence: 0.99 } },
      } as any);

      const state = {
        messages: [new HumanMessage('Hi there!')],
      };

      const result = await decisionRouterNode(state as any);
      expect(result.intent).toBe('greeting');
    });

    it('should return error message to user if decision model call fails', async () => {
      const ai = getGoogleGenAiClient();
      vi.spyOn(ai.decisions, 'create').mockRejectedValue(new Error('500 Internal Server Error'));

      const state = {
        messages: [new HumanMessage('Book an appointment')],
      };

      const result = await decisionRouterNode(state as any);
      expect(result.intent).toBe('direct');
      expect(result.finalMessage).toContain('An error occurred');
      expect(result.messages![0].content).toContain('Please try again later.');
    });

    it('should short-circuit out_of_scope requests without calling RAG or an LLM', async () => {
      const ai = getGoogleGenAiClient();
      vi.spyOn(ai.decisions, 'create').mockResolvedValue({
        answers: { intent: { type: 'choice', choice: 'out_of_scope', confidence: 0.99 } },
      } as any);
      const vectorSpy = vi.spyOn(pgVectorService, 'searchResumeChunks');
      const llmSpy = vi.spyOn(ChatOpenAI.prototype, 'invoke');

      const result = await agentGraph.invoke({
        messages: [new HumanMessage('1+1')],
      });

      expect(result.intent).toBe('out_of_scope');
      const outOfScopeText = String(result.messages[result.messages.length - 1].content);
      expect(outOfScopeText).toContain('Sorry, invalid query. I can only assist');
      expect(outOfScopeText).toContain('Vyshnav P C');
      expect(vectorSpy).not.toHaveBeenCalled();
      expect(llmSpy).not.toHaveBeenCalled();
    });

    it('passes previous assistant message context to decision model for follow-up name replies', async () => {
      const ai = getGoogleGenAiClient();
      const createSpy = vi.spyOn(ai.decisions, 'create').mockResolvedValueOnce({
        answers: { intent: { type: 'choice', choice: 'schedule_enquiry', confidence: 0.98 } },
      } as any);

      const state = {
        messages: [
          new HumanMessage('my email is alex@example.com'),
          new AIMessage('Could you please share your name as well? Vyshnav personally replies within 24 hours.'),
          new HumanMessage('Vyshnav'),
        ],
      };

      const result = await decisionRouterNode(state as any);

      expect(result.intent).toBe('schedule_enquiry');
      expect(result.extractedKeywords).toBe('Vyshnav');
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.stringContaining('Previous assistant message:'),
        })
      );
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.stringContaining('Latest user message: "Vyshnav"'),
        })
      );
    });
  });
});
