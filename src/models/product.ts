import mongoose, { Schema } from "mongoose";

export type ProductDoc = {
  _id: mongoose.Types.ObjectId;
  sellerId: mongoose.Types.ObjectId;
  title: string;
  description?: string;
  price: number;           // in Naira
  images: string[];        // up to 3 base64 data URLs
  category?: string;
  status: "active" | "out_of_stock" | "sold";
  createdAt: Date;
  updatedAt: Date;
};

const productSchema = new Schema<ProductDoc>(
  {
    sellerId:    { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title:       { type: String, required: true, maxlength: 100 },
    description: { type: String, maxlength: 500 },
    price:       { type: Number, required: true, min: 0 },
    images:      { type: [String], default: [], validate: [(v: string[]) => v.length <= 3, "Max 3 images"] },
    category:    { type: String, maxlength: 50 },
    status:      { type: String, enum: ["active", "out_of_stock", "sold"], default: "active" },
  },
  { timestamps: true },
);

productSchema.index({ status: 1, createdAt: -1 });

export const ProductModel = mongoose.model<ProductDoc>("Product", productSchema);
