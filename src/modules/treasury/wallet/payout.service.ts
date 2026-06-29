/**
 * HD-wallet payout service — sends funds directly from trade escrow addresses.
 *
 * Each trade has a unique deposit address derived from the platform's BIP44 HD
 * wallet at a per-trade index.  When a seller releases, this service derives the
 * private key for that index and broadcasts the payout transaction directly.
 *
 * EVM  (ETH/BNB native + ERC20/BEP20 tokens) — ethers.js, multiple fallback RPCs
 * TRON (TRX native + TRC20 tokens)            — @noble/curves secp256k1 signing
 * BTC                                          — bitcoinjs-lib PSBT signing
 */

import { ethers } from "ethers";
import { secp256k1 as noble_secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58check } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { config } from "../../../config.js";

// bitcoinjs-lib and tiny-secp256k1 (WASM) are loaded lazily on first BTC payout
// to avoid blocking server startup if the WASM file is not yet warm.
let _bitcoin: typeof import("bitcoinjs-lib") | null = null;
let _ecc: typeof import("tiny-secp256k1") | null = null;
async function getBitcoin() {
  if (!_bitcoin) {
    const [bitcoin, ecc] = await Promise.all([
      import("bitcoinjs-lib"),
      import("tiny-secp256k1"),
    ]);
    bitcoin.initEccLib(ecc as any);
    _bitcoin = bitcoin;
    _ecc = ecc;
  }
  return _bitcoin!;
}
async function getEcc() {
  if (!_ecc) await getBitcoin();
  return _ecc!;
}

const bs58check = base58check(sha256);

// ─── RPC endpoints with fallbacks ────────────────────────────────────────────

const RPCS: Record<string, string[]> = {
  ERC20: config.bybitTestnet
    ? [
        "https://ethereum-sepolia.publicnode.com",
        "https://sepolia.drpc.org",
        "https://rpc.sepolia.org",
      ]
    : [
        "https://eth.llamarpc.com",
        "https://rpc.ankr.com/eth",
        "https://ethereum.publicnode.com",
      ],
  BSC: config.bybitTestnet
    ? [
        "https://bsc-testnet-rpc.publicnode.com",
        "https://bsc-testnet.drpc.org",
      ]
    : [
        "https://bsc-dataseed1.binance.org",
        "https://bsc.publicnode.com",
        "https://rpc.ankr.com/bsc",
      ],
  BEP20: config.bybitTestnet
    ? [
        "https://bsc-testnet-rpc.publicnode.com",
        "https://bsc-testnet.drpc.org",
      ]
    : [
        "https://bsc-dataseed1.binance.org",
        "https://bsc.publicnode.com",
        "https://rpc.ankr.com/bsc",
      ],
};

// ─── ERC20/BEP20 mainnet token contracts ─────────────────────────────────────

const TOKEN_CONTRACTS: Record<string, Partial<Record<string, string>>> = {
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

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// ─── TRON mainnet contracts ───────────────────────────────────────────────────

const TRON_USDT_MAINNET = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  if (hex.startsWith("0x") || hex.startsWith("0X")) hex = hex.slice(2);
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return arr;
}

/** Derive TRON Base58Check address from an HD private key */
function tronAddressFromPrivKey(privKey: Uint8Array): string {
  const uncompressed = noble_secp256k1.getPublicKey(privKey, false); // 65 bytes, 0x04 prefix
  const hash = keccak_256(uncompressed.slice(1));
  const addrBytes = new Uint8Array(21);
  addrBytes[0] = 0x41;
  addrBytes.set(hash.slice(12), 1);
  return bs58check.encode(addrBytes);
}

/** ABI-encode (address, uint256) parameters for a TRC20 transfer call */
function encodeTRC20Params(toTronAddress: string, amount: number, decimals = 6): string {
  // Decode Base58Check address → 21 bytes [0x41, ...20 bytes]
  const addrBytes = bs58check.decode(toTronAddress);
  const addr20 = addrBytes.slice(1); // strip 0x41
  const addrHex = "000000000000000000000000" + Buffer.from(addr20).toString("hex");
  const rawAmount = BigInt(Math.round(amount * 10 ** decimals));
  const amountHex = rawAmount.toString(16).padStart(64, "0");
  return addrHex + amountHex;
}

/** Sign a TronGrid unsigned transaction using @noble/curves secp256k1 */
function signTRONTx(unsignedTx: Record<string, unknown>, privKey: Uint8Array): Record<string, unknown> {
  const rawDataHex = unsignedTx.raw_data_hex as string;
  const msgHash = sha256(hexToBytes(rawDataHex));
  // format:'recovered' → [recovery(1), r(32), s(32)]
  const sig65 = noble_secp256k1.sign(msgHash, privKey, { format: "recovered" });
  // TRON expects: r(32) + s(32) + v(1)
  const tronSig = new Uint8Array(65);
  tronSig.set(sig65.slice(1), 0);   // r + s
  tronSig[64] = sig65[0];           // recovery byte
  return { ...unsignedTx, signature: [Buffer.from(tronSig).toString("hex")] };
}

/** Try an async operation against a list of RPC URLs, returning on first success */
async function withFallbackRpc<T>(
  rpcUrls: string[],
  fn: (provider: ethers.JsonRpcProvider) => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (const url of rpcUrls) {
    try {
      const provider = new ethers.JsonRpcProvider(url);
      return await fn(provider);
    } catch (err) {
      console.warn(`[Payout] RPC ${url} failed: ${(err as Error).message}`);
      lastErr = err;
    }
  }
  throw lastErr;
}

// ─── EVM payout ───────────────────────────────────────────────────────────────

async function payoutEVM(params: {
  coin: string;
  network: string;
  depositIndex: number;
  toAddress: string;
  payoutAmount: number;
}): Promise<{ txid: string }> {
  const net = params.network.toUpperCase();
  const coin = params.coin.toUpperCase();

  const rpcList = RPCS[net];
  if (!rpcList) throw new Error(`No RPC configured for EVM network "${net}"`);

  const hdNode = ethers.HDNodeWallet.fromPhrase(
    config.hdWalletMnemonic, "", `m/44'/60'/0'/0/${params.depositIndex}`,
  );
  console.log(`[Payout] EVM wallet at index=${params.depositIndex}: ${hdNode.address}`);

  return withFallbackRpc(rpcList, async (provider) => {
    const wallet = hdNode.connect(provider);
    const balance = await provider.getBalance(wallet.address);
    console.log(`[Payout] EVM balance: ${ethers.formatEther(balance)} (coin=${coin} net=${net})`);

    // ── Native ETH / BNB ──────────────────────────────────────────────────
    if (coin === "ETH" || coin === "BNB") {
      const feeData = await provider.getFeeData();
      const gasLimit = 21000n;
      if (!feeData.gasPrice) throw new Error(`RPC did not return a gas price for ${net}`);
      const gasPrice = feeData.gasPrice;
      const gasCost  = gasPrice * gasLimit;
      const sendAmount = balance - gasCost;

      if (sendAmount <= 0n) {
        throw new Error(
          `Insufficient balance (${ethers.formatEther(balance)} ${coin}) to cover gas (${ethers.formatEther(gasCost)} ${coin})`,
        );
      }

      console.log(`[Payout] Sending ${ethers.formatEther(sendAmount)} ${coin} → ${params.toAddress}`);
      const tx = await wallet.sendTransaction({
        to: params.toAddress,
        value: sendAmount,
        gasLimit,
        gasPrice,
      });
      // Do NOT await tx.wait() — once sendTransaction() resolves we have the hash
      // and the tx is accepted by the network. Waiting for confirmation here creates
      // an ambiguous failure window: if the wait times out the tx IS on-chain but
      // the caller would treat it as a failure and double-refund.
      console.log(`[Payout] ✓ ${coin} broadcast txid: ${tx.hash}`);
      return { txid: tx.hash };
    }

    // ── ERC20 / BEP20 token ───────────────────────────────────────────────
    const tokenAddress = TOKEN_CONTRACTS[coin]?.[net];
    if (!tokenAddress) {
      throw new Error(
        `No token contract configured for ${coin}/${net}.` +
        (config.bybitTestnet
          ? " On testnet use ETH/BNB trades — ERC20 contracts are not standardised on testnets."
          : " Add the mainnet contract to TOKEN_CONTRACTS in payout.service.ts."),
      );
    }

    // The deposit address needs native coin (ETH/BNB) to pay gas for the token send.
    if (balance === 0n) {
      throw new Error(
        `Deposit address has no gas (${coin === "USDT" && net === "BSC" ? "BNB" : "ETH"}). ` +
        `Fund ${wallet.address} with a small amount before releasing tokens.`,
      );
    }

    const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
    const decimals: number = await token.decimals();
    const rawAmount = ethers.parseUnits(String(params.payoutAmount), decimals);

    console.log(`[Payout] Sending ${params.payoutAmount} ${coin} → ${params.toAddress}`);
    const tx = await token.transfer(params.toAddress, rawAmount);
    // Do NOT await tx.wait() — same reason as native ETH: if wait times out after
    // broadcast, the caller would refund while the tx is already on-chain.
    console.log(`[Payout] ✓ ${coin} token broadcast txid: ${tx.hash}`);
    return { txid: tx.hash };
  });
}

// ─── TRON payout ──────────────────────────────────────────────────────────────

async function payoutTRON(params: {
  coin: string;
  depositIndex: number;
  toAddress: string;
  payoutAmount: number;
}): Promise<{ txid: string }> {
  const coin = params.coin.toUpperCase();
  const testnet = config.bybitTestnet;
  const baseUrl = testnet ? "https://nile.trongrid.io" : "https://api.trongrid.io";

  const seed = mnemonicToSeedSync(config.hdWalletMnemonic);
  const child = HDKey.fromMasterSeed(seed).derive(`m/44'/195'/0'/0/${params.depositIndex}`);
  if (!child.privateKey) throw new Error("TRON: failed to derive private key");

  const ownerAddress = tronAddressFromPrivKey(child.privateKey);
  console.log(`[Payout] TRON address at index=${params.depositIndex}: ${ownerAddress}`);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.tronGridApiKey) headers["TRON-PRO-API-KEY"] = config.tronGridApiKey;

  let unsignedTx: Record<string, unknown>;

  if (coin === "TRX") {
    // ── Native TRX transfer ───────────────────────────────────────────────
    const sunAmount = Math.round(params.payoutAmount * 1_000_000); // TRX → SUN
    const resp = await fetch(`${baseUrl}/wallet/createtransaction`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        to_address: params.toAddress,
        owner_address: ownerAddress,
        amount: sunAmount,
        visible: true,
      }),
    });
    const data = await resp.json() as Record<string, unknown>;
    if (!data.raw_data) throw new Error(`TronGrid createtransaction failed: ${JSON.stringify(data)}`);
    unsignedTx = data;
  } else {
    // ── TRC20 token transfer (USDT, USDC, …) ─────────────────────────────
    const contractAddress = testnet
      ? config.tronUsdtTestnetContract
      : TRON_USDT_MAINNET;

    if (!contractAddress) {
      throw new Error(
        "TRON TRC20 contract address not set. " +
        "Add TRON_USDT_TESTNET_CONTRACT to your .env for testnet.",
      );
    }

    const parameter = encodeTRC20Params(params.toAddress, params.payoutAmount);
    const resp = await fetch(`${baseUrl}/wallet/triggersmartcontract`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        owner_address: ownerAddress,
        contract_address: contractAddress,
        function_selector: "transfer(address,uint256)",
        parameter,
        fee_limit: 100_000_000, // 100 TRX max fee
        call_value: 0,
        visible: true,
      }),
    });
    const data = await resp.json() as { result?: unknown; transaction?: Record<string, unknown> };
    if (!data.transaction?.raw_data) {
      throw new Error(`TronGrid triggersmartcontract failed: ${JSON.stringify(data)}`);
    }
    unsignedTx = data.transaction;
  }

  const signedTx = signTRONTx(unsignedTx, child.privateKey);

  const broadcastResp = await fetch(`${baseUrl}/wallet/broadcasttransaction`, {
    method: "POST",
    headers,
    body: JSON.stringify(signedTx),
  });
  const result = await broadcastResp.json() as { result?: boolean; txid?: string; message?: string };

  if (!result.result) {
    throw new Error(`TronGrid broadcast failed: ${JSON.stringify(result)}`);
  }

  const txid = result.txid ?? (unsignedTx.txID as string);
  console.log(`[Payout] ✓ TRON ${coin} txid: ${txid}`);
  return { txid };
}

// ─── BTC payout ───────────────────────────────────────────────────────────────

async function payoutBTC(params: {
  depositIndex: number;
  toAddress: string;
  payoutAmount: number;
}): Promise<{ txid: string }> {
  const bitcoin = await getBitcoin();
  const ecc = await getEcc();
  const testnet = config.bybitTestnet;
  const network = testnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
  const base = testnet ? "https://blockstream.info/testnet/api" : "https://blockstream.info/api";

  const seed = mnemonicToSeedSync(config.hdWalletMnemonic);
  const coinType = testnet ? 1 : 0;
  const child = HDKey.fromMasterSeed(seed).derive(`m/84'/${coinType}'/0'/0/${params.depositIndex}`);
  if (!child.privateKey || !child.publicKey) throw new Error("BTC: failed to derive key");

  const pubkeyBuf = Buffer.from(child.publicKey);
  const payment = bitcoin.payments.p2wpkh({ pubkey: pubkeyBuf, network });
  const depositAddress = payment.address!;
  console.log(`[Payout] BTC deposit address at index=${params.depositIndex}: ${depositAddress}`);

  // Fetch confirmed UTXOs
  type UTXO = { txid: string; vout: number; status: { confirmed: boolean }; value: number };
  const utxoResp = await fetch(`${base}/address/${depositAddress}/utxo`);
  if (!utxoResp.ok) throw new Error(`Blockstream UTXO fetch failed: HTTP ${utxoResp.status}`);
  const utxos: UTXO[] = await utxoResp.json();

  const confirmed = utxos.filter((u) => u.status.confirmed);
  if (!confirmed.length) throw new Error(`BTC: no confirmed UTXOs at ${depositAddress}`);
  const totalSats = confirmed.reduce((s, u) => s + u.value, 0);
  console.log(`[Payout] BTC UTXOs: ${confirmed.length}, total: ${totalSats} sat`);

  // Fetch fee rate (sat/vbyte, 6-block target)
  const feeResp = await fetch(`${base}/fee-estimates`);
  const feeEstimates: Record<string, number> = await feeResp.json();
  const feeRate6 = feeEstimates["6"];
  if (!feeRate6) throw new Error("Blockstream did not return a 6-block fee estimate");
  const feeRate = Math.ceil(feeRate6);

  // P2WPKH vbyte estimate: 10.5 overhead + 67.75/input + 31/output
  const vBytes = Math.ceil(10.5 + confirmed.length * 67.75 + 31);
  const feeSats = vBytes * feeRate;
  const sendSats = totalSats - feeSats;

  if (sendSats < 546) {
    throw new Error(`BTC: insufficient balance. Total=${totalSats} sat, fee=${feeSats} sat, dust limit=546 sat`);
  }
  console.log(`[Payout] BTC sending ${sendSats} sat to ${params.toAddress} (fee=${feeSats} sat @ ${feeRate} sat/vb)`);

  // Build PSBT
  const psbt = new bitcoin.Psbt({ network });

  for (const utxo of confirmed) {
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: { script: payment.output!, value: BigInt(utxo.value) },
    });
  }

  psbt.addOutput({ address: params.toAddress, value: BigInt(sendSats) });

  // Sign all inputs with a minimal signer (tiny-secp256k1)
  const privKeyBytes = child.privateKey;
  const signer = {
    publicKey: pubkeyBuf,
    sign(hash: Buffer): Buffer {
      return Buffer.from(ecc.sign(new Uint8Array(hash), privKeyBytes));
    },
  };

  psbt.signAllInputs(signer);
  psbt.finalizeAllInputs();
  const rawHex = psbt.extractTransaction().toHex();

  // Broadcast
  const broadcastResp = await fetch(`${base}/tx`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: rawHex,
  });

  if (!broadcastResp.ok) {
    const errText = await broadcastResp.text();
    throw new Error(`BTC broadcast failed (HTTP ${broadcastResp.status}): ${errText}`);
  }

  const txid = (await broadcastResp.text()).trim();
  console.log(`[Payout] ✓ BTC txid: ${txid}`);
  return { txid };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function sendPayoutFromHDWallet(params: {
  coin: string;
  network: string;
  depositIndex: number;
  toAddress: string;
  payoutAmount: number;
}): Promise<{ txid: string }> {
  const net  = params.network.toUpperCase();
  const coin = params.coin.toUpperCase();

  console.log(
    `[Payout] ${params.payoutAmount} ${coin} (${net}) → ${params.toAddress} (index=${params.depositIndex})`,
  );

  if (net === "BTC" || coin === "BTC") {
    return payoutBTC({
      depositIndex: params.depositIndex,
      toAddress: params.toAddress,
      payoutAmount: params.payoutAmount,
    });
  }

  if (net === "TRC20") {
    return payoutTRON({
      coin,
      depositIndex: params.depositIndex,
      toAddress: params.toAddress,
      payoutAmount: params.payoutAmount,
    });
  }

  // ERC20, BSC, BEP20
  return payoutEVM({
    coin,
    network: net,
    depositIndex: params.depositIndex,
    toAddress: params.toAddress,
    payoutAmount: params.payoutAmount,
  });
}
