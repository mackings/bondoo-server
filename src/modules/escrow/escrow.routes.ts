import { Router } from "express";
import { z } from "zod";
import { config } from "../../config.js";
import { requireAuth } from "../../middleware/auth.js";
import { EscrowEventModel, EscrowModel } from "../../models/escrow.js";
import { escrowJson } from "../../models/serializers.js";
import { UserModel } from "../../models/user.js";
import { WalletAddressModel } from "../../models/wallet-address.js";
import { quoteFees } from "../fees/fee.service.js";

export const escrowRouter = Router();

escrowRouter.use(requireAuth);

escrowRouter.get("/", async (req, res) => {
  const rows = await EscrowModel.find({
    $or: [{ senderUserId: req.user!._id }, { receiverUserId: req.user!._id }],
  }).sort({ createdAt: -1 });
  res.json(rows.map(escrowJson));
});

escrowRouter.post("/", async (req, res) => {
  const body = z.object({
    receiver_user_id: z.string(),
    coin: z.string().trim().toUpperCase(),
    network: z.string().trim().toUpperCase(),
    amount: z.number().positive(),
  }).parse(req.body);

  if (body.receiver_user_id === req.userId) return res.status(400).json({ error: "Cannot create escrow with yourself" });
  const receiver = await UserModel.findById(body.receiver_user_id);
  if (!receiver) return res.status(404).json({ error: "Receiver not found" });

  const fees = await quoteFees(body.coin, body.network, body.amount);
  const escrow = await EscrowModel.create({
    senderUserId: req.user!._id,
    receiverUserId: receiver._id,
    coin: body.coin,
    network: body.network,
    amount: body.amount,
    platformFee: fees.platformFee,
    networkFee: fees.networkFee,
    payoutAmount: fees.payoutAmount,
    depositAddress: config.escrowDepositAddress,
    status: "awaiting_deposit",
  });
  await EscrowEventModel.create({
    escrowTransactionId: escrow._id,
    actorUserId: req.user!._id,
    eventType: "created",
    metadata: { coin: body.coin, network: body.network, amount: body.amount },
  });

  res.status(201).json(escrowJson(escrow));
});

escrowRouter.get("/:id", async (req, res) => {
  const escrow = await EscrowModel.findById(req.params.id);
  if (!escrow) return res.status(404).json({ error: "Escrow not found" });
  if (![String(escrow.senderUserId), String(escrow.receiverUserId)].includes(req.userId!) && req.user!.role !== "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }
  res.json(escrowJson(escrow));
});

escrowRouter.get("/:id/events", async (req, res) => {
  const escrow = await EscrowModel.findById(req.params.id);
  if (!escrow) return res.status(404).json({ error: "Escrow not found" });
  if (![String(escrow.senderUserId), String(escrow.receiverUserId)].includes(req.userId!) && req.user!.role !== "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }
  const events = await EscrowEventModel.find({ escrowTransactionId: escrow._id }).sort({ createdAt: 1 });
  res.json(events.map((event) => ({
    id: String(event._id),
    escrow_transaction_id: String(event.escrowTransactionId),
    actor_user_id: event.actorUserId ? String(event.actorUserId) : null,
    event_type: event.eventType,
    metadata: event.metadata,
    created_at: event.createdAt,
  })));
});

escrowRouter.post("/:id/receiver-wallet", async (req, res) => {
  const body = z.object({
    address: z.string().min(10),
    network: z.string().trim().toUpperCase(),
  }).parse(req.body);
  const escrow = await EscrowModel.findById(req.params.id);
  if (!escrow) return res.status(404).json({ error: "Escrow not found" });
  if (String(escrow.receiverUserId) !== req.userId) return res.status(403).json({ error: "Only the receiver can submit payout wallet" });
  if (!["funded", "awaiting_receiver_wallet"].includes(escrow.status)) return res.status(400).json({ error: `Escrow is ${escrow.status}` });

  escrow.receiverWalletAddress = body.address;
  escrow.receiverWalletNetwork = body.network;
  escrow.status = "payout_pending";
  await escrow.save();
  await WalletAddressModel.create({
    userId: req.user!._id,
    coin: escrow.coin,
    network: body.network,
    address: body.address,
    label: "Escrow payout",
  });
  await EscrowEventModel.create({
    escrowTransactionId: escrow._id,
    actorUserId: req.user!._id,
    eventType: "receiver_wallet_submitted",
    metadata: { network: body.network },
  });

  res.json(escrowJson(escrow));
});
