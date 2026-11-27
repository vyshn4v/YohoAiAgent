import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  consumeVerifiedEmail,
  generateOtp,
  hashOtp,
  isEmailVerified,
  markEmailVerified,
  storeHashedOtp,
  verifyEnteredOtp,
} from '../src/services/otpService.js';
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

    vi.spyOn(redisClient, 'eval').mockImplementation(async (script: any, numKeys: any, ...rest: any[]) => {
      const s = String(script);
      const keyCount = Number(numKeys);
      const keys = rest.slice(0, keyCount).map(String);
      const args = rest.slice(keyCount).map(String);

      // Simulate Redis single-threaded atomic Lua execution across synchronous store operations
      if (s.includes("'EXHAUSTED'")) {
        const [otpKey, attemptsKey, verifiedKey, dispatchedKey, recentlyVerifiedKey] = keys;
        const maxAttempts = Number(args[0]);
        const storedHash = redisStore.get(otpKey);
        if (!storedHash) {
          return ['MISSING', redisStore.get(recentlyVerifiedKey) || '', '0'] as any;
        }
        const attempts = parseInt(redisStore.get(attemptsKey) || '0', 10) + 1;
        redisStore.set(attemptsKey, String(attempts));
        if (attempts > maxAttempts) {
          redisStore.delete(otpKey);
          redisStore.delete(attemptsKey);
          redisStore.delete(verifiedKey);
          redisStore.delete(dispatchedKey);
          return ['EXHAUSTED', '', String(attempts)] as any;
        }
        return ['ACTIVE', storedHash, String(attempts)] as any;
      }

      if (s.includes("'true'") && keyCount === 5) {
        const [otpKey, attemptsKey, verifiedKey, dispatchedKey, recentlyVerifiedKey] = keys;
        const [expectedHash] = args;
        if (redisStore.get(otpKey) !== expectedHash) {
          return 0 as any;
        }
        redisStore.delete(otpKey);
        redisStore.delete(attemptsKey);
        redisStore.delete(dispatchedKey);
        redisStore.set(verifiedKey, 'true');
        redisStore.set(recentlyVerifiedKey, expectedHash);
        return 1 as any;
      }

      if (keyCount === 4 && s.includes("ARGV[2] == '1'")) {
        const [otpKey, attemptsKey, verifiedKey, dispatchedKey] = keys;
        const [expectedHash, clearChallenge] = args;
        if (redisStore.get(otpKey) !== expectedHash) {
          return 0 as any;
        }
        redisStore.delete(verifiedKey);
        if (clearChallenge === '1') {
          redisStore.delete(otpKey);
          redisStore.delete(attemptsKey);
          redisStore.delete(dispatchedKey);
        }
        return 1 as any;
      }

      if (keyCount === 3) {
        const [otpKey, attemptsKey, dispatchedKey] = keys;
        const [expectedHash] = args;
        if (redisStore.get(otpKey) === expectedHash) {
          redisStore.delete(otpKey);
          redisStore.delete(attemptsKey);
          redisStore.delete(dispatchedKey);
          return 3 as any;
        }
        return 0 as any;
      }

      throw new Error(`Unexpected Lua script in otpService.test.ts: ${s}`);
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

  it('allows only one request to redeem the correct OTP when synchronized requests race', async () => {
    const otp = '778899';
    await storeHashedOtp(testEmail, otp);

    let gateOpen!: () => void;
    const startGate = new Promise<void>((resolve) => {
      gateOpen = resolve;
    });

    const workers = Array.from({ length: 5 }, async () => {
      await startGate;
      return verifyEnteredOtp(testEmail, otp);
    });
    gateOpen();
    const results = await Promise.all(workers);

    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(4);
    expect(redisStore.has(`otp:${testEmail}`)).toBe(false);
    expect(await isEmailVerified(testEmail)).toBe(true);
  });

  it('prevents an in-flight valid attempt from succeeding once OTP invalidation occurs', async () => {
    const otp = '246810';
    await storeHashedOtp(testEmail, otp);

    const origEval = redisClient.eval.bind(redisClient);
    let releaseValidConsume!: () => void;
    const validConsumeGate = new Promise<void>((resolve) => {
      releaseValidConsume = resolve;
    });
    let pauseNextConsume = true;

    vi.spyOn(redisClient, 'eval').mockImplementation(async (...args: any[]) => {
      const script = String(args[0]);
      if (pauseNextConsume && script.includes("'true'")) {
        pauseNextConsume = false;
        await validConsumeGate;
      }
      return origEval(...(args as [any]));
    });

    const inFlightValid = verifyEnteredOtp(testEmail, otp);
    for (let i = 0; i < 4; i++) {
      const bad = await verifyEnteredOtp(testEmail, '000000');
      expect(bad.success).toBe(false);
    }

    releaseValidConsume();
    const res = await inFlightValid;
    expect(res.success).toBe(false);
    expect(redisStore.has(`otp:${testEmail}`)).toBe(false);
  });

  it('should invalidate OTP after 5 failed attempts even under parallel verification requests', async () => {
    const otp = '778899';
    await storeHashedOtp(testEmail, otp);

    const parallelResults = await Promise.all(
      Array.from({ length: 8 }, () => verifyEnteredOtp(testEmail, '000000'))
    );

    expect(parallelResults.every((r) => !r.success)).toBe(true);
    const invalidated = parallelResults.filter((r) =>
      r.message.includes('Too many incorrect attempts')
    );
    const postInvalidationRejections = parallelResults.filter(
      (r) =>
        r.message.includes('Too many incorrect attempts') ||
        r.message.includes('No active OTP found')
    );
    expect(invalidated.length).toBeGreaterThanOrEqual(1);
    expect(postInvalidationRejections.length).toBeGreaterThanOrEqual(4);
    expect(redisStore.has(`otp:${testEmail}`)).toBe(false);

    const lateValidAttempt = await verifyEnteredOtp(testEmail, otp);
    expect(lateValidAttempt.success).toBe(false);
  });

  it('clears previously verified status when an OTP attempt fails or is consumed', async () => {
    await markEmailVerified(testEmail);
    expect(await isEmailVerified(testEmail)).toBe(true);

    // Failed OTP check (no active OTP / wrong OTP) clears verified_email
    const failed = await verifyEnteredOtp(testEmail, '123456');
    expect(failed.success).toBe(false);
    expect(await isEmailVerified(testEmail)).toBe(false);

    // Explicitly consuming verified status after booking clears it too
    await markEmailVerified(testEmail);
    await consumeVerifiedEmail(testEmail);
    expect(await isEmailVerified(testEmail)).toBe(false);
  });
});
