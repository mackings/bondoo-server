import { randomInt, createHash } from "node:crypto";
import { config } from "./config.js";

type OtpRecord = {
  codeHash: string;
  expiresAt: number;
  attempts: number;
};

type SendEmailResult =
  | { success: true; messageId: string | number | null }
  | { success: false; error: string };

const otpStore    = new Map<string, OtpRecord>();
const otpTtlMs    = 10 * 60 * 1000;
const maxAttempts = 5;

function hashOtp(code: string) {
  return createHash("sha256").update(code).digest("hex");
}

function otpKey(userId: string, destination: string) {
  return `${userId}:${destination.toLowerCase()}`;
}

export const sendEmail = async ({
  to,
  subject,
  textContent,
  htmlContent,
}: {
  to: string | string[];
  subject: string;
  textContent?: string;
  htmlContent: string;
}): Promise<SendEmailResult> => {
  try {
    if (!config.resendApiKey) {
      console.warn("[Email] RESEND_API_KEY not set — email not sent:", { to, subject });
      return { success: false, error: "RESEND_API_KEY not configured" };
    }

    const body = {
      from: `${config.emailFromName} <${config.resendFrom}>`,
      to:   Array.isArray(to) ? to : [to],
      subject,
      html: htmlContent,
      ...(textContent ? { text: textContent } : {}),
    };

    const res = await fetch("https://api.resend.com/emails", {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${config.resendApiKey}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await res.json() as any;

    if (!res.ok) {
      const msg = data?.message ?? data?.name ?? `Resend API error ${res.status}`;
      console.error("[Email] Resend error:", msg);
      return { success: false, error: msg };
    }

    console.log(`[Email] Sent via Resend: ${data.id} → ${Array.isArray(to) ? to.join(", ") : to}`);
    return { success: true, messageId: data.id };
  } catch (error: any) {
    console.error("[Email] sendEmail failed:", error.message);
    return { success: false, error: error.message ?? "Email sending failed" };
  }
};

export async function sendEmailOtp(params: {
  userId: string;
  toEmail: string;
  toName?: string;
}) {
  const code        = randomInt(1000, 10000).toString();
  const textContent = `Your BONDOO verification code is ${code}. It expires in 10 minutes.`;
  const htmlContent = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
      <h2 style="margin:0 0 8px;color:#111">Your verification code</h2>
      <p style="color:#555;margin:0 0 24px">Use the code below to verify your BONDOO account. It expires in 10 minutes.</p>
      <div style="background:#f4f4f5;border-radius:12px;padding:24px;text-align:center">
        <span style="font-size:36px;font-weight:900;letter-spacing:8px;color:#111">${code}</span>
      </div>
      <p style="color:#999;font-size:12px;margin-top:24px">If you didn't request this, you can safely ignore this email.</p>
    </div>
  `;

  const result = await sendEmail({
    to: params.toEmail,
    subject: "Your BONDOO verification code",
    textContent,
    htmlContent,
  });

  if (!result.success) throw new Error(result.error ?? "Email sending failed");

  otpStore.set(otpKey(params.userId, params.toEmail), {
    codeHash:  hashOtp(code),
    expiresAt: Date.now() + otpTtlMs,
    attempts:  0,
  });

  console.log("[Email] OTP sent", {
    toDomain: params.toEmail.split("@")[1]?.toLowerCase() ?? "unknown",
    messageId: result.messageId,
  });

  return { status: "success", messageId: result.messageId };
}

export function verifyEmailOtp(params: {
  userId: string;
  email: string;
  code: string;
}) {
  const key    = otpKey(params.userId, params.email);
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
