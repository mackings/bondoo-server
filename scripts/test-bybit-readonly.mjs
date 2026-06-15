import "dotenv/config";
import { createHmac } from "node:crypto";

const apiKey = process.env.BYBIT_API_KEY;
const apiSecret = process.env.BYBIT_API_SECRET;
const baseUrl = process.env.BYBIT_BASE_URL ?? (process.env.BYBIT_TESTNET === "true" ? "https://api-testnet.bybit.com" : "https://api.bybit.com");

if (!apiKey || !apiSecret) throw new Error("Missing BYBIT_API_KEY/BYBIT_API_SECRET");

const path = "/v5/account/wallet-balance";
const query = "accountType=UNIFIED";
const timestamp = Date.now().toString();
const recvWindow = "5000";
const signature = createHmac("sha256", apiSecret)
  .update(`${timestamp}${apiKey}${recvWindow}${query}`)
  .digest("hex");

const response = await fetch(`${baseUrl}${path}?${query}`, {
  headers: {
    "X-BAPI-API-KEY": apiKey,
    "X-BAPI-TIMESTAMP": timestamp,
    "X-BAPI-RECV-WINDOW": recvWindow,
    "X-BAPI-SIGN": signature,
  },
});
const body = await response.json();
if (!response.ok || body.retCode !== 0) {
  console.log(`FAIL Bybit wallet-balance -> HTTP ${response.status}, retCode ${body.retCode}, ${body.retMsg}`);
  process.exitCode = 1;
} else {
  console.log(`PASS Bybit wallet-balance -> ${body.result?.list?.length ?? 0} account records`);
}
