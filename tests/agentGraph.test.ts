import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { agentGraph } from '../src/agent/graph.js';
import * as otpService from '../src/services/otpService.js';
import * as emailQueue from '../src/queues/emailQueue.js';
import * as pgVectorService from '../src/services/pgVectorService.js';
import { redisClient } from '../src/services/redisClient.js';

describe('LangGraph Agent Multi-Node Orchestration', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  it('should process a profile inquiry through RAG nodes and respond with job details', async () => {
    vi.spyOn(pgVectorService, 'searchResumeChunks').mockResolvedValueOnce([
      {
        id: 'chunk-graph-1',
        chunkIndex: 0,
        title: 'Technical Skills & Experience',
        content: 'Full-Stack & AI Engineer specializing in TypeScript, Node.js, Python, LangGraph, PostgreSQL pgvector, and Redis.',
        metadata: { source: 'resume.pdf' },
        similarity: 0.94,
      },
    ]);

    const result = await agentGraph.invoke({
      messages: [new HumanMessage('What are your main technical skills and experience?')],
    });

    expect(result.intent).toBe('profile_query');
    expect(result.retrievedDocs).toBeDefined();
    expect(result.retrievedDocs.length).toBeGreaterThan(0);

    const lastMsg = result.messages[result.messages.length - 1];
    const content = typeof lastMsg.content === 'string' ? lastMsg.content : '';

    expect(content.length).toBeGreaterThan(0);
  }, 90000);

  it('should route scheduling requests to the enquiry coordinator node', async () => {
    const result = await agentGraph.invoke({
      messages: [new HumanMessage('I would like to schedule a meeting with you.')],
    });

    expect(result.intent).toBe('schedule_enquiry');

    const lastMsg = result.messages[result.messages.length - 1];
    const content = typeof lastMsg.content === 'string' ? lastMsg.content : '';

    expect(content).toContain('24 hours');
    expect(content.toLowerCase()).toContain('email');
  });

  it('should require all details and trigger OTP dispatch when name, email, phone, and reason are given', async () => {
    vi.spyOn(otpService, 'storeHashedOtp').mockResolvedValue('fakehash');
    vi.spyOn(otpService, 'markOtpDispatched').mockResolvedValue();
    vi.spyOn(otpService, 'hasDispatchedOtp').mockResolvedValue(false);
    vi.spyOn(emailQueue, 'enqueueOtpEmail').mockResolvedValue('job-123' as any);
    vi.spyOn(otpService, 'isEmailVerified').mockResolvedValue(false);

    const partialResult = await agentGraph.invoke({
      messages: [
        new HumanMessage('I want to schedule a consultation'),
        new HumanMessage('My email is client@example.com and my name is Alice'),
      ],
    });
    const partialMsg = String(partialResult.messages[partialResult.messages.length - 1].content).toLowerCase();
    expect(partialMsg).toContain('phone');

    const result = await agentGraph.invoke({
      messages: [
        new HumanMessage(
          'My name is Alice, email is client@example.com, phone is +1 555-0100, and reason is to discuss an AI project'
        ),
      ],
    });

    expect(result.intent).toBe('schedule_enquiry');
    const lastMsg = result.messages[result.messages.length - 1];
    const content = typeof lastMsg.content === 'string' ? lastMsg.content : '';

    expect(content).toContain('verification code');
    expect(content).toContain('client@example.com');
  });

  it('should handle OTP verification and guide user to complete booking', async () => {
    vi.spyOn(otpService, 'verifyEnteredOtp').mockResolvedValue({
      success: true,
      message: 'Email successfully verified!',
    });
    vi.spyOn(otpService, 'isEmailVerified').mockResolvedValue(true);
    vi.spyOn(otpService, 'consumeVerifiedEmail').mockResolvedValue();
    vi.spyOn(redisClient, 'set').mockResolvedValue('OK' as any);
    vi.spyOn(redisClient, 'lpush').mockResolvedValue(1 as any);
    vi.spyOn(redisClient, 'ltrim').mockResolvedValue('OK' as any);
    const leadNotifySpy = vi
      .spyOn(emailQueue, 'enqueueLeadNotification')
      .mockResolvedValue('job-lead' as any);

    const result = await agentGraph.invoke({
      messages: [
        new HumanMessage('My name is Alice and my email is client@example.com'),
        new AIMessage('A verification code has been dispatched to client@example.com. Please enter the 6-digit code.'),
        new HumanMessage('Here is my verification code: 654321'),
      ],
      leadInfo: {
        email: 'client@example.com',
        name: 'Alice',
        phone: '+1 555-0100',
        reason: 'Discuss consulting project',
      },
    });

    const lastMsg = result.messages[result.messages.length - 1];
    const content = typeof lastMsg.content === 'string' ? lastMsg.content : '';

    expect(leadNotifySpy).toHaveBeenCalledTimes(1);
    expect(content).toContain('successfully verified');
    expect(content).toContain('24 hours');
  });
});
