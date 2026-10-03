import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getIo, emitToUser } from "@/sockets";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { areFriends } from "@/lib/social";

export const statusesRouter = Router();
statusesRouter.use(requireAuth);

const uuid = z.string().uuid();

/** Accepted friends of a user (either direction of the friend request). */
async function friendIdsOf(userId: string): Promise<string[]> {
  const rows = await prisma.friends.findMany({
    where: { status: "accepted", OR: [{ requester_id: userId }, { addressee_id: userId }] },
    select: { requester_id: true, addressee_id: true },
  });
  return rows.map((r) => (r.requester_id === userId ? r.addressee_id : r.requester_id));
}

/** Ports the read policy: you can see a status while it's unexpired and it's yours or a friend's. */
async function loadVisibleStatus(statusId: string, viewerId: string) {
  const status = await prisma.statuses.findUnique({ where: { id: statusId } });
  if (!status || status.expires_at <= new Date()) throw new ApiError(404, "Status not found");
  if (status.user_id !== viewerId && !(await areFriends(viewerId, status.user_id))) {
    throw new ApiError(404, "Status not found");
  }
  return status;
}

// Statuses you can see: yours and your friends', not expired, newest first. Group them per person
// on the client. Your own also carry view_count / reaction_count.
statusesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const me = req.userId!;
    const friends = await friendIdsOf(me);
    const statuses = await prisma.statuses.findMany({
      where: { user_id: { in: [me, ...friends] }, expires_at: { gt: new Date() } },
      orderBy: { created_at: "desc" },
    });
    const ids = statuses.map((s) => s.id);
    const ownIds = statuses.filter((s) => s.user_id === me).map((s) => s.id);
    const userIds = [...new Set(statuses.map((s) => s.user_id))];

    const [profiles, myViews, myReactions, viewCounts, reactionCounts] = await Promise.all([
      userIds.length
        ? prisma.profiles.findMany({
            where: { user_id: { in: userIds } },
            select: { user_id: true, username: true, display_name: true, avatar_url: true, rank: true, is_verified: true },
          })
        : [],
      ids.length ? prisma.statusViews.findMany({ where: { viewer_id: me, status_id: { in: ids } }, select: { status_id: true } }) : [],
      ids.length ? prisma.statusReactions.findMany({ where: { user_id: me, status_id: { in: ids } } }) : [],
      ownIds.length
        ? prisma.statusViews.groupBy({ by: ["status_id"], where: { status_id: { in: ownIds } }, _count: { _all: true } })
        : [],
      ownIds.length
        ? prisma.statusReactions.groupBy({ by: ["status_id"], where: { status_id: { in: ownIds } }, _count: { _all: true } })
        : [],
    ]);

    const profileMap = new Map(profiles.map((p) => [p.user_id, p]));
    const viewed = new Set(myViews.map((v) => v.status_id));
    const myReaction = new Map(myReactions.map((r) => [r.status_id, r.emoji]));
    const views = new Map(viewCounts.map((v) => [v.status_id, v._count._all]));
    const reactions = new Map(reactionCounts.map((v) => [v.status_id, v._count._all]));

    res.json(
      statuses.map((s) => ({
        ...s,
        profile: profileMap.get(s.user_id),
        has_viewed: viewed.has(s.id) || s.user_id === me,
        my_reaction: myReaction.get(s.id) ?? null,
        ...(s.user_id === me ? { view_count: views.get(s.id) ?? 0, reaction_count: reactions.get(s.id) ?? 0 } : {}),
      }))
    );
  })
);

// Existing data uses "photo" for pictures.
const createSchema = z
  .object({
    type: z.enum(["text", "photo", "video"]),
    media_url: z.string().url().nullish(),
    caption: z.string().max(500).nullish(),
    bg_color: z.string().max(20).nullish(),
    text_content: z.string().max(700).nullish(),
  })
  .refine((b) => (b.type === "text" ? Boolean(b.text_content?.trim()) : Boolean(b.media_url)), {
    message: "Text statuses need text_content; photo and video statuses need media_url",
  });

// expires_at defaults to 24 hours from now in the database.
statusesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const status = await prisma.statuses.create({
      data: {
        user_id: req.userId!,
        type: body.type,
        media_url: body.media_url ?? null,
        caption: body.caption ?? null,
        bg_color: body.bg_color ?? null,
        text_content: body.text_content ?? null,
      },
    });
    getIo().emit("status:changed", { userId: req.userId!, statusId: status.id, action: "created" });
    res.status(201).json(status);
  })
);

statusesRouter.delete(
  "/:statusId",
  asyncHandler(async (req, res) => {
    const id = uuid.parse(req.params.statusId);
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.statuses.deleteMany({ where: { id, user_id: req.userId! } });
      if (count === 0) throw new ApiError(404, "Status not found");
      await tx.statusViews.deleteMany({ where: { status_id: id } });
      await tx.statusReactions.deleteMany({ where: { status_id: id } });
    });
    getIo().emit("status:changed", { userId: req.userId!, statusId: id, action: "deleted" });
    res.status(204).send();
  })
);

// Record that you've seen someone's status. Your own views and repeat views are ignored.
statusesRouter.post(
  "/:statusId/view",
  asyncHandler(async (req, res) => {
    const status = await loadVisibleStatus(uuid.parse(req.params.statusId), req.userId!);
    if (status.user_id === req.userId!) return res.json({ self_view: true });
    const inserted = await prisma.statusViews.createMany({
      data: [{ status_id: status.id, viewer_id: req.userId! }],
      skipDuplicates: true,
    });
    if (inserted.count > 0) {
      const ev = { statusId: status.id, viewerId: req.userId! };
      getIo().to(`status:${status.id}`).emit("status:view", ev);
      emitToUser(status.user_id, "status:view", ev);
    }
    res.json({ recorded: inserted.count > 0 });
  })
);

// Only the author sees who viewed, with each viewer's reaction.
statusesRouter.get(
  "/:statusId/viewers",
  asyncHandler(async (req, res) => {
    const id = uuid.parse(req.params.statusId);
    const status = await prisma.statuses.findUnique({ where: { id }, select: { user_id: true } });
    if (!status || status.user_id !== req.userId!) throw new ApiError(404, "Status not found");

    const [views, reactions] = await Promise.all([
      prisma.statusViews.findMany({ where: { status_id: id }, orderBy: { viewed_at: "desc" } }),
      prisma.statusReactions.findMany({ where: { status_id: id } }),
    ]);
    const ids = [...new Set([...views.map((v) => v.viewer_id), ...reactions.map((r) => r.user_id)])];
    const profiles = ids.length
      ? await prisma.profiles.findMany({
          where: { user_id: { in: ids } },
          select: { user_id: true, username: true, display_name: true, avatar_url: true },
        })
      : [];
    const profileMap = new Map(profiles.map((p) => [p.user_id, p]));
    const reactionMap = new Map(reactions.map((r) => [r.user_id, r.emoji]));
    res.json(
      views.map((v) => ({
        viewer: profileMap.get(v.viewer_id) ?? { user_id: v.viewer_id },
        viewed_at: v.viewed_at,
        emoji: reactionMap.get(v.viewer_id) ?? null,
      }))
    );
  })
);

// One reaction per person; sending another emoji replaces it. The old policy only checked that the
// status existed; now you must be able to see it.
statusesRouter.put(
  "/:statusId/reaction",
  asyncHandler(async (req, res) => {
    const { emoji } = z.object({ emoji: z.string().min(1).max(16) }).parse(req.body);
    const status = await loadVisibleStatus(uuid.parse(req.params.statusId), req.userId!);
    const reaction = await prisma.statusReactions.upsert({
      where: { status_id_user_id: { status_id: status.id, user_id: req.userId! } },
      create: { status_id: status.id, user_id: req.userId!, emoji },
      update: { emoji },
    });
    const ev = { statusId: status.id, userId: req.userId!, emoji };
    getIo().to(`status:${status.id}`).emit("status:reaction", ev);
    emitToUser(status.user_id, "status:reaction", ev);
    res.json(reaction);
  })
);

statusesRouter.delete(
  "/:statusId/reaction",
  asyncHandler(async (req, res) => {
    const statusId = uuid.parse(req.params.statusId);
    const { count } = await prisma.statusReactions.deleteMany({ where: { status_id: statusId, user_id: req.userId! } });
    if (count > 0) {
      const author = await prisma.statuses.findUnique({ where: { id: statusId }, select: { user_id: true } });
      const ev = { statusId, userId: req.userId!, emoji: null };
      getIo().to(`status:${statusId}`).emit("status:reaction", ev);
      if (author) emitToUser(author.user_id, "status:reaction", ev);
    }
    res.status(204).send();
  })
);
