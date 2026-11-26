import { AIMessage, BaseMessage, HumanMessage } from '@langchain/core/messages';
import type { LeadInfo } from '../agent/state.js';
import { redisClient } from '../services/redisClient.js';
import { createNodeLogger, formatErrorDetails } from '../utils/nodeLogger.js';

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
}
