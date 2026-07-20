import mongoose, { Schema } from "mongoose";

export const ORDER_STATUSES = [
  "placed",
  "processing",
  "packed",
  "shipped",
  "out_for_delivery",
  "delivered",
  "confirmed",
  "cancelled",
] as const;
export type OrderStatus = typeof ORDER_STATUSES[number];

export type OrderEventDoc = {
  status: OrderStatus;
  note?: string;
  trackingCode?: string;
  trackingUrl?: string;
  createdAt: Date;
};

export type OrderReviewDoc = {
  rating: 1 | 2 | 3 | 4 | 5;
  comment?: string;
  createdAt: Date;
};

export type OrderDoc = {
  _id: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  buyerId: mongoose.Types.ObjectId;
  sellerId: mongoose.Types.ObjectId;
  productSnapshot: {
    title: string;
    price: number;
  };
  amount: number;
  paystackReference: string;
  status: OrderStatus;
  trackingCode?: string;
  trackingUrl?: string;
  timeline: OrderEventDoc[];
  review?: OrderReviewDoc;
  createdAt: Date;
  updatedAt: Date;
};

const orderEventSchema = new Schema<OrderEventDoc>(
  {
    status:       { type: String, enum: ORDER_STATUSES, required: true },
    note:         String,
    trackingCode: String,
    trackingUrl:  String,
    createdAt:    { type: Date, default: Date.now },
  },
  { _id: false },
);

const orderSchema = new Schema<OrderDoc>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    buyerId:   { type: Schema.Types.ObjectId, ref: "User",    required: true, index: true },
    sellerId:  { type: Schema.Types.ObjectId, ref: "User",    required: true, index: true },
    productSnapshot: {
      title: { type: String, required: true },
      price: { type: Number, required: true },
    },
    amount:             { type: Number, required: true },
    paystackReference:  { type: String, required: true, unique: true },
    status:             { type: String, enum: ORDER_STATUSES, default: "placed" },
    trackingCode:       String,
    trackingUrl:        String,
    timeline:           { type: [orderEventSchema], default: [] },
    review: {
      rating:    { type: Number, min: 1, max: 5 },
      comment:   String,
      createdAt: Date,
    },
  },
  { timestamps: true },
);

export const OrderModel = mongoose.model<OrderDoc>("Order", orderSchema);
