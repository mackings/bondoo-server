/**
 * Background deposit scanner.
 *
 * Scans the blockchain for new deposits to user wallet addresses and
 * automatically credits balances — no manual "Check" tap required.
 *
 * Strategy:
 *   - Processes up to BATCH_SIZE users per run, ordered by lastWalletScan
 *     ascending (null = never scanned → goes first). This gives every user
 *     equal coverage over time (round-robin rotation).
 *   - Scans all coin/network combos per user in parallel.
 *   - Uses txid uniqueness to prevent double-crediting on repeated scans.
 *   - afterTimestamp = user.createdAt, so we never miss deposits made since
 *     sign-up (blockchain APIs return only the last N txs anyway).
 *
 * Called by:
 *   1. setInterval every 5 min in app.ts (Render persistent process)
 *   2. POST /cron/scan-deposits (Vercel cron / manual trigger)
 */

import { UserModel } from "../../models/user.js";
import { WalletModel } from "../../models/wallet.js";
import { WalletDepositModel } from "../../models/wallet_deposit.js";
import { generateDepositAddress } from "../treasury/wallet/deposit-address.service.js";
import { findBlockchainDeposit } from "../treasury/blockchain/chain-detector.js";

const BATCH_SIZE = 20;

// All coin → network pairs to scan per user
const SCAN_PAIRS: Array<{ coin: string; network: string }> = [
  { coin: "BTC",  network: "BTC"   },
  { coin: "ETH",  network: "ERC20" },
  { coin: "USDC", network: "ERC20" },
  { coin: "USDC", network: "TRC20" },
  { coin: "USDC", network: "BSC"   },
  { coin: "USDT", network: "TRC20" },
  { coin: "USDT", network: "ERC20" },
  { coin: "USDT", network: "BSC"   },
];

type ScanResult = {
  usersScanned: number;
  depositsFound: number;
  errors: string[];
};

export async function scanUserDeposits(): Promise<ScanResult> {
  const errors: string[] = [];
  let depositsFound = 0;

  // Pick the batch of users least-recently scanned (null sorts first)
  const users = await UserModel.find(
    { walletIndex: { $exists: true, $ne: null } },
    { _id: 1, walletIndex: 1, createdAt: 1, lastWalletScan: 1 },
  )
    .sort({ lastWalletScan: 1 })
    .limit(BATCH_SIZE);

  if (!users.length) return { usersScanned: 0, depositsFound: 0, errors: [] };

  console.log(`[DepositScanner] scanning ${users.length} user(s)`);

  await Promise.all(
    users.map(async (user) => {
      const walletIndex    = user.walletIndex!;
      const afterTimestamp = user.createdAt.getTime();

      // Scan all pairs for this user in parallel
      const pairResults = await Promise.allSettled(
        SCAN_PAIRS.map(async ({ coin, network }) => {
          const address = generateDepositAddress(coin, network, walletIndex);
          const found   = await findBlockchainDeposit({
            coin,
            network,
            depositAddress: address,
            minAmount: 0.000001,
            afterTimestamp,
          });
          if (!found) return;

          // Prevent double-credit via unique txid index
          try {
            await WalletDepositModel.create({
              userId:  user._id,
              coin,
              network,
              amount: parseFloat(found.amount),
              txid:   found.txid,
            });
          } catch (e: any) {
            if (e.code === 11000) return; // already credited in a prior run
            throw e;
          }

          await WalletModel.findOneAndUpdate(
            { userId: user._id, asset: coin as "BTC" | "ETH" | "USDC" | "USDT" },
            { $inc: { balance: parseFloat(found.amount) } },
            { upsert: true, new: true },
          );

          depositsFound++;
          console.log(
            `[DepositScanner] ✓ ${found.amount} ${coin}/${network} → user ${user._id}  txid=${found.txid}`,
          );
        }),
      );

      for (const r of pairResults) {
        if (r.status === "rejected") {
          errors.push(`user=${user._id}: ${(r.reason as Error)?.message ?? r.reason}`);
        }
      }

      // Mark this user scanned so the next batch doesn't re-pick them immediately
      await UserModel.updateOne({ _id: user._id }, { lastWalletScan: new Date() });
    }),
  );

  if (depositsFound || errors.length) {
    console.log(
      `[DepositScanner] done — ${depositsFound} deposit(s) credited, ${errors.length} error(s)`,
    );
    if (errors.length) console.error("[DepositScanner] errors:", errors);
  }

  return { usersScanned: users.length, depositsFound, errors };
}
