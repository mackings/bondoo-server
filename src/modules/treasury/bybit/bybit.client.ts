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

// Shape of a single row from Bybit GET /v5/asset/deposit/query-record
type BybitDepositRow = {
  coin: string;
  chain: string;       // Bybit's internal chain identifier — may differ from chainType used in other endpoints
  amount: string;
  txID: string;
  status: number;      // 0=unknown 1=toBeConfirmed 2=processing 3=success 4=failed
  toAddress: string;   // the address the funds were sent to
  depositType: number;
  successAt: string;
};

// Maps our network strings (as stored in the DB / sent by the app) to the chain
// identifier that Bybit's withdrawal API expects. These are two different systems:
//   - getDepositAddress uses chainType: "ERC20", "TRC20"
//   - withdraw/create uses chain:     "ETH",   "TRX"
// Source: Bybit v5 API docs + confirmed from coin/query-info endpoint chain field.
const NETWORK_TO_BYBIT_CHAIN: Record<string, string> = {
  BTC:    "BTC",
  ERC20:  "ETH",
  TRC20:  "TRX",
  BSC:    "BSC",
  BEP20:  "BSC",
  SOL:    "SOL",
  MATIC:  "MATIC",
  ARBONE: "ARBONE",
  OP:     "OP",
};

export class BybitClient {

  private assertConfigured() {
    if (!config.bybitApiKey || !config.bybitApiSecret) {
      throw new Error(
        "Bybit API keys are not configured. Set BYBIT_API_KEY and BYBIT_API_SECRET in environment variables.",
      );
    }
  }

  // Converts our stored network string (e.g. "ERC20") to Bybit's chain identifier (e.g. "ETH").
  // Throws clearly if we try to withdraw on an unsupported network so bugs surface immediately.
  private resolveBybitChain(network: string): string {
    const chain = NETWORK_TO_BYBIT_CHAIN[network.toUpperCase()];
    if (!chain) {
      throw new Error(
        `Unsupported network "${network}" for Bybit withdrawal. ` +
        `Supported: ${Object.keys(NETWORK_TO_BYBIT_CHAIN).join(", ")}`,
      );
    }
    return chain;
  }

  private sign(timestamp: string, params: string) {
    return createHmac("sha256", config.bybitApiSecret!)
      .update(`${timestamp}${config.bybitApiKey}5000${params}`)
      .digest("hex");
  }

  private headers(timestamp: string, signature: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-BAPI-API-KEY": config.bybitApiKey!,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": "5000",
      "X-BAPI-SIGN": signature,
    };
  }

  // ── getDepositAddress ───────────────────────────────────────────────────
  // Fetches the Bybit FUND account deposit address for a given coin + chainType.
  // chainType must match Bybit's value e.g. "BTC", "ERC20", "TRC20".
  async getDepositAddress(coin: string, chainType: string): Promise<DepositAddressResult> {
    this.assertConfigured();

    const timestamp = Date.now().toString();
    const queryString = `coin=${coin}&chainType=${chainType}`;
    const signature = this.sign(timestamp, queryString);

    const response = await fetch(
      `${config.bybitBaseUrl}/v5/asset/deposit/query-address?${queryString}`,
      { headers: this.headers(timestamp, signature) },
    );

    const json = await response.json() as any;

    if (!response.ok || json.retCode !== 0) {
      throw new Error(
        `Bybit getDepositAddress failed (retCode=${json.retCode}): ${json.retMsg ?? response.status}`,
      );
    }

    const chains: any[] = json.result?.chains ?? [];
    const chain = chains.find(
      (c: any) => c.chainType?.toUpperCase() === chainType.toUpperCase(),
    ) ?? chains[0];

    if (!chain?.addressDeposit) {
      throw new Error(
        `Bybit returned no deposit address for ${coin} on chain ${chainType}. ` +
        `Make sure this coin+chain is enabled on your Bybit account.`,
      );
    }

    console.log(`[Bybit] getDepositAddress: ${coin}/${chainType} → ${chain.addressDeposit}`);

    return {
      address: chain.addressDeposit as string,
      tag: chain.tagDeposit || undefined,
    };
  }

  // ── findDeposit ────────────────────────────────────────────────────────
  // Queries Bybit deposit history and finds a confirmed deposit that matches:
  //   - exact coin
  //   - exact deposit address (the address we gave the seller — bullet-proof, avoids chain name mismatches)
  //   - amount >= minAmount with 0.1% tolerance (covers blockchain fee rounding)
  //   - status = 3 (confirmed by blockchain)
  //   - deposit arrived after afterTimestamp (so we don't pick up old deposits)
  //
  // Returns null if no matching confirmed deposit exists yet.
  // NEVER returns a fake result — all data comes directly from the Bybit API.
  async findDeposit(params: {
    coin: string;
    depositAddress: string;  // the exact address we generated for this trade
    minAmount: number;
    afterTimestamp: number;  // ms epoch — trade creation time
  }): Promise<{ txID: string; amount: string } | null> {
    this.assertConfigured();

    const timestamp = Date.now().toString();
    // Query deposits for this coin from trade creation time, most recent first
    const queryString = `coin=${params.coin}&startTime=${params.afterTimestamp}&limit=50`;
    const signature = this.sign(timestamp, queryString);

    const response = await fetch(
      `${config.bybitBaseUrl}/v5/asset/deposit/query-record?${queryString}`,
      { headers: this.headers(timestamp, signature) },
    );

    const json = await response.json() as any;

    if (!response.ok || json.retCode !== 0) {
      throw new Error(
        `Bybit deposit query failed (retCode=${json.retCode}): ${json.retMsg ?? response.status}`,
      );
    }

    const rows: BybitDepositRow[] = json.result?.rows ?? [];

    console.log(
      `[Bybit] findDeposit: ${rows.length} record(s) for ${params.coin} ` +
      `after ${new Date(params.afterTimestamp).toISOString()}. ` +
      `Looking for address=${params.depositAddress} amount>=${params.minAmount}`,
    );

    // Log every row so we can see exactly what Bybit returned
    for (const r of rows) {
      console.log(
        `[Bybit]   row: coin=${r.coin} chain=${r.chain} toAddress=${r.toAddress} ` +
        `amount=${r.amount} status=${r.status} txID=${r.txID}`,
      );
    }

    const match = rows.find(
      (r) =>
        r.coin === params.coin &&
        r.toAddress?.toLowerCase() === params.depositAddress.toLowerCase() &&
        r.status === 3 &&  // 3 = blockchain confirmed
        parseFloat(r.amount) >= params.minAmount * 0.999,  // 0.1% tolerance for fee rounding
    );

    if (match) {
      console.log(
        `[Bybit] findDeposit: CONFIRMED match — txID=${match.txID} amount=${match.amount} coin=${match.coin}`,
      );
    } else {
      console.log(
        `[Bybit] findDeposit: no confirmed match found yet for ${params.minAmount} ${params.coin} at ${params.depositAddress}`,
      );
    }

    return match ? { txID: match.txID, amount: match.amount } : null;
  }

  // ── withdraw ───────────────────────────────────────────────────────────
  // Initiates a withdrawal from the Bybit FUND account to the buyer's wallet.
  // Throws a descriptive error if Bybit rejects the request.
  // The returned id is Bybit's withdrawal ID — store it for audit purposes.
  async withdraw(params: WithdrawParams): Promise<{ id: string }> {
    this.assertConfigured();

    const bybitChain = this.resolveBybitChain(params.chain);
    const timestamp = Date.now().toString();
    const body = JSON.stringify({
      coin: params.coin,
      chain: bybitChain,
      address: params.address,
      amount: params.amount,
      timestamp: Number(timestamp),
      forceChain: 1,
      accountType: "FUND",
      requestId: randomUUID().replace(/-/g, "").slice(0, 32),
    });
    const signature = this.sign(timestamp, body);

    console.log(
      `[Bybit] withdraw: initiating ${params.amount} ${params.coin} network=${params.chain} → bybitChain=${bybitChain} to ${params.address}`,
    );

    const response = await fetch(`${config.bybitBaseUrl}/v5/asset/withdraw/create`, {
      method: "POST",
      headers: this.headers(timestamp, signature),
      body,
    });

    const json = await response.json() as any;

    if (!response.ok || json.retCode !== 0) {
      throw new Error(
        `Bybit withdrawal failed (retCode=${json.retCode}): ${json.retMsg ?? response.status}`,
      );
    }

    const withdrawalId = json.result?.id as string | undefined;
    if (!withdrawalId) {
      throw new Error(
        "Bybit withdrawal API returned success but did not include a withdrawal ID. " +
        "Check the Bybit dashboard to confirm the withdrawal status.",
      );
    }

    console.log(
      `[Bybit] withdraw: SUCCESS — id=${withdrawalId} ${params.amount} ${params.coin} → ${params.address}`,
    );

    return { id: withdrawalId };
  }
}

export const bybitClient = new BybitClient();
