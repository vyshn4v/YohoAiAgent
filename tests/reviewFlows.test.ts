import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';

const mocks = vi.hoisted(() => ({
  route: vi.fn(), send: vi.fn(), verify: vi.fn(), schedule: vi.fn(),
}));
vi.mock('@langchain/openai', () => ({
  ChatOpenAI: class {
    withStructuredOutput() { return { invoke: mocks.route }; }
  },
}));
vi.mock('../src/tools/index.js', () => ({
  sendVerificationOtpTool: { invoke: mocks.send },
  verifyOtpTool: { invoke: mocks.verify },
  scheduleEnquiryTool: { invoke: mocks.schedule },
}));
import { firstRouterAndUiNode } from '../src/agent/nodes.js';
import type { AgentStateType } from '../src/agent/state.js';

const lead = { name: 'Alice', email: 'alice@example.com', phone: '123456789', reason: 'Project discussion' };
function state(leadInfo = {}, isVerified = false) {
  return { messages: [new HumanMessage('Continue my enquiry')], leadInfo, isVerified } as AgentStateType;
}
function route(action: string, extracted = {}) {
  mocks.route.mockResolvedValue({ isUiOrDirect: true, action, extracted });
}
function reply(result: Partial<AgentStateType>) { return String(result.messages?.[0].content); }

beforeEach(() => {
  vi.resetAllMocks();
  mocks.verify.mockResolvedValue(JSON.stringify({ status: 'verified' }));
  mocks.schedule.mockResolvedValue(JSON.stringify({ status: 'confirmed' }));
});

describe('Booking result guarantees', () => {
  it.each(['verify_otp', 'schedule'])('collects missing phone and reason for %s', async (action) => {
    route(action, { otp: '123456' });
    const result = await firstRouterAndUiNode(state({ name: lead.name, email: lead.email }));
    expect(reply(result)).toContain('phone, reason');
    expect(reply(result)).not.toContain('24 hours');
    expect(mocks.schedule).not.toHaveBeenCalled();
    if (action === 'verify_otp') expect(result.isVerified).toBe(true);
  });

  it.each(['verify_otp', 'schedule'])('confirms only after scheduling succeeds for %s', async (action) => {
    route(action, { otp: '123456' });
    const result = await firstRouterAndUiNode(state(lead));
    expect(mocks.schedule).toHaveBeenCalledWith(lead);
    expect(reply(result)).toContain('confirmed');
  });

  it.each(['verify_otp', 'schedule'])('does not promise follow-up after scheduling fails for %s', async (action) => {
    route(action, { otp: '123456' });
    mocks.schedule.mockResolvedValue(JSON.stringify({ status: 'error', message: 'Queue unavailable' }));
    const result = await firstRouterAndUiNode(state(lead));
    expect(reply(result)).toContain('Could not complete');
    expect(reply(result)).not.toMatch(/confirmed|24 hours/);
  });

  it.each(['request_info', 'send_otp', 'schedule'])('books after missing details arrive with %s', async (action) => {
    route(action, { phone: lead.phone, reason: lead.reason });
    const result = await firstRouterAndUiNode(state({ name: lead.name, email: lead.email }, true));
    expect(mocks.schedule).toHaveBeenCalledWith(lead);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(reply(result)).toContain('confirmed');
  });

  it('asks for an email before verifying a code without a known address', async () => {
    route('verify_otp', { otp: '123456' });
    const result = await firstRouterAndUiNode(state({ name: lead.name }));
    expect(reply(result)).toContain('email address');
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('does not schedule after verification fails', async () => {
    route('verify_otp', { otp: '000000' });
    mocks.verify.mockResolvedValue(JSON.stringify({ status: 'failed' }));
    expect(reply(await firstRouterAndUiNode(state(lead)))).toContain('Verification failed');
    expect(mocks.schedule).not.toHaveBeenCalled();
  });
});

describe('Existing OTP delivery status handling', () => {
  it.each(['sent', 'error'])('handles %s dispatch', async (status) => {
    route('send_otp');
    mocks.send.mockResolvedValue(JSON.stringify({ status }));
    const result = await firstRouterAndUiNode(state(lead));
    if (status === 'sent') expect(reply(result)).toContain('dispatched');
    else {
      expect(reply(result)).not.toContain('dispatched');
      expect(reply(result)).toContain('try again');
    }
  });
});
