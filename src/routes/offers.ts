import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { OfferModel } from "../models/offer.js";
import { offerJson } from "../models/serializers.js";

export const offersRouter = Router();

offersRouter.use(requireAuth);

const offerBody = z.object({
  side: z.enum(["buy", "sell"]),
  coin: z.enum(["BTC", "ETH", "USDC", "USDT"]),
  fiat_currency: z.string().min(3).max(6).transform((value) => value.toUpperCase()),
  crypto_amount: z.number().positive(),
  rate: z.number().positive(),
  min_fiat_amount: z.number().positive(),
  max_fiat_amount: z.number().positive(),
  payment_method: z.string().min(2).max(80),
  terms: z.string().max(800).optional().default(""),
});

offersRouter.get("/", async (req, res) => {
  const coin = String(req.query.coin ?? "").toUpperCase();
  const side = String(req.query.side ?? "").toLowerCase();
  const mine = String(req.query.mine ?? "") === "true";
  const filter: any = mine ? { userId: req.user!._id } : { status: "active", userId: { $ne: req.user!._id } };
  if (["BTC", "ETH", "USDC", "USDT"].includes(coin)) filter.coin = coin;
  if (["buy", "sell"].includes(side)) filter.side = side;

  const offers = await OfferModel.find(filter).populate("userId").sort({ updatedAt: -1 }).limit(100);
  res.json(offers.filter((offer) => offer.userId).map(offerJson));
});

offersRouter.post("/", async (req, res) => {
  const body = offerBody.parse(req.body);
  if (body.min_fiat_amount > body.max_fiat_amount) {
    return res.status(400).json({ error: "Minimum amount cannot exceed maximum amount" });
  }
  const offer = await OfferModel.create({
    userId: req.user!._id,
    side: body.side,
    coin: body.coin,
    fiatCurrency: body.fiat_currency,
    cryptoAmount: body.crypto_amount,
    rate: body.rate,
    minFiatAmount: body.min_fiat_amount,
    maxFiatAmount: body.max_fiat_amount,
    paymentMethod: body.payment_method,
    terms: body.terms,
  });
  await offer.populate("userId");
  res.status(201).json(offerJson(offer));
});

offersRouter.get("/:id", async (req, res) => {
  const offer = await OfferModel.findById(req.params.id).populate("userId");
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  res.json(offerJson(offer));
});

offersRouter.patch("/:id", async (req, res) => {
  const body = offerBody.partial().extend({
    status: z.enum(["active", "paused", "closed"]).optional(),
  }).parse(req.body);
  const offer = await OfferModel.findOne({ _id: req.params.id, userId: req.user!._id });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  if (body.min_fiat_amount != null && body.max_fiat_amount != null && body.min_fiat_amount > body.max_fiat_amount) {
    return res.status(400).json({ error: "Minimum amount cannot exceed maximum amount" });
  }
  if (body.side) offer.side = body.side;
  if (body.coin) offer.coin = body.coin;
  if (body.fiat_currency) offer.fiatCurrency = body.fiat_currency;
  if (body.crypto_amount != null) offer.cryptoAmount = body.crypto_amount;
  if (body.rate != null) offer.rate = body.rate;
  if (body.min_fiat_amount != null) offer.minFiatAmount = body.min_fiat_amount;
  if (body.max_fiat_amount != null) offer.maxFiatAmount = body.max_fiat_amount;
  if (body.payment_method) offer.paymentMethod = body.payment_method;
  if (body.terms != null) offer.terms = body.terms;
  if (body.status) offer.status = body.status;
  await offer.save();
  await offer.populate("userId");
  res.json(offerJson(offer));
});
