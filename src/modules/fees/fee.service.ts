import { ethers } from "ethers";
import { FeeModel } from "../../models/fee.js";
import { config } from "../../config.js";

export type FeeQuote = {
  platformFee: number;
  networkFee: number;   // estimated on-chain gas in the native coin unit
  escrowAmount: number; // what the seller must deposit (cryptoAmount + networkFee for native coins)
  payoutAmount: number; // what the buyer will receive (cryptoAmount - platformFee)
};

// ─── RPC endpoints ────────────────────────────────────────────────────────────

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

// Protocol constants — fixed by the Ethereum/Bitcoin spec, not business choices
const GAS_LIMIT_NATIVE = 21_000n;   // ETH / BNB simple transfer
const GAS_LIMIT_ERC20  = 65_000n;   // ERC20 token transfer

// ─── Live gas estimation ──────────────────────────────────────────────────────

async function estimateEVMGas(network: string, isToken: boolean): Promise<number> {
  const rpcs = config.bybitTestnet ? TESTNET_RPCS : MAINNET_RPCS;
  const rpcUrl = rpcs[network.toUpperCase()];
  if (!rpcUrl) throw new Error(`No RPC configured for EVM network "${network}"`);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const feeData = await provider.getFeeData();
  if (!feeData.gasPrice) throw new Error(`RPC did not return a gas price for ${network}`);

  const gasLimit = isToken ? GAS_LIMIT_ERC20 : GAS_LIMIT_NATIVE;
  const gasCostWei = feeData.gasPrice * gasLimit;
  // 20% buffer so the quote stays valid by the time the seller sends
  const buffered = (gasCostWei * 120n) / 100n;
  return Number(ethers.formatEther(buffered));
}

async function estimateBTCFee(): Promise<number> {
  const base = config.bybitTestnet
    ? "https://blockstream.info/testnet/api"
    : "https://blockstream.info/api";

  const resp = await fetch(`${base}/fee-estimates`);
  if (!resp.ok) throw new Error(`Blockstream fee-estimates failed: HTTP ${resp.status}`);
  const data: Record<string, number> = await resp.json();

  const feeRate = data["6"];
  if (!feeRate) throw new Error("Blockstream did not return a 6-block fee estimate");

  const typicalVBytes = 140; // P2WPKH 1-in 1-out — Bitcoin script standard
  // +20% buffer for fee market movement before seller sends
  return Math.ceil(feeRate) * typicalVBytes * 1.2 / 1e8;
}

async function estimateTRXFee(isToken: boolean): Promise<number> {
  const baseUrl = config.bybitTestnet
    ? "https://nile.trongrid.io"
    : "https://api.trongrid.io";

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.tronGridApiKey) headers["TRON-PRO-API-KEY"] = config.tronGridApiKey;

  const resp = await fetch(`${baseUrl}/wallet/getchainparameters`, { headers });
  if (!resp.ok) throw new Error(`TronGrid getchainparameters failed: HTTP ${resp.status}`);

  const data = await resp.json() as { chainParameter: { key: string; value: number }[] };
  if (!data.chainParameter) throw new Error("TronGrid returned no chain parameters");

  const params = Object.fromEntries(data.chainParameter.map((p) => [p.key, p.value]));

  const txFeePerByte = params["getTransactionFee"]; // SUN per byte (bandwidth)
  const energyFeePerUnit = params["getEnergyFee"];  // SUN per energy unit

  if (!txFeePerByte || !energyFeePerUnit) {
    throw new Error("TronGrid chain parameters missing getTransactionFee or getEnergyFee");
  }

  if (isToken) {
    // TRC20 transfer from a fresh address with no staked resources:
    // ~350 bytes bandwidth + ~29,000 energy units (measured on-chain for USDT TRC20)
    const bandwidthCost = 350 * txFeePerByte;
    const energyCost    = 29_000 * energyFeePerUnit;
    return round8((bandwidthCost + energyCost) / 1_000_000); // SUN → TRX
  } else {
    // Native TRX transfer: ~250 bytes bandwidth, no energy needed
    return round8((250 * txFeePerByte) / 1_000_000);
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function quoteFees(coin: string, network: string, amount: number): Promise<FeeQuote> {
  const net = network.toUpperCase();
  const c   = coin.toUpperCase();

  const feeDoc = await FeeModel.findOne({ coin: c, network: net, active: true });
  if (!feeDoc) {
    throw new Error(`No fee configuration found for ${c}/${net}. Run seedDefaultFees first.`);
  }

  const percentage = Number(feeDoc.get("percentageFee"));
  const fixed      = Number(feeDoc.get("fixedFee"));
  const minimum    = Number(feeDoc.get("minFee"));

  const platformFee = round8(Math.max(amount * percentage + fixed, minimum));

  // ── Network / gas fee (always fetched live) ──────────────────────────────
  const isToken = c !== "ETH" && c !== "BNB" && net !== "BTC";

  let networkFee: number;
  if (net === "BTC" || c === "BTC") {
    networkFee = await estimateBTCFee();
  } else if (net === "TRC20") {
    networkFee = await estimateTRXFee(isToken);
  } else {
    networkFee = await estimateEVMGas(net, isToken);
  }

  // ── Amounts ──────────────────────────────────────────────────────────────
  const payoutAmount = round8(Math.max(amount - platformFee, 0));
  const escrowAmount = isToken
    ? round8(amount)               // tokens: seller deposits exact amount; platform covers gas
    : round8(amount + networkFee); // native coin: seller covers gas too

  return { platformFee, networkFee, escrowAmount, payoutAmount };
}

export async function seedDefaultFees() {
  const defaults = [
    { coin: "USDT", network: "TRC20", percentageFee: 0.01, fixedFee: 0, minFee: 1 },
    { coin: "USDT", network: "ERC20", percentageFee: 0.01, fixedFee: 0, minFee: 2 },
    { coin: "USDC", network: "ERC20", percentageFee: 0.01, fixedFee: 0, minFee: 2 },
    { coin: "BTC",  network: "BTC",   percentageFee: 0.01, fixedFee: 0, minFee: 0.00005 },
    { coin: "ETH",  network: "ERC20", percentageFee: 0.01, fixedFee: 0, minFee: 0.0002 },
    { coin: "BNB",  network: "BSC",   percentageFee: 0.01, fixedFee: 0, minFee: 0.005 },
  ];
  for (const { coin, network, ...fields } of defaults) {
    await FeeModel.updateOne(
      { coin, network },
      { $set: fields },
      { upsert: true },
    );
  }
}

function round8(value: number) {
  return Math.round(value * 1e8) / 1e8;
}
