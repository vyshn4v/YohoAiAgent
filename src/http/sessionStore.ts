import type { BaseMessage } from '@langchain/core/messages';
import type { LeadInfo } from '../agent/state.js';

export interface SessionData {
  messages: BaseMessage[];
  leadInfo: LeadInfo;
  isVerified: boolean;
  updatedAt: number;
}

const MAX_SESSIONS = 500;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const conversationSessions = new Map<string, SessionData>();

function createEmptySession(): SessionData {
  return {
    messages: [],
    leadInfo: {},
    isVerified: false,
    updatedAt: Date.now(),
  };
}

/**
 * Retrieves an active conversation session, refreshing LRU order and evicting expired sessions.
 */
export function getConversationSession(conversationId: string): SessionData {
  const session = conversationSessions.get(conversationId);
  if (!session) {
    return createEmptySession();
  }

  if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
    conversationSessions.delete(conversationId);
    return createEmptySession();
  }

  // Refresh LRU access order
  conversationSessions.delete(conversationId);
  conversationSessions.set(conversationId, session);
  return session;
}

/**
 * Persists updated conversation state with bounded LRU eviction.
 */
export function saveConversationSession(
  conversationId: string,
  messages: BaseMessage[],
  leadInfo: LeadInfo,
  isVerified = false
): void {
  if (conversationSessions.size >= MAX_SESSIONS && !conversationSessions.has(conversationId)) {
    const oldestKey = conversationSessions.keys().next().value;
    if (oldestKey) conversationSessions.delete(oldestKey);
  } else {
    conversationSessions.delete(conversationId);
  }

  conversationSessions.set(conversationId, {
    messages,
    leadInfo,
    isVerified,
    updatedAt: Date.now(),
  });
}

/**
 * Clears all stored sessions (useful in isolated tests).
 */
export function clearConversationSessions(): void {
  conversationSessions.clear();
}
