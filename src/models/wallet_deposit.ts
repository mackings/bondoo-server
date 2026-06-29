import mongoose, { Schema } from "mongoose";

export type WalletDepositDoc = {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  coin: string;
  network: string;
  amount: number;
  txid: string;
  creditedAt: Date;
};

const schema = new Schema<WalletDepositDoc>({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  coin:    { type: String, required: true, uppercase: true },
  network: { type: String, required: true, uppercase: true },
  amount:  { type: Number, required: true },
  txid:    { type: String, required: true, unique: true },
  creditedAt: { type: Date, default: Date.now },
});

export const WalletDepositModel = mongoose.model<WalletDepositDoc>("WalletDeposit", schema);
