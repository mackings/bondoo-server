import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { StoryModel } from "../models/story.js";
import { userPublic } from "../models/serializers.js";
import { emitStoryEvent } from "../sockets/chat.socket.js";

export const storiesRouter = Router();
storiesRouter.use(requireAuth);

// ── POST /stories — create (replaces any existing story for this user) ────
storiesRouter.post("/", async (req, res) => {
  const body = z
    .object({
      text: z.string().max(300).optional(),
      image_data_url: z.string().startsWith("data:image/").max(1_400_000).optional(),
    })
    .refine((d) => d.text || d.image_data_url, { message: "Story must have text or image" })
    .parse(req.body);

  await StoryModel.deleteMany({ userId: req.user!._id });

  const story = await StoryModel.create({
    userId: req.user!._id,
    text: body.text,
    imageDataUrl: body.image_data_url,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  const payload = { ...toStoryJson(story, req.user!), user: userPublic(req.user!) };
  emitStoryEvent("new_story", payload);
  res.json(payload);
});

// ── GET /stories — all active stories from other users ───────────────────
storiesRouter.get("/", async (req, res) => {
  const stories = await StoryModel.find({
    expiresAt: { $gt: new Date() },
    userId: { $ne: req.user!._id },
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .populate("userId");

  res.json(stories.map((s) => toStoryJson(s, req.user!)));
});

// ── GET /stories/mine — my current story with viewer list ────────────────
storiesRouter.get("/mine", async (req, res) => {
  const story = await StoryModel.findOne({
    userId: req.user!._id,
    expiresAt: { $gt: new Date() },
  }).populate("viewedBy.userId").populate("userId");

  if (!story) return res.json(null);

  const base = toStoryJson(story, req.user!);
  res.json({
    ...base,
    user: userPublic(req.user!),
    viewers: story.viewedBy.map((v: any) => ({
      user_id: String(v.userId?._id ?? v.userId),
      user: v.userId?.email ? userPublic(v.userId) : null,
      viewed_at: v.viewedAt,
    })),
  });
});

// ── DELETE /stories/mine ─────────────────────────────────────────────────
storiesRouter.delete("/mine", async (req, res) => {
  await StoryModel.deleteMany({ userId: req.user!._id });
  emitStoryEvent("story_deleted", { user_id: String(req.user!._id) });
  res.json({ ok: true });
});

// ── POST /stories/:id/view ───────────────────────────────────────────────
storiesRouter.post("/:id/view", async (req, res) => {
  const story = await StoryModel.findOne({
    _id: req.params.id,
    expiresAt: { $gt: new Date() },
  });
  if (!story) return res.status(404).json({ error: "Story not found" });

  const seen = story.viewedBy.some(
    (v) => String(v.userId) === String(req.user!._id),
  );
  if (!seen) {
    story.viewedBy.push({ userId: req.user!._id, viewedAt: new Date() });
    await story.save();
  }
  res.json({ ok: true });
});

// ── helpers ───────────────────────────────────────────────────────────────
function toStoryJson(story: any, viewer: any) {
  const user =
    story.userId?.email ? userPublic(story.userId) : { id: String(story.userId?._id ?? story.userId) };
  const viewedByMe = story.viewedBy.some(
    (v: any) => String(v.userId?._id ?? v.userId) === String(viewer._id),
  );
  return {
    id: String(story._id),
    user_id: String(story.userId?._id ?? story.userId),
    user,
    text: story.text ?? null,
    image_data_url: story.imageDataUrl ?? null,
    view_count: story.viewedBy.length,
    viewed_by_me: viewedByMe,
    expires_at: story.expiresAt,
    created_at: story.createdAt,
  };
}
