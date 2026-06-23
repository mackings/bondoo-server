import { config } from "./config.js";
import { createSign } from "node:crypto";
import { sendEmail } from "./mailjet.js";
import { PushTokenModel } from "./models/push-token.js";

type NotifyParams = {
  user: any;
  title: string;
  body: string;
  data?: Record<string, string>;
};

let fcmAccessToken: { token: string; expiresAt: number } | null = null;

export async function notifyUser(params: NotifyParams) {
  await Promise.allSettled([
    notifyUserByEmail(params),
    notifyUserByPush(params),
  ]);
}

export async function notifyUserPushOnly(params: NotifyParams) {
  await notifyUserByPush(params);
}

async function notifyUserByEmail({ user, title, body }: NotifyParams) {
  if (!user?.email) return;
  await sendEmail({
    to: user.email,
    subject: title,
    textContent: body,
    htmlContent: `<p>${escapeHtml(body)}</p>`,
  });
}

async function notifyUserByPush({ user, title, body, data = {} }: NotifyParams) {
  if (!config.fcmServerKey && !config.fcmServiceAccountJson) return;
  const tokens = await PushTokenModel.find({ userId: user._id }).limit(20);
  if (tokens.length === 0) return;

  await Promise.allSettled(
    tokens.map(async (row) => {
      const response = config.fcmServiceAccountJson
        ? await sendFcmV1({
            token: row.token,
            title,
            body,
            data,
          })
        : await sendFcmLegacy({
            token: row.token,
            title,
            body,
            data,
          });

      if (response.status === 404 || response.status === 410) {
        await PushTokenModel.deleteOne({ _id: row._id });
      }
      if (!response.ok) {
        const message = await response.text().catch(() => "");
        console.warn("FCM push failed", { status: response.status, message });
      }
    }),
  );
}

async function sendFcmLegacy(params: {
  token: string;
  title: string;
  body: string;
  data: Record<string, string>;
}) {
  const channelId = notificationChannelId(params.data);
  return fetch("https://fcm.googleapis.com/fcm/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `key=${config.fcmServerKey}`,
    },
    body: JSON.stringify({
      to: params.token,
      notification: {
        title: params.title,
        body: params.body,
        sound: "default",
        android_channel_id: channelId,
      },
      data: params.data,
      priority: "high",
    }),
  });
}

async function sendFcmV1(params: {
  token: string;
  title: string;
  body: string;
  data: Record<string, string>;
}) {
  const serviceAccount = JSON.parse(config.fcmServiceAccountJson!);
  const accessToken = await getFcmAccessToken(serviceAccount);
  const channelId = notificationChannelId(params.data);
  const isCall = params.data.type === "incoming_call";
  return fetch(
    `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        message: {
          token: params.token,
          notification: { title: params.title, body: params.body },
          data: params.data,
          android: {
            priority: "HIGH",
            notification: {
              channel_id: channelId,
              sound: "default",
              notification_priority: isCall ? "PRIORITY_MAX" : "PRIORITY_HIGH",
              default_vibrate_timings: true,
            },
          },
          apns: {
            payload: {
              aps: {
                sound: "default",
                "interruption-level": isCall ? "time-sensitive" : "active",
              },
            },
          },
        },
      }),
    },
  );
}

function notificationChannelId(data: Record<string, string>) {
  return data.type === "incoming_call" ? "incoming_calls" : "chat_messages";
}

async function getFcmAccessToken(serviceAccount: any) {
  const now = Math.floor(Date.now() / 1000);
  if (fcmAccessToken && fcmAccessToken.expiresAt > now + 60) {
    return fcmAccessToken.token;
  }

  const assertion = signJwt({
    header: { alg: "RS256", typ: "JWT" },
    payload: {
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    },
    privateKey: serviceAccount.private_key,
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) {
    throw new Error(`FCM OAuth failed (${response.status})`);
  }
  const json = await response.json() as any;
  fcmAccessToken = {
    token: json.access_token,
    expiresAt: now + Number(json.expires_in ?? 3600),
  };
  return fcmAccessToken.token;
}

function signJwt(params: {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  privateKey: string;
}) {
  const unsigned = [
    base64Url(JSON.stringify(params.header)),
    base64Url(JSON.stringify(params.payload)),
  ].join(".");
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(params.privateKey);
  return `${unsigned}.${base64Url(signature)}`;
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
