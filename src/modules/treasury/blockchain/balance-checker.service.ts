/**
 * On-chain balance checker.
 *
 * Queries the live confirmed balance at a specific address for any supported
 * coin/network. Used by the "Verify on-chain" wallet feature so users can
 * independently confirm what's on-chain vs. what's in their in-app ledger.
 *
 * No caching — always a fresh network call.
 */

import { config } from "../../../config.js";

// Mainnet token contracts (same as chain-detector and payout service)
const EVM_CONTRACTS: Record<string, Record<string, string>> = {
  USDT: {
    ERC20: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    BSC:   "0x55d398326f99059fF775485246999027B3197955",
    BEP20: "0x55d398326f99059fF775485246999027B3197955",
  },
  USDC: {
    ERC20: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    BSC:   "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    BEP20: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  },
};

const TRON_CONTRACT: Record<string, string> = {
  USDT: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  USDC: "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8",
};

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return {};
    return resp.json();
  } catch {
    return {};
  }
}

// ── BTC ──────────────────────────────────────────────────────────────────────

async function btcBalance(address: string): Promise<number> {
  const base = config.bybitTestnet
    ? "https://blockstream.info/testnet/api"
    : "https://blockstream.info/api";

  const data = await fetchJson(`${base}/address/${address}`);
  if (!data.chain_stats) return 0;

  const confirmed =
    (data.chain_stats.funded_txo_sum  ?? 0) -
    (data.chain_stats.spent_txo_sum   ?? 0);
  return confirmed / 1e8;
}

// ── EVM (ETH native + ERC20/BEP20 tokens) ────────────────────────────────────

async function evmBalance(coin: string, network: string, address: string): Promise<number> {
  const testnet = config.bybitTestnet;
  const chain   = (network === "ERC20") ? "eth" : "bsc";
  const coinUp  = coin.toUpperCase();

  let explorerBase: string;
  let apiKey: string;

  if (chain === "eth") {
    if (testnet) {
      explorerBase = "https://eth-sepolia.blockscout.com/api";
      apiKey = "";
    } else {
      explorerBase = config.etherscanApiKey
        ? "https://api.etherscan.io/api"
        : "https://eth.blockscout.com/api";
      apiKey = config.etherscanApiKey ?? "";
    }
  } else {
    if (testnet) {
      explorerBase = "https://bsc-testnet.blockscout.com/api";
      apiKey = "";
    } else {
      explorerBase = config.bscscanApiKey
        ? "https://api.bscscan.com/api"
        : "https://bsc.blockscout.com/api";
      apiKey = config.bscscanApiKey ?? "";
    }
  }

  const contract = EVM_CONTRACTS[coinUp]?.[network.toUpperCase()];

  // ERC20/BEP20 token balance (mainnet only — testnet has no standardised contracts)
  if (contract && !testnet) {
    const url =
      `${explorerBase}?module=account&action=tokenbalance` +
      `&contractaddress=${contract}&address=${address}&tag=latest&apikey=${apiKey}`;
    const data = await fetchJson(url);
    if (data.status === "1" && data.result) {
      return Number(data.result) / 1e6; // USDT/USDC: 6 decimals
    }
    return 0;
  }

  // Native ETH / BNB (also used on testnet for all coins)
  const url =
    `${explorerBase}?module=account&action=balance` +
    `&address=${address}&tag=latest&apikey=${apiKey}`;
  const data = await fetchJson(url);
  if (data.status === "1" && data.result) {
    return Number(data.result) / 1e18;
  }
  return 0;
}

// ── TRON (TRC20 tokens + native TRX) ─────────────────────────────────────────

async function trc20Balance(coin: string, address: string): Promise<number> {
  const testnet = config.bybitTestnet;
  const baseUrl = testnet ? "https://nile.trongrid.io" : "https://api.trongrid.io";

  const headers: Record<string, string> = {};
  if (config.tronGridApiKey) headers["TRON-PRO-API-KEY"] = config.tronGridApiKey;

  const data = await fetchJson(`${baseUrl}/v1/accounts/${address}`, headers);
  if (!data.data || !Array.isArray(data.data) || !data.data[0]) return 0;

  const account = data.data[0];
  const coinUp  = coin.toUpperCase();

  if (coinUp === "TRX") return (account.balance ?? 0) / 1e6;

  const contractAddr = testnet
    ? (coinUp === "USDT" ? config.tronUsdtTestnetContract : "")
    : TRON_CONTRACT[coinUp];

  if (!contractAddr) return 0;

  const trc20List: Record<string, string>[] = account.trc20 ?? [];
  const entry = trc20List.find(
    (b) => Object.keys(b)[0]?.toLowerCase() === contractAddr.toLowerCase(),
  );
  return entry ? Number(Object.values(entry)[0]) / 1e6 : 0;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getOnchainBalance(params: {
  coin: string;
  network: string;
  address: string;
}): Promise<number> {
  const net  = params.network.toUpperCase();
  const coin = params.coin.toUpperCase();

  if (net === "BTC" || coin === "BTC") return btcBalance(params.address);
  if (net === "TRC20")                 return trc20Balance(coin, params.address);
  if (net === "ERC20" || net === "BSC" || net === "BEP20") {
    return evmBalance(coin, net, params.address);
  }

  return 0;
}
