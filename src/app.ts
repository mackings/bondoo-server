import "express-async-errors"; // patches Express 4 to forward async errors to next(err)
import cors from "cors";
import express from "express";
import helmetModule from "helmet";
import type { HelmetOptions } from "helmet";
import morgan from "morgan";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { config } from "./config.js";
import { connectMongo } from "./db/mongoose.js";
import { adminEscrowRouter } from "./modules/admin/admin-escrow.routes.js";
import { escrowRouter } from "./modules/escrow/escrow.routes.js";
import { tradesRouter } from "./modules/trades/trades.routes.js";
import { adminRouter } from "./routes/admin.js";
import { authRouter } from "./routes/auth.js";
import { contactsRouter } from "./routes/contacts.js";
import { banksRouter } from "./routes/banks.js";
import { callsRouter } from "./routes/calls.js";
import { chatRouter } from "./routes/chat.js";
import { cronRouter } from "./routes/cron.js";
import { marketRouter } from "./routes/market.js";
import { meRouter } from "./routes/me.js";
import { walletRouter } from "./routes/wallet.js";
import { offersRouter } from "./routes/offers.js";
import { ratesRouter } from "./routes/rates.js";
import { storiesRouter } from "./routes/stories.js";
import { scanUserDeposits } from "./modules/wallet/deposit-scanner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const helmet = ((helmetModule as unknown as { default?: unknown }).default ?? helmetModule) as (
  options?: HelmetOptions,
) => express.RequestHandler;

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: config.corsOrigin === "*" ? true : config.corsOrigin }));
app.use(express.json({ limit: "5mb" }));
app.use(morgan("dev", {
  skip: (req) => req.path === "/health" || req.path.startsWith("/calls/pending"),
}));
app.use("/uploads", express.static("/tmp/uploads"));

app.get("/health", (_req, res) => res.json({ ok: true, service: "bondoo-api" }));
app.get("/config", (_req, res) => res.json({ bank_btc_address: config.bankBtcAddress }));
app.get("/server-ip", async (_req, res) => {
  const r = await fetch("https://api.ipify.org?format=json");
  const data = await r.json();
  res.json(data);
});
app.get("/bybit-proxy-ip", async (_req, res) => {
  // Returns the IP Bybit sees when Render calls through the Cloudflare Worker
  const r = await fetch("https://bybit-proxy.bondoo.workers.dev/worker-ip");
  const data = await r.json();
  res.json(data);
});

app.use(async (_req, _res, next) => {
  try {
    await connectMongo();
    next();
  } catch (error) {
    next(error);
  }
});

app.use("/auth", authRouter);
app.use("/contacts", contactsRouter);
app.use("/banks", banksRouter);
app.use("/market", marketRouter);
app.use("/me", meRouter);
app.use("/wallet", walletRouter);
app.use("/cron", cronRouter);
app.use("/calls", callsRouter);
app.use("/chat", chatRouter);
app.use("/offers", offersRouter);
app.use("/rates", ratesRouter);
app.use("/stories", storiesRouter);
app.use("/escrow", escrowRouter);
app.use("/trades", tradesRouter);
app.use("/admin", adminRouter);
app.use("/admin/escrow", adminEscrowRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ZodError) return res.status(422).json({ error: "Validation failed", issues: err.issues });
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

// ── Background deposit scanner (Render persistent server only) ────────────
// On Vercel serverless this never runs — use the /cron/scan-deposits endpoint
// triggered via vercel.json crons instead.
if (process.env.VERCEL !== "1") {
  const SCAN_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

  // Delay first run 60s after startup so DB connection is stable
  setTimeout(async () => {
    const { connectMongo } = await import("./db/mongoose.js");
    const run = async () => {
      try {
        await connectMongo();
        await scanUserDeposits();
      } catch (err) {
        console.error("[DepositScanner] run error:", err);
      }
    };
    run();
    setInterval(run, SCAN_INTERVAL_MS);
  }, 60_000);
}

export default app;
