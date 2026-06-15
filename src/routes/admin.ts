import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { BtcDepositModel } from "../models/deposit.js";
import { UserModel } from "../models/user.js";
import { WalletModel } from "../models/wallet.js";

export const adminRouter = Router();

adminRouter.use(requireAuth, requireAdmin);

adminRouter.get("/deposits", async (_req, res) => {
  const deposits = await BtcDepositModel.find().sort({ createdAt: -1 }).limit(100);
  res.json(deposits.map(depositJson));
});

adminRouter.post("/deposits/refresh", async (_req, res) => {
  const response = await fetch(`https://mempool.space/api/address/${config.bankBtcAddress}/txs`);
  if (!response.ok) return res.status(502).json({ error: `mempool ${response.status}` });
  const txs = await response.json() as any[];

  let upserted = 0;
  for (const tx of txs) {
    const txid = tx.txid as string;
    const confirmed = Boolean(tx.status?.confirmed);
    const blockTime = tx.status?.block_time as number | undefined;
    const fromAddress = tx.vin?.[0]?.prevout?.scriptpubkey_address ?? null;
    const vouts = tx.vout ?? [];

    for (let i = 0; i < vouts.length; i++) {
      const vout = vouts[i];
      if (vout.scriptpubkey_address !== config.bankBtcAddress) continue;
      await BtcDepositModel.updateOne(
        { txid, vout: i },
        {
          $set: {
            fromAddress,
            amountBtc: Number(vout.value ?? 0) / 100000000,
            confirmations: confirmed ? 1 : 0,
            blockTime: blockTime ? new Date(blockTime * 1000) : null,
          },
          $setOnInsert: { status: "unmatched" },
        },
        { upsert: true },
      );
      upserted++;
    }
  }

  res.json({ ok: true, scanned: txs.length, upserted });
});

adminRouter.post("/deposits/:id/credit", async (req, res) => {
  const body = z.object({ user_id: z.string() }).parse(req.body);
  const deposit = await BtcDepositModel.findById(req.params.id);
  if (!deposit) return res.status(404).json({ error: "Deposit not found" });
  if (deposit.get("status") !== "unmatched") return res.status(400).json({ error: `Already ${deposit.get("status")}` });
  const user = await UserModel.findById(body.user_id);
  if (!user) return res.status(404).json({ error: "User not found" });
  await WalletModel.updateOne(
    { userId: user._id, asset: "BTC" },
    { $inc: { balance: deposit.get("amountBtc") } },
    { upsert: true },
  );
  deposit.set("status", "credited");
  deposit.set("creditedUserId", user._id);
  deposit.set("creditedAt", new Date());
  await deposit.save();
  res.json({ ok: true });
});

adminRouter.get("/deposits/matches/:address", async (req, res) => {
  const users = await UserModel.find({ linkedBtcAddress: req.params.address }).limit(20);
  res.json(users.map((user) => ({
    id: String(user._id),
    username: user.username,
    display_name: user.displayName,
    phone: null,
  })));
});

function depositJson(deposit: any) {
  return {
    id: String(deposit._id),
    txid: deposit.txid,
    vout: deposit.vout,
    from_address: deposit.fromAddress ?? null,
    amount_btc: deposit.amountBtc,
    confirmations: deposit.confirmations,
    status: deposit.status,
    credited_user_id: deposit.creditedUserId ? String(deposit.creditedUserId) : null,
    credited_at: deposit.creditedAt ?? null,
    block_time: deposit.blockTime ?? null,
    created_at: deposit.createdAt,
    updated_at: deposit.updatedAt,
  };
}
