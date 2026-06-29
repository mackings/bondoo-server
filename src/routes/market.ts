import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { UserModel } from "../models/user.js";
import { userPublic } from "../models/serializers.js";

export const marketRouter = Router();
marketRouter.use(requireAuth);

marketRouter.get("/", async (req, res) => {
  const filter: any = {
    "tradeStatus.active": true,
    _id: { $ne: req.user!._id },
  };
  if (req.query.type === "selling" || req.query.type === "buying") {
    filter["tradeStatus.type"] = req.query.type;
  }
  if (req.query.coin) {
    filter["tradeStatus.coin"] = String(req.query.coin).toUpperCase();
  }

  const users = await UserModel.find(filter)
    .sort({ "tradeStatus.updatedAt": -1 })
    .limit(100);

  res.json(users.map(userPublic));
});
