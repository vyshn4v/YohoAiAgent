import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import {
  decisionRouterNode,
  getGoogleGenAiClient,
  greetingSmallModelNode,
  pgVectorRetrieverNode,
  bigModelKnowledgeNode,
  scheduleEnquiryNode,
} from '../src/agent/nodes.js';
import * as pgVectorService from '../src/services/pgVectorService.js';
import * as otpService from '../src/services/otpService.js';
import * as emailQueue from '../src/queues/emailQueue.js';
import {
  createNodeLogger,
  formatErrorDetails,
  sanitizeLogValue,
} from '../src/utils/nodeLogger.js';

describe('Node Logging & Failure Diagnostics', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sanitizes newline injection in log values and extracts error metadata', () => {
    const clean = sanitizeLogValue('line1\r\nFAKE_LOG_ENTRY\tvalue');
    expect(clean).not.toContain('\n');
    expect(clean).not.toContain('\r');
    expect(clean).toBe('line1 FAKE_LOG_ENTRY value');

    const err = Object.assign(new Error('Rate limit hit'), {
      status: 429,
      lc_error_code: 'MODEL_RATE_LIMIT',
    });
    const details = formatErrorDetails(err);
    expect(details).toContain('status=429');
    expect(details).toContain('code=MODEL_RATE_LIMIT');
    expect(details).toContain('Rate limit hit');
  });

  it('includes conversation id and duration in node logger output', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const logger = createNodeLogger('TestNode', {
      configurable: { thread_id: 'conv-123' },
    });

    logger.start({ model: 'gemini-flash-latest' });
    logger.done({ docs: 3 });
    logger.fail(new Error('boom'), { step: 'invoke' });

    expect(logSpy).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('[TestNode] [conv=conv-123] Started (model=gemini-flash-latest)')
    );
    expect(logSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/\[TestNode\] \[conv=conv-123\] Completed in \d+ms \(docs=3\)/)
    );
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[TestNode\] \[conv=conv-123\] Failed in \d+ms \(step=invoke\): boom/)
    );
  });

  it('logs DecisionRouter start, target node, and failure details', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ai = getGoogleGenAiClient();

    vi.spyOn(ai.decisions, 'create').mockResolvedValueOnce({
      answers: { intent: { type: 'choice', choice: 'knowledge_query' } },
    } as any);

    await decisionRouterNode(
      { messages: [new HumanMessage('What are your skills?')] } as any,
      { configurable: { thread_id: 'conv-router-1' } }
    );

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('[DecisionRouter] [conv=conv-router-1] Started')
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('intent=profile_query, rawChoice=knowledge_query, nextNode=pgvector_retriever')
    );

    vi.spyOn(ai.decisions, 'create').mockRejectedValueOnce(
      Object.assign(new Error('Decision API down'), { status: 503 })
    );

    const failedResult = await decisionRouterNode(
      { messages: [new HumanMessage('Hi')] } as any,
      { configurable: { thread_id: 'conv-router-2' } }
    );

    expect(failedResult.intent).toBe('direct');
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('[DecisionRouter] [conv=conv-router-2] Failed')
    );
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('step=call_decision_model')
    );
  });

  it('logs GreetingNode completion, 404 fallback, and errors before rethrowing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.spyOn(ChatOpenAI.prototype, 'invoke')
      .mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404 }))
      .mockResolvedValueOnce(new AIMessage('Hello! I am Yoho.') as any);

    const result = await greetingSmallModelNode(
      { messages: [new HumanMessage('Hi')] } as any,
      { configurable: { thread_id: 'conv-greet-1' } }
    );

    expect(result.finalMessage).toBe('Hello! I am Yoho.');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[GreetingNode] [conv=conv-greet-1] Primary model returned 404/MODEL_NOT_FOUND')
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('[GreetingNode] [conv=conv-greet-1] Completed')
    );

    vi.spyOn(ChatOpenAI.prototype, 'invoke').mockRejectedValueOnce(
      Object.assign(new Error('Rate limit'), { status: 429 })
    );

    await expect(
      greetingSmallModelNode(
        { messages: [new HumanMessage('Hello')] } as any,
        { configurable: { thread_id: 'conv-greet-2' } }
      )
    ).rejects.toThrow('Rate limit');

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('[GreetingNode] [conv=conv-greet-2] Failed')
    );
  });

  it('logs PgVectorRetriever empty results and KnowledgeNode execution/failure', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.spyOn(pgVectorService, 'searchResumeChunks').mockResolvedValueOnce([]);

    const retrieval = await pgVectorRetrieverNode(
      {
        messages: [new HumanMessage('Tell me your skills')],
        extractedKeywords: 'skills',
      } as any,
      { configurable: { thread_id: 'conv-rag-1' } }
    );

    expect(retrieval.retrievedDocs).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[PgVectorRetriever] [conv=conv-rag-1] pgvector returned 0 chunks')
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('source=empty, docs=0')
    );

    vi.spyOn(ChatOpenAI.prototype, 'invoke').mockRejectedValueOnce(
      Object.assign(new Error('Model overloaded'), { status: 429, lc_error_code: 'MODEL_RATE_LIMIT' })
    );

    await expect(
      bigModelKnowledgeNode(
        {
          messages: [new HumanMessage('Tell me your skills')],
          retrievedDocs: retrieval.retrievedDocs,
        } as any,
        { configurable: { thread_id: 'conv-rag-1' } }
      )
    ).rejects.toThrow('Model overloaded');

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('[KnowledgeNode] [conv=conv-rag-1] Failed')
    );
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('status=429 code=MODEL_RATE_LIMIT')
    );
  });

  it('logs ScheduleEnquiry steps without leaking PII or OTP secrets', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.spyOn(otpService, 'isEmailVerified').mockResolvedValueOnce(false);
    vi.spyOn(otpService, 'storeHashedOtp').mockResolvedValueOnce('hashed');
    vi.spyOn(emailQueue, 'enqueueOtpEmail').mockResolvedValueOnce('job-99' as any);

    vi.spyOn(ChatOpenAI.prototype, 'withStructuredOutput').mockReturnValueOnce({
      invoke: vi.fn().mockResolvedValue({
        name: 'Alice Secret',
        email: 'alice.private@example.com',
        phone: '+15550001234',
        reason: 'Consulting',
        otp: null,
        action: 'send_otp',
      }),
    } as any);

    await scheduleEnquiryNode(
      { messages: [new HumanMessage('Schedule with Alice')] } as any,
      { configurable: { thread_id: 'conv-sched-1' } }
    );

    const allLogs = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(allLogs).toContain('[ScheduleEnquiry] [conv=conv-sched-1] Started');
    expect(allLogs).toContain('outcome=otp_dispatched');
    expect(allLogs).not.toContain('alice.private@example.com');
    expect(allLogs).not.toContain('+15550001234');

    vi.spyOn(ChatOpenAI.prototype, 'withStructuredOutput').mockReturnValueOnce({
      invoke: vi.fn().mockRejectedValue(new Error('Structured output timeout')),
    } as any);

    const failState = await scheduleEnquiryNode(
      { messages: [new HumanMessage('Schedule again')] } as any,
      { configurable: { thread_id: 'conv-sched-2' } }
    );

    expect(failState.finalMessage).toContain('An error occurred');
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ScheduleEnquiry] [conv=conv-sched-2] Failed')
    );
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('step=extract_contact_fields')
    );
  });
});
