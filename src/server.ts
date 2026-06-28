import app from "./app.js";
import { connectMongo } from "./db/mongoose.js";
import { config } from "./config.js";

// Start listening immediately so the health check passes even if MongoDB
// DNS is temporarily unreachable at boot. Per-request lazy connect handles
// all actual DB calls (see app.ts middleware).
app.listen(config.port, () => {
  console.log(`BONDOO API listening on :${config.port}`);
});

// Warm up the connection in the background — don't block startup
connectMongo().catch((err) =>
  console.warn("[MongoDB] Initial connect failed, will retry on first request:", err.message),
);
