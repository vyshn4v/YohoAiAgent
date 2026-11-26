import { AIMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { config } from '../../config/index.js';
import {
  scheduleEnquiryTool,
  sendVerificationOtpTool,
  verifyOtpTool,
} from '../../tools/index.js';
import { createNodeLogger, NodeLogger } from '../../utils/nodeLogger.js';
import { getGreetingSmallModel } from '../llm/modelFactory.js';
import { AgentStateType, LeadInfo } from '../state.js';
import { getLastUserMessage, parseToolOutput } from '../utils/messageUtils.js';

const contactSchema = z.object({
  name: z.string().nullable().describe('User full name'),
  email: z.string().nullable().describe('User email address'),
  phone: z.string().nullable().describe('User phone number'),
  reason: z.string().nullable().describe('Reason for consultation'),
  otp: z.string().nullable().describe('6-digit OTP code'),
  action: z.enum(['verify_otp', 'schedule', 'send_otp', 'request_info']),
});

function buildScheduleReply(
  replyMsg: string,
  leadInfo: LeadInfo,
  extra: Partial<AgentStateType> = {}
): Partial<AgentStateType> {
  return {
    intent: 'schedule_enquiry',
    leadInfo,
    messages: [new AIMessage(replyMsg)],
    uiAction: null,
    ...extra,
  };
}

async function handleOtpVerificationFlow(params: {
  otp: string;
  leadInfo: LeadInfo;
  log: NodeLogger;
  runConfig?: RunnableConfig;
  setStep: (step: string) => void;
}): Promise<Partial<AgentStateType>> {
  const { otp, leadInfo, log, runConfig, setStep } = params;
  const emailToVerify = leadInfo.email || 'user@example.com';

  setStep('verify_otp_tool');
  log.step('Verifying submitted OTP', { hasLeadEmail: Boolean(leadInfo.email) });
  const verifyRes = await verifyOtpTool.invoke({ email: emailToVerify, otp }, runConfig);
  const parsed = parseToolOutput(verifyRes);

  if (parsed.status !== 'verified') {
    log.warn('OTP verification rejected', { status: parsed.status });
    log.done({ outcome: 'otp_verification_failed' });
    const replyMsg = `Verification failed: ${parsed.message || 'Invalid code.'} Please check your code and try again.`;
    return buildScheduleReply(replyMsg, leadInfo, { uiAction: parsed.uiAction ?? null });
  }

  if (!leadInfo.name) {
    log.done({ outcome: 'otp_verified_missing_name', isVerified: true });
    return buildScheduleReply(
      'Your email has been successfully verified! ✅ Please share your full name to finalize the booking.',
      leadInfo,
      { isVerified: true }
    );
  }

  setStep('schedule_enquiry_after_otp');
  log.step('OTP verified; finalizing enquiry booking');
  const scheduleRes = await scheduleEnquiryTool.invoke(
    {
      name: leadInfo.name,
      email: emailToVerify,
      phone: leadInfo.phone || 'Not provided',
      reason: leadInfo.reason || 'General portfolio consultation / enquiry',
    },
    runConfig
  );
  const scheduleParsed = parseToolOutput(scheduleRes);

  if (scheduleParsed.status !== 'confirmed') {
    log.warn('Enquiry booking after OTP did not confirm', { status: scheduleParsed.status });
  }
  log.done({
    outcome: scheduleParsed.status === 'confirmed' ? 'booking_confirmed' : 'booking_failed',
    status: scheduleParsed.status,
    isVerified: true,
  });

  const replyMsg =
    scheduleParsed.status === 'confirmed'
      ? 'Your email has been successfully verified! ✅ Vyshnav will review your details and reach out within 24 hours.'
      : `Unable to finalize consultation: ${scheduleParsed.message || 'Please try again later.'}`;

  return buildScheduleReply(replyMsg, leadInfo, { isVerified: true });
}

async function handleBookingOrOtpDispatchFlow(params: {
  leadInfo: Required<Pick<LeadInfo, 'name' | 'email'>> & LeadInfo;
  log: NodeLogger;
  runConfig?: RunnableConfig;
  setStep: (step: string) => void;
}): Promise<Partial<AgentStateType>> {
  const { leadInfo, log, runConfig, setStep } = params;

  setStep('schedule_enquiry_tool');
  log.step('Checking verification and scheduling enquiry');
  const scheduleRes = await scheduleEnquiryTool.invoke(
    {
      name: leadInfo.name,
      email: leadInfo.email,
      phone: leadInfo.phone || 'Not provided',
      reason: leadInfo.reason || 'General consultation',
    },
    runConfig
  );
  const scheduleParsed = parseToolOutput(scheduleRes);

  if (scheduleParsed.status === 'confirmed') {
    log.done({ outcome: 'booking_confirmed', isVerified: true });
    return buildScheduleReply(
      'Your consultation is confirmed! ✅ Vyshnav will review your details and reach out within 24 hours.',
      leadInfo,
      { isVerified: true }
    );
  }

  if (scheduleParsed.status === 'unverified') {
    setStep('send_verification_otp_tool');
    log.step('Email unverified; dispatching verification OTP');
    const otpRes = await sendVerificationOtpTool.invoke(
      { email: leadInfo.email, name: leadInfo.name },
      runConfig
    );
    const otpParsed = parseToolOutput(otpRes);
    const isSent = otpParsed.status === 'sent';
    if (!isSent) {
      log.warn('Verification OTP dispatch failed', { status: otpParsed.status });
    }
    log.done({ outcome: isSent ? 'otp_dispatched' : 'otp_dispatch_failed', status: otpParsed.status });

    const replyMsg = isSent
      ? `A 6-digit verification code has been dispatched to ${leadInfo.email}! 🔐 Please enter the code here to confirm. Vyshnav personally replies within 24 hours!`
      : `Failed to send verification code to ${leadInfo.email}. Please try again later.`;

    return buildScheduleReply(replyMsg, leadInfo, { uiAction: otpParsed.uiAction ?? null });
  }

  log.warn('schedule_enquiry returned unexpected status', { status: scheduleParsed.status });
  log.done({ outcome: 'booking_not_confirmed', status: scheduleParsed.status });
  return buildScheduleReply(
    `Unable to finalize consultation: ${scheduleParsed.message || 'Please try again later.'}`,
    leadInfo
  );
}

/**
 * Node: Schedule Enquiry Node
 * Extracts contact details from chat and orchestrates OTP verification and booking.
 */
export async function scheduleEnquiryNode(
  state: AgentStateType,
  runConfig?: RunnableConfig
): Promise<Partial<AgentStateType>> {
  const lastMessage = getLastUserMessage(state.messages);
  const modelName = config.models?.greeting || 'gemini-flash-lite-latest';
  const log = createNodeLogger('ScheduleEnquiry', runConfig);
  let currentStep = 'init';
  const setStep = (step: string) => {
    currentStep = step;
  };

  log.start({
    model: modelName,
    historyCount: state.messages.length,
    isVerified: Boolean(state.isVerified),
  });

  try {
    setStep('extract_contact_fields');
    log.step('Extracting contact details and action', { model: modelName });
    const extractor = getGreetingSmallModel(0).withStructuredOutput(contactSchema);
    const conversationContext = state.messages
      .map(
        (m) =>
          `${m._getType() === 'human' ? 'User' : 'Assistant'}: ${
            typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          }`
      )
      .join('\n');
    const extractionPrompt = `Extract the visitor's own contact details (name, email, phone, reason, otp) from the conversation below. Note: Vyshnav P C is the portfolio owner; if the visitor provides their own name when asked (even if it is Vyshnav), extract it as name.\n\n${
      conversationContext || lastMessage
    }`;
    const extracted = await extractor.invoke(extractionPrompt, runConfig);

    const mergedLeadInfo: LeadInfo = {
      ...state.leadInfo,
      ...(extracted.name ? { name: extracted.name } : {}),
      ...(extracted.email ? { email: extracted.email } : {}),
      ...(extracted.phone ? { phone: extracted.phone } : {}),
      ...(extracted.reason ? { reason: extracted.reason } : {}),
    };

    log.step('Extracted scheduling fields', {
      action: extracted.action,
      hasName: Boolean(mergedLeadInfo.name),
      hasEmail: Boolean(mergedLeadInfo.email),
      hasPhone: Boolean(mergedLeadInfo.phone),
      hasReason: Boolean(mergedLeadInfo.reason),
      hasOtp: Boolean(extracted.otp),
    });

    if (extracted.otp && (extracted.action === 'verify_otp' || !state.isVerified)) {
      return await handleOtpVerificationFlow({
        otp: extracted.otp,
        leadInfo: mergedLeadInfo,
        log,
        runConfig,
        setStep,
      });
    }

    if (!mergedLeadInfo.name || !mergedLeadInfo.email) {
      log.done({
        outcome: 'missing_required_fields',
        hasName: Boolean(mergedLeadInfo.name),
        hasEmail: Boolean(mergedLeadInfo.email),
      });
      const replyMsg =
        !mergedLeadInfo.name && !mergedLeadInfo.email
          ? 'Please share your name and email address to schedule a consultation. Vyshnav reviews all requests within 24 hours.'
          : !mergedLeadInfo.name
          ? 'Could you please share your name as well? Vyshnav personally replies within 24 hours.'
          : 'Please share your email address so I can send a verification code.';
      return buildScheduleReply(replyMsg, mergedLeadInfo);
    }

    return await handleBookingOrOtpDispatchFlow({
      leadInfo: {
        ...mergedLeadInfo,
        name: mergedLeadInfo.name,
        email: mergedLeadInfo.email,
      },
      log,
      runConfig,
      setStep,
    });
  } catch (err: any) {
    log.fail(err, { step: currentStep, model: modelName });
    const errorMessage =
      'An error occurred while processing your scheduling request. Please try again later.';
    return {
      intent: 'schedule_enquiry',
      finalMessage: errorMessage,
      messages: [new AIMessage(errorMessage)],
    };
  }
}
