import { Router } from "express";
import multer from "multer";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { TradeModel } from "../../models/trade.js";
import { OfferModel } from "../../models/offer.js";
import { UserModel } from "../../models/user.js";
import { quoteFees } from "../fees/fee.service.js";
import { bybitClient } from "../treasury/bybit/bybit.client.js";
import { generateDepositAddress } from "../treasury/wallet/deposit-address.service.js";
import { findBlockchainDeposit } from "../treasury/blockchain/chain-detector.js";
import { nextDepositIndex } from "../../models/counter.js";
import { notifyUser } from "../../notifications.js";

export const tradesRouter = Router();
tradesRouter.use(requireAuth);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.resolve(__dirname, "../../../uploads/receipts");

// Ensure the uploads directory exists (Render ephemeral filesystem needs this on every start)
import { mkdirSync } from "node:fs";
mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, `${randomUUID()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];
    cb(null, allowed.includes(file.mimetype));
  },
});

// After populate(), buyerUserId/sellerUserId are full documents — use ._id explicitly
function docId(field: any): string {
  return String(field?._id ?? field);
}

function tradeJson(trade: any, includeUsers = false) {
  return {
    id: String(trade._id),
    offer_id: String(trade.offerId),
    buyer_user_id: docId(trade.buyerUserId),
    seller_user_id: docId(trade.sellerUserId),
    buyer: includeUsers && trade.buyerUserId?.username ? {
      id: String(trade.buyerUserId._id),
      username: trade.buyerUserId.username,
      display_name: trade.buyerUserId.displayName ?? null,
      avatar_url: trade.buyerUserId.avatarUrl ?? null,
    } : null,
    seller: includeUsers && trade.sellerUserId?.username ? {
      id: String(trade.sellerUserId._id),
      username: trade.sellerUserId.username,
      display_name: trade.sellerUserId.displayName ?? null,
      avatar_url: trade.sellerUserId.avatarUrl ?? null,
      bank_accounts: (trade.sellerUserId.bankAccounts ?? []).map((a: any) => ({
        bank_name: a.bankName,
        account_name: a.accountName,
        account_number: a.accountNumber,
        currency: a.currency,
      })),
    } : null,
    coin: trade.coin,
    network: trade.network,
    crypto_amount: trade.cryptoAmount,
    fiat_amount: trade.fiatAmount,
    fiat_currency: trade.fiatCurrency,
    rate: trade.rate,
    payment_method: trade.paymentMethod,
    deposit_address: trade.depositAddress,
    deposit_txid: trade.depositTxid ?? null,
    deposit_confirmed_at: trade.depositConfirmedAt ?? null,
    payment_receipt_url: trade.paymentReceiptUrl ?? null,
    payment_note: trade.paymentNote ?? null,
    payment_sent_at: trade.paymentSentAt ?? null,
    buyer_wallet_address: trade.buyerWalletAddress ?? null,
    buyer_wallet_network: trade.buyerWalletNetwork ?? null,
    withdrawal_id: trade.withdrawalId ?? null,
    platform_fee: trade.platformFee,
    network_fee: trade.networkFee,
    payout_amount: trade.payoutAmount,
    status: trade.status,
    completed_at: trade.completedAt ?? null,
    cancelled_at: trade.cancelledAt ?? null,
    created_at: trade.createdAt,
    updated_at: trade.updatedAt,
  };
}

/* ─── GET /trades — list my trades ─────────────────────────────────────── */
tradesRouter.get("/", async (req, res) => {
  const trades = await TradeModel.find({
    $or: [{ buyerUserId: req.user!._id }, { sellerUserId: req.user!._id }],
  })
    .populate("buyerUserId")
    .populate("sellerUserId")
    .sort({ createdAt: -1 })
    .limit(100);

  res.json(trades.map((t) => tradeJson(t, true)));
});

/* ─── POST /trades — buyer clicks "Trade" on an offer ──────────────────── */
tradesRouter.post("/", async (req, res) => {
  const body = z.object({
    offer_id: z.string(),
    fiat_amount: z.number().positive(),
    network: z.string().trim().toUpperCase(),
    buyer_wallet_address: z.string().min(10),
    buyer_wallet_network: z.string().trim().toUpperCase(),
  }).parse(req.body);

  const offer = await OfferModel.findById(body.offer_id).populate("userId");
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  if (offer.status !== "active") return res.status(400).json({ error: "Offer is no longer active" });
  if (String(offer.userId._id) === req.userId) return res.status(400).json({ error: "Cannot trade with your own offer" });

  // Offer side = "sell" means seller wants to sell crypto → buyer pays fiat
  // Offer side = "buy" means poster wants to buy crypto → they pay fiat
  // In both cases: the one who HAS the crypto puts it in escrow
  const sellerUserId = offer.side === "sell"
    ? String(offer.userId._id)   // poster is selling → they're the seller
    : req.userId!;                // poster is buying → current user is the seller

  const buyerUserId = offer.side === "sell"
    ? req.userId!                 // current user is buying
    : String(offer.userId._id);  // poster is buying

  if (body.fiat_amount < offer.minFiatAmount || body.fiat_amount > offer.maxFiatAmount) {
    return res.status(400).json({
      error: `Fiat amount must be between ${offer.minFiatAmount} and ${offer.maxFiatAmount} ${offer.fiatCurrency}`,
    });
  }

  const cryptoAmount = body.fiat_amount / offer.rate;
  const fees = await quoteFees(offer.coin, body.network, cryptoAmount);

  // Derive a unique HD wallet address for this trade — no two trades ever share an address
  let depositAddress: string;
  let depositIndex: number;
  try {
    depositIndex = await nextDepositIndex();
    depositAddress = generateDepositAddress(offer.coin, body.network, depositIndex);
    console.log(`[Trade] deposit address for index=${depositIndex} coin=${offer.coin} net=${body.network}: ${depositAddress}`);
  } catch (err: any) {
    console.error("[Trade] generateDepositAddress error:", err.message);
    return res.status(500).json({ error: "Could not generate escrow deposit address. Please try again." });
  }

  const [seller, buyer] = await Promise.all([
    UserModel.findById(sellerUserId),
    UserModel.findById(buyerUserId),
  ]);
  if (!seller || !buyer) return res.status(404).json({ error: "User not found" });

  const trade = await TradeModel.create({
    offerId:           offer._id,
    buyerUserId:       buyer._id,
    sellerUserId:      seller._id,
    coin:              offer.coin,
    network:           body.network,
    cryptoAmount,
    fiatAmount:        body.fiat_amount,
    fiatCurrency:      offer.fiatCurrency,
    rate:              offer.rate,
    paymentMethod:     offer.paymentMethod,
    depositAddress,
    depositIndex,
    buyerWalletAddress:  body.buyer_wallet_address,
    buyerWalletNetwork:  body.buyer_wallet_network,
    platformFee:       fees.platformFee,
    networkFee:        fees.networkFee,
    payoutAmount:      fees.payoutAmount,
    status:            "awaiting_escrow",
  });

  // Notify seller: please deposit crypto to escrow (fire-and-forget — don't block response)
  notifyUser({
    user: seller,
    title: "New trade — deposit crypto to escrow",
    body: `${buyer.username ?? "A buyer"} wants to buy ${cryptoAmount.toFixed(8)} ${offer.coin}. Send exactly ${cryptoAmount.toFixed(8)} ${offer.coin} to your escrow address to start the trade.`,
    data: { type: "trade", trade_id: String(trade._id), status: "awaiting_escrow" },
  }).catch(console.error);

  await trade.populate(["buyerUserId", "sellerUserId"]);
  res.status(201).json(tradeJson(trade, true));
});

/* ─── GET /trades/:id ───────────────────────────────────────────────────── */
tradesRouter.get("/:id", async (req, res) => {
  const trade = await TradeModel.findById(req.params.id)
    .populate("buyerUserId")
    .populate("sellerUserId");

  if (!trade) return res.status(404).json({ error: "Trade not found" });
  if (
    String(trade.buyerUserId._id ?? trade.buyerUserId) !== req.userId &&
    String(trade.sellerUserId._id ?? trade.sellerUserId) !== req.userId &&
    req.user!.role !== "admin"
  ) {
    return res.status(403).json({ error: "Forbidden" });
  }

  res.json(tradeJson(trade, true));
});

/* ─── POST /trades/:id/check-deposit ───────────────────────────────────── */
// Seller calls this after sending crypto. We poll Bybit to verify.
tradesRouter.post("/:id/check-deposit", async (req, res) => {
  const trade = await TradeModel.findById(req.params.id)
    .populate("buyerUserId")
    .populate("sellerUserId");

  if (!trade) return res.status(404).json({ error: "Trade not found" });
  if (String(trade.sellerUserId._id ?? trade.sellerUserId) !== req.userId) {
    return res.status(403).json({ error: "Only the seller can confirm the deposit" });
  }
  if (trade.status !== "awaiting_escrow") {
    return res.status(400).json({ error: `Trade is already ${trade.status}` });
  }

  const deposit = await findBlockchainDeposit({
    coin: trade.coin,
    network: trade.network,
    depositAddress: trade.depositAddress,
    minAmount: trade.cryptoAmount,
    afterTimestamp: trade.createdAt.getTime(),
  });

  if (!deposit) {
    return res.status(202).json({
      found: false,
      message: "Deposit not detected yet. Please wait for blockchain confirmation and try again.",
    });
  }

  trade.depositTxid = deposit.txid;
  trade.depositConfirmedAt = new Date();
  trade.status = "escrowed";
  await trade.save();

  const buyer = trade.buyerUserId as any;
  const seller = trade.sellerUserId as any;

  notifyUser({
    user: buyer,
    title: "Crypto is in escrow — pay now",
    body: `${trade.cryptoAmount.toFixed(8)} ${trade.coin} is locked in escrow. Please pay ${trade.fiatAmount} ${trade.fiatCurrency} to the seller via ${trade.paymentMethod} and upload your receipt.`,
    data: { type: "trade", trade_id: String(trade._id), status: "escrowed" },
  }).catch(console.error);

  notifyUser({
    user: seller,
    title: "Escrow confirmed",
    body: `Your ${trade.cryptoAmount.toFixed(8)} ${trade.coin} deposit has been confirmed. Waiting for buyer's payment.`,
    data: { type: "trade", trade_id: String(trade._id), status: "escrowed" },
  }).catch(console.error);

  res.json({ found: true, trade: tradeJson(trade, true) });
});

/* ─── POST /trades/:id/payment-sent — buyer uploads receipt ────────────── */
tradesRouter.post("/:id/payment-sent", upload.single("receipt"), async (req, res) => {
  const trade = await TradeModel.findById(req.params.id)
    .populate("buyerUserId")
    .populate("sellerUserId");

  if (!trade) return res.status(404).json({ error: "Trade not found" });
  if (String(trade.buyerUserId._id ?? trade.buyerUserId) !== req.userId) {
    return res.status(403).json({ error: "Only the buyer can mark payment sent" });
  }
  if (trade.status !== "escrowed") {
    return res.status(400).json({ error: `Trade must be escrowed before marking payment sent (currently: ${trade.status})` });
  }
  if (!req.file) {
    return res.status(400).json({ error: "Payment receipt image is required" });
  }

  const body = z.object({
    note: z.string().max(500).optional(),
  }).parse(req.body);

  // Build publicly accessible URL for the receipt
  const receiptUrl = `/uploads/receipts/${req.file.filename}`;

  trade.paymentReceiptUrl = receiptUrl;
  trade.paymentNote = body.note;
  trade.paymentSentAt = new Date();
  trade.status = "payment_sent";
  await trade.save();

  const seller = trade.sellerUserId as any;
  const buyer = trade.buyerUserId as any;

  notifyUser({
    user: seller,
    title: "Buyer has paid — check your bank",
    body: `${buyer.username ?? "The buyer"} has sent ${trade.fiatAmount} ${trade.fiatCurrency} via ${trade.paymentMethod}. Check your bank account and release the crypto once confirmed.`,
    data: { type: "trade", trade_id: String(trade._id), status: "payment_sent" },
  }).catch(console.error);

  res.json(tradeJson(trade, true));
});

/* ─── POST /trades/:id/release — seller releases coins to buyer ─────────── */
tradesRouter.post("/:id/release", async (req, res) => {
  const trade = await TradeModel.findById(req.params.id)
    .populate("buyerUserId")
    .populate("sellerUserId");

  if (!trade) return res.status(404).json({ error: "Trade not found" });
  if (String(trade.sellerUserId._id ?? trade.sellerUserId) !== req.userId) {
    return res.status(403).json({ error: "Only the seller can release coins" });
  }
  if (trade.status !== "payment_sent") {
    return res.status(400).json({ error: `Cannot release — trade is ${trade.status}` });
  }
  if (!trade.buyerWalletAddress) {
    return res.status(400).json({ error: "Buyer wallet address is missing" });
  }
  if (trade.payoutAmount <= 0) {
    return res.status(400).json({ error: "Payout amount is zero" });
  }

  trade.status = "releasing";
  await trade.save();

  let withdrawalId: string;
  try {
    const withdrawal = await bybitClient.withdraw({
      coin: trade.coin,
      chain: trade.buyerWalletNetwork ?? trade.network,
      address: trade.buyerWalletAddress,
      amount: String(trade.payoutAmount),
    });
    withdrawalId = withdrawal.id;
  } catch (err: any) {
    trade.status = "payment_sent"; // rollback
    await trade.save();
    console.error("Bybit withdrawal error:", err.message);
    return res.status(502).json({ error: `Withdrawal failed: ${err.message}` });
  }

  trade.withdrawalId = withdrawalId;
  trade.status = "completed";
  trade.completedAt = new Date();
  await trade.save();

  const buyer = trade.buyerUserId as any;
  const seller = trade.sellerUserId as any;

  notifyUser({
    user: buyer,
    title: "Crypto released to your wallet!",
    body: `${trade.payoutAmount.toFixed(8)} ${trade.coin} has been sent to your wallet. Trade complete.`,
    data: { type: "trade", trade_id: String(trade._id), status: "completed" },
  }).catch(console.error);
  notifyUser({
    user: seller,
    title: "Trade completed",
    body: `You have successfully released ${trade.payoutAmount.toFixed(8)} ${trade.coin} to the buyer. Trade is complete.`,
    data: { type: "trade", trade_id: String(trade._id), status: "completed" },
  }).catch(console.error);

  res.json(tradeJson(trade, true));
});

/* ─── POST /trades/:id/cancel ───────────────────────────────────────────── */
tradesRouter.post("/:id/cancel", async (req, res) => {
  const trade = await TradeModel.findById(req.params.id)
    .populate("buyerUserId")
    .populate("sellerUserId");

  if (!trade) return res.status(404).json({ error: "Trade not found" });

  const isParty =
    String(trade.buyerUserId._id ?? trade.buyerUserId) === req.userId ||
    String(trade.sellerUserId._id ?? trade.sellerUserId) === req.userId;

  if (!isParty && req.user!.role !== "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (!["awaiting_escrow", "escrowed"].includes(trade.status)) {
    return res.status(400).json({
      error: "Trade can only be cancelled before payment has been sent",
    });
  }

  trade.status = "cancelled";
  trade.cancelledAt = new Date();
  await trade.save();

  const otherParty = String(trade.buyerUserId._id ?? trade.buyerUserId) === req.userId
    ? trade.sellerUserId as any
    : trade.buyerUserId as any;

  notifyUser({
    user: otherParty,
    title: "Trade cancelled",
    body: `The trade for ${trade.cryptoAmount.toFixed(8)} ${trade.coin} has been cancelled.`,
    data: { type: "trade", trade_id: String(trade._id), status: "cancelled" },
  }).catch(console.error);

  res.json(tradeJson(trade, true));
});

/* ─── POST /trades/:id/dispute ──────────────────────────────────────────── */
tradesRouter.post("/:id/dispute", async (req, res) => {
  const body = z.object({ reason: z.string().min(10).max(1000) }).parse(req.body);

  const trade = await TradeModel.findById(req.params.id)
    .populate("buyerUserId")
    .populate("sellerUserId");

  if (!trade) return res.status(404).json({ error: "Trade not found" });

  const isParty =
    String(trade.buyerUserId._id ?? trade.buyerUserId) === req.userId ||
    String(trade.sellerUserId._id ?? trade.sellerUserId) === req.userId;

  if (!isParty) return res.status(403).json({ error: "Forbidden" });

  if (["completed", "cancelled", "disputed"].includes(trade.status)) {
    return res.status(400).json({ error: `Trade is already ${trade.status}` });
  }

  trade.status = "disputed";
  await trade.save();

  const otherParty = String(trade.buyerUserId._id ?? trade.buyerUserId) === req.userId
    ? trade.sellerUserId as any
    : trade.buyerUserId as any;

  notifyUser({
    user: otherParty,
    title: "Trade dispute raised",
    body: `A dispute has been raised on your ${trade.coin} trade. Reason: ${body.reason}. Our team will review.`,
    data: { type: "trade", trade_id: String(trade._id), status: "disputed" },
  }).catch(console.error);

  res.json({ trade: tradeJson(trade, true), reason: body.reason });
});
