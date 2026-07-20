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

  // ── DVA created after BVN/NIN identification confirmed by Paystack ──────────
  if (event.event === "customeridentification.success") {
    const customerCode = event.data?.customer?.customer_code ?? event.data?.customer_code;
    console.log("[webhook] customeridentification.success for", customerCode);
    if (customerCode) {
      const identifiedUser = await UserModel.findOne({ paystackCustomerCode: customerCode });
      if (identifiedUser && !identifiedUser.virtualAccount?.accountNumber) {
        const ok = await createDVA(identifiedUser);
        console.log("[webhook] DVA creation after identification:", ok ? "success" : "failed");
      }
    }
  }

  if (event.event === "customeridentification.failed") {
    const customerCode = event.data?.customer?.customer_code ?? event.data?.customer_code;
    console.log("[webhook] customeridentification.failed for", customerCode, event.data?.reason);
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

// POST /paystack/virtual-account — no-op if already exists; requires /identify first
paystackRouter.post("/virtual-account", requireAuth, async (req, res) => {
  const user = await UserModel.findById(req.user!._id);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.virtualAccount?.accountNumber) return res.json(user.virtualAccount);
  return res.status(400).json({ error: "Please complete identity verification first." });
});

// ── BVN/NIN identity verification → wallet creation ──────────────────────────
// POST /paystack/identify
// Body: { type: "bvn" | "nin", value: "11-digit number" }
//
// Flow:
//   1. Create Paystack customer (POST /customer)
//   2. Submit BVN/NIN identification (POST /customer/{code}/identification)
//   3. Try DVA immediately (POST /dedicated_account) — succeeds if Paystack is fast
//   4. Return "verified" if DVA created, or "pending" for Flutter to keep polling
//      (webhook customeridentification.success → createDVA will fire when Paystack confirms)
paystackRouter.post("/identify", requireAuth, async (req, res) => {
  const body = z.object({
    type:  z.enum(["bvn", "nin"]),
    value: z.string().regex(/^\d{11}$/, "Must be exactly 11 digits"),
  }).parse(req.body);

  const user = await UserModel.findById(req.user!._id);
  if (!user) return res.status(404).json({ error: "User not found" });

  // Already has wallet — return immediately
  if (user.virtualAccount?.accountNumber) {
    return res.json({ status: "verified", virtual_account: user.virtualAccount });
  }

  // Step 1: Store BVN/NIN locally for KYC
  await UserModel.findByIdAndUpdate(user._id, {
    "kyc.type":  body.type,
    "kyc.value": body.value,
  });

  // Step 2: Ensure Paystack customer exists
  let customerCode: string;
  try {
    const c = await createOrGetPaystackCustomer(user);
    customerCode = c.customerCode;
  } catch (err: any) {
    console.error("[identify] createOrGetPaystackCustomer failed:", err.message);
    return res.status(502).json({ error: "Could not create account profile. Please try again." });
  }

  // Step 3: Submit BVN/NIN to Paystack identification API
  try {
    const identPayload: Record<string, string> = {
      country: "NG",
      type:    body.type,   // "bvn" or "nin"
      value:   body.value,
    };
    const identResult = await paystackPost(`/customer/${customerCode}/identification`, identPayload);
    console.log("[identify] identification submitted:", identResult.status, identResult.message);
  } catch (err: any) {
    console.error("[identify] identification failed:", err.message);
    return res.status(502).json({ error: "Identity verification could not be submitted. Please try again." });
  }

  // Step 4: Try DVA immediately (works if Paystack identifies synchronously)
  const dvaCreated = await createDVA(user);
  if (dvaCreated) {
    console.log("[identify] DVA created immediately after identification");
    return res.json({ status: "verified", virtual_account: user.virtualAccount });
  }

  // DVA not ready yet — Flutter will poll /identify-status while webhook fires createDVA
  console.log("[identify] DVA pending — waiting for customeridentification.success webhook");
  return res.json({ status: "pending" });
});

// ── Check wallet creation status (Flutter polls this while waiting) ──────────
// GET /paystack/identify-status
// Also actively checks Paystack's customer API so we don't depend solely on webhooks.
paystackRouter.get("/identify-status", requireAuth, async (req, res) => {
  const user = await UserModel.findById(req.user!._id);
  if (!user) return res.status(404).json({ error: "User not found" });

  // Already has wallet — done
  if (user.virtualAccount?.accountNumber) {
    return res.json({ status: "verified" });
  }

  // No customer yet — can't check
  if (!user.paystackCustomerCode) {
    return res.json({ status: "pending" });
  }

  // Ask Paystack directly: has this customer been identified?
  try {
    const customerResult = await paystackGet(`/customer/${user.paystackCustomerCode}`);
    const identified = customerResult.data?.identified === true;
    console.log(`[identify-status] customer ${user.paystackCustomerCode} identified=${identified}`);

    if (identified) {
      // Customer is now identified — create DVA right now
      const ok = await createDVA(user);
      if (ok) return res.json({ status: "verified" });
    }

    // Check if identification was rejected
    const identifications = customerResult.data?.identifications as any[] | undefined;
    const latestIdent = identifications?.[identifications.length - 1];
    if (latestIdent?.status === "failed") {
      console.log(`[identify-status] identification failed: ${latestIdent?.remarks}`);
      return res.json({ status: "failed", message: "Identity verification failed. Please check your BVN/NIN and try again." });
    }
  } catch (err: any) {
    console.error("[identify-status] Paystack customer check error:", err.message);
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
