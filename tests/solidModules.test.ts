import { describe, it, expect, beforeEach } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
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
} from '../src/http/sessionStore.js';
import {
  buildLeadNotificationEmail,
  buildOtpEmail,
  escapeHtml,
} from '../src/workers/emailTemplates.js';

describe('SOLID Module Unit Tests', () => {
  beforeEach(() => {
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
    it('stores and retrieves messages, leadInfo, and isVerified across turns', () => {
      const initial = getConversationSession('sess-1');
      expect(initial.messages).toEqual([]);
      expect(initial.isVerified).toBe(false);

      saveConversationSession(
        'sess-1',
        [new HumanMessage('hi'), new AIMessage('hello')],
        { name: 'Alice', email: 'alice@example.com' },
        true
      );

      const loaded = getConversationSession('sess-1');
      expect(loaded.messages).toHaveLength(2);
      expect(loaded.leadInfo.name).toBe('Alice');
      expect(loaded.isVerified).toBe(true);
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
