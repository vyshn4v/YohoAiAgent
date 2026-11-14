import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sendVerificationOtpTool,
  verifyOtpTool,
  scheduleEnquiryTool,
} from '../src/tools/index.js';
import * as otpService from '../src/services/otpService.js';
import * as emailQueue from '../src/queues/emailQueue.js';
import { redisClient } from '../src/services/redisClient.js';

describe('Agent Tools', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('sendVerificationOtpTool', () => {
    it('should generate OTP, store in Redis, and enqueue BullMQ email job', async () => {
      const storeSpy = vi.spyOn(otpService, 'storeHashedOtp').mockResolvedValue('hash123');
      const queueSpy = vi.spyOn(emailQueue, 'enqueueOtpEmail').mockResolvedValue('job-1' as any);

      const res = await sendVerificationOtpTool.invoke({
        email: 'test@domain.com',
        name: 'Alex',
      });

      const parsed = JSON.parse(res);
      expect(parsed.status).toBe('sent');
      expect(parsed.message).toContain('6-digit verification code has been dispatched');
      expect(storeSpy).toHaveBeenCalledWith('test@domain.com', expect.any(String));
      expect(queueSpy).toHaveBeenCalledWith('test@domain.com', expect.any(String), 'Alex');
    });
  });

  describe('verifyOtpTool', () => {
    it('should return verified status when code matches', async () => {
      vi.spyOn(otpService, 'verifyEnteredOtp').mockResolvedValue({
        success: true,
        message: 'Email successfully verified!',
      });

      const res = await verifyOtpTool.invoke({
        email: 'test@domain.com',
        otp: '123456',
      });

      const parsed = JSON.parse(res);
      expect(parsed.status).toBe('verified');
      expect(parsed.message).toContain('successfully verified');
    });

    it('should return failed status when code does not match', async () => {
      vi.spyOn(otpService, 'verifyEnteredOtp').mockResolvedValue({
        success: false,
        message: 'Invalid code.',
      });

      const res = await verifyOtpTool.invoke({
        email: 'test@domain.com',
        otp: '000000',
      });

      const parsed = JSON.parse(res);
      expect(parsed.status).toBe('failed');
      expect(parsed.message).toBe('Invalid code.');
    });
  });

  describe('scheduleEnquiryTool', () => {
    it('should reject scheduling if email is unverified', async () => {
      vi.spyOn(otpService, 'isEmailVerified').mockResolvedValue(false);

      const res = await scheduleEnquiryTool.invoke({
        name: 'Sarah Connor',
        email: 'sarah@skynet.com',
        phone: '+1 555-0199',
        reason: 'Discuss AI agent architecture',
      });

      const parsed = JSON.parse(res);
      expect(parsed.status).toBe('unverified');
      expect(parsed.message).toContain('has not been verified yet');
    });

    it('should schedule enquiry and promise 24-hour response when email is verified', async () => {
      vi.spyOn(otpService, 'isEmailVerified').mockResolvedValue(true);
      vi.spyOn(redisClient, 'set').mockResolvedValue('OK' as any);
      vi.spyOn(redisClient, 'lpush').mockResolvedValue(1 as any);
      const queueSpy = vi.spyOn(emailQueue, 'enqueueLeadNotification').mockResolvedValue('job-lead-1' as any);

      const res = await scheduleEnquiryTool.invoke({
        name: 'John Doe',
        email: 'john@example.com',
        phone: '+1 555-0100',
        reason: 'Consulting on LangGraph and BullMQ integration',
      });

      const parsed = JSON.parse(res);
      expect(parsed.status).toBe('confirmed');
      expect(parsed.enquiryId).toBeDefined();
      expect(parsed.message).toContain('within 24 hours');
      expect(queueSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'John Doe',
          email: 'john@example.com',
        })
      );
    });
  });
});
