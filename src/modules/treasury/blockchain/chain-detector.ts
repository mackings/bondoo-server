/**
 * On-chain deposit detection.
 *
 * Each network queries its own blockchain explorer API to find a confirmed
 * incoming transaction to a specific address.  We never share one deposit
 * address across trades, so the address match is always unambiguous.
 *
 * Networks supported:
 *   ERC20  → Etherscan (Sepolia on testnet, mainnet otherwise)
 *   BSC    → BSCScan   (testnet / mainnet)
 *   TRC20  → TronGrid  (Nile testnet / mainnet)
 *   BTC    → Blockstream (testnet / mainnet)
 */

import { config } from "../../../config.js";

type DepositResult = { txid: string; amount: string } | null;

// ── EVM (ETH native + ERC20 / BEP20 tokens) ─────────────────────────────────

// Mainnet token contracts
const EVM_CONTRACTS: Record<string, Record<"eth" | "bsc", string>> = {
  USDT: {
    eth: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    bsc: "0x55d398326f99059fF775485246999027B3197955",
  },
  USDC: {
    eth: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    bsc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  },
};

async function findEVMDeposit(params: {
  coin: string;
  address: string;
  minAmount: number;
  afterTimestamp: number;
  chain: "eth" | "bsc";
}): Promise<DepositResult> {
  const testnet = config.bybitTestnet;
  const coin = params.coin.toUpperCase();
  const contract = EVM_CONTRACTS[coin]?.[params.chain];

  let explorerBase: string;
  let apiKey: string;

  if (params.chain === "eth") {
    if (testnet) {
      // Blockscout Sepolia — Etherscan-compatible API, no API key required, no rate limits
      explorerBase = "https://eth-sepolia.blockscout.com/api";
      apiKey = "";
    } else {
      explorerBase = config.etherscanApiKey
        ? "https://api.etherscan.io/api"
        : "https://eth.blockscout.com/api"; // fallback: Blockscout mainnet, no key
      apiKey = config.etherscanApiKey ?? "";
    }
  } else {
    if (testnet) {
      explorerBase = "https://bsc-testnet.blockscout.com/api"; // Blockscout BSC testnet
      apiKey = "";
    } else {
      explorerBase = config.bscscanApiKey
        ? "https://api.bscscan.com/api"
        : "https://bsc.blockscout.com/api"; // fallback: Blockscout BSC mainnet
      apiKey = config.bscscanApiKey ?? "";
    }
  }

  // ── Token transfer detection ─────────────────────────────────────────────
  if (contract || (coin !== "ETH" && coin !== "BNB")) {
    // On mainnet: filter by USDT/USDC contract.
    // On testnet: query ALL ERC20 transfers (no official test USDT contract).
    const contractParam = !testnet && contract ? `&contractaddress=${contract}` : "";
    const url =
      `${explorerBase}?module=account&action=tokentx${contractParam}` +
      `&address=${encodeURIComponent(params.address)}&sort=desc&apikey=${apiKey}`;

    const data = await fetchJson(url);

    if (data.status === "1" && Array.isArray(data.result)) {
      const DECIMALS = ["USDT", "USDC"].includes(coin) ? 6 : 18;
      const match = (data.result as any[]).find(
        (tx) =>
          tx.to?.toLowerCase() === params.address.toLowerCase() &&
          Number(tx.timeStamp) * 1000 >= params.afterTimestamp &&
          Number(tx.value) / 10 ** DECIMALS >= params.minAmount * 0.999,
      );
      if (match) {
        const amt = (Number(match.value) / 10 ** DECIMALS).toString();
        return { txid: match.hash, amount: amt };
      }
    }
  }

  // ── Native ETH / BNB detection (also catches any testnet ETH deposits) ──
  const nativeUrl =
    `${explorerBase}?module=account&action=txlist` +
    `&address=${encodeURIComponent(params.address)}&sort=desc&apikey=${apiKey}`;

  const nativeData = await fetchJson(nativeUrl);
  if (nativeData.status === "1" && Array.isArray(nativeData.result)) {
    const match = (nativeData.result as any[]).find(
      (tx) =>
        tx.to?.toLowerCase() === params.address.toLowerCase() &&
        tx.isError === "0" &&
        Number(tx.timeStamp) * 1000 >= params.afterTimestamp &&
        Number(tx.value) / 1e18 >= params.minAmount * 0.999,
    );
    if (match) {
      const amt = (Number(match.value) / 1e18).toString();
      return { txid: match.hash, amount: amt };
    }
  }

  return null;
}

// ── TRON (TRC20) ─────────────────────────────────────────────────────────────

const TRON_USDT_MAINNET = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

async function findTRC20Deposit(params: {
  coin: string;
  address: string;
  minAmount: number;
  afterTimestamp: number;
}): Promise<DepositResult> {
  const testnet = config.bybitTestnet;
  const baseUrl = testnet ? "https://nile.trongrid.io" : "https://api.trongrid.io";

  // On mainnet: filter by USDT contract; on testnet: accept any TRC20 token transfer
  const contractParam =
    !testnet && params.coin.toUpperCase() === "USDT"
      ? `&contract_address=${TRON_USDT_MAINNET}`
      : "";

  const url =
    `${baseUrl}/v1/accounts/${params.address}/transactions/trc20` +
    `?limit=50&order_by=block_timestamp,desc${contractParam}`;

  const headers: Record<string, string> = {};
  if (config.tronGridApiKey) headers["TRON-PRO-API-KEY"] = config.tronGridApiKey;

  const data = await fetchJson(url, headers);
  const txs: any[] = Array.isArray(data.data) ? data.data : [];

  const match = txs.find(
    (tx) =>
      tx.to?.toLowerCase() === params.address.toLowerCase() &&
      Number(tx.block_timestamp) >= params.afterTimestamp &&
      Number(tx.value) / 1e6 >= params.minAmount * 0.999, // USDT TRC20 has 6 decimals
  );

  if (match) {
    const amt = (Number(match.value) / 1e6).toString();
    return { txid: match.transaction_id, amount: amt };
  }
  return null;
}

// ── Bitcoin ───────────────────────────────────────────────────────────────────

async function findBTCDeposit(params: {
  address: string;
  minAmount: number;
  afterTimestamp: number;
}): Promise<DepositResult> {
  const testnet = config.bybitTestnet;
  const base = testnet
    ? "https://blockstream.info/testnet/api"
    : "https://blockstream.info/api";

  const url = `${base}/address/${params.address}/txs`;
  const txs = await fetchJson(url);
  if (!Array.isArray(txs)) return null;

  for (const tx of txs) {
    if (!tx.status?.confirmed) continue; // skip unconfirmed
    const blockTime: number = (tx.status?.block_time ?? 0) * 1000;
    if (blockTime > 0 && blockTime < params.afterTimestamp) continue;

    const received: number = (tx.vout as any[])
      .filter((v) => v.scriptpubkey_address === params.address)
      .reduce((sum, v) => sum + Number(v.value), 0) / 1e8; // satoshi → BTC

    if (received >= params.minAmount * 0.999) {
      return { txid: tx.txid, amount: received.toString() };
    }
  }
  return null;
}

// ── Shared fetch helper ───────────────────────────────────────────────────────

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  try {
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      console.error(`[ChainDetector] HTTP ${resp.status} from ${url}`);
      return {};
    }
    return resp.json();
  } catch (err: any) {
    console.error(`[ChainDetector] fetch error for ${url}:`, err.message);
    return {};
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function findBlockchainDeposit(params: {
  coin: string;
  network: string;
  depositAddress: string;
  minAmount: number;
  afterTimestamp: number;
}): Promise<{ txid: string; amount: string } | null> {
  const net = params.network.toUpperCase();
  const coin = params.coin.toUpperCase();

  if (net === "BTC" || coin === "BTC") {
    return findBTCDeposit({
      address: params.depositAddress,
      minAmount: params.minAmount,
      afterTimestamp: params.afterTimestamp,
    });
  }

  if (net === "TRC20") {
    return findTRC20Deposit({
      coin,
      address: params.depositAddress,
      minAmount: params.minAmount,
      afterTimestamp: params.afterTimestamp,
    });
  }

  if (net === "ERC20") {
    return findEVMDeposit({
      coin,
      address: params.depositAddress,
      minAmount: params.minAmount,
      afterTimestamp: params.afterTimestamp,
      chain: "eth",
    });
  }

  if (net === "BSC" || net === "BEP20") {
    return findEVMDeposit({
      coin,
      address: params.depositAddress,
      minAmount: params.minAmount,
      afterTimestamp: params.afterTimestamp,
      chain: "bsc",
    });
  }

  throw new Error(`[ChainDetector] Unsupported network: "${params.network}"`);
}
