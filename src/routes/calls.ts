import { createHash } from "node:crypto";
import agoraToken from "agora-token";
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { CallInviteModel } from "../models/call-invite.js";
import { ConversationModel } from "../models/chat.js";
import { userPublic } from "../models/serializers.js";
import { UserModel } from "../models/user.js";
import { notifyUserPushOnly } from "../notifications.js";

const { RtcTokenBuilder, RtcRole } = agoraToken as typeof import("agora-token");

export const callsRouter = Router();

callsRouter.use(requireAuth);

const inviteRequestSchema = z.object({
  conversation_id: z.string().min(1),
  kind: z.enum(["voice", "video"]),
});

function agoraChannelName(conversationId: string) {
  return `bondoo-chat-${conversationId.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

function agoraUidForUser(userId: string) {
  const uid = createHash("sha256").update(userId).digest().readUInt32BE(0);
  return uid === 0 ? 1 : uid;
}

function ensureAgoraConfigured(res: any) {
  if (!config.agoraAppCertificate) {
    res.status(503).json({ error: "Agora token service is not configured." });
    return false;
  }
  return true;
}

function buildAgoraToken(userId: string, channelName: string) {
  const uid = agoraUidForUser(userId);
  const expiresIn = config.agoraTokenTtlSeconds;
  const token = RtcTokenBuilder.buildTokenWithUid(
    config.agoraAppId,
    config.agoraAppCertificate!,
    channelName,
    uid,
    RtcRole.PUBLISHER,
    expiresIn,
    expiresIn,
  );
  return {
    app_id: config.agoraAppId,
    channel_name: channelName,
    token,
    uid,
    expires_in: expiresIn,
  };
}

function callJson(call: any) {
  return {
    id: String(call._id),
    conversation_id: String(call.conversationId),
    caller_id: String(call.callerId?._id ?? call.callerId),
    receiver_id: String(call.receiverId?._id ?? call.receiverId),
    kind: call.kind,
    status: call.status,
    channel_name: call.channelName,
    caller: call.callerId?.email ? userPublic(call.callerId) : null,
    receiver: call.receiverId?.email ? userPublic(call.receiverId) : null,
    accepted_at: call.acceptedAt ?? null,
    ended_at: call.endedAt ?? null,
    expires_at: call.expiresAt,
    created_at: call.createdAt,
    updated_at: call.updatedAt,
  };
}

async function expireOldCalls() {
  const now = new Date();
  await CallInviteModel.updateMany(
    { status: "ringing", expiresAt: { $lte: now } },
    { status: "missed", endedAt: now },
  );
}

async function findVisibleCall(callId: string, userId: string) {
  await expireOldCalls();
  const call = await CallInviteModel.findById(callId)
    .populate("callerId")
    .populate("receiverId");
  if (!call) return null;
  const callerId = String((call.callerId as any)._id ?? call.callerId);
  const receiverId = String((call.receiverId as any)._id ?? call.receiverId);
  if (callerId !== userId && receiverId !== userId) return null;
  return call;
}

callsRouter.post("/invite", async (req, res) => {
  if (!ensureAgoraConfigured(res)) return;
  const body = inviteRequestSchema.parse(req.body);
  const conversation = await ConversationModel.findById(body.conversation_id);
  if (!conversation || !conversation.memberIds.some((id) => String(id) === req.userId)) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  const receiverId = conversation.memberIds.find((id) => String(id) !== req.userId);
  if (!receiverId) return res.status(400).json({ error: "No receiver found for this call." });

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 45_000);
  const channelName = `${agoraChannelName(String(conversation._id))}-${now.getTime()}`;
  const call = await CallInviteModel.create({
    conversationId: conversation._id,
    callerId: req.user!._id,
    receiverId,
    kind: body.kind,
    status: "ringing",
    channelName,
    expiresAt,
  });

  const receiver = await UserModel.findById(receiverId);
  if (receiver) {
    await notifyUserPushOnly({
      user: receiver,
      title: `Incoming ${body.kind} call`,
      body: `${req.user!.displayName ?? req.user!.username ?? "BONDOO"} is calling you`,
      data: {
        type: "incoming_call",
        call_id: String(call._id),
        conversation_id: String(conversation._id),
        call_kind: body.kind,
      },
    });
  }

  const populated = await call.populate(["callerId", "receiverId"]);
  res.status(201).json({
    call: callJson(populated),
    agora: buildAgoraToken(req.userId!, channelName),
  });
});

callsRouter.get("/history", async (req, res) => {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const calls = await CallInviteModel.find({
    $or: [{ callerId: req.user!._id }, { receiverId: req.user!._id }],
    createdAt: { $gte: since },
    status: { $in: ["accepted", "declined", "ended", "missed"] },
  })
    .populate("callerId")
    .populate("receiverId")
    .sort({ createdAt: -1 })
    .limit(100);
  res.json(calls.map(callJson));
});

callsRouter.get("/pending", async (req, res) => {
  await expireOldCalls();
  const calls = await CallInviteModel.find({
    receiverId: req.user!._id,
    status: "ringing",
    expiresAt: { $gt: new Date() },
  })
    .populate("callerId")
    .populate("receiverId")
    .sort({ createdAt: -1 })
    .limit(5);
  res.json(calls.map(callJson));
});

callsRouter.get("/:id", async (req, res) => {
  const call = await findVisibleCall(req.params.id, req.userId!);
  if (!call) return res.status(404).json({ error: "Call not found" });
  res.json(callJson(call));
});

callsRouter.post("/:id/accept", async (req, res) => {
  if (!ensureAgoraConfigured(res)) return;
  const call = await findVisibleCall(req.params.id, req.userId!);
  if (!call) return res.status(404).json({ error: "Call not found" });
  const receiverId = String((call.receiverId as any)._id ?? call.receiverId);
  if (receiverId !== req.userId) return res.status(403).json({ error: "Only the receiver can accept this call." });
  if (call.status !== "ringing") return res.status(409).json({ error: `Call is ${call.status}.` });
  call.status = "accepted";
  call.acceptedAt = new Date();
  await call.save();
  const populated = await call.populate(["callerId", "receiverId"]);
  res.json({
    call: callJson(populated),
    agora: buildAgoraToken(req.userId!, call.channelName),
  });
});

callsRouter.post("/:id/decline", async (req, res) => {
  const call = await findVisibleCall(req.params.id, req.userId!);
  if (!call) return res.status(404).json({ error: "Call not found" });
  const receiverId = String((call.receiverId as any)._id ?? call.receiverId);
  if (receiverId !== req.userId) return res.status(403).json({ error: "Only the receiver can decline this call." });
  if (call.status === "ringing") {
    call.status = "declined";
    call.endedAt = new Date();
    await call.save();
  }
  res.json(callJson(call));
});

callsRouter.post("/:id/end", async (req, res) => {
  const call = await findVisibleCall(req.params.id, req.userId!);
  if (!call) return res.status(404).json({ error: "Call not found" });
  if (call.status === "ringing" || call.status === "accepted") {
    call.status = "ended";
    call.endedAt = new Date();
    await call.save();
  }
  res.json(callJson(call));
});
