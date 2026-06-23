import mongoose, { Schema } from "mongoose";

export type PasswordResetTokenDoc = {
  _id: mongoose.Types.ObjectId;
  email: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
};

const passwordResetTokenSchema = new Schema<PasswordResetTokenDoc>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    attempts: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

export const PasswordResetTokenModel = mongoose.model<PasswordResetTokenDoc>(
  "PasswordResetToken",
  passwordResetTokenSchema,
);
