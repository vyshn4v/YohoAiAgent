import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { agentGraph } from '../src/agent/graph.js';
import * as otpService from '../src/services/otpService.js';
import * as emailQueue from '../src/queues/emailQueue.js';

describe('LangGraph Agent Multi-Node Orchestration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should process a profile inquiry through RAG nodes and respond with job details', async () => {
    const result = await agentGraph.invoke({
      messages: [new HumanMessage('What are your main technical skills and experience?')],
    });

    expect(result.intent).toBe('profile_query');
    expect(result.retrievedDocs).toBeDefined();
    expect(result.retrievedDocs.length).toBeGreaterThan(0);

    const lastMsg = result.messages[result.messages.length - 1];
    const content = typeof lastMsg.content === 'string' ? lastMsg.content : '';

    expect(content).toContain('Vyshnav');
    expect(content).toContain('24 hours');
  });

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

  it('should trigger OTP dispatch when user provides an email to schedule', async () => {
    vi.spyOn(otpService, 'storeHashedOtp').mockResolvedValue('fakehash');
    vi.spyOn(emailQueue, 'enqueueOtpEmail').mockResolvedValue('job-123' as any);

    const result = await agentGraph.invoke({
      messages: [
        new HumanMessage('I want to schedule a consultation'),
        new HumanMessage('My email is client@example.com and my name is Alice'),
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

    const result = await agentGraph.invoke({
      messages: [
        new HumanMessage('My name is Alice and my email is client@example.com'),
        new AIMessage('A verification code has been dispatched to client@example.com. Please enter the 6-digit code.'),
        new HumanMessage('Here is my verification code: 654321'),
      ],
      leadInfo: { email: 'client@example.com', name: 'Alice' },
    });

    const lastMsg = result.messages[result.messages.length - 1];
    const content = typeof lastMsg.content === 'string' ? lastMsg.content : '';

    expect(content).toContain('successfully verified');
    expect(content).toContain('24 hours');
  });
});
