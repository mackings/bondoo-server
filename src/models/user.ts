import mongoose, { Schema } from "mongoose";

export type UserRole = "user" | "admin";

export type TradeStatusDoc = {
  type: "selling" | "buying";
  coin: string;
  network: string;
  paymentMethod: string;
  rate?: number;
  active: boolean;
  updatedAt: Date;
};

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
  bankAccounts: Array<{
    bankName: string;
    accountName: string;
    accountNumber: string;
    currency: string;
  }>;
  payoutWallets: Array<{
    asset: "BTC" | "ETH" | "USDC" | "USDT";
    provider: string;
    address: string;
  }>;
  tradeStatus?: TradeStatusDoc;
  walletIndex?: number;
  lastWalletScan?: Date;
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
    bankAccounts: {
      type: [
        {
          bankName: { type: String, required: true, trim: true },
          accountName: { type: String, required: true, trim: true },
          accountNumber: { type: String, required: true, trim: true },
          currency: { type: String, required: true, uppercase: true, trim: true, default: "NGN" },
        },
      ],
      default: [],
    },
    payoutWallets: {
      type: [
        {
          asset: { type: String, enum: ["BTC", "ETH", "USDC", "USDT"], required: true },
          provider: { type: String, required: true, trim: true },
          address: { type: String, required: true, trim: true },
        },
      ],
      default: [],
    },
    tradeStatus: {
      type: {
        type: String,
        enum: ["selling", "buying"],
      },
      coin: String,
      network: String,
      paymentMethod: String,
      rate: Number,
      active: { type: Boolean, default: false },
      updatedAt: { type: Date, default: Date.now },
    },
    walletIndex:    { type: Number },
    lastWalletScan: { type: Date },
    emailVerified:  { type: Boolean, default: false },
  },
  { timestamps: true },
);

export const UserModel = mongoose.model<UserDoc>("User", userSchema);
