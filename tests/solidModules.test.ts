import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { redisClient } from '../src/services/redisClient.js';
import {
  buildDecisionInput,
  extractConversationalReply,
  getLastUserMessage,
  parseToolOutput,
} from '../src/agent/utils/messageUtils.js';
import {
  clearConversationSessions,
  getConversationSession,
  saveConversationSession,
  withConversationLock,
} from '../src/http/sessionStore.js';
import {
  buildLeadNotificationEmail,
  buildOtpEmail,
  escapeHtml,
} from '../src/workers/emailTemplates.js';

describe('SOLID Module Unit Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearConversationSessions();
  });

  describe('messageUtils', () => {
    it('extracts plain text from structured reply/message JSON or passes plain text through', () => {
      expect(extractConversationalReply('{"reply":"Hello from Yoho"}')).toBe('Hello from Yoho');
      expect(extractConversationalReply('{"message":"OTP dispatched"}')).toBe('OTP dispatched');
      expect(extractConversationalReply('Plain response text')).toBe('Plain response text');
    });

    it('parses valid tool JSON and falls back cleanly on plain strings', () => {
      expect(parseToolOutput('{"status":"sent"}')).toEqual({ status: 'sent' });
      expect(parseToolOutput('non-json-error')).toEqual({
        status: 'error',
        message: 'non-json-error',
      });
    });

    it('formats contextual decision input only when a prior assistant turn exists', () => {
      expect(buildDecisionInput([new HumanMessage('1+1')], '1+1')).toBe('1+1');

      const contextual = buildDecisionInput(
        [
          new HumanMessage('my email is a@b.com'),
          new AIMessage('Could you please share your name?'),
          new HumanMessage('Alex'),
        ],
        'Alex'
      );
      expect(contextual).toContain('Previous assistant message: "Could you please share your name?"');
      expect(contextual).toContain('Latest user message: "Alex"');
      expect(getLastUserMessage([new HumanMessage('Hi'), new AIMessage('Hey')])).toBe('Hi');
    });
  });

  describe('sessionStore', () => {
    it('persists messages, leadInfo, and isVerified in Redis and reconstructs message instances', async () => {
      const store = new Map<string, string>();
      vi.spyOn(redisClient, 'get').mockImplementation(async (key: any) => store.get(key) ?? null);
      const setSpy = vi
        .spyOn(redisClient, 'set')
        .mockImplementation(async (key: any, val: any) => {
          store.set(key, String(val));
          return 'OK' as any;
        });

      const initial = await getConversationSession('sess-1');
      expect(initial.messages).toEqual([]);
      expect(initial.isVerified).toBe(false);

      await saveConversationSession(
        'sess-1',
        [new HumanMessage('hi'), new AIMessage('hello')],
        { name: 'Alice', email: 'alice@example.com' },
        true
      );

      expect(setSpy).toHaveBeenCalledWith('session:sess-1', expect.any(String), 'EX', 86400);

      const loaded = await getConversationSession('sess-1');
      expect(loaded.messages).toHaveLength(2);
      expect(loaded.messages[0]).toBeInstanceOf(HumanMessage);
      expect(loaded.messages[1]).toBeInstanceOf(AIMessage);
      expect(loaded.leadInfo.name).toBe('Alice');
      expect(loaded.isVerified).toBe(true);
    });

    it('falls back safely to in-memory storage when Redis errors', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(redisClient, 'get').mockRejectedValue(new Error('Redis down'));
      vi.spyOn(redisClient, 'set').mockRejectedValue(new Error('Redis down'));

      await saveConversationSession(
        'sess-fallback',
        [new HumanMessage('hi')],
        { name: 'Bob' },
        false
      );

      const loaded = await getConversationSession('sess-fallback');
      expect(loaded.messages).toHaveLength(1);
      expect(loaded.leadInfo.name).toBe('Bob');
    });

    it('serializes concurrent turns for the same conversationId with Redis lock and Lua release', async () => {
      const redisMap = new Map<string, string>();
      vi.spyOn(redisClient, 'get').mockImplementation(async (key: any) => redisMap.get(key) ?? null);
      vi.spyOn(redisClient, 'set').mockImplementation(async (key: any, val: any, ...args: any[]) => {
        if (args.includes('NX')) {
          if (redisMap.has(key)) return null;
          redisMap.set(key, String(val));
          return 'OK' as any;
        }
        redisMap.set(key, String(val));
        return 'OK' as any;
      });
      const evalSpy = vi
        .spyOn(redisClient, 'eval')
        .mockImplementation(async (_script: any, _numKeys: any, key: any, token: any) => {
          if (redisMap.get(key) === token) {
            redisMap.delete(key);
            return 1 as any;
          }
          return 0 as any;
        });

      const order: string[] = [];
      await Promise.all([
        withConversationLock('conv-lock', async () => {
          order.push('t1-start');
          await new Promise((r) => setTimeout(r, 30));
          await saveConversationSession('conv-lock', [new HumanMessage('turn-1')], { name: 'A' });
          order.push('t1-end');
        }),
        withConversationLock('conv-lock', async () => {
          order.push('t2-start');
          const session = await getConversationSession('conv-lock');
          expect(session.messages).toHaveLength(1);
          expect(session.messages[0].content).toBe('turn-1');
          order.push('t2-end');
        }),
      ]);

      expect(order).toEqual(['t1-start', 't1-end', 't2-start', 't2-end']);
      expect(evalSpy).toHaveBeenCalledTimes(2);
      expect(redisMap.has('session_lock:conv-lock')).toBe(false);
    });

    it('falls back to local lock serialization when Redis lock throws', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(redisClient, 'set').mockRejectedValue(new Error('Redis offline'));

      const order: string[] = [];
      await Promise.all([
        withConversationLock('conv-local-lock', async () => {
          order.push('first-in');
          await new Promise((r) => setTimeout(r, 25));
          order.push('first-out');
        }),
        withConversationLock('conv-local-lock', async () => {
          order.push('second-in');
          order.push('second-out');
        }),
      ]);

      expect(order).toEqual(['first-in', 'first-out', 'second-in', 'second-out']);
    });
  });

  describe('emailTemplates (OWASP HTML escaping)', () => {
    it('escapes HTML tags in OTP and lead notification emails', () => {
      expect(escapeHtml('<script>alert(1)</script>')).toBe(
        '&lt;script&gt;alert(1)&lt;/script&gt;'
      );

      const otpMail = buildOtpEmail({ name: '<b>Alice</b>', otp: '123456' });
      expect(otpMail.html).toContain('Hello &lt;b&gt;Alice&lt;/b&gt;,');
      expect(otpMail.html).not.toContain('<b>Alice</b>');

      const leadMail = buildLeadNotificationEmail({
        name: '<img src=x onerror=alert(1)>',
        email: 'a@b.com',
        phone: '123',
        reason: 'Discuss <AI>',
      });
      expect(leadMail.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(leadMail.html).toContain('Discuss &lt;AI&gt;');
      expect(leadMail.html).not.toContain('<img');
    });
  });
});
