import crypto from 'crypto';
import { AIMessage, BaseMessage, HumanMessage } from '@langchain/core/messages';
import type { LeadInfo } from '../agent/state.js';
import { redisClient } from '../services/redisClient.js';
import { createNodeLogger, formatErrorDetails } from '../utils/nodeLogger.js';

const LOCK_TTL_MS = 60_000;
const LOCK_WAIT_TIMEOUT_MS = 30_000;
const LOCK_RETRY_DELAY_MS = 50;
const RELEASE_LOCK_LUA = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  else
    return 0
  end
`;
const localLocks = new Map<string, Promise<void>>();

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

const MAX_FALLBACK_SESSIONS = 500;
const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const fallbackSessions = new Map<string, SessionData>();

function sessionRedisKey(conversationId: string): string {
  return `session:${conversationId}`;
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

function getFallbackSession(conversationId: string): SessionData {
  const session = fallbackSessions.get(conversationId);
  if (!session) return createEmptySession();

  if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
    fallbackSessions.delete(conversationId);
    return createEmptySession();
  }

  fallbackSessions.delete(conversationId);
  fallbackSessions.set(conversationId, session);
  return session;
}

function saveFallbackSession(conversationId: string, data: SessionData): void {
  if (fallbackSessions.size >= MAX_FALLBACK_SESSIONS && !fallbackSessions.has(conversationId)) {
    const oldestKey = fallbackSessions.keys().next().value;
    if (oldestKey) fallbackSessions.delete(oldestKey);
  } else {
    fallbackSessions.delete(conversationId);
  }
  fallbackSessions.set(conversationId, data);
}

/**
 * Retrieves an active conversation session from Redis, falling back to a bounded
 * local Map only when Redis is unreachable.
 */
export async function getConversationSession(conversationId: string): Promise<SessionData> {
  if (redisClient.status !== 'end') {
    try {
      const raw = await redisClient.get(sessionRedisKey(conversationId));
      if (!raw) {
        return createEmptySession();
      }
      const parsed = JSON.parse(raw) as StoredSessionPayload;
      return {
        messages: deserializeMessages(parsed.messages),
        leadInfo: parsed.leadInfo || {},
        isVerified: Boolean(parsed.isVerified),
        updatedAt: parsed.updatedAt || Date.now(),
      };
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
 * Persists conversation state in Redis with a 24-hour TTL (with bounded memory fallback on error).
 */
export async function saveConversationSession(
  conversationId: string,
  messages: BaseMessage[],
  leadInfo: LeadInfo,
  isVerified = false
): Promise<void> {
  const updatedAt = Date.now();
  const sessionData: SessionData = { messages, leadInfo, isVerified, updatedAt };

  if (redisClient.status !== 'end') {
    try {
      const payload: StoredSessionPayload = {
        messages: serializeMessages(messages),
        leadInfo,
        isVerified,
        updatedAt,
      };
      await redisClient.set(
        sessionRedisKey(conversationId),
        JSON.stringify(payload),
        'EX',
        SESSION_TTL_SECONDS
      );
      return;
    } catch (err) {
      createNodeLogger('SessionStore', conversationId).warn(
        'Redis session write failed; kept in-memory copy',
        { error: formatErrorDetails(err) }
      );
    }
  }

  saveFallbackSession(conversationId, sessionData);
}

/**
 * Clears in-memory fallback sessions (useful in isolated tests).
 */
export function clearConversationSessions(): void {
  fallbackSessions.clear();
  localLocks.clear();
}

async function acquireRedisLock(conversationId: string, lockToken: string): Promise<boolean> {
  if (redisClient.status === 'end') return false;

  const key = `session_lock:${conversationId}`;
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

  while (true) {
    try {
      const result = await redisClient.set(key, lockToken, 'PX', LOCK_TTL_MS, 'NX');
      if (result === 'OK') return true;
    } catch (err) {
      createNodeLogger('SessionStore', conversationId).warn(
        'Redis lock unavailable; using local lock fallback',
        { error: formatErrorDetails(err) }
      );
      return false;
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
    await redisClient.eval(RELEASE_LOCK_LUA, 1, `session_lock:${conversationId}`, lockToken);
  } catch (err) {
    createNodeLogger('SessionStore', conversationId).warn(
      'Redis lock release failed (will expire via TTL)',
      { error: formatErrorDetails(err) }
    );
  }
}

/**
 * Serializes turns sharing a conversationId across local async handlers and Redis instances.
 */
export async function withConversationLock<T>(
  conversationId: string,
  fn: () => Promise<T>
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
  let redisLockAcquired = false;

  try {
    redisLockAcquired = await acquireRedisLock(conversationId, lockToken);
    return await fn();
  } finally {
    if (redisLockAcquired) {
      await releaseRedisLock(conversationId, lockToken);
    }
    releaseLocal();
    if (localLocks.get(conversationId) === chained) {
      localLocks.delete(conversationId);
    }
  }
}
