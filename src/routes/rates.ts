import { Router } from "express";

export const ratesRouter = Router();

const idsByCoin = {
  BTC: "bitcoin",
  ETH: "ethereum",
  USDC: "usd-coin",
  USDT: "tether",
} as const;

let cached: { expiresAt: number; payload: unknown } | null = null;

async function fetchJson(url: URL | string) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "bondoo-server/1.0 (+https://bondoo-server.onrender.com)",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Rates provider returned ${response.status}`);
  return await response.json() as any;
}

async function fromCoinGecko(localCurrency: string) {
  const vsCurrencies = Array.from(new Set(["usd", localCurrency])).join(",");
  const url = new URL("https://api.coingecko.com/api/v3/simple/price");
  url.searchParams.set("ids", Object.values(idsByCoin).join(","));
  url.searchParams.set("vs_currencies", vsCurrencies);
  url.searchParams.set("include_24hr_change", "true");

  const raw = await fetchJson(url) as Record<string, any>;
  return Object.entries(idsByCoin).map(([coin, id]) => {
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
}

async function fromBinanceWithFx(localCurrency: string) {
  const [tickers, fx] = await Promise.all([
    fetchJson("https://api.binance.com/api/v3/ticker/24hr?symbols=%5B%22BTCUSDT%22,%22ETHUSDT%22,%22USDCUSDT%22%5D"),
    fetchJson("https://open.er-api.com/v6/latest/USD"),
  ]);
  const fxRate = Number(fx?.rates?.[localCurrency.toUpperCase()] ?? 1);
  const tickerBySymbol = new Map((tickers as any[]).map((ticker) => [ticker.symbol, ticker]));
  const rows = [
    ["BTC", tickerBySymbol.get("BTCUSDT")],
    ["ETH", tickerBySymbol.get("ETHUSDT")],
    ["USDC", tickerBySymbol.get("USDCUSDT")],
    ["USDT", { lastPrice: "1", priceChangePercent: "0" }],
  ] as const;
  return rows.map(([coin, ticker]) => {
    const usd = Number(ticker?.lastPrice ?? 0);
    const change = Number(ticker?.priceChangePercent ?? 0);
    return {
      coin,
      usd,
      local_currency: localCurrency.toUpperCase(),
      local: usd * fxRate,
      usd_24h_change: change,
      local_24h_change: change,
    };
  });
}

ratesRouter.get("/", async (req, res) => {
  const localCurrency = String(req.query.local_currency ?? "ngn").toLowerCase();
  if (cached && cached.expiresAt > Date.now()) return res.json(cached.payload);

  try {
    let coins;
    let source = "coingecko";
    try {
      coins = await fromCoinGecko(localCurrency);
    } catch {
      coins = await fromBinanceWithFx(localCurrency);
      source = "binance+open-er-api";
    }
    const payload = {
      source,
      local_currency: localCurrency.toUpperCase(),
      updated_at: new Date().toISOString(),
      coins,
    };
    cached = { expiresAt: Date.now() + 60_000, payload };
    res.json(payload);
  } catch {
    if (cached) return res.json(cached.payload);
    res.status(502).json({ error: "Unable to load global market rates" });
  }
});
