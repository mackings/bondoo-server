import mongoose, { Schema } from "mongoose";

export type Asset = "BTC" | "ETH" | "USDC" | "USDT";

export type WalletDoc = {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  asset: Asset;
  balance: number;
  createdAt: Date;
  updatedAt: Date;
};

const walletSchema = new Schema<WalletDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    asset: { type: String, enum: ["BTC", "ETH", "USDC", "USDT"], required: true },
    balance: { type: Number, default: 0 },
  },
  { timestamps: true },
);

walletSchema.index({ userId: 1, asset: 1 }, { unique: true });

export const WalletModel = mongoose.model<WalletDoc>("Wallet", walletSchema);
