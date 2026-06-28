import { ethers } from "ethers";
import { FeeModel } from "../../models/fee.js";
import { config } from "../../config.js";

export type FeeQuote = {
  platformFee: number;
  networkFee: number;   // estimated on-chain gas in the native coin unit
  escrowAmount: number; // what the seller must deposit (cryptoAmount + networkFee for native coins)
  payoutAmount: number; // what the buyer will receive (cryptoAmount - platformFee)
};

// ─── Live gas estimation ──────────────────────────────────────────────────────

const TESTNET_RPCS: Record<string, string> = {
  ERC20: "https://ethereum-sepolia.publicnode.com",
  BSC:   "https://bsc-testnet-rpc.publicnode.com",
  BEP20: "https://bsc-testnet-rpc.publicnode.com",
};

const MAINNET_RPCS: Record<string, string> = {
  ERC20: "https://eth.llamarpc.com",
  BSC:   "https://bsc-dataseed1.binance.org",
  BEP20: "https://bsc-dataseed1.binance.org",
};

// Gas limits per operation type
const GAS_LIMIT_NATIVE  = 21_000n;      // ETH / BNB transfer
const GAS_LIMIT_ERC20   = 65_000n;      // ERC20 token transfer
const GAS_LIMIT_BTC_SAT = 200n;         // sat/vbyte × typical 140 vbytes
const TRX_BANDWIDTH_FEE = 0.5;          // ~0.5 TRX for a TRC20 transfer

async function estimateEVMGas(network: string, isToken: boolean): Promise<number> {
  const rpcs = config.bybitTestnet ? TESTNET_RPCS : MAINNET_RPCS;
  const rpcUrl = rpcs[network.toUpperCase()];
  if (!rpcUrl) return 0;

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? ethers.parseUnits("5", "gwei");
    const gasLimit = isToken ? GAS_LIMIT_ERC20 : GAS_LIMIT_NATIVE;
    const gasCostWei = gasPrice * gasLimit;
    // Add 20% buffer so the estimate doesn't go stale by the time the seller sends
    const buffered = (gasCostWei * 120n) / 100n;
    return Number(ethers.formatEther(buffered));
  } catch {
    // Fallback: safe conservative estimates (won't underquote)
    return isToken ? 0.005 : 0.0003;
  }
}

async function estimateBTCFee(): Promise<number> {
  const base = config.bybitTestnet
    ? "https://blockstream.info/testnet/api"
    : "https://blockstream.info/api";
  try {
    const resp = await fetch(`${base}/fee-estimates`);
    const data: Record<string, number> = await resp.json();
    const feeRate = Math.ceil(data["6"] ?? 5); // sat/vbyte, 6-block target
    const typicalVBytes = 140; // 1-in 1-out P2WPKH
    return (feeRate * typicalVBytes * 120) / 1e8 / 100; // +20% buffer, sat→BTC
  } catch {
    return 0.00005; // conservative 5000 sat fallback
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function quoteFees(coin: string, network: string, amount: number): Promise<FeeQuote> {
  const net  = network.toUpperCase();
  const c    = coin.toUpperCase();

  const feeDoc = await FeeModel.findOne({ coin: c, network: net, active: true });
  const percentage = Number(feeDoc?.get("percentageFee") ?? 0.01); // must match seedDefaultFees
  const fixed      = Number(feeDoc?.get("fixedFee") ?? 0);
  const minimum    = Number(feeDoc?.get("minFee") ?? 0);

  const platformFee = round8(Math.max(amount * percentage + fixed, minimum));

  // ── Network / gas fee ────────────────────────────────────────────────────
  let networkFee = 0;
  const isToken = c !== "ETH" && c !== "BNB" && net !== "BTC"; // USDT, USDC, etc.

  if (net === "BTC" || c === "BTC") {
    networkFee = round8(await estimateBTCFee());
  } else if (net === "TRC20") {
    // TRX for bandwidth. For USDT TRC20 this is negligible but real.
    networkFee = TRX_BANDWIDTH_FEE;
  } else {
    // ERC20, BSC, BEP20
    networkFee = round8(await estimateEVMGas(net, isToken));
  }

  // ── Amounts ──────────────────────────────────────────────────────────────
  // payoutAmount  = what the buyer receives
  // escrowAmount  = what the seller must deposit
  //
  // For native coins (ETH, BNB, BTC, TRX):
  //   seller deposits (cryptoAmount + networkFee) so after gas the buyer gets cryptoAmount - platformFee
  //
  // For tokens (USDT ERC20, TRC20, BEP20):
  //   seller deposits exactly cryptoAmount in tokens — gas is paid from platform gas wallet
  //   networkFee is shown informatively but does NOT add to what the seller sends

  const payoutAmount  = round8(Math.max(amount - platformFee, 0));
  const escrowAmount  = isToken
    ? round8(amount)                        // token sender deposits exact amount
    : round8(amount + networkFee);          // native coin sender must cover gas too

  return { platformFee, networkFee, escrowAmount, payoutAmount };
}

export async function seedDefaultFees() {
  const defaults = [
    { coin: "USDT", network: "TRC20", percentageFee: 0.01, fixedFee: 0, minFee: 1 },
    { coin: "USDT", network: "ERC20", percentageFee: 0.01, fixedFee: 0, minFee: 2 },
    { coin: "USDC", network: "ERC20", percentageFee: 0.01, fixedFee: 0, minFee: 2 },
    { coin: "BTC",  network: "BTC",   percentageFee: 0.01, fixedFee: 0, minFee: 0.00005 },
    { coin: "ETH",  network: "ERC20", percentageFee: 0.01, fixedFee: 0, minFee: 0.001 },
    { coin: "BNB",  network: "BSC",   percentageFee: 0.01, fixedFee: 0, minFee: 0.005 },
  ];
  for (const fee of defaults) {
    await FeeModel.updateOne(
      { coin: fee.coin, network: fee.network },
      { $setOnInsert: fee },
      { upsert: true },
    );
  }
}

function round8(value: number) {
  return Math.round(value * 1e8) / 1e8;
}
