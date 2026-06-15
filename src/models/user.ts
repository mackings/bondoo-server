import mongoose, { Schema } from "mongoose";

export type UserRole = "user" | "admin";

export type UserDoc = {
  _id: mongoose.Types.ObjectId;
  email: string;
  passwordHash: string;
  displayName: string;
  username: string;
  avatarUrl?: string;
  role: UserRole;
  linkedBtcAddress?: string;
  linkedEthAddress?: string;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const userSchema = new Schema<UserDoc>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    displayName: { type: String, required: true },
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    avatarUrl: String,
    role: { type: String, enum: ["user", "admin"], default: "user" },
    linkedBtcAddress: String,
    linkedEthAddress: String,
    emailVerified: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export const UserModel = mongoose.model<UserDoc>("User", userSchema);
