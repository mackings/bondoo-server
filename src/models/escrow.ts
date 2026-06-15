import mongoose, { Schema } from "mongoose";

export type EscrowStatus =
  | "draft"
  | "awaiting_deposit"
  | "deposit_seen"
  | "funded"
  | "awaiting_receiver_wallet"
  | "payout_pending"
  | "paid_out"
  | "failed"
  | "refunded"
  | "cancelled"
  | "disputed";

export type EscrowDoc = {
  _id: mongoose.Types.ObjectId;
  senderUserId: mongoose.Types.ObjectId;
  receiverUserId: mongoose.Types.ObjectId;
  coin: string;
  network: string;
  amount: number;
  platformFee: number;
  networkFee: number;
  payoutAmount: number;
  depositAddress: string;
  depositTxid?: string;
  withdrawalId?: string;
  receiverWalletAddress?: string;
  receiverWalletNetwork?: string;
  status: EscrowStatus;
  fundedAt?: Date;
  paidOutAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type EscrowEventDoc = {
  _id: mongoose.Types.ObjectId;
  escrowTransactionId: mongoose.Types.ObjectId;
  actorUserId?: mongoose.Types.ObjectId;
  eventType: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

const escrowSchema = new Schema<EscrowDoc>(
  {
    senderUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    receiverUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    coin: { type: String, required: true },
    network: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    platformFee: { type: Number, default: 0 },
    networkFee: { type: Number, default: 0 },
    payoutAmount: { type: Number, default: 0 },
    depositAddress: { type: String, required: true },
    depositTxid: String,
    withdrawalId: String,
    receiverWalletAddress: String,
    receiverWalletNetwork: String,
    status: {
      type: String,
      enum: ["draft", "awaiting_deposit", "deposit_seen", "funded", "awaiting_receiver_wallet", "payout_pending", "paid_out", "failed", "refunded", "cancelled", "disputed"],
      default: "awaiting_deposit",
    },
    fundedAt: Date,
    paidOutAt: Date,
  },
  { timestamps: true },
);

const escrowEventSchema = new Schema<EscrowEventDoc>(
  {
    escrowTransactionId: { type: Schema.Types.ObjectId, ref: "EscrowTransaction", required: true, index: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: "User" },
    eventType: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

export const EscrowModel = mongoose.model<EscrowDoc>("EscrowTransaction", escrowSchema);
export const EscrowEventModel = mongoose.model<EscrowEventDoc>("EscrowEvent", escrowEventSchema);
