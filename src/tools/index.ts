import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import {
  generateOtp,
  storeHashedOtp,
  verifyEnteredOtp,
  isEmailVerified,
} from '../services/otpService.js';
import { enqueueOtpEmail, enqueueLeadNotification } from '../queues/emailQueue.js';
import { redisClient } from '../services/redisClient.js';
import { createNodeLogger } from '../utils/nodeLogger.js';

/**
 * Tool 1: send_verification_otp
 * Generates a 6-digit OTP, stores it in encrypted/hashed form in Redis,
 * and enqueues the email delivery job to BullMQ.
 */
export const sendVerificationOtpTool = tool(
  async ({ email, name }) => {
    const log = createNodeLogger('Tool:send_verification_otp');
    log.start({ hasName: Boolean(name) });

    try {
      const otp = generateOtp();
      await storeHashedOtp(email, otp);
      const jobId = await enqueueOtpEmail(email, otp, name);

      log.done({ status: 'sent', jobId });
      return JSON.stringify({
        status: 'sent',
        message: `A 6-digit verification code has been dispatched to ${email}. Please enter the code to verify your email. (Note: Valid for 5 minutes).`,
        uiAction: {
          type: 'otp_input',
          title: 'Enter 6-Digit Verification Code',
          email,
          length: 6,
          placeholder: '123456',
          description: `Please enter the 6-digit code sent to ${email}`,
        },
      });
    } catch (error: any) {
      log.fail(error);
      return JSON.stringify({
        status: 'error',
        message: `Failed to dispatch verification OTP: ${error.message}`,
      });
    }
  },
  {
    name: 'send_verification_otp',
    description:
      'Sends a 6-digit OTP email to the user for email verification, and stores the encrypted OTP in Redis. Call this when the user wants to schedule a meeting and needs to verify their email.',
    schema: z.object({
      name: z.string().describe("The user's full name."),
      email: z.string().email().describe("The user's email address to verify."),
    }),
  }
);

/**
 * Tool 3: verify_otp
 * Compares the user-entered OTP against the encrypted/hashed OTP in Redis.
 */
export const verifyOtpTool = tool(
  async ({ email, otp }) => {
    const log = createNodeLogger('Tool:verify_otp');
    log.start({ otpLength: otp.trim().length });

    try {
      const result = await verifyEnteredOtp(email, otp);
      const status = result.success ? 'verified' : 'failed';
      if (result.success) {
        log.done({ status });
      } else {
        log.warn('OTP verification did not match', { status });
      }

      return JSON.stringify({
        status,
        message: result.message,
        uiAction: result.success
          ? null
          : {
              type: 'otp_input',
              title: 'Enter 6-Digit Verification Code',
              email,
              length: 6,
              error: result.message,
            },
      });
    } catch (error: any) {
      log.fail(error);
      return JSON.stringify({
        status: 'error',
        message: `Error during OTP verification: ${error.message}`,
      });
    }
  },
  {
    name: 'verify_otp',
    description:
      'Verifies the 6-digit OTP entered by the user against the encrypted hash in Redis. Call this when the user provides their verification code.',
    schema: z.object({
      email: z.string().email().describe("The user's email address being verified."),
      otp: z.string().describe('The 6-digit OTP entered by the user.'),
    }),
  }
);

/**
 * Tool 4: schedule_enquiry
 * Schedules a meeting/consultation enquiry. Checks if the email is verified in Redis.
 * If verified, persists the enquiry and triggers lead notifications.
 */
export const scheduleEnquiryTool = tool(
  async ({ name, email, phone, reason }) => {
    const log = createNodeLogger('Tool:schedule_enquiry');
    log.start({ hasName: Boolean(name), hasPhone: Boolean(phone), reasonLen: reason.length });

    try {
      const verified = await isEmailVerified(email);
      if (!verified) {
        log.done({ status: 'unverified' });
        return JSON.stringify({
          status: 'unverified',
          message: `Email ${email} has not been verified yet. Please request a verification OTP and verify your email before scheduling the meeting.`,
        });
      }

      // Persist enquiry in Redis
      const enquiryId = uuidv4();
      const enquiryData = {
        id: enquiryId,
        name,
        email,
        phone,
        reason,
        createdAt: new Date().toISOString(),
        status: 'confirmed',
      };

      await redisClient.set(
        `enquiry:${enquiryId}`,
        JSON.stringify(enquiryData),
        'EX',
        86400 * 30 // Retain for 30 days
      );

      // Add to enquiries list
      await redisClient.lpush('enquiries:list', enquiryId);

      // Enqueue notification email to host via BullMQ
      await enqueueLeadNotification({ name, email, phone, reason });

      log.done({ status: 'confirmed', enquiryId });
      return JSON.stringify({
        status: 'confirmed',
        enquiryId,
        message: `Enquiry successfully scheduled! Vyshnav P C will get in touch with you at ${email} / ${phone} within 24 hours.`,
        uiAction: null,
      });
    } catch (error: any) {
      log.fail(error);
      return JSON.stringify({
        status: 'error',
        message: `Failed to schedule enquiry: ${error.message}`,
      });
    }
  },
  {
    name: 'schedule_enquiry',
    description:
      'Finalizes and schedules the meeting / get-in-touch enquiry after email verification. Requires name, email, phone, and reason.',
    schema: z.object({
      name: z.string().describe('Full name of the user.'),
      email: z.string().email().describe('Verified email address of the user.'),
      phone: z.string().describe('Contact phone number of the user.'),
      reason: z.string().describe('Reason for the meeting or project details.'),
    }),
  }
);

export const agentTools = [
  sendVerificationOtpTool,
  verifyOtpTool,
  scheduleEnquiryTool,
];
