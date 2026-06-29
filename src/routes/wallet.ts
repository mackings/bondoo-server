import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { WalletModel } from "../models/wallet.js";
import { WalletDepositModel } from "../models/wallet_deposit.js";
import { WalletWithdrawalModel } from "../models/wallet_withdrawal.js";
import { UserModel } from "../models/user.js";
import { nextDepositIndex } from "../models/counter.js";
import { generateDepositAddress } from "../modules/treasury/wallet/deposit-address.service.js";
import { findBlockchainDeposit } from "../modules/treasury/blockchain/chain-detector.js";
import { getOnchainBalance } from "../modules/treasury/blockchain/balance-checker.service.js";
import { sendPayoutFromHDWallet } from "../modules/treasury/wallet/payout.service.js";
import { config } from "../config.js";

export const walletRouter = Router();
walletRouter.use(requireAuth);

// Supported networks per coin — order = default shown in UI first
const COIN_NETWORKS: Record<string, string[]> = {
  BTC:  ["BTC"],
  ETH:  ["ERC20"],
  USDC: ["ERC20", "TRC20", "BSC"],
  USDT: ["TRC20", "ERC20", "BSC"],
};

// BIP44/BIP84 derivation paths per network (for user disclosure)
const DERIVATION_PATHS: Record<string, string> = {
  BTC:   config.bybitTestnet ? "m/84'/1'/0'/0/{index}" : "m/84'/0'/0'/0/{index}",
  ERC20: "m/44'/60'/0'/0/{index}",
  BSC:   "m/44'/60'/0'/0/{index}",
  BEP20: "m/44'/60'/0'/0/{index}",
  TRC20: "m/44'/195'/0'/0/{index}",
};

// Assign a globally-unique HD wallet index to a user the first time they
// open their wallet. Shared counter with trade escrow so indices never collide.
async function ensureWalletIndex(userId: any): Promise<number> {
  const user = await UserModel.findById(userId).select("walletIndex");
  if (user!.walletIndex != null) return user!.walletIndex;
  const idx = await nextDepositIndex();
  await UserModel.updateOne({ _id: userId }, { walletIndex: idx });
  return idx;
}

/* ── GET /wallet ── balances + real deposit addresses + derivation paths ──── */
walletRouter.get("/", async (req, res) => {
  const userId      = req.user!._id;
  const walletIndex = await ensureWalletIndex(userId);

  const wallets = await WalletModel.find({ userId });
  const balances: Record<string, number> = { BTC: 0, ETH: 0, USDC: 0, USDT: 0 };
  for (const w of wallets) balances[w.asset] = w.balance;

  // Derive the real blockchain address for every coin/network
  const addresses: Record<string, Record<string, string>> = {};
  for (const [coin, networks] of Object.entries(COIN_NETWORKS)) {
    addresses[coin] = {};
    for (const network of networks) {
      addresses[coin][network] = generateDepositAddress(coin, network, walletIndex);
    }
  }

  // Derivation paths with the real index substituted in — users can verify in
  // any BIP39 tool (e.g. Ian Coleman's) using the platform mnemonic + this path
  const derivation_paths: Record<string, Record<string, string>> = {};
  for (const [coin, networks] of Object.entries(COIN_NETWORKS)) {
    derivation_paths[coin] = {};
    for (const network of networks) {
      const tmpl = DERIVATION_PATHS[network] ?? DERIVATION_PATHS["ERC20"];
      derivation_paths[coin][network] = tmpl.replace("{index}", String(walletIndex));
    }
  }

  res.json({ balances, addresses, derivation_paths, wallet_index: walletIndex });
});

/* ── GET /wallet/onchain-balance ── live blockchain balance at user's address  */
walletRouter.get("/onchain-balance", async (req, res) => {
  const { coin, network } = z.object({
    coin:    z.enum(["BTC", "ETH", "USDC", "USDT"]),
    network: z.string().min(2).max(10).transform((v) => v.toUpperCase()),
  }).parse(req.query);

  const userId      = req.user!._id;
  const walletIndex = await ensureWalletIndex(userId);
  const address     = generateDepositAddress(coin, network, walletIndex);
  const onchain     = await getOnchainBalance({ coin, network, address });

  // Also return the in-app balance for comparison
  const wallet = await WalletModel.findOne({ userId, asset: coin });
  const inApp  = wallet?.balance ?? 0;

  res.json({ coin, network, address, onchain_balance: onchain, inapp_balance: inApp });
});

/* ── POST /wallet/check-deposit ── manual scan + credit ──────────────────── */
walletRouter.post("/check-deposit", async (req, res) => {
  const { coin, network } = z.object({
    coin:    z.enum(["BTC", "ETH", "USDC", "USDT"]),
    network: z.string().min(2).max(10).transform((v) => v.toUpperCase()),
  }).parse(req.body);

  const userId         = req.user!._id;
  const walletIndex    = await ensureWalletIndex(userId);
  const depositAddress = generateDepositAddress(coin, network, walletIndex);
  const afterTimestamp = req.user!.createdAt.getTime();

  const found = await findBlockchainDeposit({
    coin,
    network,
    depositAddress,
    minAmount: 0.000001,
    afterTimestamp,
  });

  if (!found) return res.json({ found: false });

  const existing = await WalletDepositModel.findOne({ txid: found.txid });
  if (existing) {
    return res.json({
      found: true,
      already_credited: true,
      txid: found.txid,
      amount: found.amount,
      coin,
      network,
    });
  }

  // Record first (unique txid), then credit
  try {
    await WalletDepositModel.create({
      userId,
      coin,
      network,
      amount: parseFloat(found.amount),
      txid: found.txid,
    });
  } catch (e: any) {
    if (e.code === 11000) {
      return res.json({
        found: true,
        already_credited: true,
        txid: found.txid,
        amount: found.amount,
        coin,
        network,
      });
    }
    throw e;
  }

  await WalletModel.findOneAndUpdate(
    { userId, asset: coin as "BTC" | "ETH" | "USDC" | "USDT" },
    { $inc: { balance: parseFloat(found.amount) } },
    { upsert: true, new: true },
  );

  res.json({ found: true, credited: true, txid: found.txid, amount: found.amount, coin, network });
});

/* ── POST /wallet/withdraw ── atomic debit + on-chain broadcast ──────────── */
walletRouter.post("/withdraw", async (req, res) => {
  const { coin, network, amount, to_address } = z.object({
    coin:       z.enum(["BTC", "ETH", "USDC", "USDT"]),
    network:    z.string().min(2).max(10).transform((v) => v.toUpperCase()),
    amount:     z.number().positive(),
    to_address: z.string().min(10).max(200),
  }).parse(req.body);

  const userId = req.user!._id;

  // Atomic debit — only succeeds if balance is sufficient
  const debitResult = await WalletModel.updateOne(
    { userId, asset: coin, balance: { $gte: amount } },
    { $inc: { balance: -amount } },
  );

  if (debitResult.modifiedCount === 0) {
    return res.status(400).json({ error: `Insufficient ${coin} balance` });
  }

  const walletIndex = await ensureWalletIndex(userId);

  // Create a pending record BEFORE broadcasting. This way even if the server
  // crashes between broadcast and DB write, we have an audit trail. Status
  // will be updated to "completed" or "failed" after the broadcast attempt.
  const withdrawalDoc = await WalletWithdrawalModel.create({
    userId,
    coin,
    network,
    amount,
    toAddress: to_address,
    txid: "",
    status: "pending",
  });

  try {
    const { txid } = await sendPayoutFromHDWallet({
      coin,
      network,
      depositIndex: walletIndex,
      toAddress: to_address,
      payoutAmount: amount,
    });

    await WalletWithdrawalModel.updateOne(
      { _id: withdrawalDoc._id },
      { txid, status: "completed" },
    );

    res.json({ txid, coin, network, amount, to_address });
  } catch (err) {
    // Since tx.wait() is removed, an error here means broadcast was never accepted.
    // Safe to refund: the tx is not on-chain.
    await Promise.all([
      WalletWithdrawalModel.updateOne({ _id: withdrawalDoc._id }, { status: "failed" }),
      WalletModel.updateOne({ userId, asset: coin }, { $inc: { balance: amount } }),
    ]);
    throw err;
  }
});

/* ── GET /wallet/withdrawals ── withdrawal history ──────────────────────── */
walletRouter.get("/withdrawals", async (req, res) => {
  const userId      = req.user!._id;
  const withdrawals = await WalletWithdrawalModel.find({ userId })
    .sort({ createdAt: -1 })
    .limit(50);

  res.json(
    withdrawals.map((w) => ({
      id:         String(w._id),
      coin:       w.coin,
      network:    w.network,
      amount:     w.amount,
      to_address: w.toAddress,
      txid:       w.txid,
      status:     w.status,
      created_at: w.createdAt,
    })),
  );
});

/* ── GET /wallet/deposits ── deposit history ─────────────────────────────── */
walletRouter.get("/deposits", async (req, res) => {
  const userId  = req.user!._id;
  const deposits = await WalletDepositModel.find({ userId })
    .sort({ creditedAt: -1 })
    .limit(50);

  res.json(
    deposits.map((d) => ({
      id:          String(d._id),
      coin:        d.coin,
      network:     d.network,
      amount:      d.amount,
      txid:        d.txid,
      credited_at: d.creditedAt,
    })),
  );
});
