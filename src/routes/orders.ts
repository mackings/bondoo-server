import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { OrderModel, ORDER_STATUSES } from "../models/order.js";
import { orderJson } from "../models/serializers.js";

export const ordersRouter = Router();

ordersRouter.use(requireAuth);

// ── GET /orders — buyer's purchases ───────────────────────────────────────────
ordersRouter.get("/", async (req, res) => {
  const orders = await OrderModel.find({ buyerId: req.user!._id })
    .populate("sellerId", "username displayName avatarUrl")
    .populate("productId", "title images status")
    .sort({ createdAt: -1 });
  res.json(orders.map(orderJson));
});

// ── GET /orders/selling — seller's sales ──────────────────────────────────────
ordersRouter.get("/selling", async (req, res) => {
  const orders = await OrderModel.find({ sellerId: req.user!._id })
    .populate("buyerId", "username displayName avatarUrl")
    .populate("productId", "title images status")
    .sort({ createdAt: -1 });
  res.json(orders.map(orderJson));
});

// ── GET /orders/:id — single order (buyer or seller) ─────────────────────────
ordersRouter.get("/:id", async (req, res) => {
  const order = await OrderModel.findById(req.params.id)
    .populate("sellerId", "username displayName avatarUrl")
    .populate("buyerId", "username displayName avatarUrl")
    .populate("productId", "title images status");
  if (!order) return res.status(404).json({ error: "Order not found" });

  const uid = String(req.user!._id);
  const buyerId  = String((order.buyerId  as any)?._id ?? order.buyerId);
  const sellerId = String((order.sellerId as any)?._id ?? order.sellerId);
  if (buyerId !== uid && sellerId !== uid) {
    return res.status(403).json({ error: "Forbidden" });
  }
  res.json(orderJson(order));
});

// ── PATCH /orders/:id/status — seller updates order progress ─────────────────
ordersRouter.patch("/:id/status", async (req, res) => {
  const body = z.object({
    status:        z.enum(ORDER_STATUSES),
    note:          z.string().max(300).optional(),
    tracking_code: z.string().max(100).optional(),
    tracking_url:  z.string().url().optional(),
  }).parse(req.body);

  if (body.status === "placed" || body.status === "confirmed") {
    return res.status(400).json({ error: "Invalid status for seller" });
  }

  const order = await OrderModel.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (String(order.sellerId) !== String(req.user!._id)) {
    return res.status(403).json({ error: "Only the seller can update order status" });
  }
  if (order.status === "confirmed" || order.status === "cancelled") {
    return res.status(400).json({ error: "Cannot update a finalized order" });
  }

  order.status = body.status;
  if (body.tracking_code) order.trackingCode = body.tracking_code;
  if (body.tracking_url)  order.trackingUrl  = body.tracking_url;
  order.timeline.push({
    status:       body.status,
    note:         body.note,
    trackingCode: body.tracking_code,
    trackingUrl:  body.tracking_url,
    createdAt:    new Date(),
  });
  await order.save();

  res.json(orderJson(order));
});

// ── POST /orders/:id/confirm — buyer confirms they received the product ───────
ordersRouter.post("/:id/confirm", async (req, res) => {
  const order = await OrderModel.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (String(order.buyerId) !== String(req.user!._id)) {
    return res.status(403).json({ error: "Only the buyer can confirm delivery" });
  }
  if (order.status !== "delivered") {
    return res.status(400).json({ error: "Order must be marked as delivered first" });
  }

  order.status = "confirmed";
  order.timeline.push({ status: "confirmed", note: "Buyer confirmed receipt", createdAt: new Date() });
  await order.save();

  res.json(orderJson(order));
});

// ── POST /orders/:id/review — buyer leaves seller a review ───────────────────
ordersRouter.post("/:id/review", async (req, res) => {
  const body = z.object({
    rating:  z.number().int().min(1).max(5),
    comment: z.string().max(500).optional(),
  }).parse(req.body);

  const order = await OrderModel.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (String(order.buyerId) !== String(req.user!._id)) {
    return res.status(403).json({ error: "Only the buyer can leave a review" });
  }
  if (order.status !== "confirmed") {
    return res.status(400).json({ error: "Confirm delivery before leaving a review" });
  }
  if (order.review) {
    return res.status(409).json({ error: "Review already submitted" });
  }

  order.review = { rating: body.rating as any, comment: body.comment, createdAt: new Date() };
  await order.save();

  res.json(orderJson(order));
});
