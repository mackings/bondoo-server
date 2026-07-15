import mongoose, { Schema } from "mongoose";

export type StoryDoc = {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  text?: string;
  imageDataUrl?: string;
  viewedBy: Array<{ userId: mongoose.Types.ObjectId; viewedAt: Date }>;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const storySchema = new Schema<StoryDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    text: { type: String, maxlength: 300 },
    imageDataUrl: { type: String, maxlength: 1_400_000 },
    viewedBy: [
      {
        userId: { type: Schema.Types.ObjectId, ref: "User" },
        viewedAt: { type: Date, default: Date.now },
      },
    ],
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: true },
);

export const StoryModel = mongoose.model<StoryDoc>("Story", storySchema);
