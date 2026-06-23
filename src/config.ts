import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(here, "..");

for (const path of [
  resolve(backendRoot, ".env"),
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "..", ".env"),
  resolve(process.cwd(), "..", "..", ".env"),
]) {
  if (existsSync(path)) dotenv.config({ path, override: false });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  mongodbUri: required("MONGODB_URI"),
  jwtSecret: required("JWT_SECRET"),
  bankBtcAddress: process.env.BANK_BTC_ADDRESS ?? "1H9JgpE3vC3fb9fVkwN1LhnTmaFD2x4ix3",
  emailHost: process.env.EMAIL_HOST ?? process.env.SMTP_HOST ?? "smtp.gmail.com",
  emailPort: Number(process.env.EMAIL_PORT ?? process.env.SMTP_PORT ?? 587),
  emailUser: process.env.EMAIL_USER ?? process.env.SMTP_USER,
  emailPassword: process.env.EMAIL_PASSWORD ?? process.env.SMTP_PASS,
  emailFrom: process.env.EMAIL_FROM ?? process.env.EMAIL_USER ?? process.env.SMTP_USER,
  emailFromName: process.env.EMAIL_FROM_NAME ?? process.env.SMTP_FROM ?? "BONDOO",
  escrowDepositAddress: process.env.ESCROW_DEPOSIT_ADDRESS ?? process.env.BYBIT_DEPOSIT_ADDRESS ?? process.env.BANK_BTC_ADDRESS ?? "1H9JgpE3vC3fb9fVkwN1LhnTmaFD2x4ix3",
  bybitApiKey: process.env.BYBIT_API_KEY,
  bybitApiSecret: process.env.BYBIT_API_SECRET,
  bybitBaseUrl: process.env.BYBIT_BASE_URL ?? (process.env.BYBIT_TESTNET === "true" ? "https://api-testnet.bybit.com" : "https://api.bybit.com"),
  bybitDryRun: process.env.BYBIT_DRY_RUN !== "false",
  agoraAppId: process.env.AGORA_APP_ID ?? "d454d5abab694b20ae57c6a5b4953e0a",
  agoraAppCertificate: process.env.AGORA_APP_CERTIFICATE,
  agoraTokenTtlSeconds: Number(process.env.AGORA_TOKEN_TTL_SECONDS ?? 3600),
  fcmServerKey: process.env.FCM_SERVER_KEY,
  fcmServiceAccountJson: process.env.FCM_SERVICE_ACCOUNT_JSON,
};
