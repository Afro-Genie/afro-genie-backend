import nodemailer from 'nodemailer';
import { env } from '../lib/env';
import { logger } from '../lib/logger';

const SMTP_SEND_TIMEOUT_MS = 15_000;

interface BrevoMailPayload {
  sender: { email: string; name?: string };
  to: Array<{ email: string; name?: string }>;
  subject: string;
  htmlContent: string;
  textContent: string;
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

// ─── Transport Layer ─────────────────────────────────────────────────────────

const sendViaBrevoApi = async (options: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> => {
  const apiKey = env.BREVO_API_KEY;
  if (!apiKey) {
    throw new Error('BREVO_API_KEY is not set');
  }

  const payload: BrevoMailPayload = {
    sender: { email: options.from, name: 'Afro Genie' },
    to: [{ email: options.to }],
    subject: options.subject,
    htmlContent: options.html,
    textContent: options.text,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SMTP_SEND_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Brevo API ${res.status}: ${body}`);
    }
  } finally {
    clearTimeout(timer);
  }
};

const createMailTransporter = () => {
  if (!env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_USER || !env.SMTP_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    requireTLS: env.SMTP_PORT !== 465,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS
    }
  });
};

const sendMailWithTimeout = (
  transporter: nodemailer.Transporter,
  mailOptions: nodemailer.SendMailOptions
): Promise<unknown> => {
  return Promise.race([
    transporter.sendMail(mailOptions),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`SMTP send timed out after ${SMTP_SEND_TIMEOUT_MS}ms`)), SMTP_SEND_TIMEOUT_MS)
    )
  ]);
};

// ─── Core Send Function ──────────────────────────────────────────────────────

export const sendEmail = async (options: SendEmailOptions): Promise<void> => {
  const from = env.SMTP_FROM_EMAIL;
  if (!from) {
    logger.warn({ to: options.to, subject: options.subject }, 'SMTP_FROM_EMAIL not set; email not sent');
    return;
  }

  const text = options.text || options.html.replace(/<[^>]*>/g, '');

  if (env.BREVO_API_KEY) {
    logger.info({ method: 'brevo_api', to: options.to }, 'Sending email via Brevo HTTP API');
    await sendViaBrevoApi({ from, to: options.to, subject: options.subject, text, html: options.html });
    return;
  }

  const transporter = createMailTransporter();
  if (!transporter) {
    throw new Error('No email transport available: set BREVO_API_KEY or SMTP_* env vars');
  }

  logger.info({ method: 'smtp', to: options.to }, 'Sending email via SMTP');
  await sendMailWithTimeout(transporter, { from, to: options.to, subject: options.subject, text, html: options.html });
};

// ─── Artist Application Emails ───────────────────────────────────────────────

export const sendArtistApplicationConfirmation = async (email: string, stageName: string): Promise<void> => {
  try {
    await sendEmail({
      to: email,
      subject: 'Your Artist Application Has Been Received',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1a1a2e;">Application Received</h2>
          <p>Hi ${stageName},</p>
          <p>Thank you for applying to join Afro Genie as a verified artist. We have received your application and our team will review it shortly.</p>
          <p><strong>Stage Name:</strong> ${stageName}</p>
          <p>You will receive another email once your application has been reviewed.</p>
          <br>
          <p>Best regards,<br>The Afro Genie Team</p>
        </div>
      `,
    });
    logger.info({ email, stageName }, 'Artist application confirmation email sent');
  } catch (err) {
    logger.error({ err, email, stageName }, 'Failed to send artist application confirmation email');
  }
};

export const sendApplicationApproved = async (email: string, stageName: string): Promise<void> => {
  try {
    await sendEmail({
      to: email,
      subject: 'Your Artist Application Has Been Approved!',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2ecc71;">Application Approved</h2>
          <p>Hi ${stageName},</p>
          <p>Congratulations! Your application to join Afro Genie as a verified artist has been <strong>approved</strong>.</p>
          <p>You can now access your Artist Dashboard to manage your songs, releases, and analytics.</p>
          <p><a href="${env.CLIENT_URL}/#/artist/dashboard" style="display: inline-block; padding: 12px 24px; background-color: #1a1a2e; color: white; text-decoration: none; border-radius: 4px;">Go to Dashboard</a></p>
          <br>
          <p>Welcome aboard!<br>The Afro Genie Team</p>
        </div>
      `,
    });
    logger.info({ email, stageName }, 'Application approved email sent');
  } catch (err) {
    logger.error({ err, email, stageName }, 'Failed to send application approved email');
  }
};

export const sendApplicationRejected = async (email: string, stageName: string, reason?: string): Promise<void> => {
  try {
    const reasonSection = reason
      ? `<p><strong>Reason:</strong> ${reason}</p>`
      : '';

    await sendEmail({
      to: email,
      subject: 'Update on Your Artist Application',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #e74c3c;">Application Update</h2>
          <p>Hi ${stageName},</p>
          <p>Thank you for your interest in joining Afro Genie as a verified artist.</p>
          <p>After careful review, we are unable to approve your application at this time.</p>
          ${reasonSection}
          <p>You are welcome to reapply after addressing the feedback above.</p>
          <br>
          <p>Best regards,<br>The Afro Genie Team</p>
        </div>
      `,
    });
    logger.info({ email, stageName }, 'Application rejected email sent');
  } catch (err) {
    logger.error({ err, email, stageName }, 'Failed to send application rejected email');
  }
};

// ─── Debug / Health ──────────────────────────────────────────────────────────

export const getSmtpDebugInfo = async (): Promise<Record<string, unknown>> => {
  const hasAllVars = Boolean(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_USER && env.SMTP_PASS);
  const hasApiKey = Boolean(env.BREVO_API_KEY);

  const result: Record<string, unknown> = {
    brevoApiKeySet: hasApiKey,
    transportMethod: hasApiKey ? 'brevo_http_api' : (hasAllVars ? 'smtp' : 'none'),
    hostSet: !!env.SMTP_HOST,
    portSet: !!env.SMTP_PORT,
    userSet: !!env.SMTP_USER,
    passSet: !!env.SMTP_PASS,
    fromEmail: env.SMTP_FROM_EMAIL || 'NOT SET',
    clientUrl: env.CLIENT_URL,
  };

  if (hasApiKey) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': env.BREVO_API_KEY!,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          sender: { email: env.SMTP_FROM_EMAIL || 'test@test.com' },
          to: [{ email: env.SMTP_FROM_EMAIL || 'test@test.com' }],
          subject: 'SMTP Debug Test',
          textContent: 'test',
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 401) {
        result.status = 'FAILED — Brevo API key is invalid (401 Unauthorized)';
      } else if (res.status === 400) {
        result.status = 'OK — Brevo API reachable, key is valid (400 = test payload rejected, expected)';
      } else if (res.ok) {
        result.status = 'OK — Brevo HTTP API connected and working';
      } else {
        const body = await res.text();
        result.status = `BREVO API ${res.status}: ${body}`;
      }
    } catch (err: any) {
      result.status = `FAILED — ${err.message}`;
    }
    return result;
  }

  if (!hasAllVars) {
    result.status = 'INCOMPLETE — set BREVO_API_KEY (preferred) or all SMTP_* vars';
    return result;
  }

  const transporter = createMailTransporter();
  if (!transporter) {
    result.status = 'UNEXPECTED — transporter is null despite all vars present';
    return result;
  }

  try {
    await Promise.race([
      transporter.verify(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('SMTP verify timed out after 10s')), 10_000)
      )
    ]);
    result.status = 'OK — SMTP connection and auth verified';
  } catch (err: any) {
    result.status = `FAILED — ${err.message}`;
  }

  return result;
};
