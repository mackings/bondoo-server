/**
 * HD wallet deposit address derivation.
 *
 * Derives a unique blockchain address per trade from a single BIP39 mnemonic.
 * Each trade gets a unique index (stored on the trade doc), ensuring
 * zero address collision across concurrent trades for any coin/amount.
 *
 * Supported chains:
 *   ERC20 / BSC  → BIP44 m/44'/60'/0'/0/{index}  (EVM P2PKH — same address on all EVM chains)
 *   TRC20        → BIP44 m/44'/195'/0'/0/{index} (TRON, derived from same seed, different encoding)
 *   BTC          → BIP84 m/84'/0'/0'/0/{index}   (native SegWit P2WPKH — bc1... / tb1...)
 */

import { ethers } from "ethers";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { bech32 } from "@scure/base";
import { createHash } from "node:crypto";
import { config } from "../../../config.js";

// ── BTC seed cache ────────────────────────────────────────────────────────────

let _btcSeed: Uint8Array | undefined;
function btcSeed(): Uint8Array {
  return (_btcSeed ??= mnemonicToSeedSync(config.hdWalletMnemonic));
}

// ── Base58Check (for TRON addresses) ─────────────────────────────────────────

const B58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function sha256d(buf: Buffer): Buffer {
  return createHash("sha256")
    .update(createHash("sha256").update(buf).digest())
    .digest();
}

function base58(buf: Buffer): string {
  let n = BigInt("0x" + buf.toString("hex"));
  let s = "";
  while (n > 0n) { s = B58_ALPHA[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; s = "1" + s; }
  return s;
}

function bs58check(payload: Buffer): string {
  return base58(Buffer.concat([payload, sha256d(payload).subarray(0, 4)]));
}

// ── EVM (ETH/ERC20, BSC/BEP20, MATIC, etc.) ─────────────────────────────────

function deriveEVMAddress(index: number): string {
  const w = ethers.HDNodeWallet.fromPhrase(
    config.hdWalletMnemonic, "", `m/44'/60'/0'/0/${index}`,
  );
  return w.address; // 0x... checksummed
}

// ── TRON (TRC20) ─────────────────────────────────────────────────────────────

function deriveTRONAddress(index: number): string {
  // Derive private key at TRON's BIP44 coin_type = 195
  const w = ethers.HDNodeWallet.fromPhrase(
    config.hdWalletMnemonic, "", `m/44'/195'/0'/0/${index}`,
  );
  // publicKey = "04" + 128 hex chars (65-byte uncompressed), strip "04" → 64 bytes
  const pub64 = Buffer.from(w.signingKey.publicKey.slice(2), "hex");
  // keccak256 of the 64-byte key, take last 20 bytes → TRON inner address
  const k = ethers.keccak256(pub64); // "0x" + 64 hex (32 bytes)
  const payload = Buffer.from("41" + k.slice(-40), "hex"); // 0x41 + 20 bytes
  return bs58check(payload); // T... address
}

// ── Bitcoin (native SegWit P2WPKH) ───────────────────────────────────────────

function deriveBTCAddress(index: number): string {
  const testnet = config.bybitTestnet; // share the testnet flag
  const coinType = testnet ? 1 : 0;   // 1 = BTC testnet, 0 = BTC mainnet
  const path = `m/84'/${coinType}'/0'/0/${index}`;
  const child = HDKey.fromMasterSeed(btcSeed()).derive(path);
  if (!child.publicKey) throw new Error(`BTC: no public key at ${path}`);
  // P2WPKH witness program = RIPEMD160(SHA256(compressed_pubkey))
  const pubKeyHash = ripemd160(sha256(child.publicKey)); // Uint8Array, 20 bytes
  const hrp = testnet ? "tb" : "bc";
  // bech32 encode: [witnessVersion=0, ...5-bit-words(pubKeyHash)]
  return bech32.encode(hrp, [0, ...bech32.toWords(pubKeyHash)]);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function generateDepositAddress(coin: string, network: string, tradeIndex: number): string {
  const net = network.toUpperCase();
  const c = coin.toUpperCase();
  if (net === "BTC" || c === "BTC") return deriveBTCAddress(tradeIndex);
  if (net === "TRC20") return deriveTRONAddress(tradeIndex);
  // All other EVM chains: ERC20, BSC, BEP20, MATIC, ARBONE, OP
  return deriveEVMAddress(tradeIndex);
}
