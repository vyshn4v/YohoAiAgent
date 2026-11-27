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
const RECENT_CONSUMED_TTL_SECONDS = 10; // Grace window so concurrent replay does not wipe verified status
const MAX_ATTEMPTS = 5;

// Atomically read active challenge hash and increment attempts so invalidated challenges cannot proceed
const VERIFY_OTP_STATE_LUA = `
  local storedHash = redis.call('get', KEYS[1])
  if not storedHash then
    local recentlyVerified = redis.call('get', KEYS[5]) or ''
    return { 'MISSING', recentlyVerified, '0' }
  end
  local attempts = redis.call('incr', KEYS[2])
  if attempts == 1 then
    local ttl = redis.call('pttl', KEYS[1])
    if ttl > 0 then
      redis.call('pexpire', KEYS[2], ttl)
    end
  end
  if attempts > tonumber(ARGV[1]) then
    redis.call('del', KEYS[1], KEYS[2], KEYS[3], KEYS[4])
    return { 'EXHAUSTED', '', tostring(attempts) }
  end
  return { 'ACTIVE', storedHash, tostring(attempts) }
`;

// Atomically consume an active OTP only if its hash still matches the checked challenge
const CONSUME_OTP_LUA = `
  if redis.call('get', KEYS[1]) ~= ARGV[1] then
    return 0
  end
  redis.call('del', KEYS[1], KEYS[2], KEYS[4])
  redis.call('set', KEYS[3], 'true', 'EX', tonumber(ARGV[2]))
  redis.call('set', KEYS[5], ARGV[1], 'EX', tonumber(ARGV[3]))
  return 1
`;

// Clear verified/challenge keys on wrong OTP only while the same challenge remains active
const FAIL_OTP_ATTEMPT_LUA = `
  if redis.call('get', KEYS[1]) ~= ARGV[1] then
    return 0
  end
  redis.call('del', KEYS[3])
  if ARGV[2] == '1' then
    redis.call('del', KEYS[1], KEYS[2], KEYS[4])
  end
  return 1
`;

const ROLLBACK_OTP_LUA = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1], KEYS[2], KEYS[3])
  end
  return 0
`;

function otpRedisKeys(email: string) {
  const normalizedEmail = email.toLowerCase().trim();
  return {
    normalizedEmail,
    otpKey: `otp:${normalizedEmail}`,
    attemptsKey: `otp_attempts:${normalizedEmail}`,
    verifiedKey: `verified_email:${normalizedEmail}`,
    dispatchedKey: `otp_dispatched:${normalizedEmail}`,
    recentlyVerifiedKey: `otp_recent:${normalizedEmail}`,
  };
}

function hashesMatchConstantTime(expectedHex: string, actualHex: string): boolean {
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const actualBuf = Buffer.from(actualHex, 'hex');
  return expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);
}

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
 * Stores the hashed OTP in Redis with TTL and resets attempt counter and prior dispatch/verification markers.
 */
export async function storeHashedOtp(email: string, otp: string): Promise<string> {
  const { normalizedEmail, otpKey, attemptsKey, verifiedKey, dispatchedKey, recentlyVerifiedKey } =
    otpRedisKeys(email);
  const hashed = hashOtp(normalizedEmail, otp);

  await redisClient.set(otpKey, hashed, 'EX', OTP_TTL_SECONDS);
  await redisClient.set(attemptsKey, '0', 'EX', OTP_TTL_SECONDS);
  await redisClient.del(verifiedKey);
  await redisClient.del(dispatchedKey);
  await redisClient.del(recentlyVerifiedKey);

  return hashed;
}

/**
 * Records that a specific OTP challenge hash was successfully queued for email delivery.
 */
export async function markOtpDispatched(email: string, hashedOtp: string): Promise<void> {
  const { dispatchedKey } = otpRedisKeys(email);
  await redisClient.set(dispatchedKey, hashedOtp, 'EX', OTP_TTL_SECONDS);
}

/**
 * Removes an unsent OTP challenge only if it still holds the failed dispatch's hash.
 */
export async function rollbackOtpChallenge(email: string, hashedOtp: string): Promise<void> {
  const { otpKey, attemptsKey, dispatchedKey } = otpRedisKeys(email);
  await redisClient.eval(ROLLBACK_OTP_LUA, 3, otpKey, attemptsKey, dispatchedKey, hashedOtp);
}

/**
 * Compares user-entered OTP against the encrypted/hashed form in Redis using atomic state/attempt transitions.
 */
export async function verifyEnteredOtp(
  email: string,
  enteredOtp: string
): Promise<{ success: boolean; message: string }> {
  const {
    normalizedEmail,
    otpKey,
    attemptsKey,
    verifiedKey,
    dispatchedKey,
    recentlyVerifiedKey,
  } = otpRedisKeys(email);

  const [state, storedHashOrRecent, attemptsRaw] = (await redisClient.eval(
    VERIFY_OTP_STATE_LUA,
    5,
    otpKey,
    attemptsKey,
    verifiedKey,
    dispatchedKey,
    recentlyVerifiedKey,
    String(MAX_ATTEMPTS)
  )) as [string, string, string];

  const enteredHash = hashOtp(normalizedEmail, enteredOtp.trim());

  if (state === 'MISSING') {
    const isRecentSameCode =
      Boolean(storedHashOrRecent) && hashesMatchConstantTime(storedHashOrRecent, enteredHash);
    if (!isRecentSameCode) {
      await redisClient.del(verifiedKey);
    }
    return {
      success: false,
      message: 'No active OTP found or it has expired. Please request a new verification code.',
    };
  }

  if (state === 'EXHAUSTED') {
    return {
      success: false,
      message: 'Too many incorrect attempts. For security, your OTP was invalidated. Please request a new code.',
    };
  }

  const storedHash = storedHashOrRecent;
  const attempts = Number(attemptsRaw);
  const isMatch = hashesMatchConstantTime(storedHash, enteredHash);

  if (!isMatch) {
    const exhausted = attempts >= MAX_ATTEMPTS;
    await redisClient.eval(
      FAIL_OTP_ATTEMPT_LUA,
      4,
      otpKey,
      attemptsKey,
      verifiedKey,
      dispatchedKey,
      storedHash,
      exhausted ? '1' : '0'
    );

    const remaining = MAX_ATTEMPTS - attempts;
    if (remaining <= 0) {
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

  const consumed = await redisClient.eval(
    CONSUME_OTP_LUA,
    5,
    otpKey,
    attemptsKey,
    verifiedKey,
    dispatchedKey,
    recentlyVerifiedKey,
    storedHash,
    String(VERIFIED_TTL_SECONDS),
    String(RECENT_CONSUMED_TTL_SECONDS)
  );

  if (Number(consumed) !== 1) {
    return {
      success: false,
      message: 'No active OTP found or it has expired. Please request a new verification code.',
    };
  }

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
    const { otpKey } = otpRedisKeys(email);
    const val = await redisClient.get(otpKey);
    return Boolean(val);
  } catch {
    return false;
  }
}

/**
 * Checks if an active OTP exists AND its current hash was successfully dispatched.
 */
export async function hasDispatchedOtp(email: string): Promise<boolean> {
  try {
    const { otpKey, dispatchedKey } = otpRedisKeys(email);
    const [otpHash, dispatchedHash] = await Promise.all([
      redisClient.get(otpKey),
      redisClient.get(dispatchedKey),
    ]);
    return Boolean(otpHash && dispatchedHash && otpHash === dispatchedHash);
  } catch {
    return false;
  }
}

/**
 * Checks if an email has already been verified in Redis.
 */
export async function isEmailVerified(email: string): Promise<boolean> {
  const { verifiedKey } = otpRedisKeys(email);
  const val = await redisClient.get(verifiedKey);
  return val === 'true';
}

/**
 * Clears verified status once a booking completes so OTP verification stays single-use.
 */
export async function consumeVerifiedEmail(email: string): Promise<void> {
  const { verifiedKey, recentlyVerifiedKey } = otpRedisKeys(email);
  await redisClient.del(verifiedKey);
  await redisClient.del(recentlyVerifiedKey);
}

/**
 * Helper to manually mark email as verified (e.g. for testing / mocking).
 */
export async function markEmailVerified(email: string): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();
  await redisClient.set(`verified_email:${normalizedEmail}`, 'true', 'EX', VERIFIED_TTL_SECONDS);
}
