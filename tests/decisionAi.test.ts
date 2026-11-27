import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatOpenAI } from '@langchain/openai';
import {
  bigModelKnowledgeNode,
  decisionRouterNode,
  getGoogleGenAiClient,
  greetingSmallModelNode,
  pgVectorRetrieverNode,
  scheduleEnquiryNode,
} from '../src/agent/nodes.js';
import { extractOtpFromLastMessage } from '../src/agent/nodes/scheduleEnquiryNode.js';
import { agentGraph } from '../src/agent/graph.js';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import * as pgVectorService from '../src/services/pgVectorService.js';
import * as otpService from '../src/services/otpService.js';
import * as emailQueue from '../src/queues/emailQueue.js';

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
          content: 'LangGraph, TypeScript, Node.js, Python, PostgreSQL pgvector, BullMQ',
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

    it('should return empty docs cleanly when pgvector search throws an error', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(pgVectorService, 'searchResumeChunks').mockRejectedValueOnce(
        new Error('DB connection lost')
      );

      const state = {
        messages: [new HumanMessage('Tell me about Neutrinos')],
        extractedKeywords: 'Neutrinos experience',
      };

      const result = await pgVectorRetrieverNode(state as any);

      expect(result.retrievedDocs).toEqual([]);
    });

    it('returns an insufficient-context reply offering a call without hardcoded bio or LLM invocation when retrievedDocs is empty', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const llmSpy = vi.spyOn(ChatOpenAI.prototype, 'invoke');

      const result = await bigModelKnowledgeNode({
        messages: [new HumanMessage('Where did you study?')],
        retrievedDocs: [],
      } as any);

      expect(llmSpy).not.toHaveBeenCalled();
      expect(result.finalMessage).toContain("don't have enough verified information");
      expect(result.finalMessage).toContain('schedule a call');
      expect(result.uiAction).toBeNull();
    });

    it('preserves answers grounded in retrievedDocs when chunks are available', async () => {
      const llmSpy = vi
        .spyOn(ChatOpenAI.prototype, 'invoke')
        .mockResolvedValueOnce(new AIMessage('Grounded in chunk content.') as any);

      const result = await bigModelKnowledgeNode({
        messages: [new HumanMessage('What frameworks do you use?')],
        retrievedDocs: [{ id: '1', score: 0.9, text: '### Skills\nLangGraph & TypeScript', metadata: {} }],
      } as any);

      expect(llmSpy).toHaveBeenCalledTimes(1);
      expect(result.finalMessage).toBe('Grounded in chunk content.');
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

  describe('scheduleEnquiryNode OTP & email state edge cases', () => {
    it('asks for email instead of falling back to user@example.com when OTP has no email', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const verifySpy = vi.spyOn(otpService, 'verifyEnteredOtp');
      vi.spyOn(ChatOpenAI.prototype, 'withStructuredOutput').mockReturnValueOnce({
        invoke: vi.fn().mockResolvedValue({
          name: 'Alex',
          email: null,
          phone: null,
          reason: null,
          otp: '654321',
          action: 'verify_otp',
        }),
      } as any);

      const result = await scheduleEnquiryNode({
        messages: [new HumanMessage('654321')],
        leadInfo: { name: 'Alex' },
        isVerified: false,
      } as any);

      expect(verifySpy).not.toHaveBeenCalled();
      expect(String(result.messages![0].content)).toContain('email address');
    });

    it('resets isVerified on email change and verifies subsequent OTP regardless of action label', async () => {
      vi.spyOn(otpService, 'isEmailVerified').mockResolvedValueOnce(false);
      vi.spyOn(otpService, 'hasDispatchedOtp').mockResolvedValueOnce(false);
      vi.spyOn(otpService, 'storeHashedOtp').mockResolvedValueOnce('hashed');
      vi.spyOn(otpService, 'markOtpDispatched').mockResolvedValueOnce();
      vi.spyOn(emailQueue, 'enqueueOtpEmail').mockResolvedValueOnce('job-bob' as any);

      vi.spyOn(ChatOpenAI.prototype, 'withStructuredOutput').mockReturnValueOnce({
        invoke: vi.fn().mockResolvedValue({
          name: 'Alice',
          email: 'bob@example.com',
          phone: '+1 555-0100',
          reason: 'Consultation',
          otp: null,
          action: 'send_otp',
        }),
      } as any);

      const dispatchRes = await scheduleEnquiryNode({
        messages: [new HumanMessage('Use bob@example.com instead, phone +1 555-0100 for consultation')],
        leadInfo: { name: 'Alice', email: 'alice@example.com' },
        isVerified: true,
      } as any);

      expect(dispatchRes.isVerified).toBe(false);

      const verifySpy = vi.spyOn(otpService, 'verifyEnteredOtp').mockResolvedValueOnce({
        success: false,
        message: 'Invalid code.',
      });
      vi.spyOn(ChatOpenAI.prototype, 'withStructuredOutput').mockReturnValueOnce({
        invoke: vi.fn().mockResolvedValue({
          name: 'Alice',
          email: 'bob@example.com',
          phone: '+1 555-0100',
          reason: 'Consultation',
          otp: '456789',
          action: 'schedule',
        }),
      } as any);

      await scheduleEnquiryNode({
        messages: [new HumanMessage('456789')],
        leadInfo: { name: 'Alice', email: 'bob@example.com', phone: '+1 555-0100', reason: 'Consultation' },
        isVerified: Boolean(dispatchRes.isVerified),
      } as any);

      expect(verifySpy).toHaveBeenCalledWith('bob@example.com', '456789');
    });

    it('requires phone and reason before dispatching an OTP or scheduling', async () => {
      const otpSpy = vi.spyOn(otpService, 'storeHashedOtp');
      const leadSpy = vi.spyOn(emailQueue, 'enqueueLeadNotification');

      vi.spyOn(ChatOpenAI.prototype, 'withStructuredOutput').mockReturnValueOnce({
        invoke: vi.fn().mockResolvedValue({
          name: 'Alice',
          email: 'alice@example.com',
          phone: null,
          reason: null,
          otp: null,
          action: 'schedule',
        }),
      } as any);

      const res = await scheduleEnquiryNode({
        messages: [new HumanMessage('My name is Alice and email is alice@example.com')],
        leadInfo: {},
        isVerified: false,
      } as any);

      const reply = String(res.messages![0].content).toLowerCase();
      expect(reply).toContain('phone number');
      expect(reply).toContain('reason for connecting');
      expect(otpSpy).not.toHaveBeenCalled();
      expect(leadSpy).not.toHaveBeenCalled();
    });

    it('extracts OTP deterministically from latest message even if AI omits it and ignores stale history OTPs', async () => {
      expect(extractOtpFromLastMessage('654321', false)).toBe('654321');
      expect(extractOtpFromLastMessage('Here is my otp: 654321', false)).toBe('654321');
      expect(extractOtpFromLastMessage('+91 9876543210', true)).toBeNull();

      const verifySpy = vi.spyOn(otpService, 'verifyEnteredOtp').mockResolvedValueOnce({
        success: false,
        message: 'Invalid code.',
      });
      vi.spyOn(ChatOpenAI.prototype, 'withStructuredOutput').mockReturnValueOnce({
        invoke: vi.fn().mockResolvedValue({
          name: 'Alice',
          email: 'alice@example.com',
          phone: '+1 555-0100',
          reason: 'Project chat',
          otp: null, // Simulate LLM failing to extract bare OTP
          action: 'schedule',
        }),
      } as any);

      const res = await scheduleEnquiryNode({
        messages: [
          new AIMessage('A 6-digit verification code has been dispatched to alice@example.com.'),
          new HumanMessage('654321'),
        ],
        leadInfo: {
          name: 'Alice',
          email: 'alice@example.com',
          phone: '+1 555-0100',
          reason: 'Project chat',
        },
        isVerified: false,
      } as any);

      expect(verifySpy).toHaveBeenCalledWith('alice@example.com', '654321');
      expect(res.isVerified).toBe(false);
    });

    it('retries OTP dispatch when an active hash was not dispatched, but reuses after successful dispatch', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(otpService, 'isEmailVerified').mockResolvedValue(false);

      const activeMock = vi.spyOn(otpService, 'hasActiveOtp').mockResolvedValue(true);
      const dispatchedMock = vi
        .spyOn(otpService, 'hasDispatchedOtp')
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      vi.spyOn(otpService, 'storeHashedOtp').mockResolvedValueOnce('hashed-retry');
      const enqueueSpy = vi.spyOn(emailQueue, 'enqueueOtpEmail').mockResolvedValueOnce('job-retry' as any);
      const markDispatchedSpy = vi.spyOn(otpService, 'markOtpDispatched').mockResolvedValueOnce();

      vi.spyOn(ChatOpenAI.prototype, 'withStructuredOutput').mockReturnValue({
        invoke: vi.fn().mockResolvedValue({
          name: 'Alice',
          email: 'alice@example.com',
          phone: '+1 555-0100',
          reason: 'Consultation',
          otp: null,
          action: 'schedule',
        }),
      } as any);

      const baseState = {
        messages: [new HumanMessage('Proceed with scheduling')],
        leadInfo: {
          name: 'Alice',
          email: 'alice@example.com',
          phone: '+1 555-0100',
          reason: 'Consultation',
        },
        isVerified: false,
      } as any;

      const retryRes = await scheduleEnquiryNode(baseState);
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(markDispatchedSpy).toHaveBeenCalledWith('alice@example.com', 'hashed-retry');
      expect(String(retryRes.messages![0].content)).toContain('dispatched to alice@example.com');

      const reuseRes = await scheduleEnquiryNode(baseState);
      expect(dispatchedMock).toHaveBeenCalledTimes(2);
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(String(reuseRes.messages![0].content)).toContain('already sent');
      expect(activeMock).not.toHaveBeenCalled();
    });
  });
});
