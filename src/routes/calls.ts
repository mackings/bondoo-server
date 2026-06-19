import { createHash } from "node:crypto";
import agoraToken from "agora-token";
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { ConversationModel } from "../models/chat.js";

const { RtcTokenBuilder, RtcRole } = agoraToken as typeof import("agora-token");

export const callsRouter = Router();

callsRouter.use(requireAuth);

const tokenRequestSchema = z.object({
  conversation_id: z.string().min(1),
});

function agoraChannelName(conversationId: string) {
  return `bondoo-chat-${conversationId.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

function agoraUidForUser(userId: string) {
  const uid = createHash("sha256").update(userId).digest().readUInt32BE(0);
  return uid === 0 ? 1 : uid;
}

callsRouter.post("/agora-token", async (req, res) => {
  if (!config.agoraAppCertificate) {
    return res.status(503).json({ error: "Agora token service is not configured." });
  }

  const body = tokenRequestSchema.parse(req.body);
  const conversation = await ConversationModel.findById(body.conversation_id);
  if (!conversation || !conversation.memberIds.some((id) => String(id) === req.userId)) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  const channelName = agoraChannelName(String(conversation._id));
  const uid = agoraUidForUser(req.userId!);
  const expiresIn = config.agoraTokenTtlSeconds;
  const token = RtcTokenBuilder.buildTokenWithUid(
    config.agoraAppId,
    config.agoraAppCertificate,
    channelName,
    uid,
    RtcRole.PUBLISHER,
    expiresIn,
    expiresIn,
  );

  res.json({
    app_id: config.agoraAppId,
    channel_name: channelName,
    token,
    uid,
    expires_in: expiresIn,
  });
});
