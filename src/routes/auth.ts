import { createHash, randomInt } from "node:crypto";
import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { requireAuth, signToken } from "../middleware/auth.js";
import { sendEmail, sendEmailOtp } from "../mailjet.js";
import { PasswordResetTokenModel } from "../models/password-reset-token.js";
import { userPublic } from "../models/serializers.js";
import { UserModel } from "../models/user.js";
import { WalletModel } from "../models/wallet.js";

export const authRouter = Router();
const passwordResetOtpTtlMs = 10 * 60 * 1000;
const passwordResetMaxAttempts = 5;

function hashResetCode(code: string) {
  return createHash("sha256").update(code).digest("hex");
}

authRouter.post("/signup", async (req, res) => {
  const body = z.object({
    email: z.string().email().transform((v) => v.toLowerCase()),
    password: z.string().min(6),
    display_name: z.string().min(1).optional(),
  }).parse(req.body);

  const existing = await UserModel.findOne({ email: body.email });
  if (existing) return res.status(409).json({ error: "Email already registered" });

  const baseUsername = body.email.split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "") || "user";
  let username = baseUsername;
  let suffix = 0;
  while (await UserModel.exists({ username })) {
    suffix += 1;
    username = `${baseUsername}${suffix}`;
  }

  const passwordHash = await bcrypt.hash(body.password, 12);
  const user = await UserModel.create({
    email: body.email,
    passwordHash,
    displayName: body.display_name || username,
    username,
  });

  await WalletModel.insertMany([
    { userId: user._id, asset: "BTC", balance: 0 },
    { userId: user._id, asset: "ETH", balance: 0 },
    { userId: user._id, asset: "USDC", balance: 0 },
    { userId: user._id, asset: "USDT", balance: 0 },
  ]);

  await sendEmailOtp({
    userId: String(user._id),
    toEmail: user.email,
    toName: user.displayName,
  });

  res.status(201).json({ token: signToken(user), user: userPublic(user) });
});

authRouter.post("/signin", async (req, res) => {
  const body = z.object({
    email: z.string().email().transform((v) => v.toLowerCase()),
    password: z.string().min(1),
  }).parse(req.body);

  const user = await UserModel.findOne({ email: body.email });
  if (!user) return res.status(401).json({ error: "Invalid email or password" });
  const ok = await bcrypt.compare(body.password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid email or password" });

  res.json({ token: signToken(user), user: userPublic(user) });
});

authRouter.post("/password/forgot", async (req, res) => {
  const body = z.object({
    email: z.string().email().transform((v) => v.toLowerCase()),
  }).parse(req.body);

  const user = await UserModel.findOne({ email: body.email });
  if (user) {
    const code = randomInt(1000, 10000).toString();
    const textContent = `Your BONDOO password reset code is ${code}. It expires in 10 minutes.`;
    const htmlContent = `<p>Your BONDOO password reset code is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>`;
    const result = await sendEmail({
      to: user.email,
      subject: "Reset your BONDOO password",
      textContent,
      htmlContent,
    });
    if (!result.success) {
      throw new Error(result.error ?? "Email sending failed");
    }

    await PasswordResetTokenModel.findOneAndUpdate(
      { email: user.email },
      {
        email: user.email,
        codeHash: hashResetCode(code),
        expiresAt: new Date(Date.now() + passwordResetOtpTtlMs),
        attempts: 0,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  res.json({
    message: "If an account exists for this email, a reset code has been sent.",
  });
});

authRouter.post("/password/reset", async (req, res) => {
  const body = z.object({
    email: z.string().email().transform((v) => v.toLowerCase()),
    code: z.string().regex(/^\d{4}$/),
    password: z.string().min(6),
  }).parse(req.body);

  const user = await UserModel.findOne({ email: body.email });
  if (!user) return res.status(400).json({ error: "Invalid or expired reset code" });

  const token = await PasswordResetTokenModel.findOne({ email: user.email });
  if (!token || token.expiresAt.getTime() < Date.now()) {
    if (token) await PasswordResetTokenModel.deleteOne({ _id: token._id });
    return res.status(400).json({ error: "Invalid or expired reset code" });
  }
  if (token.attempts >= passwordResetMaxAttempts) {
    await PasswordResetTokenModel.deleteOne({ _id: token._id });
    return res.status(400).json({ error: "Too many attempts" });
  }
  if (token.codeHash !== hashResetCode(body.code)) {
    token.attempts += 1;
    await token.save();
    return res.status(400).json({ error: "Invalid or expired reset code" });
  }

  user.passwordHash = await bcrypt.hash(body.password, 12);
  await user.save();
  await PasswordResetTokenModel.deleteOne({ _id: token._id });

  res.json({ message: "Password reset successful" });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  res.json({ user: userPublic(req.user!) });
});
