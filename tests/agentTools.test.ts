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
    it('should generate OTP, store in Redis, enqueue BullMQ email job, and mark dispatched', async () => {
      const storeSpy = vi.spyOn(otpService, 'storeHashedOtp').mockResolvedValue('hash123');
      const queueSpy = vi.spyOn(emailQueue, 'enqueueOtpEmail').mockResolvedValue('job-1' as any);
      const dispatchSpy = vi.spyOn(otpService, 'markOtpDispatched').mockResolvedValue();

      const res = await sendVerificationOtpTool.invoke({
        email: 'test@domain.com',
        name: 'Alex',
      });

      const parsed = JSON.parse(res);
      expect(parsed.status).toBe('sent');
      expect(parsed.message).toContain('6-digit verification code has been dispatched');
      expect(storeSpy).toHaveBeenCalledWith('test@domain.com', expect.any(String));
      expect(queueSpy).toHaveBeenCalledWith('test@domain.com', expect.any(String), 'Alex');
      expect(dispatchSpy).toHaveBeenCalledWith('test@domain.com', 'hash123');
    });

    it('rolls back the stored OTP challenge if enqueueOtpEmail fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(otpService, 'storeHashedOtp').mockResolvedValue('hash-fail');
      const rollbackSpy = vi.spyOn(otpService, 'rollbackOtpChallenge').mockResolvedValue();
      const dispatchSpy = vi.spyOn(otpService, 'markOtpDispatched').mockResolvedValue();
      vi.spyOn(emailQueue, 'enqueueOtpEmail').mockRejectedValue(new Error('BullMQ down'));

      const res = await sendVerificationOtpTool.invoke({
        email: 'fail@domain.com',
        name: 'Alex',
      });

      const parsed = JSON.parse(res);
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('BullMQ down');
      expect(rollbackSpy).toHaveBeenCalledWith('fail@domain.com', 'hash-fail');
      expect(dispatchSpy).not.toHaveBeenCalled();
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

    it('should reject scheduling when phone or reason is missing', async () => {
      const verifiedSpy = vi.spyOn(otpService, 'isEmailVerified').mockResolvedValue(true);

      const res = await scheduleEnquiryTool.invoke({
        name: 'John Doe',
        email: 'john@example.com',
        phone: ' ',
        reason: 'Discuss AI project',
      });

      const parsed = JSON.parse(res);
      expect(parsed.status).toBe('missing_fields');
      expect(verifiedSpy).not.toHaveBeenCalled();
    });

    it('should schedule enquiry, promise 24-hour response, and consume verified email once', async () => {
      vi.spyOn(otpService, 'isEmailVerified').mockResolvedValue(true);
      const consumeSpy = vi.spyOn(otpService, 'consumeVerifiedEmail').mockResolvedValue();
      vi.spyOn(redisClient, 'set').mockResolvedValue('OK' as any);
      vi.spyOn(redisClient, 'lpush').mockResolvedValue(1 as any);
      const ltrimSpy = vi.spyOn(redisClient, 'ltrim').mockResolvedValue('OK' as any);
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
      expect(ltrimSpy).toHaveBeenCalledWith('enquiries:list', 0, 999);
      expect(consumeSpy).toHaveBeenCalledWith('john@example.com');
      expect(queueSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'John Doe',
          email: 'john@example.com',
        })
      );
    });

    it('retains created enquiryId when consumeVerifiedEmail fails and resumes without duplicate persistence or notification', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(otpService, 'isEmailVerified').mockResolvedValue(true);
      const setSpy = vi.spyOn(redisClient, 'set').mockResolvedValue('OK' as any);
      const lpushSpy = vi.spyOn(redisClient, 'lpush').mockResolvedValue(1 as any);
      const ltrimSpy = vi.spyOn(redisClient, 'ltrim').mockResolvedValue('OK' as any);
      const notifySpy = vi
        .spyOn(emailQueue, 'enqueueLeadNotification')
        .mockResolvedValue('job-lead-resume' as any);
      const consumeSpy = vi
        .spyOn(otpService, 'consumeVerifiedEmail')
        .mockRejectedValueOnce(new Error('Redis DEL timed out'))
        .mockResolvedValueOnce();

      const args = {
        name: 'Resume User',
        email: 'resume@example.com',
        phone: '+1 555-0200',
        reason: 'Discuss AI rollout',
      };

      const firstRes = JSON.parse(await scheduleEnquiryTool.invoke(args));
      expect(firstRes.status).toBe('error');
      expect(firstRes.enquiryId).toBeTruthy();

      const retryRes = JSON.parse(await scheduleEnquiryTool.invoke(args));
      expect(retryRes.status).toBe('confirmed');
      expect(retryRes.enquiryId).toBe(firstRes.enquiryId);
      expect(setSpy).toHaveBeenCalledTimes(1);
      expect(lpushSpy).toHaveBeenCalledTimes(1);
      expect(ltrimSpy).toHaveBeenCalledTimes(1);
      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect(consumeSpy).toHaveBeenCalledTimes(2);
    });

    it('preserves failure behavior for errors before consumeVerifiedEmail', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(otpService, 'isEmailVerified').mockResolvedValue(true);
      const setSpy = vi.spyOn(redisClient, 'set').mockResolvedValue('OK' as any);
      vi.spyOn(redisClient, 'lpush').mockResolvedValue(1 as any);
      vi.spyOn(redisClient, 'ltrim').mockResolvedValue('OK' as any);
      const consumeSpy = vi.spyOn(otpService, 'consumeVerifiedEmail').mockResolvedValue();
      vi.spyOn(emailQueue, 'enqueueLeadNotification')
        .mockRejectedValueOnce(new Error('Queue offline'))
        .mockResolvedValueOnce('job-ok' as any);

      const args = {
        name: 'Error User',
        email: 'otherfail@example.com',
        phone: '+1 555-0300',
        reason: 'Backend check',
      };

      const failRes = JSON.parse(await scheduleEnquiryTool.invoke(args));
      expect(failRes.status).toBe('error');
      expect(failRes.enquiryId).toBeUndefined();
      expect(consumeSpy).not.toHaveBeenCalled();

      const okRes = JSON.parse(await scheduleEnquiryTool.invoke(args));
      expect(okRes.status).toBe('confirmed');
      expect(setSpy).toHaveBeenCalledTimes(2);
      expect(consumeSpy).toHaveBeenCalledTimes(1);
    });
  });
});
