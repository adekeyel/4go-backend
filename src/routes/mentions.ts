import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler } from "@/middleware/errorHandler";
import { Prisma } from "@prisma/client";
import { emitToUser } from "@/sockets";
import { pushMention } from "@/lib/push";

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

    const found = await prisma.profiles.findMany({
      where: { username: { in: handles, mode: "insensitive" }, user_id: { not: req.userId! } },
      select: { user_id: true },
    });
    // record_mentions skipped anyone who has blocked you or whom you've blocked.
    const blocks = found.length
      ? await prisma.userBlocks.findMany({
          where: {
            OR: [
              { blocker_id: req.userId!, blocked_id: { in: found.map((f) => f.user_id) } },
              { blocked_id: req.userId!, blocker_id: { in: found.map((f) => f.user_id) } },
            ],
          },
        })
      : [];
    const hidden = new Set(blocks.map((b) => (b.blocker_id === req.userId! ? b.blocked_id : b.blocker_id)));
    const profiles = found.filter((f) => !hidden.has(f.user_id));
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
    for (const p of profiles) {
      emitToUser(p.user_id, "mention:new", { sourceType: body.sourceType, sourceId: body.sourceId });
      // ports notify_push_on_mention
      void pushMention({
        mentionerId: req.userId!,
        mentionedUserId: p.user_id,
        sourceType: body.sourceType,
        sourceId: body.sourceId,
        contextId: body.contextId,
        preview: body.preview,
      });
    }
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

const escapeLike = (v: string) => v.replace(/[\\%_]/g, (c) => "\\" + c);

// Ports search_mentionable_users, for the @-autocomplete. Usernames match by prefix, display names
// anywhere. Ordering: people in the room you're typing in, then friends, then everyone else. Blocked
// users (either way) never show up. Pass room_id only for rooms you belong to; otherwise it's ignored.
mentionsRouter.get(
  "/search",
  asyncHandler(async (req, res) => {
    const me = req.userId!;
    const q = (typeof req.query.q === "string" ? req.query.q : "").trim().toLowerCase();
    if (!q) return res.json([]);
    const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 20);

    let roomId: string | null = null;
    const requested = z.string().uuid().safeParse(req.query.room_id);
    if (requested.success) {
      const member = await prisma.roomMembers.findUnique({
        where: { room_id_user_id: { room_id: requested.data, user_id: me } },
        select: { id: true },
      });
      if (member) roomId = requested.data;
    }

    const prefix = escapeLike(q) + "%";
    const contains = "%" + escapeLike(q) + "%";
    const rows = await prisma.$queryRaw<unknown[]>(Prisma.sql`
      WITH friends_set AS (
        SELECT CASE WHEN requester_id = ${me}::uuid THEN addressee_id ELSE requester_id END AS uid
        FROM friends
        WHERE (requester_id = ${me}::uuid OR addressee_id = ${me}::uuid) AND status = 'accepted'
      ),
      room_set AS (
        SELECT user_id AS uid FROM room_members
        WHERE ${roomId}::uuid IS NOT NULL AND room_id = ${roomId}::uuid AND user_id <> ${me}::uuid
      )
      SELECT p.user_id, p.username, p.display_name, p.avatar_url,
             CASE WHEN p.user_id IN (SELECT uid FROM room_set) THEN 1
                  WHEN p.user_id IN (SELECT uid FROM friends_set) THEN 2
                  ELSE 3 END AS priority
      FROM profiles p
      WHERE p.user_id <> ${me}::uuid
        AND (lower(COALESCE(p.username, '')) LIKE ${prefix}
             OR lower(COALESCE(p.display_name, '')) LIKE ${contains})
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks ub
          WHERE (ub.blocker_id = ${me}::uuid AND ub.blocked_id = p.user_id)
             OR (ub.blocker_id = p.user_id AND ub.blocked_id = ${me}::uuid))
      ORDER BY priority ASC, p.username NULLS LAST
      LIMIT ${limit}`);
    res.json(rows);
  })
);
