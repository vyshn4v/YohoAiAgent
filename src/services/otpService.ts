import crypto from 'crypto';
import { redisClient } from './redisClient.js';

const OTP_SECRET =
  process.env.OTP_SECRET ||
  (process.env.NODE_ENV === 'production'
    ? (() => {
        throw new Error('FATAL: OTP_SECRET environment variable must be set in production.');
      })()
    : 'agent_otp_secure_salt_key_2026');
const OTP_TTL_SECONDS = 300; // 5 minutes
const VERIFIED_TTL_SECONDS = 3600; // 1 hour
const MAX_ATTEMPTS = 5;

/**
 * Generates a cryptographically secure 6-digit numeric OTP.
 */
export function generateOtp(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Encrypts/hashes the OTP using HMAC-SHA256 with email-specific salt.
 */
export function hashOtp(email: string, otp: string): string {
  const normalizedEmail = email.toLowerCase().trim();
  return crypto
    .createHmac('sha256', OTP_SECRET)
    .update(`${normalizedEmail}:${otp}`)
    .digest('hex');
}

/**
 * Stores the hashed OTP in Redis with TTL and resets attempt counter.
 */
export async function storeHashedOtp(email: string, otp: string): Promise<string> {
  const normalizedEmail = email.toLowerCase().trim();
  const hashed = hashOtp(normalizedEmail, otp);
  const otpKey = `otp:${normalizedEmail}`;
  const attemptsKey = `otp_attempts:${normalizedEmail}`;
  const verifiedKey = `verified_email:${normalizedEmail}`;

  await redisClient.set(otpKey, hashed, 'EX', OTP_TTL_SECONDS);
  await redisClient.set(attemptsKey, '0', 'EX', OTP_TTL_SECONDS);
  await redisClient.del(verifiedKey); // Invalidate any previous verification until new OTP is verified

  return hashed;
}

/**
 * Compares user-entered OTP against the encrypted/hashed form in Redis.
 */
export async function verifyEnteredOtp(
  email: string,
  enteredOtp: string
): Promise<{ success: boolean; message: string }> {
  const normalizedEmail = email.toLowerCase().trim();
  const otpKey = `otp:${normalizedEmail}`;
  const attemptsKey = `otp_attempts:${normalizedEmail}`;
  const verifiedKey = `verified_email:${normalizedEmail}`;

  const storedHash = await redisClient.get(otpKey);
  if (!storedHash) {
    await redisClient.del(verifiedKey);
    return {
      success: false,
      message: 'No active OTP found or it has expired. Please request a new verification code.',
    };
  }

  // Increment attempt counter atomically before hash comparison to prevent parallel brute-force races
  const attempts = await redisClient.incr(attemptsKey);
  if (attempts > MAX_ATTEMPTS) {
    await redisClient.del(otpKey);
    await redisClient.del(attemptsKey);
    await redisClient.del(verifiedKey);
    return {
      success: false,
      message: 'Too many incorrect attempts. For security, your OTP was invalidated. Please request a new code.',
    };
  }

  const enteredHash = hashOtp(normalizedEmail, enteredOtp.trim());

  // Constant-time comparison
  const storedBuf = Buffer.from(storedHash, 'hex');
  const enteredBuf = Buffer.from(enteredHash, 'hex');

  const isMatch =
    storedBuf.length === enteredBuf.length &&
    crypto.timingSafeEqual(storedBuf, enteredBuf);

  if (!isMatch) {
    await redisClient.del(verifiedKey);
    const remaining = MAX_ATTEMPTS - attempts;
    if (remaining <= 0) {
      await redisClient.del(otpKey);
      await redisClient.del(attemptsKey);
      return {
        success: false,
        message: 'Too many incorrect attempts. For security, your OTP was invalidated. Please request a new code.',
      };
    }
    return {
      success: false,
      message: `Invalid code. ${remaining} attempt(s) remaining.`,
    };
  }

  // Valid OTP: delete OTP keys and set verified email status
  await redisClient.del(otpKey);
  await redisClient.del(attemptsKey);
  await redisClient.set(verifiedKey, 'true', 'EX', VERIFIED_TTL_SECONDS);

  return {
    success: true,
    message: 'Email successfully verified! You may now finalize your meeting enquiry.',
  };
}

/**
 * Checks if an active (unexpired) OTP currently exists for this email.
 */
export async function hasActiveOtp(email: string): Promise<boolean> {
  try {
    const normalizedEmail = email.toLowerCase().trim();
    const val = await redisClient.get(`otp:${normalizedEmail}`);
    return Boolean(val);
  } catch {
    return false;
  }
}

/**
 * Checks if an email has already been verified in Redis.
 */
export async function isEmailVerified(email: string): Promise<boolean> {
  const normalizedEmail = email.toLowerCase().trim();
  const val = await redisClient.get(`verified_email:${normalizedEmail}`);
  return val === 'true';
}

/**
 * Clears verified status once a booking completes so OTP verification stays single-use.
 */
export async function consumeVerifiedEmail(email: string): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();
  await redisClient.del(`verified_email:${normalizedEmail}`);
}

/**
 * Helper to manually mark email as verified (e.g. for testing / mocking).
 */
export async function markEmailVerified(email: string): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();
  await redisClient.set(`verified_email:${normalizedEmail}`, 'true', 'EX', VERIFIED_TTL_SECONDS);
}
