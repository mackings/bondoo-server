import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { HydratedDocument } from "mongoose";
import { config } from "../config.js";
import { UserModel, type UserDoc } from "../models/user.js";

declare global {
  namespace Express {
    interface Request {
      accessToken?: string;
      userId?: string;
      user?: HydratedDocument<UserDoc>;
    }
  }
}

type TokenPayload = {
  sub: string;
  role: string;
};

export function signToken(user: HydratedDocument<UserDoc> | UserDoc) {
  return jwt.sign({ sub: String(user._id), role: user.role } satisfies TokenPayload, config.jwtSecret, {
    expiresIn: "30d",
  });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });

  const token = header.slice("Bearer ".length);
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as TokenPayload;
    const user = await UserModel.findById(decoded.sub);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    req.accessToken = token;
    req.userId = String(user._id);
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (req.user.role !== "admin") return res.status(403).json({ error: "Forbidden" });
  next();
}
