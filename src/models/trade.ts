import mongoose, { Schema } from "mongoose";

export type TradeStatus =
  | "awaiting_escrow"    // trade created, waiting for seller to deposit crypto
  | "escrowed"           // crypto confirmed received on Bybit
  | "payment_sent"       // buyer sent fiat + uploaded receipt
  | "releasing"          // withdrawal to buyer wallet initiated
  | "completed"          // crypto delivered to buyer
  | "cancelled"          // cancelled before escrowed
  | "disputed"           // dispute raised
  | "refunded";          // crypto returned to seller

export type TradeDoc = {
  _id: mongoose.Types.ObjectId;
  offerId?: mongoose.Types.ObjectId;
  conversationId?: mongoose.Types.ObjectId;
  source: "offer" | "direct";
  buyerUserId: mongoose.Types.ObjectId;   // accepts the offer, pays fiat
  sellerUserId: mongoose.Types.ObjectId;  // posted the offer, deposits crypto
  coin: string;
  network: string;
  cryptoAmount: number;
  fiatAmount: number;
  fiatCurrency: string;
  rate: number;
  paymentMethod: string;
  // Escrow deposit (seller sends crypto here)
  depositAddress: string;
  depositIndex: number;  // HD wallet derivation index — unique per trade
  depositTxid?: string;
  depositConfirmedAt?: Date;
  // Fiat payment proof
  paymentReceiptUrl?: string;
  paymentNote?: string;
  paymentSentAt?: Date;
  // Payout (buyer receives crypto here)
  buyerWalletAddress?: string;
  buyerWalletNetwork?: string;
  withdrawalId?: string;
  // Fees
  platformFee: number;
  networkFee: number;
  escrowAmount: number;  // exact amount seller must send to the deposit address
  payoutAmount: number;  // exact amount buyer will receive
  // State
  status: TradeStatus;
  completedAt?: Date;
  cancelledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

const tradeSchema = new Schema<TradeDoc>(
  {
    offerId:       { type: Schema.Types.ObjectId, ref: "Offer",  index: true },
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", index: true },
    source:        { type: String, enum: ["offer", "direct"], default: "offer" },
    buyerUserId:   { type: Schema.Types.ObjectId, ref: "User",   required: true, index: true },
    sellerUserId:  { type: Schema.Types.ObjectId, ref: "User",   required: true, index: true },
    coin:          { type: String, required: true, uppercase: true },
    network:       { type: String, required: true, uppercase: true },
    cryptoAmount:  { type: Number, required: true, min: 0 },
    fiatAmount:    { type: Number, required: true, min: 0 },
    fiatCurrency:  { type: String, required: true, uppercase: true },
    rate:          { type: Number, required: true, min: 0 },
    paymentMethod: { type: String, required: true },
    depositAddress:         { type: String, required: true },
    depositIndex:           { type: Number, required: true },
    depositTxid:            String,
    depositConfirmedAt:     Date,
    paymentReceiptUrl:      String,
    paymentNote:            String,
    paymentSentAt:          Date,
    buyerWalletAddress:     String,
    buyerWalletNetwork:     String,
    withdrawalId:           String,
    platformFee:   { type: Number, default: 0 },
    networkFee:    { type: Number, default: 0 },
    escrowAmount:  { type: Number, default: 0 },
    payoutAmount:  { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["awaiting_escrow", "escrowed", "payment_sent", "releasing", "completed", "cancelled", "disputed", "refunded"],
      default: "awaiting_escrow",
      index: true,
    },
    completedAt:  Date,
    cancelledAt:  Date,
  },
  { timestamps: true },
);

tradeSchema.index({ buyerUserId: 1, createdAt: -1 });
tradeSchema.index({ sellerUserId: 1, createdAt: -1 });

export const TradeModel = mongoose.model<TradeDoc>("Trade", tradeSchema);
