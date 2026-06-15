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
  mailjetApiKey: process.env.MAILJET_API_KEY,
  mailjetApiSecret: process.env.MAILJET_API_SECRET,
  mailjetFromEmail: process.env.MAILJET_FROM_EMAIL ?? "no-reply@bondoo.app",
  mailjetFromName: process.env.MAILJET_FROM_NAME ?? "BONDOO",
  escrowDepositAddress: process.env.ESCROW_DEPOSIT_ADDRESS ?? process.env.BYBIT_DEPOSIT_ADDRESS ?? process.env.BANK_BTC_ADDRESS ?? "1H9JgpE3vC3fb9fVkwN1LhnTmaFD2x4ix3",
  bybitApiKey: process.env.BYBIT_API_KEY,
  bybitApiSecret: process.env.BYBIT_API_SECRET,
  bybitBaseUrl: process.env.BYBIT_BASE_URL ?? (process.env.BYBIT_TESTNET === "true" ? "https://api-testnet.bybit.com" : "https://api.bybit.com"),
  bybitDryRun: process.env.BYBIT_DRY_RUN !== "false",
};
