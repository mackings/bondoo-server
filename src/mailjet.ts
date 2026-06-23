import { randomInt, createHash } from "node:crypto";
import nodemailer from "nodemailer";
import { config } from "./config.js";

type OtpRecord = {
  codeHash: string;
  expiresAt: number;
  attempts: number;
};

type SendEmailResult =
  | { success: true; messageId: string | number | null }
  | { success: false; error: string };

const otpStore = new Map<string, OtpRecord>();
const otpTtlMs = 10 * 60 * 1000;
const maxAttempts = 5;

function hashOtp(code: string) {
  return createHash("sha256").update(code).digest("hex");
}

function otpKey(userId: string, destination: string) {
  return `${userId}:${destination.toLowerCase()}`;
}

const createTransporter = () => {
  return nodemailer.createTransport({
    host: config.emailHost,
    port: config.emailPort,
    secure: config.emailPort === 465,
    auth: {
      user: config.emailUser,
      pass: config.emailPassword,
    },
    tls: {
      rejectUnauthorized: false,
    },
  });
};

export const sendEmail = async ({ to, subject, textContent, htmlContent, attachments = [] }: {
  to: string | string[];
  subject: string;
  textContent?: string;
  htmlContent: string;
  attachments?: unknown[];
}): Promise<SendEmailResult> => {
  try {
    if (!to) throw new Error("Recipient email address is required");
    if (!subject) throw new Error("Email subject is required");
    if (!htmlContent) throw new Error("Email content is required");

    if (!config.emailUser || !config.emailPassword || !config.emailFrom) {
      console.warn("SMTP not configured. Email not sent:", { to, subject });
      return { success: false, error: "Email credentials not configured" };
    }

    const transporter = createTransporter();
    const message = {
      from: `"${config.emailFromName}" <${config.emailFrom}>`,
      to: Array.isArray(to) ? to.join(", ") : to,
      subject,
      text: textContent,
      html: htmlContent,
      attachments: Array.isArray(attachments) ? (attachments as any[]) : [],
    };

    const info = await transporter.sendMail(message) as any;

    console.log(`Email sent via SMTP: ${info.messageId} to ${to}`);
    return { success: true, messageId: info.messageId };
  } catch (error: any) {
    console.error("Email sending failed:", error.message);
    return { success: false, error: error.message ?? "Email sending failed" };
  }
};

export async function sendEmailOtp(params: {
  userId: string;
  toEmail: string;
  toName?: string;
}) {
  const code = randomInt(1000, 10000).toString();
  const textContent = `Your BONDOO verification code is ${code}. It expires in 10 minutes.`;
  const htmlContent = `<p>Your BONDOO verification code is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>`;
  const result = await sendEmail({
    to: params.toEmail,
    subject: "Your BONDOO verification code",
    textContent,
    htmlContent,
  });

  if (!result.success) {
    throw new Error(result.error ?? "Email sending failed");
  }

  otpStore.set(otpKey(params.userId, params.toEmail), {
    codeHash: hashOtp(code),
    expiresAt: Date.now() + otpTtlMs,
    attempts: 0,
  });

  console.log("SMTP OTP email accepted", {
    status: "success",
    messageId: result.messageId,
    toDomain: params.toEmail.split("@")[1]?.toLowerCase() ?? "unknown",
  });

  return { status: "success", messageId: result.messageId };
}

export function verifyEmailOtp(params: {
  userId: string;
  email: string;
  code: string;
}) {
  const key = otpKey(params.userId, params.email);
  const record = otpStore.get(key);
  if (!record) return { ok: false, error: "No active OTP" };
  if (Date.now() > record.expiresAt) {
    otpStore.delete(key);
    return { ok: false, error: "OTP expired" };
  }
  if (record.attempts >= maxAttempts) {
    otpStore.delete(key);
    return { ok: false, error: "Too many attempts" };
  }

  record.attempts += 1;
  if (record.codeHash !== hashOtp(params.code)) {
    return { ok: false, error: "Invalid OTP" };
  }

  otpStore.delete(key);
  return { ok: true };
}
