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
import { paystackPost, paystackGet, tryCreateDVA } from "../lib/paystack-dva.js";

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

  // ── DVA created after BVN/NIN identification ──────────────────────────────
  if (event.event === "customeridentification.success") {
    const customerCode = event.data?.customer?.customer_code ?? event.data?.customer_code;
    if (customerCode) {
      const identifiedUser = await UserModel.findOne({ paystackCustomerCode: customerCode });
      if (identifiedUser) await tryCreateDVA(identifiedUser);
    }
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

// POST /paystack/virtual-account — creates Paystack customer + DVA (idempotent)
paystackRouter.post("/virtual-account", requireAuth, async (req, res) => {
  const user = await UserModel.findById(req.user!._id);
  if (!user) return res.status(404).json({ error: "User not found" });

  if (user.virtualAccount?.accountNumber) return res.json(user.virtualAccount);

  const created = await tryCreateDVA(user);
  if (!created) {
    return res.status(502).json({
      error: "Virtual account could not be created. Identity verification may be required.",
    });
  }
  res.json(user.virtualAccount);
});

// ── Customer identity verification (BVN / NIN) ────────────────────────────
// POST /paystack/identify
// Body: { type: "bvn" | "nin", value: "11-digit number" }
paystackRouter.post("/identify", requireAuth, async (req, res) => {
  const body = z.object({
    type:  z.enum(["bvn", "nin"]),
    value: z.string().regex(/^\d{11}$/, "Must be exactly 11 digits"),
  }).parse(req.body);

  const user = await UserModel.findById(req.user!._id);
  if (!user) return res.status(404).json({ error: "User not found" });

  if (user.virtualAccount?.accountNumber) {
    return res.json({ status: "verified", virtual_account: user.virtualAccount });
  }

  const parts = (user.displayName ?? "").split(" ");
  const firstName = parts[0] || "User";
  const lastName  = parts.slice(1).join(" ") || firstName;

  // Create or reuse Paystack customer
  let customerCode = user.paystackCustomerCode;
  if (!customerCode) {
    const customerResult = await paystackPost("/customer", {
      email:      user.email,
      first_name: firstName,
      last_name:  lastName,
    });
    customerCode = customerResult.data.customer_code as string;
    await UserModel.findByIdAndUpdate(user._id, { paystackCustomerCode: customerCode });
  }

  // Submit BVN / NIN identification
  await paystackPost(`/customer/${customerCode}/identification`, {
    country: "NG",
    type:    body.type,
    value:   body.value,
  });

  // Poll Paystack customer until identified (up to ~30 s, then fall back to webhook)
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  let identified = false;
  for (let attempt = 0; attempt < 15; attempt++) {
    await delay(2000);
    try {
      const customerData = await paystackGet(`/customer/${customerCode}`);
      if (customerData.data?.identified === true) {
        identified = true;
        break;
      }
    } catch {
      // ignore transient errors during polling
    }
  }

  if (identified) {
    try {
      const dvaResult = await paystackPost("/dedicated_account", {
        customer:       customerCode,
        preferred_bank: "wema-bank",
      });
      const virtualAccount = {
        accountNumber: dvaResult.data.account_number as string,
        accountName:   dvaResult.data.account_name as string,
        bankName:      dvaResult.data.bank.name as string,
        bankSlug:      dvaResult.data.bank.slug as string,
        customerId:    customerCode,
      };
      await UserModel.findByIdAndUpdate(user._id, { virtualAccount });
      return res.json({ status: "verified", virtual_account: virtualAccount });
    } catch (err: any) {
      return res.status(502).json({ error: `Wallet setup failed: ${err.message}` });
    }
  }

  // Identification still processing — webhook will create DVA when ready
  return res.json({ status: "pending" });
});

// ── Check identity/DVA status (Flutter polls this after pending identify) ──
// GET /paystack/identify-status
// Actively checks Paystack customer state and creates DVA if identified.
// Does not rely on webhooks.
paystackRouter.get("/identify-status", requireAuth, async (req, res) => {
  const user = await UserModel.findById(req.user!._id);
  if (!user) return res.status(404).json({ error: "User not found" });

  // Already has DVA — done
  if (user.virtualAccount?.accountNumber) {
    return res.json({ status: "verified" });
  }

  const customerCode = user.paystackCustomerCode;
  if (!customerCode) return res.json({ status: "pending" });

  try {
    const customerData = await paystackGet(`/customer/${customerCode}`);
    const customer = customerData.data;

    if (customer?.identified === true) {
      // Customer verified — create DVA now
      const dvaResult = await paystackPost("/dedicated_account", {
        customer:       customerCode,
        preferred_bank: "wema-bank",
      });
      const virtualAccount = {
        accountNumber: dvaResult.data.account_number as string,
        accountName:   dvaResult.data.account_name as string,
        bankName:      dvaResult.data.bank.name as string,
        bankSlug:      dvaResult.data.bank.slug as string,
        customerId:    customerCode,
      };
      await UserModel.findByIdAndUpdate(user._id, { virtualAccount });
      return res.json({ status: "verified" });
    }

    // Check if the latest identification attempt failed
    const identifications: any[] = customer?.identifications ?? [];
    const latest = identifications[identifications.length - 1];
    if (latest?.status === "failed") {
      return res.json({
        status:  "failed",
        message: "Identity verification failed. Please check your BVN/NIN and try again.",
      });
    }
  } catch (err: any) {
    console.error("[identify-status] error:", err.message);
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
