import { Schema, model } from "mongoose";

const feeSchema = new Schema(
  {
    coin: { type: String, required: true },
    network: { type: String, required: true },
    percentageFee: { type: Number, default: 0.02 },
    fixedFee: { type: Number, default: 0 },
    minFee: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

feeSchema.index({ coin: 1, network: 1 }, { unique: true });

export const FeeModel = model("Fee", feeSchema);
