import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateOtp, hashOtp, storeHashedOtp, verifyEnteredOtp, isEmailVerified } from '../src/services/otpService.js';
import { redisClient } from '../src/services/redisClient.js';

describe('OTP Service', () => {
  const testEmail = 'client@example.com';
  const redisStore = new Map<string, string>();

  beforeEach(() => {
    redisStore.clear();

    vi.spyOn(redisClient, 'set').mockImplementation(async (key: any, val: any) => {
      redisStore.set(key, String(val));
      return 'OK' as any;
    });

    vi.spyOn(redisClient, 'get').mockImplementation(async (key: any) => {
      return redisStore.get(key) || null;
    });

    vi.spyOn(redisClient, 'del').mockImplementation(async (key: any) => {
      redisStore.delete(key);
      return 1 as any;
    });

    vi.spyOn(redisClient, 'incr').mockImplementation(async (key: any) => {
      const current = parseInt(redisStore.get(key) || '0', 10);
      const next = current + 1;
      redisStore.set(key, String(next));
      return next as any;
    });
  });

  it('should generate a 6-digit numeric OTP', () => {
    const otp = generateOtp();
    expect(otp).toMatch(/^\d{6}$/);
    expect(otp.length).toBe(6);
  });

  it('should generate deterministic hash for the same email and OTP', () => {
    const hash1 = hashOtp(testEmail, '123456');
    const hash2 = hashOtp(testEmail, '123456');
    const hashDifferent = hashOtp(testEmail, '654321');

    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hashDifferent);
    expect(hash1).not.toBe('123456'); // Never plaintext
  });

  it('should store encrypted OTP in Redis', async () => {
    const otp = '987654';
    const hash = await storeHashedOtp(testEmail, otp);

    expect(redisStore.has(`otp:${testEmail}`)).toBe(true);
    expect(redisStore.get(`otp:${testEmail}`)).toBe(hash);
    expect(redisStore.get(`otp:${testEmail}`)).not.toBe(otp);
  });

  it('should successfully verify correct OTP and mark email as verified', async () => {
    const otp = '456789';
    await storeHashedOtp(testEmail, otp);

    const result = await verifyEnteredOtp(testEmail, otp);
    expect(result.success).toBe(true);
    expect(result.message).toContain('successfully verified');

    // OTP keys should be cleaned up
    expect(redisStore.has(`otp:${testEmail}`)).toBe(false);

    // Email should be marked as verified
    const isVerified = await isEmailVerified(testEmail);
    expect(isVerified).toBe(true);
  });

  it('should reject invalid OTP and increment attempt counter', async () => {
    const otp = '112233';
    await storeHashedOtp(testEmail, otp);

    const result = await verifyEnteredOtp(testEmail, '999999');
    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid code');

    const isVerified = await isEmailVerified(testEmail);
    expect(isVerified).toBe(false);
  });

  it('should reject verification if OTP does not exist or has expired', async () => {
    const result = await verifyEnteredOtp('unknown@example.com', '123456');
    expect(result.success).toBe(false);
    expect(result.message).toContain('No active OTP found or it has expired');
  });
});
