import mongoose, { Schema } from "mongoose";

const btcDepositSchema = new Schema(
  {
    txid: { type: String, required: true },
    vout: { type: Number, required: true },
    fromAddress: String,
    amountBtc: { type: Number, required: true },
    confirmations: { type: Number, default: 0 },
    status: { type: String, enum: ["unmatched", "credited", "ignored"], default: "unmatched" },
    creditedUserId: { type: Schema.Types.ObjectId, ref: "User" },
    creditedAt: Date,
    blockTime: Date,
  },
  { timestamps: true },
);

btcDepositSchema.index({ txid: 1, vout: 1 }, { unique: true });

export const BtcDepositModel = mongoose.model("BtcDeposit", btcDepositSchema);
