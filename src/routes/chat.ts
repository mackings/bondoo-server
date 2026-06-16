import mongoose from "mongoose";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { ConversationModel, MessageModel } from "../models/chat.js";
import { OfferModel } from "../models/offer.js";
import { messageJson, offerJson, userPublic } from "../models/serializers.js";
import { UserModel } from "../models/user.js";
import { WalletModel } from "../models/wallet.js";

export const chatRouter = Router();

chatRouter.use(requireAuth);

function convJson(conv: any, messages: any[] = []) {
  return {
    id: String(conv._id),
    is_group: conv.isGroup,
    name: conv.name ?? null,
    last_message_at: conv.lastMessageAt,
    conversation_members: conv.memberIds.map((member: any) => ({
      user_id: String(member._id ?? member),
      profiles: member.email ? userPublic(member) : null,
    })),
    messages: messages.map(messageJson),
  };
}

chatRouter.get("/conversations", async (req, res) => {
  const conversations = await ConversationModel.find({ memberIds: req.user!._id })
    .populate("memberIds")
    .sort({ lastMessageAt: -1 });
  const rows = [];
  for (const conversation of conversations) {
    const latest = await MessageModel.find({ conversationId: conversation._id }).sort({ createdAt: -1 }).limit(1);
    rows.push(convJson(conversation, latest));
  }
  res.json(rows);
});

chatRouter.get("/conversations/:id/messages", async (req, res) => {
  const conversation = await ConversationModel.findById(req.params.id);
  if (!conversation || !conversation.memberIds.some((id) => String(id) === req.userId)) return res.status(404).json({ error: "Conversation not found" });
  const messages = await MessageModel.find({ conversationId: conversation._id }).sort({ createdAt: 1 });
  res.json(messages.map(messageJson));
});

chatRouter.post("/conversations/:id/messages", async (req, res) => {
  const body = z.object({ body: z.string().min(1).max(4000) }).parse(req.body);
  const conversation = await ConversationModel.findById(req.params.id);
  if (!conversation || !conversation.memberIds.some((id) => String(id) === req.userId)) return res.status(404).json({ error: "Conversation not found" });
  const message = await MessageModel.create({
    conversationId: conversation._id,
    senderId: req.user!._id,
    body: body.body,
    kind: "text",
  });
  conversation.lastMessageAt = new Date();
  await conversation.save();
  res.status(201).json(messageJson(message));
});

chatRouter.post("/conversations/:id/transfers", async (req, res) => {
  const body = z.object({
    recipient_id: z.string(),
    asset: z.enum(["BTC", "ETH", "USDC", "USDT"]),
    amount: z.number().positive(),
    note: z.string().optional().default(""),
  }).parse(req.body);
  const conversation = await ConversationModel.findById(req.params.id);
  if (!conversation || !conversation.memberIds.some((id) => String(id) === req.userId)) return res.status(404).json({ error: "Conversation not found" });
  if (!conversation.memberIds.some((id) => String(id) === body.recipient_id)) return res.status(400).json({ error: "Recipient is not in conversation" });

  const session = await mongoose.startSession();
  let message;
  await session.withTransaction(async () => {
    const senderWallet = await WalletModel.findOne({ userId: req.user!._id, asset: body.asset }).session(session);
    if (!senderWallet || senderWallet.balance < body.amount) throw new Error("Insufficient balance");
    senderWallet.balance -= body.amount;
    await senderWallet.save({ session });
    await WalletModel.updateOne(
      { userId: body.recipient_id, asset: body.asset },
      { $inc: { balance: body.amount } },
      { upsert: true, session },
    );
    message = await MessageModel.create([{
      conversationId: conversation._id,
      senderId: req.user!._id,
      kind: "transfer",
      transferAsset: body.asset,
      transferAmount: body.amount,
      transferNote: body.note,
    }], { session });
    conversation.lastMessageAt = new Date();
    await conversation.save({ session });
  });
  await session.endSession();

  res.status(201).json({ id: String((message as any)[0]._id) });
});

chatRouter.get("/users/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const filter: any = { _id: { $ne: req.user!._id } };
  if (q) filter.$or = [{ username: new RegExp(q, "i") }, { displayName: new RegExp(q, "i") }, { email: new RegExp(q, "i") }];
  const users = await UserModel.find(filter).limit(30);
  res.json(users.map(userPublic));
});

chatRouter.post("/users/open-direct", async (req, res) => {
  const body = z.object({ other_id: z.string() }).parse(req.body);
  if (body.other_id === req.userId) return res.status(400).json({ error: "Cannot chat with yourself" });
  const other = await UserModel.findById(body.other_id);
  if (!other) return res.status(404).json({ error: "User not found" });
  let conversation = await ConversationModel.findOne({
    isGroup: false,
    memberIds: { $all: [req.user!._id, other._id], $size: 2 },
  });
  if (!conversation) {
    conversation = await ConversationModel.create({
      isGroup: false,
      memberIds: [req.user!._id, other._id],
      createdBy: req.user!._id,
    });
  }
  res.json({ conversation_id: String(conversation._id) });
});

chatRouter.post("/offers/:id/open", async (req, res) => {
  const offer = await OfferModel.findById(req.params.id).populate("userId");
  if (!offer || offer.status !== "active") return res.status(404).json({ error: "Offer not found" });
  if (String(offer.userId._id) === req.userId) return res.status(400).json({ error: "You cannot start a trade with your own offer" });

  let conversation = await ConversationModel.findOne({
    isGroup: false,
    memberIds: { $all: [req.user!._id, offer.userId._id], $size: 2 },
  });
  if (!conversation) {
    conversation = await ConversationModel.create({
      isGroup: false,
      memberIds: [req.user!._id, offer.userId._id],
      createdBy: req.user!._id,
    });
  }

  const snapshot = offerJson(offer);
  const message = await MessageModel.create({
    conversationId: conversation._id,
    senderId: req.user!._id,
    kind: "offer",
    offerId: offer._id,
    offerSnapshot: snapshot,
    body: `I want to trade this ${offer.coin} offer.`,
  });
  conversation.lastMessageAt = new Date();
  await conversation.save();
  res.status(201).json({ conversation_id: String(conversation._id), message: messageJson(message) });
});
