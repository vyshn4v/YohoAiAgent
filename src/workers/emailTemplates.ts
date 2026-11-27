/**
 * Escapes HTML special characters to prevent HTML injection in outbound emails.
 */
export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildOtpEmail(params: { name?: string; otp: string }) {
  const safeName = params.name ? escapeHtml(params.name) : '';
  const safeOtp = escapeHtml(params.otp);
  const greeting = params.name ? `Hello ${params.name},` : 'Hello,';
  const htmlGreeting = safeName ? `Hello ${safeName},` : 'Hello,';

  return {
    subject: `${params.otp} is your verification code for meeting enquiry`,
    text: `${greeting}\n\nYour 6-digit email verification code is: ${params.otp}\n\nThis code will expire in 5 minutes. If you did not request this, please ignore this email.`,
    html: `
            <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 500px; border: 1px solid #e0e0e0; border-radius: 8px;">
              <h2 style="color: #2b6cb0;">Email Verification</h2>
              <p>${htmlGreeting}</p>
              <p>You requested to schedule a meeting with Vyshnav P C. Please use the verification code below to verify your email address:</p>
              <div style="font-size: 32px; font-weight: bold; letter-spacing: 6px; text-align: center; margin: 25px 0; padding: 15px; background: #f7fafc; border: 1px dashed #cbd5e0; color: #2d3748;">
                ${safeOtp}
              </div>
              <p style="color: #718096; font-size: 14px;">This code is valid for <strong>5 minutes</strong>. To prevent unauthorized requests, do not share this code.</p>
              <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
              <p style="font-size: 12px; color: #a0aec0;">Vyshnav P C &bull; AI & Full-Stack Engineer &bull; Guaranteed response within 24 hours.</p>
            </div>
          `,
  };
}

export function buildLeadNotificationEmail(params: {
  name: string;
  email: string;
  phone: string;
  reason: string;
}) {
  const safeName = escapeHtml(params.name);
  const safeEmail = escapeHtml(params.email);
  const safePhone = escapeHtml(params.phone);
  const safeReason = escapeHtml(params.reason);

  return {
    subject: `New Meeting Lead: ${params.name} (${params.email})`,
    text: `New verified enquiry received!\n\nName: ${params.name}\nEmail: ${params.email}\nPhone: ${params.phone}\nReason:\n${params.reason}\n\nReminder: You promised to respond within 24 hours!`,
    html: `
            <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 600px; border: 1px solid #e0e0e0; border-radius: 8px;">
              <h2 style="color: #2b6cb0;">New Verified Meeting Lead</h2>
              <p>A client has verified their email and submitted a meeting request:</p>
              <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
                <tr><td style="padding: 8px; font-weight: bold; width: 120px;">Name:</td><td style="padding: 8px;">${safeName}</td></tr>
                <tr><td style="padding: 8px; font-weight: bold;">Email:</td><td style="padding: 8px;"><a href="mailto:${safeEmail}">${safeEmail}</a> (Verified)</td></tr>
                <tr><td style="padding: 8px; font-weight: bold;">Phone:</td><td style="padding: 8px;">${safePhone}</td></tr>
                <tr><td style="padding: 8px; font-weight: bold;">Reason:</td><td style="padding: 8px;">${safeReason}</td></tr>
              </table>
              <div style="margin-top: 20px; padding: 12px; background: #ebf8ff; border-left: 4px solid #3182ce; color: #2b6cb0;">
                <strong>Commitment:</strong> Get in touch with this user within 24 hours.
              </div>
            </div>
          `,
  };
}
