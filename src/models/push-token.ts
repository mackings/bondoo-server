import mongoose, { Schema } from "mongoose";

export type PushTokenDoc = {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  token: string;
  platform: "android" | "ios" | "web" | "unknown";
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const pushTokenSchema = new Schema<PushTokenDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    token: { type: String, required: true, unique: true },
    platform: { type: String, enum: ["android", "ios", "web", "unknown"], default: "unknown" },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

pushTokenSchema.index({ userId: 1, token: 1 }, { unique: true });

export const PushTokenModel = mongoose.model<PushTokenDoc>("PushToken", pushTokenSchema);
