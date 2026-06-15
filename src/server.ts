import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { ZodError } from "zod";
import { config } from "./config.js";
import { connectMongo } from "./db/mongoose.js";
import { seedDefaultFees } from "./modules/fees/fee.service.js";
import { adminRouter } from "./routes/admin.js";
import { authRouter } from "./routes/auth.js";
import { chatRouter } from "./routes/chat.js";
import { meRouter } from "./routes/me.js";
import { escrowRouter } from "./modules/escrow/escrow.routes.js";
import { adminEscrowRouter } from "./modules/admin/admin-escrow.routes.js";

const app = express();

app.use(helmet());
app.use(cors({ origin: config.corsOrigin === "*" ? true : config.corsOrigin }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

app.get("/health", (_req, res) => res.json({ ok: true, service: "bondoo-api" }));
app.get("/config", (_req, res) => res.json({ bank_btc_address: config.bankBtcAddress }));

app.use("/auth", authRouter);
app.use("/me", meRouter);
app.use("/chat", chatRouter);
app.use("/escrow", escrowRouter);
app.use("/admin", adminRouter);
app.use("/admin/escrow", adminEscrowRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ZodError) return res.status(422).json({ error: "Validation failed", issues: err.issues });
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

await connectMongo();
await seedDefaultFees();

app.listen(config.port, () => {
  console.log(`BONDOO API listening on :${config.port}`);
});
