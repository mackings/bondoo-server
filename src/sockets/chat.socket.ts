import type { Server as HttpServer } from "http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { UserModel } from "../models/user.js";
import { ConversationModel, MessageModel } from "../models/chat.js";
import { messageJson } from "../models/serializers.js";

export let io: Server | undefined;

export function initSocket(httpServer: HttpServer) {
  io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] },
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) return next(new Error("Unauthorized"));
      const decoded = jwt.verify(token, config.jwtSecret) as { sub: string };
      const user = await UserModel.findById(decoded.sub);
      if (!user) return next(new Error("Unauthorized"));
      socket.data.user = user;
      socket.data.userId = String(user._id);
      next();
    } catch {
      next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.data.userId as string;

    socket.on("join_conversation", (conversationId: string) => {
      socket.join(`conv:${conversationId}`);
    });

    socket.on("leave_conversation", (conversationId: string) => {
      socket.leave(`conv:${conversationId}`);
    });

    socket.on("send_message", async (data: { conversation_id: string; body: string }, callback) => {
      try {
        if (typeof data?.conversation_id !== "string" || !data.body?.trim()) {
          return callback?.({ error: "Invalid message" });
        }
        const conversation = await ConversationModel.findById(data.conversation_id);
        if (!conversation || !conversation.memberIds.some((id: any) => String(id) === userId)) {
          return callback?.({ error: "Conversation not found" });
        }
        const message = await MessageModel.create({
          conversationId: conversation._id,
          senderId: socket.data.user._id,
          body: data.body.trim(),
          kind: "text",
        });
        conversation.lastMessageAt = new Date();
        await conversation.save();
        const payload = messageJson(message);
        io!.to(`conv:${data.conversation_id}`).emit("new_message", payload);
        callback?.({ ok: true, message: payload });
      } catch (err: any) {
        callback?.({ error: err.message ?? "Failed to send message" });
      }
    });
  });
}
