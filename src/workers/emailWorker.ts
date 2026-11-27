import { Worker, Job } from 'bullmq';
import nodemailer from 'nodemailer';
import { config } from '../config/index.js';
import { createRedisConnection } from '../services/redisClient.js';
import { EmailJobData } from '../queues/emailQueue.js';
import { buildLeadNotificationEmail, buildOtpEmail } from './emailTemplates.js';

let transporter: nodemailer.Transporter | null = null;

async function getTransporter(): Promise<nodemailer.Transporter> {
  if (transporter) return transporter;

  if (config.smtp.host && config.smtp.user) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: {
        user: config.smtp.user,
        pass: config.smtp.pass,
      },
    });
    console.log('[EmailWorker] Configured production SMTP transport.');
    return transporter;
  }

  try {
    const testAccount = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass,
      },
    });
    console.log(`[EmailWorker] Using Ethereal test account: ${testAccount.user}`);
  } catch {
    transporter = nodemailer.createTransport({ jsonTransport: true });
    console.log('[EmailWorker] Using JSON logging fallback transport.');
  }

  return transporter;
}

export function startEmailWorker(): Worker<EmailJobData> {
  const connection = createRedisConnection();

  const worker = new Worker<EmailJobData>(
    'email-queue',
    async (job: Job<EmailJobData>) => {
      console.log(`[EmailWorker] Processing job ${job.id} (type: ${job.data.type})...`);
      const mailer = await getTransporter();

      if (job.data.type === 'otp_email') {
        const { email, name, otp } = job.data;
        const template = buildOtpEmail({ name, otp });
        const info = await mailer.sendMail({
          from: config.smtp.from,
          to: email,
          ...template,
        });

        console.log(`[EmailWorker] OTP email delivered to ${email}. Message ID: ${info.messageId}`);
        const previewUrl = nodemailer.getTestMessageUrl(info);
        if (previewUrl) {
          console.log(`[EmailWorker] Ethereal Preview URL: ${previewUrl}`);
        }
        if (config.nodeEnv === 'development') {
          console.log(`[DEV ONLY] OTP for ${email}: >>> ${otp} <<<`);
        }
        return { messageId: info.messageId, email };
      }

      if (job.data.type === 'lead_notification') {
        const template = buildLeadNotificationEmail(job.data);
        const info = await mailer.sendMail({
          from: config.smtp.from,
          to: config.hostEmail,
          ...template,
        });

        console.log(`[EmailWorker] Lead notification delivered to host (${config.hostEmail}).`);
        return { messageId: info.messageId };
      }

      throw new Error('Unknown job data type');
    },
    {
      connection,
      concurrency: 5,
    }
  );

  worker.on('failed', (job, err) => {
    console.error(`[EmailWorker] Job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}

if (process.argv[1]?.includes('emailWorker')) {
  console.log('[EmailWorker] Starting standalone BullMQ email worker...');
  const worker = startEmailWorker();

  const shutdown = async () => {
    console.log('[EmailWorker] Shutting down worker gracefully...');
    await worker.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
