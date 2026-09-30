import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler } from "@/middleware/errorHandler";
import { emitToUser } from "@/sockets";

export const mentionsRouter = Router();
mentionsRouter.use(requireAuth);

const recordSchema = z.object({
  // @handles as typed (without the @); resolved to users server-side.
  handles: z.array(z.string().min(2).max(30)).min(1).max(20),
  sourceType: z.enum(["message", "comment", "post"]),
  sourceId: z.string().uuid(),
  contextId: z.string().uuid().optional(),
  preview: z.string().max(200).optional(),
});

// Replaces the old record_mentions RPC: resolve handles -> users, insert one
// mention row per (distinct, non-self) user, and ping each live via socket.
mentionsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = recordSchema.parse(req.body);
    const handles = [...new Set(body.handles.map((h) => h.toLowerCase()))];

    const profiles = await prisma.profiles.findMany({
      where: { username: { in: handles, mode: "insensitive" }, user_id: { not: req.userId! } },
      select: { user_id: true },
    });
    if (!profiles.length) return res.json({ recorded: 0 });

    await prisma.mentions.createMany({
      data: profiles.map((p) => ({
        mentioner_id: req.userId!,
        mentioned_user_id: p.user_id,
        source_type: body.sourceType,
        source_id: body.sourceId,
        context_id: body.contextId ?? null,
        preview: body.preview ?? null,
      })),
    });
    for (const p of profiles) emitToUser(p.user_id, "mention:new", { sourceType: body.sourceType, sourceId: body.sourceId });
    res.status(201).json({ recorded: profiles.length });
  })
);

mentionsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const rows = await prisma.mentions.findMany({
      where: { mentioned_user_id: req.userId! },
      orderBy: { created_at: "desc" },
      take: 50,
    });
    const ids = [...new Set(rows.map((r) => r.mentioner_id))];
    const profiles = ids.length
      ? await prisma.profiles.findMany({
          where: { user_id: { in: ids } },
          select: { user_id: true, display_name: true, username: true, avatar_url: true },
        })
      : [];
    const map = new Map(profiles.map((p) => [p.user_id, p]));
    res.json(rows.map((r) => ({ ...r, mentioner: map.get(r.mentioner_id) })));
  })
);

mentionsRouter.get(
  "/unread-count",
  asyncHandler(async (req, res) => {
    const count = await prisma.mentions.count({ where: { mentioned_user_id: req.userId!, read_at: null } });
    res.json({ count });
  })
);

mentionsRouter.post(
  "/read",
  asyncHandler(async (req, res) => {
    await prisma.mentions.updateMany({
      where: { mentioned_user_id: req.userId!, read_at: null },
      data: { read_at: new Date() },
    });
    res.status(204).send();
  })
);
