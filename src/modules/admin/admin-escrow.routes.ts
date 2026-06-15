import { Router } from "express";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../../middleware/auth.js";
import { EscrowEventModel, EscrowModel } from "../../models/escrow.js";
import { escrowJson } from "../../models/serializers.js";
import { bybitClient } from "../treasury/bybit/bybit.client.js";

export const adminEscrowRouter = Router();

adminEscrowRouter.use(requireAuth, requireAdmin);

adminEscrowRouter.get("/", async (_req, res) => {
  const rows = await EscrowModel.find().sort({ createdAt: -1 }).limit(200);
  res.json(rows.map(escrowJson));
});

adminEscrowRouter.post("/:id/mark-funded", async (req, res) => {
  const body = z.object({ deposit_txid: z.string().min(4) }).parse(req.body);
  const escrow = await EscrowModel.findById(req.params.id);
  if (!escrow) return res.status(404).json({ error: "Escrow not found" });
  escrow.depositTxid = body.deposit_txid;
  escrow.status = "awaiting_receiver_wallet";
  escrow.fundedAt = new Date();
  await escrow.save();
  await EscrowEventModel.create({
    escrowTransactionId: escrow._id,
    actorUserId: req.user!._id,
    eventType: "deposit_confirmed",
    metadata: { deposit_txid: body.deposit_txid },
  });
  res.json(escrowJson(escrow));
});

adminEscrowRouter.post("/:id/release", async (req, res) => {
  const escrow = await EscrowModel.findById(req.params.id);
  if (!escrow) return res.status(404).json({ error: "Escrow not found" });
  if (escrow.status !== "payout_pending") return res.status(400).json({ error: `Escrow is ${escrow.status}` });
  if (!escrow.receiverWalletAddress) return res.status(400).json({ error: "Receiver wallet missing" });

  const withdrawal = await bybitClient.withdraw({
    coin: escrow.coin,
    chain: escrow.receiverWalletNetwork ?? escrow.network,
    address: escrow.receiverWalletAddress,
    amount: String(escrow.payoutAmount),
  });
  escrow.withdrawalId = withdrawal.id;
  escrow.status = "paid_out";
  escrow.paidOutAt = new Date();
  await escrow.save();
  await EscrowEventModel.create({
    escrowTransactionId: escrow._id,
    actorUserId: req.user!._id,
    eventType: "payout_released",
    metadata: { withdrawal_id: withdrawal.id, dry_run: withdrawal.dryRun },
  });
  res.json(escrowJson(escrow));
});
