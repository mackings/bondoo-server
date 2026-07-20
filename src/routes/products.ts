import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { ProductModel } from "../models/product.js";
import { UserModel } from "../models/user.js";
import { userPublic } from "../models/serializers.js";

export const productsRouter = Router();
productsRouter.use(requireAuth);

function productJson(p: any) {
  return {
    id:          String(p._id),
    seller_id:   String(p.sellerId?._id ?? p.sellerId),
    seller:      p.sellerId && typeof p.sellerId === "object" ? userPublic(p.sellerId) : null,
    title:       p.title,
    description: p.description ?? null,
    price:       p.price,
    images:      p.images ?? [],
    category:    p.category ?? null,
    status:      p.status,
    created_at:  p.createdAt,
  };
}

// GET /products — active listings excluding own
productsRouter.get("/", async (req, res) => {
  const products = await ProductModel.find({ status: "active" })
    .sort({ createdAt: -1 })
    .limit(100)
    .populate("sellerId");
  res.json(products.map(productJson));
});

// GET /products/mine — own listings
productsRouter.get("/mine", async (req, res) => {
  const products = await ProductModel.find({ sellerId: req.user!._id })
    .sort({ createdAt: -1 })
    .populate("sellerId");
  res.json(products.map(productJson));
});

// GET /products/:id — single product
productsRouter.get("/:id", async (req, res) => {
  const product = await ProductModel.findById(req.params.id).populate("sellerId");
  if (!product) return res.status(404).json({ error: "Product not found" });
  res.json(productJson(product));
});

// POST /products — create listing
productsRouter.post("/", async (req, res) => {
  const body = z.object({
    title:       z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).optional(),
    price:       z.number().min(0),
    images:      z.array(z.string().startsWith("data:image/").max(1_400_000)).max(3).default([]),
    category:    z.string().trim().max(50).optional(),
  }).parse(req.body);

  const product = await ProductModel.create({
    sellerId:    req.user!._id,
    title:       body.title,
    description: body.description,
    price:       body.price,
    images:      body.images,
    category:    body.category,
  });
  const populated = await product.populate("sellerId");
  res.status(201).json(productJson(populated));
});

// PATCH /products/:id — update own listing
productsRouter.patch("/:id", async (req, res) => {
  const product = await ProductModel.findOne({ _id: req.params.id, sellerId: req.user!._id });
  if (!product) return res.status(404).json({ error: "Product not found" });

  const body = z.object({
    title:       z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).optional(),
    price:       z.number().min(0).optional(),
    images:      z.array(z.string().startsWith("data:image/").max(1_400_000)).max(3).optional(),
    category:    z.string().trim().max(50).optional(),
    status:      z.enum(["active", "sold"]).optional(),
  }).parse(req.body);

  Object.assign(product, body);
  await product.save();
  const populated = await product.populate("sellerId");
  res.json(productJson(populated));
});

// DELETE /products/:id — delete own listing
productsRouter.delete("/:id", async (req, res) => {
  const product = await ProductModel.findOneAndDelete({ _id: req.params.id, sellerId: req.user!._id });
  if (!product) return res.status(404).json({ error: "Product not found" });
  res.json({ ok: true });
});
