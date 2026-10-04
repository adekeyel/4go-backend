import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, optionalAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { addComment, commentsWithProfiles, deleteComment, editComment, purgePostData, toggleLike, toggleSave } from "@/lib/postActions";
import { assertCanSendToRoom, sendRoomMessage } from "@/lib/roomMessages";

export const feedRouter = Router();

const uuid = z.string().uuid();
const clampInt = (v: unknown, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : fallback;
};

/** Attach author profile and the viewer's liked state to a list of posts (order preserved). */
async function hydrate<T extends { id: string; user_id: string }>(posts: T[], viewerId?: string) {
  const userIds = [...new Set(posts.map((p) => p.user_id))];
  const profiles = userIds.length
    ? await prisma.profiles.findMany({
        where: { user_id: { in: userIds } },
        select: { user_id: true, username: true, display_name: true, avatar_url: true, rank: true },
      })
    : [];
  const profileMap = new Map(profiles.map((p) => [p.user_id, p]));

  let likedSet = new Set<string>();
  if (viewerId && posts.length) {
    const likes = await prisma.postLikes.findMany({
      where: { user_id: viewerId, post_id: { in: posts.map((p) => p.id) } },
    });
    likedSet = new Set(likes.map((l) => l.post_id));
  }
  return posts.map((p) => ({ ...p, profile: profileMap.get(p.user_id), is_liked: likedSet.has(p.id) }));
}

/**
 * Ports get_feed_posts. Ranking: your own posts 100, friends 80, friends of friends 50,
 * people you share a room with 30, everyone else 5; plus engagement (max 50) and a
 * freshness bonus that decays to 0 over 30 hours. Posts from blocked users (either direction) are hidden.
 */
async function scoredFeedIds(userId: string, limit: number, offset: number) {
  return prisma.$queryRaw<{ id: string; feed_score: number }[]>(Prisma.sql`
    WITH my_friends AS (
      SELECT CASE WHEN requester_id = ${userId}::uuid THEN addressee_id ELSE requester_id END AS friend_id
      FROM friends
      WHERE (requester_id = ${userId}::uuid OR addressee_id = ${userId}::uuid) AND status = 'accepted'
    ),
    friends_of_friends AS (
      SELECT DISTINCT CASE WHEN f.requester_id = mf.friend_id THEN f.addressee_id ELSE f.requester_id END AS fof_id
      FROM my_friends mf
      JOIN friends f ON (f.requester_id = mf.friend_id OR f.addressee_id = mf.friend_id) AND f.status = 'accepted'
      WHERE CASE WHEN f.requester_id = mf.friend_id THEN f.addressee_id ELSE f.requester_id END <> ${userId}::uuid
        AND CASE WHEN f.requester_id = mf.friend_id THEN f.addressee_id ELSE f.requester_id END NOT IN (SELECT friend_id FROM my_friends)
    ),
    room_peers AS (
      SELECT DISTINCT rm.user_id AS peer_id
      FROM room_members rm
      JOIN room_members mine ON mine.room_id = rm.room_id AND mine.user_id = ${userId}::uuid
      WHERE rm.user_id <> ${userId}::uuid
    ),
    scored AS (
      SELECT p.id, p.created_at,
        (
          CASE WHEN p.user_id = ${userId}::uuid THEN 100
               WHEN p.user_id IN (SELECT friend_id FROM my_friends) THEN 80
               WHEN p.user_id IN (SELECT fof_id FROM friends_of_friends) THEN 50
               WHEN p.user_id IN (SELECT peer_id FROM room_peers) THEN 30
               ELSE 5 END
          + LEAST(p.likes_count * 2 + p.comments_count * 3, 50)
          + GREATEST(0, 30 - EXTRACT(EPOCH FROM (now() - p.created_at)) / 3600)
        )::float8 AS feed_score
      FROM posts p
      JOIN profiles pr ON pr.user_id = p.user_id
      WHERE NOT EXISTS (
        SELECT 1 FROM user_blocks ub
        WHERE (ub.blocker_id = ${userId}::uuid AND ub.blocked_id = p.user_id)
           OR (ub.blocker_id = p.user_id AND ub.blocked_id = ${userId}::uuid)
      )
    )
    SELECT id, feed_score FROM scored
    ORDER BY feed_score DESC, created_at DESC
    LIMIT ${limit} OFFSET ${offset}`);
}

// Signed-in users get the ranked feed (?limit=&offset=). Guests, and older clients that still
// pass ?before=<timestamp>, get the newest-first list.
feedRouter.get(
  "/",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const limit = clampInt(req.query.limit, 20, 1, 50);
    const offset = clampInt(req.query.offset, 0, 0, 10_000);
    const before = typeof req.query.before === "string" ? new Date(req.query.before) : undefined;

    if (req.userId && !before) {
      const ranked = await scoredFeedIds(req.userId, limit, offset);
      const posts = await prisma.posts.findMany({ where: { id: { in: ranked.map((r) => r.id) } } });
      const byId = new Map(posts.map((p) => [p.id, p]));
      const ordered = ranked.flatMap((r) => (byId.has(r.id) ? [{ ...byId.get(r.id)!, feed_score: r.feed_score }] : []));
      return res.json(await hydrate(ordered, req.userId));
    }

    let hidden: string[] = [];
    if (req.userId) {
      const blocks = await prisma.userBlocks.findMany({
        where: { OR: [{ blocker_id: req.userId }, { blocked_id: req.userId }] },
      });
      hidden = blocks.map((b) => (b.blocker_id === req.userId ? b.blocked_id : b.blocker_id));
    }
    const posts = await prisma.posts.findMany({
      where: { ...(before ? { created_at: { lt: before } } : {}), ...(hidden.length ? { user_id: { notIn: hidden } } : {}) },
      orderBy: { created_at: "desc" },
      take: limit,
      skip: before ? 0 : offset,
    });
    res.json(await hydrate(posts, req.userId));
  })
);

// Posts the signed-in user has saved, newest save first.
feedRouter.get(
  "/saved",
  requireAuth,
  asyncHandler(async (req, res) => {
    const saves = await prisma.postSaves.findMany({
      where: { user_id: req.userId! },
      orderBy: { saved_at: "desc" },
      take: 100,
    });
    const posts = await prisma.posts.findMany({ where: { id: { in: saves.map((s) => s.post_id) } } });
    const byId = new Map(posts.map((p) => [p.id, p]));
    const ordered = saves.flatMap((s) => (byId.has(s.post_id) ? [byId.get(s.post_id)!] : []));
    res.json(await hydrate(ordered, req.userId));
  })
);

// How many posts the signed-in user has made (onboarding checklist).
feedRouter.get(
  "/mine/count",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ count: await prisma.posts.count({ where: { user_id: req.userId! } }) });
  })
);

// One post (deep links from mentions and shared-post cards), with author and your liked state.
// Declared after "/saved" so that word isn't read as a post id.
feedRouter.get(
  "/:postId",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const post = await prisma.posts.findUnique({ where: { id: uuid.parse(req.params.postId) } });
    if (!post) throw new ApiError(404, "Post not found");
    if (req.userId) {
      const blocked = await prisma.userBlocks.findFirst({
        where: { OR: [{ blocker_id: req.userId, blocked_id: post.user_id }, { blocker_id: post.user_id, blocked_id: req.userId }] },
        select: { blocker_id: true },
      });
      if (blocked) throw new ApiError(404, "Post not found");
    }
    res.json((await hydrate([post], req.userId))[0]);
  })
);

const createPostSchema = z.object({
  content: z.string().min(1).max(2000),
  image_url: z.string().url().optional(),
});

feedRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = createPostSchema.parse(req.body);
    const post = await prisma.posts.create({
      data: { user_id: req.userId!, content: body.content, image_url: body.image_url ?? null },
    });
    res.status(201).json(post);
  })
);

const updatePostSchema = z.object({
  content: z.string().min(1).max(2000).optional(),
  image_url: z.string().url().nullable().optional(),
});

feedRouter.patch(
  "/:postId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = updatePostSchema.parse(req.body);
    const { count } = await prisma.posts.updateMany({
      where: { id: uuid.parse(req.params.postId), user_id: req.userId! },
      data: { ...body, updated_at: new Date() },
    });
    if (count === 0) throw new ApiError(404, "Post not found");
    res.json(await prisma.posts.findUnique({ where: { id: req.params.postId } }));
  })
);

feedRouter.delete(
  "/:postId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const postId = uuid.parse(req.params.postId);
    const post = await prisma.posts.findUnique({ where: { id: postId } });
    if (!post || post.user_id !== req.userId!) throw new ApiError(404, "Post not found");
    await prisma.$transaction(async (tx) => {
      await purgePostData(tx, [postId]);
      await tx.posts.delete({ where: { id: postId } });
    });
    res.status(204).send();
  })
);

feedRouter.post(
  "/:postId/like",
  requireAuth,
  asyncHandler(async (req, res) => {
    const postId = uuid.parse(req.params.postId);
    res.json(await prisma.$transaction((tx) => toggleLike(tx, req.userId!, postId, "post")));
  })
);

feedRouter.post(
  "/:postId/save",
  requireAuth,
  asyncHandler(async (req, res) => {
    const postId = uuid.parse(req.params.postId);
    res.json(await prisma.$transaction((tx) => toggleSave(tx, req.userId!, postId, "post")));
  })
);

feedRouter.get(
  "/:postId/comments",
  optionalAuth,
  asyncHandler(async (req, res) => {
    res.json(await commentsWithProfiles(uuid.parse(req.params.postId)));
  })
);

const commentSchema = z.object({ content: z.string().min(1).max(1000), parent_id: z.string().uuid().optional() });

feedRouter.post(
  "/:postId/comments",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = commentSchema.parse(req.body);
    const postId = uuid.parse(req.params.postId);
    const comment = await prisma.$transaction((tx) =>
      addComment(tx, req.userId!, postId, body.content, body.parent_id, "post")
    );
    res.status(201).json(comment);
  })
);

const editCommentSchema = z.object({ content: z.string().min(1).max(1000) });

feedRouter.patch(
  "/:postId/comments/:commentId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { content } = editCommentSchema.parse(req.body);
    const commentId = uuid.parse(req.params.commentId);
    res.json(await prisma.$transaction((tx) => editComment(tx, req.userId!, commentId, content)));
  })
);

feedRouter.delete(
  "/:postId/comments/:commentId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const commentId = uuid.parse(req.params.commentId);
    res.json(await prisma.$transaction((tx) => deleteComment(tx, req.userId!, commentId)));
  })
);

// Ports forward_post_to_room: shares the post into a room you're in as a "shared_post" message.
const forwardSchema = z.object({ room_id: z.string().uuid(), note: z.string().max(500).optional() });

feedRouter.post(
  "/:postId/forward",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = forwardSchema.parse(req.body);
    const postId = uuid.parse(req.params.postId);
    if (!(await prisma.posts.findUnique({ where: { id: postId }, select: { id: true } }))) {
      throw new ApiError(404, "Post not found");
    }
    await assertCanSendToRoom(body.room_id, req.userId!);
    const message = await sendRoomMessage(body.room_id, req.userId!, {
      type: "shared_post",
      content: JSON.stringify({ post_id: postId, note: body.note ?? "" }),
    });
    res.status(201).json(message);
  })
);
