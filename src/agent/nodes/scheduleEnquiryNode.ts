import { AIMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { config } from '../../config/index.js';
import { hasActiveOtp } from '../../services/otpService.js';
import {
  scheduleEnquiryTool,
  sendVerificationOtpTool,
  verifyOtpTool,
} from '../../tools/index.js';
import { createNodeLogger, NodeLogger } from '../../utils/nodeLogger.js';
import { getGreetingSmallModel } from '../llm/modelFactory.js';
import { AgentStateType, LeadInfo } from '../state.js';
import { getLastUserMessage, parseToolOutput } from '../utils/messageUtils.js';

type RequiredLeadField = 'name' | 'email' | 'phone' | 'reason';

const FIELD_LABELS: Record<RequiredLeadField, string> = {
  name: 'full name',
  email: 'email address',
  phone: 'phone number',
  reason: 'reason for connecting',
};

const contactSchema = z.object({
  name: z.string().nullable().describe('User full name'),
  email: z.string().nullable().describe('User email address'),
  phone: z.string().nullable().describe('User phone number'),
  reason: z.string().nullable().describe('Reason for consultation'),
  otp: z.string().nullable().describe('6-digit OTP code from the latest user message only'),
  action: z.enum(['verify_otp', 'schedule', 'send_otp', 'request_info']),
});

function getMissingLeadFields(leadInfo: LeadInfo): RequiredLeadField[] {
  const missing: RequiredLeadField[] = [];
  if (!leadInfo.name?.trim()) missing.push('name');
  if (!leadInfo.email?.trim()) missing.push('email');
  if (!leadInfo.phone?.trim()) missing.push('phone');
  if (!leadInfo.reason?.trim()) missing.push('reason');
  return missing;
}

function formatMissingFieldsPrompt(missing: RequiredLeadField[], afterOtp = false): string {
  const labels = missing.map((f) => FIELD_LABELS[f]);
  const joined =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;

  return afterOtp
    ? `Your email has been successfully verified! ✅ Please share your ${joined} to finalize the booking.`
    : `Please share your ${joined} to schedule a consultation. Vyshnav reviews all requests within 24 hours.`;
}

/**
 * Deterministically extracts a 6-digit OTP from the latest user turn only,
 * preventing AI omissions or stale OTPs from older chat messages.
 */
export function extractOtpFromLastMessage(
  lastMessage: string,
  expectingOtp: boolean
): string | null {
  const trimmed = lastMessage.trim();
  if (/^\d{6}$/.test(trimmed)) {
    return trimmed;
  }

  const labeledMatch = lastMessage.match(
    /\b(?:otp|code|pin|verification(?:\s+code)?)\b\D{0,15}(\d{6})\b/i
  );
  if (labeledMatch?.[1]) {
    return labeledMatch[1];
  }

  if (expectingOtp && !/\+\d|\d{7,}/.test(lastMessage)) {
    const standalone = lastMessage.match(/(?:^|\D)(\d{6})(?=\D|$)/);
    if (standalone?.[1]) {
      return standalone[1];
    }
  }

  return null;
}

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
  email: string;
  otp: string;
  leadInfo: LeadInfo;
  log: NodeLogger;
  runConfig?: RunnableConfig;
  setStep: (step: string) => void;
}): Promise<Partial<AgentStateType>> {
  const { email, otp, leadInfo, log, runConfig, setStep } = params;

  setStep('verify_otp_tool');
  log.step('Verifying submitted OTP', { hasLeadEmail: Boolean(leadInfo.email) });
  const verifyRes = await verifyOtpTool.invoke({ email, otp }, runConfig);
  const parsed = parseToolOutput(verifyRes);

  if (parsed.status !== 'verified') {
    log.warn('OTP verification rejected', { status: parsed.status });
    log.done({ outcome: 'otp_verification_failed', isVerified: false });
    const replyMsg = `Verification failed: ${parsed.message || 'Invalid code.'} Please check your code and try again.`;
    return buildScheduleReply(replyMsg, leadInfo, {
      isVerified: false,
      uiAction: parsed.uiAction ?? null,
    });
  }

  const missingAfterOtp = getMissingLeadFields(leadInfo);
  if (missingAfterOtp.length > 0) {
    log.done({ outcome: 'otp_verified_missing_fields', missing: missingAfterOtp.join(','), isVerified: true });
    return buildScheduleReply(
      formatMissingFieldsPrompt(missingAfterOtp, true),
      leadInfo,
      { isVerified: true }
    );
  }

  setStep('schedule_enquiry_after_otp');
  log.step('OTP verified; finalizing enquiry booking');
  const scheduleRes = await scheduleEnquiryTool.invoke(
    {
      name: leadInfo.name!,
      email,
      phone: leadInfo.phone!,
      reason: leadInfo.reason!,
    },
    runConfig
  );
  const scheduleParsed = parseToolOutput(scheduleRes);

  if (scheduleParsed.status !== 'confirmed') {
    log.warn('Enquiry booking after OTP did not confirm', { status: scheduleParsed.status });
  }
  const confirmed = scheduleParsed.status === 'confirmed';
  log.done({
    outcome: confirmed ? 'booking_confirmed' : 'booking_failed',
    status: scheduleParsed.status,
    isVerified: !confirmed,
  });

  const replyMsg = confirmed
    ? 'Your email has been successfully verified! ✅ Vyshnav will review your details and reach out within 24 hours.'
    : `Unable to finalize consultation: ${scheduleParsed.message || 'Please try again later.'}`;

  return buildScheduleReply(replyMsg, leadInfo, { isVerified: !confirmed });
}

async function handleBookingOrOtpDispatchFlow(params: {
  leadInfo: Required<LeadInfo>;
  lastMessage: string;
  log: NodeLogger;
  runConfig?: RunnableConfig;
  setStep: (step: string) => void;
}): Promise<Partial<AgentStateType>> {
  const { leadInfo, lastMessage, log, runConfig, setStep } = params;

  setStep('schedule_enquiry_tool');
  log.step('Checking verification and scheduling enquiry');
  const scheduleRes = await scheduleEnquiryTool.invoke(
    {
      name: leadInfo.name,
      email: leadInfo.email,
      phone: leadInfo.phone,
      reason: leadInfo.reason,
    },
    runConfig
  );
  const scheduleParsed = parseToolOutput(scheduleRes);

  if (scheduleParsed.status === 'confirmed') {
    log.done({ outcome: 'booking_confirmed', isVerified: false });
    return buildScheduleReply(
      'Your consultation is confirmed! ✅ Vyshnav will review your details and reach out within 24 hours.',
      leadInfo,
      { isVerified: false }
    );
  }

  if (scheduleParsed.status === 'unverified') {
    const resendRequested = /\b(resend|new\s+(?:otp|code)|send\s+again)\b/i.test(lastMessage);
    if (!resendRequested && (await hasActiveOtp(leadInfo.email))) {
      log.done({ outcome: 'otp_already_active' });
      return buildScheduleReply(
        `A 6-digit verification code was already sent to ${leadInfo.email}. Please enter that code here to confirm your booking.`,
        leadInfo,
        {
          isVerified: false,
          uiAction: {
            type: 'otp_input',
            title: 'Enter 6-Digit Verification Code',
            email: leadInfo.email,
            length: 6,
            placeholder: '123456',
            description: `Please enter the 6-digit code sent to ${leadInfo.email}`,
          },
        }
      );
    }

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

    return buildScheduleReply(replyMsg, leadInfo, {
      isVerified: false,
      uiAction: otpParsed.uiAction ?? null,
    });
  }

  log.warn('schedule_enquiry returned unexpected status', { status: scheduleParsed.status });
  log.done({ outcome: 'booking_not_confirmed', status: scheduleParsed.status });
  return buildScheduleReply(
    `Unable to finalize consultation: ${scheduleParsed.message || 'Please try again later.'}`,
    leadInfo,
    { isVerified: false }
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
    const extractionPrompt = `Extract the visitor's own contact details (name, email, phone, reason) from the conversation below, and extract otp ONLY if a 6-digit OTP appears in the LATEST user message (never copy an old OTP from earlier messages). Note: Vyshnav P C is the portfolio owner; if the visitor provides their own name when asked (even if it is Vyshnav), extract it as name.\n\n${
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

    const lastAssistantMsg = [...state.messages]
      .reverse()
      .find((m) => m._getType() === 'ai');
    const lastAssistantText = lastAssistantMsg
      ? typeof lastAssistantMsg.content === 'string'
        ? lastAssistantMsg.content
        : JSON.stringify(lastAssistantMsg.content)
      : '';
    const expectingOtp =
      Boolean(mergedLeadInfo.email) &&
      (state.uiAction?.type === 'otp_input' ||
        /verification\s+code|verification\s+failed|invalid\s+code|\botp\b|6-digit\s+code/i.test(
          lastAssistantText
        ));
    const regexOtp = extractOtpFromLastMessage(lastMessage, expectingOtp);
    const aiOtp =
      extracted.otp &&
      /^\d{6}$/.test(extracted.otp.trim()) &&
      lastMessage.includes(extracted.otp.trim())
        ? extracted.otp.trim()
        : null;
    const resolvedOtp = regexOtp || aiOtp;

    log.step('Extracted scheduling fields', {
      action: extracted.action,
      hasName: Boolean(mergedLeadInfo.name),
      hasEmail: Boolean(mergedLeadInfo.email),
      hasPhone: Boolean(mergedLeadInfo.phone),
      hasReason: Boolean(mergedLeadInfo.reason),
      hasOtp: Boolean(resolvedOtp),
    });

    const emailChanged = Boolean(
      extracted.email &&
        state.leadInfo?.email &&
        extracted.email.toLowerCase().trim() !== state.leadInfo.email.toLowerCase().trim()
    );
    const effectiveIsVerified = emailChanged ? false : Boolean(state.isVerified);

    if (resolvedOtp && (extracted.action === 'verify_otp' || !effectiveIsVerified)) {
      if (!mergedLeadInfo.email) {
        log.warn('OTP provided without email address in session or message');
        log.done({ outcome: 'otp_missing_email' });
        return buildScheduleReply(
          'Please share the email address associated with your verification code so I can verify it.',
          mergedLeadInfo,
          { isVerified: false }
        );
      }

      return await handleOtpVerificationFlow({
        email: mergedLeadInfo.email,
        otp: resolvedOtp,
        leadInfo: mergedLeadInfo,
        log,
        runConfig,
        setStep,
      });
    }

    const missingFields = getMissingLeadFields(mergedLeadInfo);
    if (missingFields.length > 0) {
      log.done({
        outcome: 'missing_required_fields',
        missing: missingFields.join(','),
      });
      return buildScheduleReply(
        formatMissingFieldsPrompt(missingFields, effectiveIsVerified),
        mergedLeadInfo,
        { isVerified: effectiveIsVerified }
      );
    }

    return await handleBookingOrOtpDispatchFlow({
      leadInfo: {
        name: mergedLeadInfo.name!,
        email: mergedLeadInfo.email!,
        phone: mergedLeadInfo.phone!,
        reason: mergedLeadInfo.reason!,
      },
      lastMessage,
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
