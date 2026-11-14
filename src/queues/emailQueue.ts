import { Queue } from 'bullmq';
import { createRedisConnection } from '../services/redisClient.js';

export interface OtpEmailPayload {
  type: 'otp_email';
  email: string;
  name?: string;
  otp: string;
}

export interface LeadNotificationPayload {
  type: 'lead_notification';
  name: string;
  email: string;
  phone: string;
  reason: string;
}

export type EmailJobData = OtpEmailPayload | LeadNotificationPayload;

const redisConnection = createRedisConnection();
redisConnection.on('error', (err: any) => {
  if (process.env.NODE_ENV !== 'test') {
    console.warn(`[BullMQ Redis Notice] ${err.message}`);
  }
});

export const emailQueue = new Queue<EmailJobData>('email-queue', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1500,
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

/**
 * Enqueues an OTP delivery email job.
 */
export async function enqueueOtpEmail(email: string, otp: string, name?: string) {
  const job = await emailQueue.add(
    'send_otp',
    {
      type: 'otp_email',
      email,
      name,
      otp,
    },
    {
      jobId: `otp:${email}:${Date.now()}`,
    }
  );
  return job.id;
}

/**
 * Enqueues a notification email to the host when a lead is scheduled.
 */
export async function enqueueLeadNotification(lead: {
  name: string;
  email: string;
  phone: string;
  reason: string;
}) {
  const job = await emailQueue.add(
    'lead_notification',
    {
      type: 'lead_notification',
      ...lead,
    },
    {
      jobId: `lead:${lead.email}:${Date.now()}`,
    }
  );
  return job.id;
}
