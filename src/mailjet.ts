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
const mailjetBaseUrl = "https://api.mailjet.com";

function hashOtp(code: string) {
  return createHash("sha256").update(code).digest("hex");
}

function otpKey(userId: string, destination: string) {
  return `${userId}:${destination.toLowerCase()}`;
}

function mailjetAuthHeader() {
  return `Basic ${Buffer.from(`${config.mailjetApiKey}:${config.mailjetApiSecret}`).toString("base64")}`;
}

export async function sendEmailOtp(params: {
  userId: string;
  toEmail: string;
  toName?: string;
}) {
  if (!config.mailjetApiKey || !config.mailjetApiSecret) {
    throw new Error("Mailjet is not configured");
  }

  const code = randomInt(1000, 10000).toString();
  const response = await fetch(`${mailjetBaseUrl}/v3.1/send`, {
    method: "POST",
    headers: {
      Authorization: mailjetAuthHeader(),
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

  const rawBody = await response.text();
  let body: any = null;
  try {
    body = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    console.error("Mailjet HTTP send failed", {
      status: response.status,
      body: rawBody.slice(0, 1200),
    });
    throw new Error(`Mailjet send failed: ${response.status}`);
  }

  const message = body?.Messages?.[0];
  const status = message?.Status;
  const to = message?.To?.[0];
  const messageId = to?.MessageID ?? to?.MessageUUID ?? null;
  const messageHref = to?.MessageHref ?? null;
  if (status !== "success") {
    console.error("Mailjet rejected OTP email", {
      status,
      errors: message?.Errors ?? null,
      toStatus: to?.MessageHref ? "has-message-href" : null,
    });
    throw new Error("Mailjet did not accept the OTP email");
  }

  otpStore.set(otpKey(params.userId, params.toEmail), {
    codeHash: hashOtp(code),
    expiresAt: Date.now() + otpTtlMs,
    attempts: 0,
  });

  console.log("Mailjet OTP email accepted", {
    status,
    messageId,
    messageHref,
    toDomain: params.toEmail.split("@")[1]?.toLowerCase() ?? "unknown",
  });

  return { status, messageId, messageHref };
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
