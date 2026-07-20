import mongoose, { Schema } from "mongoose";

export type NairaTransactionDoc = {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  type: "credit" | "debit";
  amount: number;          // in Naira
  description: string;
  reference: string;
  status: "pending" | "completed" | "failed";
  meta?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type NairaWalletDoc = {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  balance: number;         // in Naira
  createdAt: Date;
  updatedAt: Date;
};

const nairaWalletSchema = new Schema<NairaWalletDoc>(
  {
    userId:  { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    balance: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

const nairaTransactionSchema = new Schema<NairaTransactionDoc>(
  {
    userId:      { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type:        { type: String, enum: ["credit", "debit"], required: true },
    amount:      { type: Number, required: true, min: 0 },
    description: { type: String, required: true },
    reference:   { type: String, required: true, unique: true },
    status:      { type: String, enum: ["pending", "completed", "failed"], default: "completed" },
    meta:        { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

nairaTransactionSchema.index({ userId: 1, createdAt: -1 });

export const NairaWalletModel = mongoose.model<NairaWalletDoc>("NairaWallet", nairaWalletSchema);
export const NairaTransactionModel = mongoose.model<NairaTransactionDoc>("NairaTransaction", nairaTransactionSchema);

/** Get or create a wallet for a user, returns it */
export async function getOrCreateWallet(userId: mongoose.Types.ObjectId | string) {
  let wallet = await NairaWalletModel.findOne({ userId });
  if (!wallet) wallet = await NairaWalletModel.create({ userId, balance: 0 });
  return wallet;
}
