import { describe, it, expect, vi } from 'vitest';
import { agentGraph } from '../src/agent/graph.js';
import { HumanMessage } from '@langchain/core/messages';
import * as otpService from '../src/services/otpService.js';
import * as emailQueue from '../src/queues/emailQueue.js';
import { redisClient } from '../src/services/redisClient.js';

describe('End-to-End AI Multi-Turn Scheduling', () => {
  it('should enforce name requirement, extract phone and reason, verify OTP and book', async () => {
    vi.spyOn(otpService, 'storeHashedOtp').mockResolvedValue('fakehash');
    vi.spyOn(otpService, 'markOtpDispatched').mockResolvedValue();
    vi.spyOn(otpService, 'hasDispatchedOtp').mockResolvedValue(false);
    vi.spyOn(otpService, 'consumeVerifiedEmail').mockResolvedValue();
    vi.spyOn(emailQueue, 'enqueueOtpEmail').mockResolvedValue('job-1' as any);
    vi.spyOn(otpService, 'verifyEnteredOtp').mockResolvedValue({
      success: true,
      message: 'Email successfully verified!',
    });
    vi.spyOn(otpService, 'isEmailVerified').mockResolvedValueOnce(false).mockResolvedValue(true);
    vi.spyOn(emailQueue, 'enqueueLeadNotification').mockResolvedValue('job-2' as any);
    vi.spyOn(redisClient, 'set').mockResolvedValue('OK' as any);
    vi.spyOn(redisClient, 'lpush').mockResolvedValue(1 as any);
    vi.spyOn(redisClient, 'ltrim').mockResolvedValue('OK' as any);

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
