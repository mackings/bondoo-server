import { createHmac, randomUUID } from "node:crypto";
import { config } from "../../../config.js";

type WithdrawParams = {
  coin: string;
  chain: string;
  address: string;
  amount: string;
};

type DepositAddressResult = {
  address: string;
  tag?: string;
};

type DepositRecord = {
  txID: string;
  coin: string;
  chain: string;
  amount: string;
  status: number; // 0=unknown,1=toBeConfirmed,2=processing,3=success,4=deposit failed
  depositType: number;
  insertTime: number;
};

export class BybitClient {
  private sign(timestamp: string, params: string) {
    return createHmac("sha256", config.bybitApiSecret ?? "")
      .update(`${timestamp}${config.bybitApiKey}5000${params}`)
      .digest("hex");
  }

  private get isDryRun() {
    return config.bybitDryRun || !config.bybitApiKey || !config.bybitApiSecret;
  }

  async withdraw(params: WithdrawParams) {
    if (this.isDryRun) {
      return { id: `dry_run_${randomUUID()}`, dryRun: true };
    }

    const path = "/v5/asset/withdraw/create";
    const timestamp = Date.now().toString();
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
    const signature = this.sign(timestamp, body);

    const response = await fetch(`${config.bybitBaseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-BAPI-API-KEY": config.bybitApiKey!,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": "5000",
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

  async getDepositAddress(coin: string, chainType: string): Promise<DepositAddressResult> {
    if (this.isDryRun) {
      return { address: `DRY_RUN_${coin}_${chainType}_ADDRESS`, tag: undefined };
    }

    const timestamp = Date.now().toString();
    const queryString = `coin=${coin}&chainType=${chainType}`;
    const signature = this.sign(timestamp, queryString);

    const response = await fetch(
      `${config.bybitBaseUrl}/v5/asset/deposit/query-address?${queryString}`,
      {
        headers: {
          "X-BAPI-API-KEY": config.bybitApiKey!,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": "5000",
          "X-BAPI-SIGN": signature,
        },
      },
    );
    const json = await response.json() as any;
    if (!response.ok || json.retCode !== 0) {
      throw new Error(json.retMsg ?? `Bybit getDepositAddress failed (${response.status})`);
    }

    const chains: any[] = json.result?.chains ?? [];
    const chain = chains.find((c: any) => c.chainType?.toUpperCase() === chainType.toUpperCase()) ?? chains[0];
    if (!chain) throw new Error(`No deposit address found for ${coin} / ${chainType}`);

    return {
      address: chain.addressDeposit as string,
      tag: chain.tagDeposit || undefined,
    };
  }

  // Polls Bybit deposit records to find a matching deposit for a trade.
  // Returns the txID if a successful deposit >= minAmount is found after startTime.
  async findDeposit(params: {
    coin: string;
    chainType: string;
    minAmount: number;
    afterTimestamp: number; // ms
  }): Promise<{ txID: string; amount: string } | null> {
    if (this.isDryRun) {
      return { txID: `dry_run_tx_${randomUUID()}`, amount: String(params.minAmount) };
    }

    const timestamp = Date.now().toString();
    const startTime = params.afterTimestamp;
    const queryString = `coin=${params.coin}&startTime=${startTime}&limit=50`;
    const signature = this.sign(timestamp, queryString);

    const response = await fetch(
      `${config.bybitBaseUrl}/v5/asset/deposit/query-record?${queryString}`,
      {
        headers: {
          "X-BAPI-API-KEY": config.bybitApiKey!,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": "5000",
          "X-BAPI-SIGN": signature,
        },
      },
    );
    const json = await response.json() as any;
    if (!response.ok || json.retCode !== 0) {
      throw new Error(json.retMsg ?? `Bybit deposit query failed (${response.status})`);
    }

    const rows: DepositRecord[] = json.result?.rows ?? [];
    const match = rows.find(
      (r) =>
        r.coin === params.coin &&
        r.chain?.toUpperCase() === params.chainType.toUpperCase() &&
        r.status === 3 && // success
        parseFloat(r.amount) >= params.minAmount * 0.999, // 0.1% tolerance for rounding
    );

    return match ? { txID: match.txID, amount: match.amount } : null;
  }
}

export const bybitClient = new BybitClient();
