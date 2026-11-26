import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { agentGraph } from '../src/agent/graph.js';
import { HumanMessage } from '@langchain/core/messages';
import * as otpService from '../src/services/otpService.js';
import * as emailQueue from '../src/queues/emailQueue.js';

describe('End-to-End AI Multi-Turn Scheduling', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockImplementation((url: string | URL | Request, opts?: any) => {
      if (String(url).includes('createDecision')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ decisions: { intent: { choice: 'schedule_enquiry' } } }),
        });
      }
      return originalFetch(url, opts);
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  it('should enforce name requirement, extract phone and reason, verify OTP and book', async () => {
    vi.spyOn(otpService, 'storeHashedOtp').mockResolvedValue('fakehash');
    vi.spyOn(emailQueue, 'enqueueOtpEmail').mockResolvedValue('job-1' as any);
    vi.spyOn(otpService, 'verifyEnteredOtp').mockResolvedValue({
      success: true,
      message: 'Email successfully verified!',
    });
    vi.spyOn(otpService, 'isEmailVerified').mockResolvedValueOnce(false).mockResolvedValue(true);
    vi.spyOn(emailQueue, 'enqueueLeadNotification').mockResolvedValue('job-2' as any);

    // Turn 1: Providing email only without name
    console.log('--- Turn 1: Email only ---');
    const res1 = await agentGraph.invoke({
      messages: [new HumanMessage('i need to connect with him my email : vyshnavpcnaravoor@gmail.com')],
    });
    const reply1 = String(res1.messages[res1.messages.length - 1].content);
    console.log('Reply 1:\n', reply1);

    // AI must ask for the name before sending OTP!
    expect(reply1.toLowerCase()).toContain('name');

    // Turn 2: Providing name, phone, and reason
    console.log('\n--- Turn 2: Providing name, phone, reason ---');
    const res2 = await agentGraph.invoke({
      messages: [
        ...res1.messages,
        new HumanMessage('My name is Vyshnav, phone is +91 9876543210, and I want to discuss an AI agent project'),
      ],
      leadInfo: res1.leadInfo,
    });
    const reply2 = String(res2.messages[res2.messages.length - 1].content);
    console.log('Reply 2:\n', reply2);

    // AI should have sent verification code now
    expect(reply2.toLowerCase()).toContain('verification code');

    // Turn 3: User enters 6-digit code
    console.log('\n--- Turn 3: Entering OTP code ---');
    const res3 = await agentGraph.invoke({
      messages: [
        ...res2.messages,
        new HumanMessage('Here is my verification code: 654321'),
      ],
      leadInfo: res2.leadInfo,
    });
    const reply3 = String(res3.messages[res3.messages.length - 1].content);
    console.log('Reply 3:\n', reply3);
    console.log('Final Lead Info:\n', res3.leadInfo);

    expect(reply3).toContain('24 hours');
  });
});
