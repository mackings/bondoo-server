import { randomInt, createHash } from "node:crypto";
import { config } from "./config.js";

type OtpRecord = {
  codeHash: string;
  expiresAt: number;
  attempts: number;
};

const otpStore = new Map<string, OtpRecord>();
const otpTtlMs = 10 * 60 * 1000;
const maxAttempts = 5;

function hashOtp(code: string) {
  return createHash("sha256").update(code).digest("hex");
}

function otpKey(userId: string, destination: string) {
  return `${userId}:${destination.toLowerCase()}`;
}

export async function sendEmailOtp(params: {
  userId: string;
  toEmail: string;
  toName?: string;
}) {
  if (!config.mailjetApiKey || !config.mailjetApiSecret) {
    throw new Error("Mailjet is not configured");
  }

  const code = randomInt(100000, 1000000).toString();
  otpStore.set(otpKey(params.userId, params.toEmail), {
    codeHash: hashOtp(code),
    expiresAt: Date.now() + otpTtlMs,
    attempts: 0,
  });

  const auth = Buffer.from(`${config.mailjetApiKey}:${config.mailjetApiSecret}`).toString("base64");
  const response = await fetch("https://api.mailjet.com/v3.1/send", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      Messages: [
        {
          From: {
            Email: config.mailjetFromEmail,
            Name: config.mailjetFromName,
          },
          To: [
            {
              Email: params.toEmail,
              Name: params.toName ?? params.toEmail,
            },
          ],
          Subject: "Your BONDOO verification code",
          TextPart: `Your BONDOO verification code is ${code}. It expires in 10 minutes.`,
          HTMLPart: `<p>Your BONDOO verification code is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Mailjet send failed: ${response.status} ${body}`);
  }
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
