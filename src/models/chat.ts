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
  kind: "text" | "transfer";
  body?: string;
  transferAsset?: string;
  transferAmount?: number;
  transferNote?: string;
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
    kind: { type: String, enum: ["text", "transfer"], default: "text" },
    body: String,
    transferAsset: String,
    transferAmount: Number,
    transferNote: String,
  },
  { timestamps: true },
);

export const ConversationModel = mongoose.model<ConversationDoc>("Conversation", conversationSchema);
export const MessageModel = mongoose.model<MessageDoc>("Message", messageSchema);
