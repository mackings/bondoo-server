import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { requireAuth, signToken } from "../middleware/auth.js";
import { userPublic } from "../models/serializers.js";
import { UserModel } from "../models/user.js";
import { WalletModel } from "../models/wallet.js";

export const authRouter = Router();

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

authRouter.get("/me", requireAuth, async (req, res) => {
  res.json({ user: userPublic(req.user!) });
});
