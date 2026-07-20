import mongoose, { Schema } from "mongoose";

export type ConversationDoc = {
  _id: mongoose.Types.ObjectId;
  isGroup: boolean;
  name?: string;
  memberIds: mongoose.Types.ObjectId[];
  createdBy: mongoose.Types.ObjectId;
  lastMessageAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type MessageDoc = {
  _id: mongoose.Types.ObjectId;
  conversationId: mongoose.Types.ObjectId;
  senderId: mongoose.Types.ObjectId;
  kind: "text" | "transfer" | "offer" | "voice" | "image" | "trade_proposal" | "trade_update" | "story_reply" | "product_inquiry";
  body?: string;
  voiceDataUrl?: string;
  voiceDurationMs?: number;
  imageDataUrl?: string;
  storyReplyImageDataUrl?: string;
  storyReplyCaption?: string;
  storyReplyPosterName?: string;
  productId?: string;
  productTitle?: string;
  productPrice?: number;
  productImageDataUrl?: string;
  transferAsset?: string;
  transferAmount?: number;
  transferNote?: string;
  offerId?: mongoose.Types.ObjectId;
  offerSnapshot?: Record<string, unknown>;
  tradeId?: mongoose.Types.ObjectId;
  tradeSnapshot?: Record<string, unknown>;
  readReceipts: Array<{
    userId: mongoose.Types.ObjectId;
    readAt: Date;
  }>;
  createdAt: Date;
  updatedAt: Date;
};

const conversationSchema = new Schema<ConversationDoc>(
  {
    isGroup: { type: Boolean, default: false },
    name: String,
    memberIds: [{ type: Schema.Types.ObjectId, ref: "User", required: true }],
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    lastMessageAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

const messageSchema = new Schema<MessageDoc>(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
    senderId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    kind: { type: String, enum: ["text", "transfer", "offer", "voice", "image", "trade_proposal", "trade_update", "story_reply", "product_inquiry"], default: "text" },
    body: String,
    voiceDataUrl: String,
    voiceDurationMs: Number,
    imageDataUrl: String,
    storyReplyImageDataUrl: String,
    storyReplyCaption: String,
    storyReplyPosterName: String,
    productId: String,
    productTitle: String,
    productPrice: Number,
    productImageDataUrl: String,
    transferAsset: String,
    transferAmount: Number,
    transferNote: String,
    offerId: { type: Schema.Types.ObjectId, ref: "Offer" },
    offerSnapshot: Schema.Types.Mixed,
    tradeId: { type: Schema.Types.ObjectId, ref: "Trade" },
    tradeSnapshot: Schema.Types.Mixed,
    readReceipts: {
      type: [
        {
          userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
          readAt: { type: Date, required: true },
        },
      ],
      default: [],
    },
  },
  { timestamps: true },
);

export const ConversationModel = mongoose.model<ConversationDoc>("Conversation", conversationSchema);
export const MessageModel = mongoose.model<MessageDoc>("Message", messageSchema);
