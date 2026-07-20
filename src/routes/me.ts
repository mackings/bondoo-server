import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { sendEmailOtp, verifyEmailOtp } from "../mailjet.js";
import { tryCreateDVA } from "../lib/paystack-dva.js";
import { PushTokenModel } from "../models/push-token.js";
import { userPublic, walletJson } from "../models/serializers.js";
import { WalletModel } from "../models/wallet.js";

export const meRouter = Router();

meRouter.use(requireAuth);

meRouter.get("/profile", async (req, res) => {
  res.json(userPublic(req.user!));
});

meRouter.patch("/profile", async (req, res) => {
  const body = z.object({
    display_name: z.string().min(1).optional(),
  }).parse(req.body);

  if (body.display_name) req.user!.displayName = body.display_name;
  await req.user!.save();
  res.json(userPublic(req.user!));
});

meRouter.post("/profile/avatar", async (req, res) => {
  const body = z.object({
    image_data_url: z
      .string()
      .startsWith("data:image/")
      .max(900_000),
  }).parse(req.body);

  req.user!.avatarUrl = body.image_data_url;
  await req.user!.save();
  res.json(userPublic(req.user!));
});

const networksByChain: Record<string, string[]> = {
  btc:  ["BTC"],
  eth:  ["ERC20"],
  usdc: ["ERC20", "TRC20", "BSC"],
  usdt: ["TRC20", "ERC20", "BSC"],
};

meRouter.post("/linked-wallet", async (req, res) => {
  const body = z.object({
    chain: z.enum(["btc", "eth", "usdc", "usdt"]),
    network: z.string().min(2).max(20).optional(),
    address: z.string().min(10),
    provider: z.string().min(2).max(80).optional().default("External wallet"),
  }).parse(req.body);

  const validNets = networksByChain[body.chain];
  const network = body.network && validNets.includes(body.network)
    ? body.network
    : validNets[0];

  if (body.chain === "btc") req.user!.linkedBtcAddress = body.address;
  if (body.chain === "eth") req.user!.linkedEthAddress = body.address;
  const asset = body.chain.toUpperCase() as "BTC" | "ETH" | "USDC" | "USDT";
  // Remove existing entry for same asset+network combo, then add the new one
  req.user!.payoutWallets = (req.user!.payoutWallets ?? []).filter(
    (w) => !(w.asset === asset && (w.network === network || !w.network)),
  );
  req.user!.payoutWallets.push({ asset, network, provider: body.provider, address: body.address });
  await req.user!.save();
  res.json(userPublic(req.user!));
});

meRouter.post("/bank-account", async (req, res) => {
  const body = z.object({
    bank_name: z.string().min(2).max(80),
    account_name: z.string().min(2).max(120),
    account_number: z.string().min(4).max(40),
    currency: z.string().min(3).max(6).transform((value) => value.toUpperCase()).default("NGN"),
  }).parse(req.body);

  req.user!.bankAccounts = [
    {
      bankName: body.bank_name,
      accountName: body.account_name,
      accountNumber: body.account_number,
      currency: body.currency,
    },
  ];
  await req.user!.save();
  res.json(userPublic(req.user!));
});

meRouter.get("/wallets", async (req, res) => {
  const wallets = await WalletModel.find({ userId: req.user!._id }).sort({ asset: 1 });
  res.json(wallets.map(walletJson));
});

meRouter.post("/push-token", async (req, res) => {
  const body = z.object({
    token: z.string().min(20).max(4096),
    platform: z.enum(["android", "ios", "web", "unknown"]).default("unknown"),
  }).parse(req.body);

  await PushTokenModel.findOneAndUpdate(
    { token: body.token },
    {
      userId: req.user!._id,
      token: body.token,
      platform: body.platform,
      lastSeenAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  res.json({ ok: true });
});

meRouter.patch("/trade-status", async (req, res) => {
  const body = z.object({
    type: z.enum(["selling", "buying"]),
    coin: z.enum(["BTC", "ETH", "USDC", "USDT"]),
    network: z.string().min(2).max(20).transform((v) => v.toUpperCase()),
    payment_method: z.string().min(2).max(80),
    rate: z.number().positive().optional(),
    active: z.boolean().default(true),
  }).parse(req.body);

  req.user!.tradeStatus = {
    type: body.type,
    coin: body.coin,
    network: body.network,
    paymentMethod: body.payment_method,
    rate: body.rate,
    active: body.active,
    updatedAt: new Date(),
  };
  await req.user!.save();
  res.json(userPublic(req.user!));
});

meRouter.delete("/trade-status", async (req, res) => {
  req.user!.tradeStatus = undefined;
  await req.user!.save();
  res.json(userPublic(req.user!));
});

meRouter.post("/otp/email/send", async (req, res) => {
  const email = await sendEmailOtp({
    userId: req.userId!,
    toEmail: req.user!.email,
    toName: req.user!.displayName,
  });
  res.json({ ok: true, provider: "smtp", email });
});

meRouter.post("/otp/email/verify", async (req, res) => {
  const body = z.object({
    code: z.string().regex(/^\d{4}$/),
  }).parse(req.body);

  const result = verifyEmailOtp({ userId: req.userId!, email: req.user!.email, code: body.code });
  if (!result.ok) return res.status(400).json({ error: result.error });
  req.user!.emailVerified = true;
  await req.user!.save();

  // Retry DVA creation if it wasn't set up at signup (non-blocking)
  if (!req.user!.virtualAccount?.accountNumber) {
    tryCreateDVA(req.user!).catch((err) => console.error("[email-verify] DVA setup failed:", err));
  }

  res.json(userPublic(req.user!));
});
