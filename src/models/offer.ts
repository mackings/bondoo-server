import mongoose, { Schema } from "mongoose";

export type OfferSide = "buy" | "sell";
export type OfferStatus = "active" | "paused" | "closed";

export type OfferDoc = {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  side: OfferSide;
  coin: "BTC" | "ETH" | "USDC" | "USDT";
  fiatCurrency: string;
  cryptoAmount: number;
  rate: number;
  minFiatAmount: number;
  maxFiatAmount: number;
  paymentMethod: string;
  terms?: string;
  status: OfferStatus;
  createdAt: Date;
  updatedAt: Date;
};

const offerSchema = new Schema<OfferDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    side: { type: String, enum: ["buy", "sell"], required: true, index: true },
    coin: { type: String, enum: ["BTC", "ETH", "USDC", "USDT"], required: true, index: true },
    fiatCurrency: { type: String, required: true, uppercase: true, trim: true, default: "USD" },
    cryptoAmount: { type: Number, required: true, min: 0 },
    rate: { type: Number, required: true, min: 0 },
    minFiatAmount: { type: Number, required: true, min: 0 },
    maxFiatAmount: { type: Number, required: true, min: 0 },
    paymentMethod: { type: String, required: true, trim: true },
    terms: { type: String, default: "" },
    status: { type: String, enum: ["active", "paused", "closed"], default: "active", index: true },
  },
  { timestamps: true },
);

offerSchema.index({ coin: 1, side: 1, status: 1, updatedAt: -1 });

export const OfferModel = mongoose.model<OfferDoc>("Offer", offerSchema);
