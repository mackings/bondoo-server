import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { UserModel } from "../models/user.js";

export const contactsRouter = Router();

function normalizePhone(raw: string): string {
  const cleaned = raw.replace(/[\s\-\(\)\.]+/g, "");
  if (cleaned.startsWith("+")) return cleaned;
  const digits = cleaned.replace(/[^\d]/g, "");
  if (digits.startsWith("234")) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 11) return `+234${digits.slice(1)}`;
  return `+${digits}`;
}

contactsRouter.post("/sync", requireAuth, async (req, res) => {
  const body = z.object({
    phones: z.array(z.string()).max(500),
  }).parse(req.body);

  const normalizedPhones = body.phones.map(normalizePhone);

  const users = await UserModel
    .find({ phone: { $in: normalizedPhones } })
    .select("_id username displayName avatarUrl phone");

  const result = users.map((u) => ({
    phone: u.phone,
    user: {
      id: String(u._id),
      username: u.username,
      display_name: u.displayName,
      avatar_url: u.avatarUrl ?? null,
    },
  }));

  res.json(result);
});
