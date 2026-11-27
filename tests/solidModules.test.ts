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
  StaleSessionLockError,
  withConversationLock,
} from '../src/http/sessionStore.js';
import {
  buildLeadNotificationEmail,
  buildOtpEmail,
  escapeHtml,
} from '../src/workers/emailTemplates.js';

function createStatefulRedisMock() {
  const store = new Map<string, string>();
  const expiresAt = new Map<string, number>();

  const readKey = (key: string): string | null => {
    const exp = expiresAt.get(key);
    if (exp !== undefined && exp <= Date.now()) {
      store.delete(key);
      expiresAt.delete(key);
      return null;
    }
    return store.get(key) ?? null;
  };

  const getSpy = vi.spyOn(redisClient, 'get').mockImplementation(async (key: any) => readKey(String(key)));
  const setSpy = vi
    .spyOn(redisClient, 'set')
    .mockImplementation(async (key: any, val: any, ...args: any[]) => {
      const k = String(key);
      const pxIdx = args.indexOf('PX');
      const exIdx = args.indexOf('EX');
      if (args.includes('NX') && readKey(k) !== null) {
        return null as any;
      }
      store.set(k, String(val));
      if (pxIdx !== -1) expiresAt.set(k, Date.now() + Number(args[pxIdx + 1]));
      else if (exIdx !== -1) expiresAt.set(k, Date.now() + Number(args[exIdx + 1]) * 1000);
      else expiresAt.delete(k);
      return 'OK' as any;
    });

  const evalSpy = vi
    .spyOn(redisClient, 'eval')
    .mockImplementation(async (script: any, numKeys: any, ...rest: any[]) => {
      const s = String(script);
      const keyCount = Number(numKeys);
      const keys = rest.slice(0, keyCount).map(String);
      const args = rest.slice(keyCount).map(String);

      if (s.includes("'NX'") && s.includes('incr')) {
        const [lockKey, fenceKey] = keys;
        const [lockToken, ttlMs] = args;
        if (readKey(lockKey) !== null) return null as any;
        store.set(lockKey, lockToken);
        expiresAt.set(lockKey, Date.now() + Number(ttlMs));
        const fence = Number(store.get(fenceKey) || '0') + 1;
        store.set(fenceKey, String(fence));
        return fence as any;
      }

      if (s.includes('pexpire')) {
        const [lockKey] = keys;
        const [lockToken, ttlMs] = args;
        if (readKey(lockKey) !== lockToken) return 0 as any;
        expiresAt.set(lockKey, Date.now() + Number(ttlMs));
        return 1 as any;
      }

      if (s.includes('-2')) {
        const [sessionKey, lockKey, savedFenceKey] = keys;
        const [payload, ttlSeconds, lockToken, fence] = args;
        if (readKey(lockKey) !== lockToken) return -1 as any;
        const savedFence = Number(readKey(savedFenceKey) || '0');
        const incomingFence = Number(fence);
        if (savedFence > incomingFence) return -2 as any;
        store.set(savedFenceKey, String(incomingFence));
        store.set(sessionKey, payload);
        expiresAt.set(sessionKey, Date.now() + Number(ttlSeconds) * 1000);
        return 1 as any;
      }

      if (s.includes('del')) {
        const [lockKey] = keys;
        const [lockToken] = args;
        if (readKey(lockKey) === lockToken) {
          store.delete(lockKey);
          expiresAt.delete(lockKey);
          return 1 as any;
        }
        return 0 as any;
      }

      throw new Error(`Unexpected Lua script in solidModules.test.ts: ${s}`);
    });

  return { store, expiresAt, readKey, getSpy, setSpy, evalSpy };
}

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

    it('rejects null, arrays, and primitive JSON values via the error fallback path', () => {
      expect(parseToolOutput('{"status":"sent"}')).toEqual({ status: 'sent' });
      expect(parseToolOutput('non-json-error')).toEqual({
        status: 'error',
        message: 'non-json-error',
      });
      for (const bad of ['null', '[1,2,3]', '42', '"hello"', 'true']) {
        expect(parseToolOutput(bad)).toEqual({
          status: 'error',
          message: bad,
        });
      }
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

    it('evicts empty-string conversation IDs cleanly at fallback capacity', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(redisClient, 'set').mockRejectedValue(new Error('Redis down'));
      vi.spyOn(redisClient, 'get').mockRejectedValue(new Error('Redis down'));

      await saveConversationSession('', [new HumanMessage('empty-id')], {}, false);
      for (let i = 1; i < 500; i++) {
        await saveConversationSession(`cap-${i}`, [new HumanMessage(`m-${i}`)], {}, false);
      }

      // Adding the 501st key should evict the oldest key even when its ID is ""
      await saveConversationSession('cap-500', [new HumanMessage('m-500')], {}, false);

      const evicted = await getConversationSession('');
      const retained = await getConversationSession('cap-1');
      expect(evicted.messages).toEqual([]);
      expect(retained.messages).toHaveLength(1);
    });

    it('reconciles pending local fallback with missing or older Redis reads and clears stale snapshots only after Redis save succeeds', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const store = new Map<string, string>();
      const setSpy = vi.spyOn(redisClient, 'set').mockRejectedValueOnce(new Error('Write offline'));
      const getSpy = vi.spyOn(redisClient, 'get').mockImplementation(async (k: any) => store.get(String(k)) ?? null);

      // 1. Outage write lands in pending fallback
      await saveConversationSession('conv-rec', [new HumanMessage('fallback-turn')], { name: 'Ana' }, false);

      // 2. Redis recovers for reads but has missing key -> reconciled session keeps fallback turn
      const fromMissing = await getConversationSession('conv-rec');
      expect(fromMissing.messages).toHaveLength(1);
      expect(fromMissing.messages[0].content).toBe('fallback-turn');

      // 3. Redis has older pre-outage snapshot -> reconciled session still keeps newer fallback turn
      store.set(
        'session:conv-rec',
        JSON.stringify({
          messages: [],
          leadInfo: {},
          isVerified: false,
          updatedAt: fromMissing.updatedAt - 10_000,
        })
      );
      const fromOlderRedis = await getConversationSession('conv-rec');
      expect(fromOlderRedis.messages).toHaveLength(1);

      // 4. Subsequent Redis write fails -> prior local snapshot is still preserved
      setSpy.mockRejectedValueOnce(new Error('Still failing'));
      await saveConversationSession('conv-rec', [new HumanMessage('fallback-turn-2')], { name: 'Ana' }, false);

      // 5. Next Redis write succeeds -> clears local snapshot afterward so a later Redis read error does not revive old fallback data
      setSpy.mockImplementation(async (k: any, v: any) => {
        store.set(String(k), String(v));
        return 'OK' as any;
      });
      await saveConversationSession(
        'conv-rec',
        [new HumanMessage('fallback-turn-2'), new AIMessage('Synced reply')],
        { name: 'Ana' },
        false
      );

      getSpy.mockRejectedValueOnce(new Error('Later read failure'));
      const afterClearReadFail = await getConversationSession('conv-rec');
      expect(afterClearReadFail.messages).toEqual([]);
    });

    it('serializes concurrent turns for the same conversationId with Redis lock and Lua release', async () => {
      const mock = createStatefulRedisMock();

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
      expect(mock.evalSpy).toHaveBeenCalled();
      expect(mock.readKey('session_lock:conv-lock')).toBeNull();
    });

    it('renews long-running lock leases so a slow valid turn can still save normally', async () => {
      const mock = createStatefulRedisMock();

      await withConversationLock(
        'conv-lease-ok',
        async () => {
          await new Promise((r) => setTimeout(r, 140));
          await saveConversationSession('conv-lease-ok', [new HumanMessage('slow-valid')], { name: 'Ok' });
        },
        { lockTtlMs: 80, renewIntervalMs: 20 }
      );

      const saved = await getConversationSession('conv-lease-ok');
      expect(saved.messages).toHaveLength(1);
      expect(saved.messages[0].content).toBe('slow-valid');
      expect(
        mock.evalSpy.mock.calls.some(([script]) => String(script).includes('pexpire'))
      ).toBe(true);
    });

    it('rejects stale turn saves atomically when lock lease expires or is superseded by a newer fence', async () => {
      const mock = createStatefulRedisMock();

      let releaseStaleSave!: () => void;
      const letStaleSaveRun = new Promise<void>((resolve) => {
        releaseStaleSave = resolve;
      });
      let notifyStaleLocked!: () => void;
      const staleLocked = new Promise<void>((resolve) => {
        notifyStaleLocked = resolve;
      });

      const staleTurn = withConversationLock(
        'conv-stale',
        async () => {
          notifyStaleLocked();
          await letStaleSaveRun;
          await saveConversationSession('conv-stale', [new HumanMessage('stale-overwrite')], { name: 'Old' });
        },
        { lockTtlMs: 50, renewIntervalMs: 5000 }
      );

      await staleLocked;
      // Wait for stale turn's 50ms unrenewed lease to expire so a competing replica takes over via Redis
      await new Promise((r) => setTimeout(r, 75));

      const replicaBToken = 'replica-b-token';
      const replicaBFence = await redisClient.eval(
        "if redis.call('set', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[2]), 'NX') then return redis.call('incr', KEYS[2]) end return nil",
        2,
        'session_lock:conv-stale',
        'session_fence:conv-stale',
        replicaBToken,
        '1000'
      );
      expect(Number(replicaBFence)).toBe(2);

      const replicaBCommit = await redisClient.eval(
        "if redis.call('get', KEYS[2]) ~= ARGV[3] then return -1 end local incomingFence = tonumber(ARGV[4]) local savedFence = tonumber(redis.call('get', KEYS[3]) or '0') if savedFence > incomingFence then return -2 end redis.call('set', KEYS[3], tostring(incomingFence), 'EX', tonumber(ARGV[2])) redis.call('set', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2])) return 1",
        3,
        'session:conv-stale',
        'session_lock:conv-stale',
        'session_saved_fence:conv-stale',
        JSON.stringify({
          messages: [{ role: 'human', content: 'newer-turn' }],
          leadInfo: { name: 'New' },
          isVerified: false,
          updatedAt: Date.now(),
        }),
        '86400',
        replicaBToken,
        String(replicaBFence)
      );
      expect(Number(replicaBCommit)).toBe(1);

      await redisClient.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        'session_lock:conv-stale',
        replicaBToken
      );

      releaseStaleSave();
      await expect(staleTurn).rejects.toThrow(StaleSessionLockError);

      // Newer Redis commit must remain intact and stale turn must not poison local fallback
      const finalSession = await getConversationSession('conv-stale');
      expect(finalSession.leadInfo.name).toBe('New');
      expect(finalSession.messages).toHaveLength(1);
      expect(finalSession.messages[0].content).toBe('newer-turn');
      expect(mock.readKey('session_lock:conv-stale')).toBeNull();
    });

    it('serializes overlapping in-process requests end-to-end across lease renewal and session save', async () => {
      createStatefulRedisMock();
      const events: string[] = [];

      await Promise.all([
        withConversationLock(
          'conv-overlap-full',
          async () => {
            events.push('req1-start');
            await new Promise((r) => setTimeout(r, 120));
            await saveConversationSession(
              'conv-overlap-full',
              [new HumanMessage('from-req1')],
              { name: 'Req1' }
            );
            events.push('req1-saved');
          },
          { lockTtlMs: 80, renewIntervalMs: 20 }
        ),
        withConversationLock('conv-overlap-full', async () => {
          events.push('req2-start');
          const session = await getConversationSession('conv-overlap-full');
          expect(session.messages).toHaveLength(1);
          expect(session.messages[0].content).toBe('from-req1');
          events.push('req2-read');
        }),
      ]);

      expect(events).toEqual(['req1-start', 'req1-saved', 'req2-start', 'req2-read']);
    });

    it('fails closed in withConversationLock when Redis lock fails or Redis is ended', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(redisClient, 'eval').mockRejectedValue(new Error('Redis offline'));
      const fnSpy = vi.fn().mockResolvedValue('should-not-run');

      await expect(withConversationLock('conv-fail-error', fnSpy)).rejects.toThrow(
        'Failed to acquire distributed conversation lock.'
      );
      expect(fnSpy).not.toHaveBeenCalled();

      const originalStatusDesc = Object.getOwnPropertyDescriptor(redisClient, 'status');
      Object.defineProperty(redisClient, 'status', { value: 'end', configurable: true });
      try {
        await expect(withConversationLock('conv-fail-end', fnSpy)).rejects.toThrow(
          'Failed to acquire distributed conversation lock.'
        );
        expect(fnSpy).not.toHaveBeenCalled();
      } finally {
        if (originalStatusDesc) {
          Object.defineProperty(redisClient, 'status', originalStatusDesc);
        } else {
          delete (redisClient as any).status;
        }
      }
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
