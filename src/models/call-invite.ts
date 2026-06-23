import mongoose, { Schema } from "mongoose";

export type CallInviteStatus = "ringing" | "accepted" | "declined" | "ended" | "missed";
export type CallInviteKind = "voice" | "video";

export type CallInviteDoc = {
  _id: mongoose.Types.ObjectId;
  conversationId: mongoose.Types.ObjectId;
  callerId: mongoose.Types.ObjectId;
  receiverId: mongoose.Types.ObjectId;
  kind: CallInviteKind;
  status: CallInviteStatus;
  channelName: string;
  acceptedAt?: Date;
  endedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const callInviteSchema = new Schema<CallInviteDoc>(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
    callerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    receiverId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    kind: { type: String, enum: ["voice", "video"], required: true },
    status: { type: String, enum: ["ringing", "accepted", "declined", "ended", "missed"], default: "ringing", index: true },
    channelName: { type: String, required: true },
    acceptedAt: Date,
    endedAt: Date,
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true },
);

callInviteSchema.index({ receiverId: 1, status: 1, createdAt: -1 });

export const CallInviteModel = mongoose.model<CallInviteDoc>("CallInvite", callInviteSchema);
