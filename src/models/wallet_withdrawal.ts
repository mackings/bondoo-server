import mongoose, { Schema } from "mongoose";

export type WithdrawalStatus = "pending" | "completed" | "failed";

export type WalletWithdrawalDoc = {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  coin: string;
  network: string;
  amount: number;
  toAddress: string;
  txid: string;
  status: WithdrawalStatus;
  createdAt: Date;
  updatedAt: Date;
};

const schema = new Schema<WalletWithdrawalDoc>(
  {
    userId:    { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    coin:      { type: String, required: true, uppercase: true },
    network:   { type: String, required: true, uppercase: true },
    amount:    { type: Number, required: true },
    toAddress: { type: String, required: true },
    txid:      { type: String, default: "" },
    status:    { type: String, enum: ["pending", "completed", "failed"], default: "pending", required: true },
  },
  { timestamps: true },
);

// Only enforce txid uniqueness for completed withdrawals (pending/failed have empty txid).
schema.index({ txid: 1 }, { unique: true, sparse: true, partialFilterExpression: { txid: { $ne: "" } } });

export const WalletWithdrawalModel = mongoose.model<WalletWithdrawalDoc>("WalletWithdrawal", schema);
