import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';
import { AIMessage, BaseMessage, HumanMessage } from '@langchain/core/messages';
import type { LeadInfo } from '../agent/state.js';
import { redisClient } from '../services/redisClient.js';
import { createNodeLogger, formatErrorDetails } from '../utils/nodeLogger.js';

export const LOCK_TTL_MS = 60_000;
const LOCK_WAIT_TIMEOUT_MS = 30_000;
const LOCK_RETRY_DELAY_MS = 50;

const ACQUIRE_LOCK_LUA = `
  if redis.call('set', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[2]), 'NX') then
    return redis.call('incr', KEYS[2])
  end
  return nil
`;

const RENEW_LOCK_LUA = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('pexpire', KEYS[1], tonumber(ARGV[2]))
  end
  return 0
`;

// Atomically enforce both lock ownership and monotonic fencing on session commit
const SAVE_SESSION_FENCED_LUA = `
  if redis.call('get', KEYS[2]) ~= ARGV[3] then
    return -1
  end
  local incomingFence = tonumber(ARGV[4])
  local savedFence = tonumber(redis.call('get', KEYS[3]) or '0')
  if savedFence > incomingFence then
    return -2
  end
  redis.call('set', KEYS[3], tostring(incomingFence), 'EX', tonumber(ARGV[2]))
  redis.call('set', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
  return 1
`;

const RELEASE_LOCK_LUA = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  else
    return 0
  end
`;

interface ActiveLockLease {
  conversationId: string;
  lockToken: string;
  fence: number;
  isLost: () => boolean;
}

export class StaleSessionLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleSessionLockError';
  }
}

const localLocks = new Map<string, Promise<void>>();
const leaseStorage = new AsyncLocalStorage<ActiveLockLease>();

export interface SessionData {
  messages: BaseMessage[];
  leadInfo: LeadInfo;
  isVerified: boolean;
  updatedAt: number;
}

interface StoredMessage {
  role: 'human' | 'ai';
  content: string;
}

interface StoredSessionPayload {
  messages: StoredMessage[];
  leadInfo: LeadInfo;
  isVerified: boolean;
  updatedAt: number;
}

interface FallbackSessionEntry {
  data: SessionData;
  pendingRedisSync: boolean;
}

const MAX_FALLBACK_SESSIONS = 500;
const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const fallbackSessions = new Map<string, FallbackSessionEntry>();

function sessionRedisKey(conversationId: string): string {
  return `session:${conversationId}`;
}

function sessionLockKey(conversationId: string): string {
  return `session_lock:${conversationId}`;
}

function sessionFenceKey(conversationId: string): string {
  return `session_fence:${conversationId}`;
}

function sessionSavedFenceKey(conversationId: string): string {
  return `session_saved_fence:${conversationId}`;
}

function createEmptySession(): SessionData {
  return {
    messages: [],
    leadInfo: {},
    isVerified: false,
    updatedAt: Date.now(),
  };
}

function serializeMessages(messages: BaseMessage[]): StoredMessage[] {
  return messages.map((m) => ({
    role: m._getType() === 'human' ? 'human' : 'ai',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }));
}

function deserializeMessages(stored: StoredMessage[] = []): BaseMessage[] {
  return stored.map((m) =>
    m.role === 'human' ? new HumanMessage(m.content) : new AIMessage(m.content)
  );
}

function getFallbackEntry(conversationId: string): FallbackSessionEntry | null {
  const entry = fallbackSessions.get(conversationId);
  if (!entry) return null;

  if (Date.now() - entry.data.updatedAt > SESSION_TTL_MS) {
    fallbackSessions.delete(conversationId);
    return null;
  }

  fallbackSessions.delete(conversationId);
  fallbackSessions.set(conversationId, entry);
  return entry;
}

function getFallbackSession(conversationId: string): SessionData {
  const entry = getFallbackEntry(conversationId);
  return entry ? entry.data : createEmptySession();
}

function saveFallbackSession(
  conversationId: string,
  data: SessionData,
  pendingRedisSync = true
): void {
  if (fallbackSessions.size >= MAX_FALLBACK_SESSIONS && !fallbackSessions.has(conversationId)) {
    const oldest = fallbackSessions.keys().next();
    if (!oldest.done) fallbackSessions.delete(oldest.value);
  } else {
    fallbackSessions.delete(conversationId);
  }
  fallbackSessions.set(conversationId, { data, pendingRedisSync });
}

function reconcileWithPendingFallback(
  conversationId: string,
  redisSession: SessionData | null
): SessionData {
  const pendingEntry = getFallbackEntry(conversationId);
  if (!pendingEntry || !pendingEntry.pendingRedisSync) {
    return redisSession ?? createEmptySession();
  }

  const localSession = pendingEntry.data;
  if (!redisSession) {
    return localSession;
  }

  const localIsNewer =
    localSession.updatedAt > redisSession.updatedAt ||
    (localSession.updatedAt === redisSession.updatedAt &&
      localSession.messages.length >= redisSession.messages.length);

  if (localIsNewer) {
    return localSession;
  }

  fallbackSessions.delete(conversationId);
  return redisSession;
}

/**
 * Retrieves an active conversation session from Redis and reconciles any pending local fallback write.
 */
export async function getConversationSession(conversationId: string): Promise<SessionData> {
  if (redisClient.status !== 'end') {
    try {
      const raw = await redisClient.get(sessionRedisKey(conversationId));
      let redisSession: SessionData | null = null;
      if (raw) {
        const parsed = JSON.parse(raw) as StoredSessionPayload;
        redisSession = {
          messages: deserializeMessages(parsed.messages),
          leadInfo: parsed.leadInfo || {},
          isVerified: Boolean(parsed.isVerified),
          updatedAt: parsed.updatedAt || Date.now(),
        };
      }
      return reconcileWithPendingFallback(conversationId, redisSession);
    } catch (err) {
      createNodeLogger('SessionStore', conversationId).warn(
        'Redis session read failed; using in-memory fallback',
        { error: formatErrorDetails(err) }
      );
    }
  }

  return getFallbackSession(conversationId);
}

/**
 * Persists conversation state in Redis with atomic lock/fencing verification (and memory fallback on Redis I/O failure).
 */
export async function saveConversationSession(
  conversationId: string,
  messages: BaseMessage[],
  leadInfo: LeadInfo,
  isVerified = false
): Promise<void> {
  const updatedAt = Date.now();
  const sessionData: SessionData = { messages, leadInfo, isVerified, updatedAt };
  const activeLease = leaseStorage.getStore();

  if (activeLease && activeLease.conversationId === conversationId && activeLease.isLost()) {
    throw new StaleSessionLockError('Lost conversation lock lease before saving session.');
  }

  if (redisClient.status !== 'end') {
    try {
      const payload: StoredSessionPayload = {
        messages: serializeMessages(messages),
        leadInfo,
        isVerified,
        updatedAt,
      };
      const serialized = JSON.stringify(payload);

      if (activeLease && activeLease.conversationId === conversationId) {
        const commitResult = await redisClient.eval(
          SAVE_SESSION_FENCED_LUA,
          3,
          sessionRedisKey(conversationId),
          sessionLockKey(conversationId),
          sessionSavedFenceKey(conversationId),
          serialized,
          String(SESSION_TTL_SECONDS),
          activeLease.lockToken,
          String(activeLease.fence)
        );
        if (Number(commitResult) === -1) {
          throw new StaleSessionLockError('Conversation lock expired or was claimed by another turn.');
        }
        if (Number(commitResult) === -2) {
          throw new StaleSessionLockError('Stale session write rejected by monotonic fencing token.');
        }
      } else {
        await redisClient.set(
          sessionRedisKey(conversationId),
          serialized,
          'EX',
          SESSION_TTL_SECONDS
        );
      }

      // Clear local snapshot only after Redis commit succeeds and only if not superseded by a newer local write
      const localEntry = fallbackSessions.get(conversationId);
      if (localEntry && localEntry.data.updatedAt <= updatedAt) {
        fallbackSessions.delete(conversationId);
      }
      return;
    } catch (err) {
      if (err instanceof StaleSessionLockError) {
        throw err;
      }
      createNodeLogger('SessionStore', conversationId).warn(
        'Redis session write failed; kept in-memory copy',
        { error: formatErrorDetails(err) }
      );
    }
  }

  saveFallbackSession(conversationId, sessionData, true);
}

/**
 * Clears in-memory fallback sessions (useful in isolated tests).
 */
export function clearConversationSessions(): void {
  fallbackSessions.clear();
  localLocks.clear();
}

async function acquireRedisLock(
  conversationId: string,
  lockToken: string,
  lockTtlMs = LOCK_TTL_MS
): Promise<number | null> {
  if (redisClient.status === 'end') return null;

  const lockKey = sessionLockKey(conversationId);
  const fenceKey = sessionFenceKey(conversationId);
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

  while (true) {
    try {
      const fence = await redisClient.eval(
        ACQUIRE_LOCK_LUA,
        2,
        lockKey,
        fenceKey,
        lockToken,
        String(lockTtlMs)
      );
      if (fence !== null && fence !== undefined) {
        return Number(fence);
      }
    } catch (err) {
      createNodeLogger('SessionStore', conversationId).warn(
        'Redis lock unavailable; aborting turn because local-only lock cannot serialize across replicas',
        { error: formatErrorDetails(err) }
      );
      // shortcut: single-node Redis lock fails closed because process-local fallback cannot serialize turns across replicas; upgrade to a shared consensus lock that fails closed before running multiple replicas
      return null;
    }

    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for conversation lock.');
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
  }
}

async function releaseRedisLock(conversationId: string, lockToken: string): Promise<void> {
  if (redisClient.status === 'end') return;
  try {
    await redisClient.eval(RELEASE_LOCK_LUA, 1, sessionLockKey(conversationId), lockToken);
  } catch (err) {
    createNodeLogger('SessionStore', conversationId).warn(
      'Redis lock release failed (will expire via TTL)',
      { error: formatErrorDetails(err) }
    );
  }
}

export interface ConversationLockOptions {
  lockTtlMs?: number;
  renewIntervalMs?: number;
}

/**
 * Serializes turns sharing a conversationId across Redis instances with lease renewal and atomic save fencing.
 */
export async function withConversationLock<T>(
  conversationId: string,
  fn: () => Promise<T>,
  options: ConversationLockOptions = {}
): Promise<T> {
  const prevLock = localLocks.get(conversationId) || Promise.resolve();
  let releaseLocal!: () => void;
  const currentLock = new Promise<void>((resolve) => {
    releaseLocal = resolve;
  });
  const chained = prevLock.then(() => currentLock);
  localLocks.set(conversationId, chained);

  await prevLock;
  const lockToken = crypto.randomUUID();
  const lockTtlMs = options.lockTtlMs ?? LOCK_TTL_MS;
  const renewIntervalMs = options.renewIntervalMs ?? Math.max(50, Math.floor(lockTtlMs / 3));

  let fence: number | null = null;
  let leaseLost = false;
  let renewTimer: NodeJS.Timeout | undefined;

  try {
    fence = await acquireRedisLock(conversationId, lockToken, lockTtlMs);
    if (fence === null) {
      throw new Error('Failed to acquire distributed conversation lock.');
    }

    let lastRenewedAt = Date.now();
    renewTimer = setInterval(async () => {
      if (leaseLost || redisClient.status === 'end') return;
      try {
        const renewed = await redisClient.eval(
          RENEW_LOCK_LUA,
          1,
          sessionLockKey(conversationId),
          lockToken,
          String(lockTtlMs)
        );
        if (Number(renewed) === 1) {
          lastRenewedAt = Date.now();
        } else {
          leaseLost = true;
          if (renewTimer) clearInterval(renewTimer);
        }
      } catch (err) {
        if (Date.now() - lastRenewedAt >= lockTtlMs) {
          leaseLost = true;
        }
        createNodeLogger('SessionStore', conversationId).warn('Redis lock renewal failed', {
          error: formatErrorDetails(err),
        });
      }
    }, renewIntervalMs);
    renewTimer.unref();

    return await leaseStorage.run(
      { conversationId, lockToken, fence, isLost: () => leaseLost },
      fn
    );
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    if (fence !== null && !leaseLost) {
      await releaseRedisLock(conversationId, lockToken);
    }
    releaseLocal();
    if (localLocks.get(conversationId) === chained) {
      localLocks.delete(conversationId);
    }
  }
}
