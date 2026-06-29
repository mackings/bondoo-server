/**
 * Cron endpoint — POST /cron/scan-deposits
 *
 * Triggered by:
 *   - Vercel cron (vercel.json schedule)
 *   - External scheduler (UptimeRobot, cron-job.org, etc.)
 *   - The setInterval in app.ts also calls scanUserDeposits() directly,
 *     so this route is just for external triggering / manual testing.
 *
 * Protected by CRON_SECRET header. Requests without a valid secret are
 * rejected. If CRON_SECRET is not set in env, the endpoint is disabled.
 */

import { Router } from "express";
import { config } from "../config.js";
import { connectMongo } from "../db/mongoose.js";
import { scanUserDeposits } from "../modules/wallet/deposit-scanner.js";

export const cronRouter = Router();

cronRouter.post("/scan-deposits", async (req, res) => {
  // Reject if CRON_SECRET is not configured
  if (!config.cronSecret) {
    return res.status(503).json({ error: "Cron not configured (CRON_SECRET not set)" });
  }

  // Validate secret — accept via Authorization header or x-cron-secret header
  const provided =
    req.headers.authorization?.replace("Bearer ", "") ??
    req.headers["x-cron-secret"];

  if (provided !== config.cronSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  await connectMongo();
  const result = await scanUserDeposits();
  res.json({ ok: true, ...result });
});
