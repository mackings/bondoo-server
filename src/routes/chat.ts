import mongoose from "mongoose";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { ConversationModel, MessageModel } from "../models/chat.js";
import { notifyUserPushOnly, notifyUser } from "../notifications.js";
import { OfferModel } from "../models/offer.js";
import { messageJson, offerJson, userPublic } from "../models/serializers.js";
import { UserModel } from "../models/user.js";
import { WalletModel } from "../models/wallet.js";
import { TradeModel } from "../models/trade.js";
import { quoteFees } from "../modules/fees/fee.service.js";
import { generateDepositAddress } from "../modules/treasury/wallet/deposit-address.service.js";
import { nextDepositIndex } from "../models/counter.js";
import { io } from "../sockets/chat.socket.js";

export const chatRouter = Router();

chatRouter.use(requireAuth);

async function convJson(conv: any, currentUserId: string, messages: any[] = []) {
  return {
    id: String(conv._id),
    is_group: conv.isGroup,
    name: conv.name ?? null,
    last_message_at: conv.lastMessageAt,
    unread_count: await unreadCount(conv._id, currentUserId),
    conversation_members: conv.memberIds.map((member: any) => ({
      user_id: String(member._id ?? member),
      profiles: member.email ? userPublic(member) : null,
    })),
    messages: messages.map(messageJson),
  };
}

function messagePreview(message: any) {
  switch (message.kind) {
    case "image":
      return "sent a photo";
    case "voice":
      return "sent a voice note";
    case "transfer":
      return `sent ${message.transferAmount ?? ""} ${message.transferAsset ?? ""}`.trim();
    case "offer":
      return "shared an offer";
    case "trade_proposal":
      return "proposed a trade";
    case "trade_update":
      return `trade update: ${message.body ?? "status changed"}`;
    default:
      return `${message.body ?? "sent a message"}`.trim() || "sent a message";
  }
}

async function unreadCount(conversationId: any, currentUserId: string) {
  return MessageModel.countDocuments({
    conversationId,
    senderId: { $ne: currentUserId },
    "readReceipts.userId": { $ne: currentUserId },
  });
}

async function notifyConversationRecipients(conversation: any, message: any, sender: any) {
  const populated = await conversation.populate("memberIds");
  const recipients = populated.memberIds.filter((member: any) => String(member._id) !== String(sender._id));
  await Promise.allSettled(
    recipients.map((user: any) =>
      notifyUserPushOnly({
        user,
        title: `New message from ${sender.displayName ?? sender.username ?? "BONDOO"}`,
        body: messagePreview(message),
        data: {
          type: "chat_message",
          conversation_id: String(conversation._id),
          message_id: String(message._id),
        },
      }),
    ),
  );
}

chatRouter.get("/conversations", async (req, res) => {
  const conversations = await ConversationModel.find({ memberIds: req.user!._id })
    .populate("memberIds")
    .sort({ lastMessageAt: -1 });
  const rows = [];
  for (const conversation of conversations) {
    const latest = await MessageModel.find({ conversationId: conversation._id }).sort({ createdAt: -1 }).limit(1);
    rows.push(await convJson(conversation, req.userId!, latest));
  }
  res.json(rows);
});

chatRouter.get("/conversations/:id/messages", async (req, res) => {
  const conversation = await ConversationModel.findById(req.params.id);
  if (!conversation || !conversation.memberIds.some((id) => String(id) === req.userId)) return res.status(404).json({ error: "Conversation not found" });
  const messages = await MessageModel.find({ conversationId: conversation._id }).sort({ createdAt: 1 });
  res.json(messages.map(messageJson));
});

chatRouter.post("/conversations/:id/read", async (req, res) => {
  const conversation = await ConversationModel.findById(req.params.id);
  if (!conversation || !conversation.memberIds.some((id) => String(id) === req.userId)) return res.status(404).json({ error: "Conversation not found" });
  const now = new Date();
  await MessageModel.updateMany(
    {
      conversationId: conversation._id,
      senderId: { $ne: req.user!._id },
      "readReceipts.userId": { $ne: req.user!._id },
    },
    {
      $push: {
        readReceipts: {
          userId: req.user!._id,
          readAt: now,
        },
      },
    },
  );
  res.json({ ok: true });
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
  const textPayload = messageJson(message);
  io?.to(`conv:${String(conversation._id)}`).emit("new_message", textPayload);
  await notifyConversationRecipients(conversation, message, req.user!);
  res.status(201).json(textPayload);
});

chatRouter.post("/conversations/:id/voice-notes", async (req, res) => {
  const body = z.object({
    audio_data_url: z.string().startsWith("data:audio/").max(1_400_000),
    duration_ms: z.number().int().positive().max(120_000),
  }).parse(req.body);
  const conversation = await ConversationModel.findById(req.params.id);
  if (!conversation || !conversation.memberIds.some((id) => String(id) === req.userId)) return res.status(404).json({ error: "Conversation not found" });
  const message = await MessageModel.create({
    conversationId: conversation._id,
    senderId: req.user!._id,
    kind: "voice",
    voiceDataUrl: body.audio_data_url,
    voiceDurationMs: body.duration_ms,
  });
  conversation.lastMessageAt = new Date();
  await conversation.save();
  const voicePayload = messageJson(message);
  io?.to(`conv:${String(conversation._id)}`).emit("new_message", voicePayload);
  await notifyConversationRecipients(conversation, message, req.user!);
  res.status(201).json(voicePayload);
});

chatRouter.post("/conversations/:id/images", async (req, res) => {
  const body = z.object({
    image_data_url: z.string().startsWith("data:image/").max(4_000_000),
  }).parse(req.body);
  const conversation = await ConversationModel.findById(req.params.id);
  if (!conversation || !conversation.memberIds.some((id) => String(id) === req.userId)) return res.status(404).json({ error: "Conversation not found" });
  const message = await MessageModel.create({
    conversationId: conversation._id,
    senderId: req.user!._id,
    kind: "image",
    imageDataUrl: body.image_data_url,
  });
  conversation.lastMessageAt = new Date();
  await conversation.save();
  const imagePayload = messageJson(message);
  io?.to(`conv:${String(conversation._id)}`).emit("new_message", imagePayload);
  await notifyConversationRecipients(conversation, message, req.user!);
  res.status(201).json(imagePayload);
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
  if (message) {
    const transferMsg = (message as any)[0];
    const transferPayload = messageJson(transferMsg);
    io?.to(`conv:${String(conversation._id)}`).emit("new_message", transferPayload);
    await notifyConversationRecipients(conversation, transferMsg, req.user!);
  }

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
  if (!offer.userId || !(offer.userId as any)._id) return res.status(404).json({ error: "Offer owner not found" });
  if (String((offer.userId as any)._id) === req.userId) return res.status(400).json({ error: "You cannot start a trade with your own offer" });

  let conversation = await ConversationModel.findOne({
    isGroup: false,
    memberIds: { $all: [req.user!._id, (offer.userId as any)._id], $size: 2 },
  });
  if (!conversation) {
    conversation = await ConversationModel.create({
      isGroup: false,
      memberIds: [req.user!._id, (offer.userId as any)._id],
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
  const offerMsgPayload = messageJson(message);
  io?.to(`conv:${String(conversation._id)}`).emit("new_message", offerMsgPayload);
  await notifyConversationRecipients(conversation, message, req.user!);
  res.status(201).json({ conversation_id: String(conversation._id), message: offerMsgPayload });
});

/* POST /chat/conversations/:id/propose-trade
   Either party proposes a direct trade inside an existing DM.
   Body: seller_user_id, coin, network, fiat_amount, fiat_currency,
         rate, payment_method, buyer_wallet_address, buyer_wallet_network
*/
chatRouter.post("/conversations/:id/propose-trade", async (req, res) => {
  const body = z.object({
    seller_user_id: z.string(),
    coin: z.enum(["BTC", "ETH", "USDC", "USDT"]),
    network: z.string().trim().toUpperCase(),
    fiat_amount: z.number().positive(),
    fiat_currency: z.string().min(3).max(6).transform((v) => v.toUpperCase()).default("NGN"),
    rate: z.number().positive(),
    payment_method: z.string().min(2).max(80),
    buyer_wallet_address: z.string().min(10),
    buyer_wallet_network: z.string().trim().toUpperCase(),
  }).parse(req.body);

  const conversation = await ConversationModel.findById(req.params.id);
  if (!conversation || !conversation.memberIds.some((id) => String(id) === req.userId)) {
    return res.status(404).json({ error: "Conversation not found" });
  }
  if (conversation.isGroup) return res.status(400).json({ error: "Trade proposals only allowed in direct messages" });

  const memberStrs = conversation.memberIds.map(String);
  if (!memberStrs.includes(body.seller_user_id)) {
    return res.status(400).json({ error: "Seller must be a member of this conversation" });
  }
  if (body.seller_user_id === req.userId) {
    return res.status(400).json({ error: "You cannot be both buyer and seller" });
  }

  const buyerUserId = req.userId!;
  const sellerUserId = body.seller_user_id;

  const [seller, buyer] = await Promise.all([
    UserModel.findById(sellerUserId),
    UserModel.findById(buyerUserId),
  ]);
  if (!seller || !buyer) return res.status(404).json({ error: "User not found" });

  const cryptoAmount = body.fiat_amount / body.rate;
  const fees = await quoteFees(body.coin, body.network, cryptoAmount);

  let depositAddress: string;
  let depositIndex: number;
  try {
    depositIndex = await nextDepositIndex();
    depositAddress = generateDepositAddress(body.coin, body.network, depositIndex);
  } catch (err: any) {
    return res.status(500).json({ error: "Could not generate escrow address. Try again." });
  }

  const trade = await TradeModel.create({
    conversationId: conversation._id,
    source: "direct",
    buyerUserId: buyer._id,
    sellerUserId: seller._id,
    coin: body.coin,
    network: body.network,
    cryptoAmount,
    fiatAmount: body.fiat_amount,
    fiatCurrency: body.fiat_currency,
    rate: body.rate,
    paymentMethod: body.payment_method,
    depositAddress,
    depositIndex,
    buyerWalletAddress: body.buyer_wallet_address,
    buyerWalletNetwork: body.buyer_wallet_network,
    platformFee: fees.platformFee,
    networkFee: fees.networkFee,
    escrowAmount: fees.escrowAmount,
    payoutAmount: fees.payoutAmount,
    status: "awaiting_escrow",
  });

  const tradeSnapshot = {
    id: String(trade._id),
    coin: trade.coin,
    network: trade.network,
    crypto_amount: trade.cryptoAmount,
    fiat_amount: trade.fiatAmount,
    fiat_currency: trade.fiatCurrency,
    rate: trade.rate,
    payment_method: trade.paymentMethod,
    escrow_amount: trade.escrowAmount,
    payout_amount: trade.payoutAmount,
    status: trade.status,
  };

  const message = await MessageModel.create({
    conversationId: conversation._id,
    senderId: req.user!._id,
    kind: "trade_proposal",
    tradeId: trade._id,
    tradeSnapshot,
    body: `Trade proposal: buy ${cryptoAmount.toFixed(8)} ${body.coin} for ${body.fiat_amount} ${body.fiat_currency} at ${body.rate} rate.`,
  });

  conversation.lastMessageAt = new Date();
  await conversation.save();

  const tradePayload = messageJson(message);
  io?.to(`conv:${String(conversation._id)}`).emit("new_message", tradePayload);

  notifyUser({
    user: seller,
    title: `${buyer.displayName ?? buyer.username} proposed a trade`,
    body: `Buy ${cryptoAmount.toFixed(8)} ${body.coin} for ${body.fiat_amount} ${body.fiat_currency}. Send crypto to escrow to confirm.`,
    data: { type: "trade_proposal", trade_id: String(trade._id), conversation_id: String(conversation._id) },
  }).catch(console.error);

  res.status(201).json({ trade_id: String(trade._id), message: tradePayload });
});
