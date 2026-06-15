import { createHmac, randomUUID } from "node:crypto";
import { config } from "../../../config.js";

type WithdrawParams = {
  coin: string;
  chain: string;
  address: string;
  amount: string;
};

export class BybitClient {
  async withdraw(params: WithdrawParams) {
    if (config.bybitDryRun || !config.bybitApiKey || !config.bybitApiSecret) {
      return { id: `dry_run_${randomUUID()}`, dryRun: true };
    }

    const path = "/v5/asset/withdraw/create";
    const timestamp = Date.now().toString();
    const recvWindow = "5000";
    const body = JSON.stringify({
      coin: params.coin,
      chain: params.chain,
      address: params.address,
      amount: params.amount,
      timestamp: Number(timestamp),
      forceChain: 1,
      accountType: "FUND",
      requestId: randomUUID().replace(/-/g, "").slice(0, 32),
    });
    const signature = createHmac("sha256", config.bybitApiSecret)
      .update(`${timestamp}${config.bybitApiKey}${recvWindow}${body}`)
      .digest("hex");

    const response = await fetch(`${config.bybitBaseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-BAPI-API-KEY": config.bybitApiKey,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recvWindow,
        "X-BAPI-SIGN": signature,
      },
      body,
    });
    const json = await response.json() as any;
    if (!response.ok || json.retCode !== 0) {
      throw new Error(json.retMsg ?? `Bybit withdrawal failed (${response.status})`);
    }
    return { id: json.result?.id as string, dryRun: false };
  }
}

export const bybitClient = new BybitClient();
