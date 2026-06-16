import { Router } from "express";

export const ratesRouter = Router();

const idsByCoin = {
  BTC: "bitcoin",
  ETH: "ethereum",
  USDC: "usd-coin",
  USDT: "tether",
} as const;

let cached: { expiresAt: number; payload: unknown } | null = null;

ratesRouter.get("/", async (req, res) => {
  const localCurrency = String(req.query.local_currency ?? "ngn").toLowerCase();
  const vsCurrencies = Array.from(new Set(["usd", localCurrency])).join(",");
  if (cached && cached.expiresAt > Date.now()) return res.json(cached.payload);

  const url = new URL("https://api.coingecko.com/api/v3/simple/price");
  url.searchParams.set("ids", Object.values(idsByCoin).join(","));
  url.searchParams.set("vs_currencies", vsCurrencies);
  url.searchParams.set("include_24hr_change", "true");

  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    return res.status(502).json({ error: "Unable to load global market rates" });
  }
  const raw = await response.json() as Record<string, any>;
  const coins = Object.entries(idsByCoin).map(([coin, id]) => {
    const row = raw[id] ?? {};
    return {
      coin,
      usd: row.usd ?? null,
      local_currency: localCurrency.toUpperCase(),
      local: row[localCurrency] ?? null,
      usd_24h_change: row.usd_24h_change ?? null,
      local_24h_change: row[`${localCurrency}_24h_change`] ?? null,
    };
  });
  const payload = {
    source: "coingecko",
    local_currency: localCurrency.toUpperCase(),
    updated_at: new Date().toISOString(),
    coins,
  };
  cached = { expiresAt: Date.now() + 60_000, payload };
  res.json(payload);
});
