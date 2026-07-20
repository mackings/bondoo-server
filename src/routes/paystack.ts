import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { config } from "../config.js";
import { NairaWalletModel, NairaTransactionModel, getOrCreateWallet } from "../models/naira_wallet.js";
import { OrderModel } from "../models/order.js";
import { ProductModel } from "../models/product.js";
import { UserModel } from "../models/user.js";
import { notifyUser } from "../notifications.js";
import { paystackPost, paystackGet, createOrGetPaystackCustomer, createDVA } from "../lib/paystack-dva.js";

export const paystackRouter = Router();

// ── Initialize payment ─────────────────────────────────────────────────────
// POST /paystack/initialize
// Body: { product_id, amount? } — amount defaults to product price if omitted
paystackRouter.post("/initialize", requireAuth, async (req, res) => {
  const body = z.object({
    product_id: z.string(),
    amount:     z.number().min(1).optional(),
  }).parse(req.body);

  const product = await ProductModel.findById(body.product_id).populate("sellerId");
  if (!product || product.status !== "active") {
    return res.status(404).json({ error: "Product not available" });
  }

  const buyer = req.user!;
  const amountNaira = body.amount ?? product.price;
  const amountKobo  = Math.round(amountNaira * 100);

  const result = await paystackPost("/transaction/initialize", {
    email:         buyer.email,
    amount:        amountKobo,
    currency:      "NGN",
    reference:     `bondoo_${Date.now()}_${buyer._id}`,
    metadata: {
      buyer_id:   String(buyer._id),
      seller_id:  String(product.sellerId._id ?? product.sellerId),
      product_id: String(product._id),
      product_title: product.title,
    },
    callback_url:  `${req.protocol}://${req.get("host")}/paystack/callback`,
  });

  res.json({
    authorization_url: result.data.authorization_url,
    reference:         result.data.reference,
    amount:            amountNaira,
  });
});

// ── Paystack webhook ───────────────────────────────────────────────────────
// POST /paystack/webhook  (no auth — verified via HMAC)
paystackRouter.post("/webhook", async (req, res) => {
  // Verify signature
  const sig  = req.headers["x-paystack-signature"] as string;
  const hash = crypto.createHmac("sha512", config.paystackSecretKey)
    .update(JSON.stringify(req.body))
    .digest("hex");
  if (hash !== sig) return res.status(401).end();

  const event = req.body as { event: string; data: any };

  // ── Wallet top-up via Dedicated Virtual Account ──────────────────────────
  // Fires when someone sends money to a user's virtual account number
  const isDvaCredit =
    event.event === "dedicatedaccount.credit" ||
    (event.event === "charge.success" && event.data?.dedicated_account);

  if (isDvaCredit) {
    const d = event.data;
    const reference = d.reference as string;
    const amountNaira = (d.amount as number) / 100;

    // Find the user — try receiver account number first, then customer code
    const accountNumber: string | undefined =
      d.dedicated_account?.account?.account_number ??
      d.dedicated_account?.account_number ??
      d.authorization?.receiver_bank_account_number;
    const customerCode: string | undefined =
      d.customer?.customer_code ??
      d.dedicated_account?.customer?.customer_code;

    const depositUser = accountNumber
      ? await UserModel.findOne({ "virtualAccount.accountNumber": accountNumber })
      : customerCode
      ? await UserModel.findOne({ paystackCustomerCode: customerCode })
      : null;

    if (depositUser) {
      const dupCheck = await NairaTransactionModel.findOne({ reference });
      if (!dupCheck) {
        const depositWallet = await getOrCreateWallet(depositUser._id);
        depositWallet.balance += amountNaira;
        await depositWallet.save();
        await NairaTransactionModel.create({
          userId:      depositUser._id,
          type:        "credit",
          amount:      amountNaira,
          description: `Wallet top-up`,
          reference,
          status:      "completed",
        });
        notifyUser({
          user: depositUser,
          title: "Wallet Credited 💰",
          body:  `₦${amountNaira.toLocaleString("en-NG")} has been added to your wallet.`,
          data:  { type: "wallet_credit" },
        }).catch(() => {});
      }
    }
    return res.json({ ok: true });
  }

  // ── DVA assigned via /dedicated_account/assign ───────────────────────────
  if (event.event === "dedicatedaccount.assign.success") {
    const d = event.data;
    const customerCode = d?.customer?.customer_code;
    const email        = d?.customer?.email;
    console.log("[webhook] dedicatedaccount.assign.success for", customerCode, email);

    const assignedUser = customerCode
      ? await UserModel.findOne({ paystackCustomerCode: customerCode })
      : email
      ? await UserModel.findOne({ email: email.toLowerCase() })
      : null;

    if (assignedUser && !assignedUser.virtualAccount?.accountNumber) {
      const virtualAccount = {
        accountNumber: d.account_number as string,
        accountName:   d.account_name as string,
        bankName:      d.bank?.name as string,
        bankSlug:      d.bank?.slug as string,
        customerId:    customerCode as string,
      };
      await UserModel.findByIdAndUpdate(assignedUser._id, { virtualAccount });
      console.log("[webhook] DVA saved for", email, "→", d.account_number);
    }
    return res.json({ ok: true });
  }

  if (event.event === "dedicatedaccount.assign.failed") {
    console.log("[webhook] dedicatedaccount.assign.failed for", event.data?.customer?.email, event.data?.reason);
  }

  if (event.event === "charge.success") {
    const { reference, amount: amountKobo, metadata } = event.data;
    const amountNaira  = amountKobo / 100;
    const { seller_id, buyer_id, product_id, product_title } = metadata ?? {};

    // Idempotency: skip if already processed
    const existing = await NairaTransactionModel.findOne({ reference });
    if (existing) return res.json({ ok: true });

    // Credit seller wallet
    const wallet = await getOrCreateWallet(seller_id);
    wallet.balance += amountNaira;
    await wallet.save();

    await NairaTransactionModel.create({
      userId:      seller_id,
      type:        "credit",
      amount:      amountNaira,
      description: `Sale: ${product_title ?? "Product"}`,
      reference,
      status:      "completed",
      meta:        { buyer_id, product_id, product_title },
    });

    // Debit buyer record (for purchase history)
    const buyerRef = `${reference}_buyer`;
    const buyerWallet = await getOrCreateWallet(buyer_id);
    // No balance deduction for buyer — Paystack charged their card directly
    await NairaTransactionModel.create({
      userId:      buyer_id,
      type:        "debit",
      amount:      amountNaira,
      description: `Purchase: ${product_title ?? "Product"}`,
      reference:   buyerRef,
      status:      "completed",
      meta:        { seller_id, product_id, product_title },
    });

    // Create order record (idempotent — paystackReference is unique)
    if (product_id && buyer_id && seller_id) {
      try {
        await OrderModel.create({
          productId:       product_id,
          buyerId:         buyer_id,
          sellerId:        seller_id,
          productSnapshot: { title: product_title ?? "Product", price: amountNaira },
          amount:          amountNaira,
          paystackReference: reference,
          status:          "placed",
          timeline: [{ status: "placed", note: "Order placed successfully", createdAt: new Date() }],
        });
      } catch (err: any) {
        // duplicate key on re-delivery — wallet already credited, safe to ignore
        if (err?.code !== 11000) console.error("[webhook] order create error:", err);
      }

      // Notify seller
      const sellerUser = await UserModel.findById(seller_id);
      if (sellerUser) {
        const amountFormatted = `₦${amountNaira.toLocaleString("en-NG")}`;
        notifyUser({
          user: sellerUser,
          title: "You just made a sale! 🎉",
          body: `Your product "${product_title ?? "Product"}" sold for ${amountFormatted}. Your wallet has been credited.`,
          data: { type: "sale", product_id: String(product_id) },
        }).catch((err) => console.error("[webhook] notify seller error:", err));
      }
    }
  }

  res.json({ ok: true });
});

// ── Payment callback (Paystack redirects here after card flow) ────────────
// GET /paystack/callback — redirects to bondoo:// deep link so Chrome Custom
// Tab closes and returns the user to the app
paystackRouter.get("/callback", (req, res) => {
  const reference = (req.query.reference ?? req.query.trxref ?? "") as string;
  res.redirect(`bondoo://payment/callback?reference=${encodeURIComponent(reference)}`);
});

// ── Verify payment (mobile polls after returning from browser) ─────────────
// GET /paystack/verify/:reference
paystackRouter.get("/verify/:reference", requireAuth, async (req, res) => {
  const result = await paystackGet(`/transaction/verify/${req.params.reference}`);
  res.json({
    status:    result.data.status,
    amount:    result.data.amount / 100,
    reference: result.data.reference,
  });
});

// ── Naira wallet balance + transactions ────────────────────────────────────
// GET /paystack/wallet
paystackRouter.get("/wallet", requireAuth, async (req, res) => {
  const wallet = await getOrCreateWallet(req.user!._id);
  const transactions = await NairaTransactionModel.find({ userId: req.user!._id })
    .sort({ createdAt: -1 })
    .limit(50);

  res.json({
    balance: wallet.balance,
    transactions: transactions.map((t) => ({
      id:          String(t._id),
      type:        t.type,
      amount:      t.amount,
      description: t.description,
      reference:   t.reference,
      status:      t.status,
      meta:        t.meta ?? null,
      created_at:  t.createdAt,
    })),
  });
});

// ── List banks ─────────────────────────────────────────────────────────────
// GET /paystack/banks
paystackRouter.get("/banks", requireAuth, async (_req, res) => {
  const result = await paystackGet("/bank?country=nigeria&perPage=100");
  res.json(result.data ?? []);
});

// ── Resolve bank account number ────────────────────────────────────────────
// GET /paystack/resolve-account?account_number=&bank_code=
paystackRouter.get("/resolve-account", requireAuth, async (req, res) => {
  const { account_number, bank_code } = req.query as Record<string, string>;
  const result = await paystackGet(`/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`);
  res.json(result.data);
});

// ── Dedicated Virtual Account (DVA) ───────────────────────────────────────
// GET /paystack/virtual-account — returns existing DVA or null
paystackRouter.get("/virtual-account", requireAuth, async (req, res) => {
  const user = await UserModel.findById(req.user!._id).lean();
  if (user?.virtualAccount?.accountNumber) {
    return res.json(user.virtualAccount);
  }
  res.json(null);
});

// POST /paystack/virtual-account — idempotent: returns existing or tries to create
paystackRouter.post("/virtual-account", requireAuth, async (req, res) => {
  const user = await UserModel.findById(req.user!._id);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.virtualAccount?.accountNumber) return res.json(user.virtualAccount);

  try {
    await createOrGetPaystackCustomer(user);
  } catch (err: any) {
    return res.status(502).json({ error: "Could not create account. Please try again." });
  }
  const ok = await createDVA(user);
  if (!ok) return res.status(502).json({ error: "Could not create wallet. Please try again." });
  res.json(user.virtualAccount);
});

// ── Identity verification + wallet creation via /dedicated_account/assign ────
// POST /paystack/identify
// Body: { type, value, account_number, bank_code }
//
// Uses Paystack's single-call assign endpoint:
//   POST /dedicated_account/assign — creates customer + validates identity + assigns DVA
// Returns { status: "submitted" } immediately (async).
// Webhook dedicatedaccount.assign.success saves the DVA to the user.
paystackRouter.post("/identify", requireAuth, async (req, res) => {
  const body = z.object({
    type:           z.enum(["bvn", "nin"]),
    value:          z.string().regex(/^\d{11}$/, "Must be exactly 11 digits"),
    account_number: z.string().min(10).max(10),
    bank_code:      z.string().min(2).max(10),
  }).parse(req.body);

  const user = await UserModel.findById(req.user!._id);
  if (!user) return res.status(404).json({ error: "User not found" });

  if (user.virtualAccount?.accountNumber) {
    return res.json({ status: "verified" });
  }

  // Store BVN/NIN locally for compliance
  await UserModel.findByIdAndUpdate(user._id, { "kyc.type": body.type, "kyc.value": body.value });

  // Single-call assign: creates customer + validates identity + assigns DVA
  const parts = (user.displayName ?? "").split(" ");
  const firstName = parts[0] || "User";
  const lastName  = parts.slice(1).join(" ") || firstName;

  try {
    await paystackPost("/dedicated_account/assign", {
      email:          user.email,
      first_name:     firstName,
      last_name:      lastName,
      phone:          user.phone ?? "",
      preferred_bank: "wema-bank",
      country:        "NG",
      [body.type]:    body.value,        // bvn: "..." or nin: "..."
      account_number: body.account_number,
      bank_code:      body.bank_code,
    });
    console.log("[identify] assign submitted for", user.email);
    return res.json({ status: "submitted" });
  } catch (err: any) {
    console.error("[identify] assign failed:", err.message);
    return res.status(502).json({ error: "Could not submit verification. Please try again." });
  }
});

// ── Wallet status check ───────────────────────────────────────────────────────
// GET /paystack/identify-status
paystackRouter.get("/identify-status", requireAuth, async (req, res) => {
  const user = await UserModel.findById(req.user!._id).lean();
  if (user?.virtualAccount?.accountNumber) {
    return res.json({ status: "verified" });
  }
  res.json({ status: "pending" });
});

// ── Withdraw to bank account ───────────────────────────────────────────────
// POST /paystack/withdraw
// Body: { amount, account_number, bank_code, account_name }
paystackRouter.post("/withdraw", requireAuth, async (req, res) => {
  const body = z.object({
    amount:         z.number().min(100),   // min ₦100
    account_number: z.string().length(10),
    bank_code:      z.string().min(2),
    account_name:   z.string().min(2),
  }).parse(req.body);

  const wallet = await getOrCreateWallet(req.user!._id);
  if (wallet.balance < body.amount) {
    return res.status(400).json({ error: "Insufficient balance" });
  }

  // Create transfer recipient
  const recipientResult = await paystackPost("/transferrecipient", {
    type:           "nuban",
    name:           body.account_name,
    account_number: body.account_number,
    bank_code:      body.bank_code,
    currency:       "NGN",
  });
  const recipientCode = recipientResult.data.recipient_code;

  // Initiate transfer
  const reference  = `withdraw_${Date.now()}_${req.user!._id}`;
  const amountKobo = Math.round(body.amount * 100);
  const transferResult = await paystackPost("/transfer", {
    source:     "balance",
    amount:     amountKobo,
    recipient:  recipientCode,
    reason:     "Bondoo wallet withdrawal",
    reference,
  });

  // Deduct from wallet
  wallet.balance -= body.amount;
  await wallet.save();

  await NairaTransactionModel.create({
    userId:      req.user!._id,
    type:        "debit",
    amount:      body.amount,
    description: `Withdrawal to ${body.account_name} (${body.bank_code} ${body.account_number})`,
    reference,
    status:      transferResult.data?.status === "pending" ? "pending" : "completed",
    meta:        { account_number: body.account_number, bank_code: body.bank_code, account_name: body.account_name },
  });

  res.json({
    ok:        true,
    reference,
    amount:    body.amount,
    status:    transferResult.data?.status ?? "pending",
  });
});
