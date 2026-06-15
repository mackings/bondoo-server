import mongoose, { Schema } from "mongoose";

const walletAddressSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    coin: { type: String, required: true },
    network: { type: String, required: true },
    address: { type: String, required: true },
    label: String,
    verifiedAt: Date,
  },
  { timestamps: true },
);

export const WalletAddressModel = mongoose.model("WalletAddress", walletAddressSchema);
