import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { sendEmailOtp, verifyEmailOtp } from "../mailjet.js";
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
    username: z.string().min(1).regex(/^[a-z0-9_]+$/).optional(),
  }).parse(req.body);

  if (body.display_name) req.user!.displayName = body.display_name;
  if (body.username) req.user!.username = body.username;
  await req.user!.save();
  res.json(userPublic(req.user!));
});

meRouter.post("/linked-wallet", async (req, res) => {
  const body = z.object({
    chain: z.enum(["btc", "eth", "usdc", "usdt"]),
    address: z.string().min(10),
    provider: z.string().min(2).max(80).optional().default("External wallet"),
  }).parse(req.body);

  if (body.chain === "btc") req.user!.linkedBtcAddress = body.address;
  if (body.chain === "eth") req.user!.linkedEthAddress = body.address;
  const asset = body.chain.toUpperCase() as "BTC" | "ETH" | "USDC" | "USDT";
  req.user!.payoutWallets = (req.user!.payoutWallets ?? []).filter((wallet) => wallet.asset !== asset);
  req.user!.payoutWallets.push({
    asset,
    provider: body.provider,
    address: body.address,
  });
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

meRouter.post("/otp/email/send", async (req, res) => {
  await sendEmailOtp({
    userId: req.userId!,
    toEmail: req.user!.email,
    toName: req.user!.displayName,
  });
  res.json({ ok: true });
});

meRouter.post("/otp/email/verify", async (req, res) => {
  const body = z.object({
    code: z.string().regex(/^\d{4}$/),
  }).parse(req.body);

  const result = verifyEmailOtp({ userId: req.userId!, email: req.user!.email, code: body.code });
  if (!result.ok) return res.status(400).json({ error: result.error });
  req.user!.emailVerified = true;
  await req.user!.save();
  res.json(userPublic(req.user!));
});
