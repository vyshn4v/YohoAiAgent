import { Worker, Job } from 'bullmq';
import nodemailer from 'nodemailer';
import { config } from '../config/index.js';
import { createRedisConnection } from '../services/redisClient.js';
import { EmailJobData } from '../queues/emailQueue.js';

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
  } else {
    // Development fallback: ethereal.email or console logger
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
      console.log(
        `[EmailWorker] Using Ethereal test account: ${testAccount.user}`
      );
    } catch {
      // Fallback: sendmail or json transport
      transporter = nodemailer.createTransport({
        jsonTransport: true,
      });
      console.log('[EmailWorker] Using JSON logging fallback transport.');
    }
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
        const greeting = name ? `Hello ${name},` : 'Hello,';

        const info = await mailer.sendMail({
          from: config.smtp.from,
          to: email,
          subject: `${otp} is your verification code for meeting enquiry`,
          text: `${greeting}\n\nYour 6-digit email verification code is: ${otp}\n\nThis code will expire in 5 minutes. If you did not request this, please ignore this email.`,
          html: `
            <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 500px; border: 1px solid #e0e0e0; border-radius: 8px;">
              <h2 style="color: #2b6cb0;">Email Verification</h2>
              <p>${greeting}</p>
              <p>You requested to schedule a meeting with Vyshnav P C. Please use the verification code below to verify your email address:</p>
              <div style="font-size: 32px; font-weight: bold; letter-spacing: 6px; text-align: center; margin: 25px 0; padding: 15px; background: #f7fafc; border: 1px dashed #cbd5e0; color: #2d3748;">
                ${otp}
              </div>
              <p style="color: #718096; font-size: 14px;">This code is valid for <strong>5 minutes</strong>. To prevent unauthorized requests, do not share this code.</p>
              <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
              <p style="font-size: 12px; color: #a0aec0;">Vyshnav P C &bull; AI & Full-Stack Engineer &bull; Guaranteed response within 24 hours.</p>
            </div>
          `,
        });

        console.log(`[EmailWorker] OTP email delivered to ${email}. Message ID: ${info.messageId}`);
        const previewUrl = nodemailer.getTestMessageUrl(info);
        if (previewUrl) {
          console.log(`[EmailWorker] Ethereal Preview URL: ${previewUrl}`);
        }
        // In local development, also log the OTP directly to console for rapid testing
        console.log(`[DEV ONLY] OTP for ${email}: >>> ${otp} <<<`);
        return { messageId: info.messageId, email };
      }

      if (job.data.type === 'lead_notification') {
        const { name, email, phone, reason } = job.data;
        const info = await mailer.sendMail({
          from: config.smtp.from,
          to: config.hostEmail,
          subject: `New Meeting Lead: ${name} (${email})`,
          text: `New verified enquiry received!\n\nName: ${name}\nEmail: ${email}\nPhone: ${phone}\nReason:\n${reason}\n\nReminder: You promised to respond within 24 hours!`,
          html: `
            <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 600px; border: 1px solid #e0e0e0; border-radius: 8px;">
              <h2 style="color: #2b6cb0;">New Verified Meeting Lead</h2>
              <p>A client has verified their email and submitted a meeting request:</p>
              <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
                <tr><td style="padding: 8px; font-weight: bold; width: 120px;">Name:</td><td style="padding: 8px;">${name}</td></tr>
                <tr><td style="padding: 8px; font-weight: bold;">Email:</td><td style="padding: 8px;"><a href="mailto:${email}">${email}</a> (Verified)</td></tr>
                <tr><td style="padding: 8px; font-weight: bold;">Phone:</td><td style="padding: 8px;">${phone}</td></tr>
                <tr><td style="padding: 8px; font-weight: bold;">Reason:</td><td style="padding: 8px;">${reason}</td></tr>
              </table>
              <div style="margin-top: 20px; padding: 12px; background: #ebf8ff; border-left: 4px solid #3182ce; color: #2b6cb0;">
                <strong>Commitment:</strong> Get in touch with this user within 24 hours.
              </div>
            </div>
          `,
        });

        console.log(`[EmailWorker] Lead notification delivered to host (${config.hostEmail}).`);
        return { messageId: info.messageId };
      }

      throw new Error(`Unknown job data type`);
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

// Standalone execution check
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
