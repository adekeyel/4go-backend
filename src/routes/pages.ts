import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, optionalAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { lockProfile } from "@/lib/coins";
import { isSuperAdmin } from "@/lib/roles";
import { addComment, deleteComment, editComment, purgePostData, toggleLike, toggleSave } from "@/lib/postActions";
import { BOOST_PLANS, BoostPlan, boostPagePost, recordPageView } from "@/lib/pageEconomy";
import { assertCanSendToRoom, sendRoomMessage } from "@/lib/roomMessages";

export const pagesRouter = Router();

const uuid = z.string().uuid();
const clampInt = (v: unknown, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : fallback;
};

// How many pages each rank may own (ports create_page). The SQL left King out entirely,
// so the top rank couldn't create pages; King now gets the same allowance as Master.
const PAGE_LIMITS: Record<string, number> = { Professional: 1, Expert: 2, Master: 3, King: 3 };

const pageFields = {
  name: z.string().trim().min(1).max(100),
  about: z.string().max(1000).nullish(),
  category: z.string().max(50).nullish(),
  profile_image: z.string().url().nullish(),
  cover_image: z.string().url().nullish(),
};
const createPageSchema = z.object(pageFields);
const updatePageSchema = z.object(pageFields).partial();

async function assertPageManager(pageId: string, userId: string) {
  const page = await prisma.pages.findUnique({ where: { id: pageId } });
  if (!page) throw new ApiError(404, "Page not found");
  if (page.owner_id !== userId && !(await isSuperAdmin(userId))) throw new ApiError(403, "You don't manage this page");
  return page;
}

async function assertPostManager(postId: string, userId: string) {
  const post = await prisma.pagePosts.findUnique({ where: { id: postId } });
  if (!post) throw new ApiError(404, "Post not found");
  await assertPageManager(post.page_id, userId);
  return post;
}

/** Add the page card plus the viewer's liked/saved state to page posts (order preserved). */
async function hydratePosts<T extends { id: string; page_id: string }>(posts: T[], viewerId?: string) {
  const pageIds = [...new Set(posts.map((p) => p.page_id))];
  const pages = pageIds.length
    ? await prisma.pages.findMany({ where: { id: { in: pageIds } }, select: { id: true, name: true, profile_image: true } })
    : [];
  const pageMap = new Map(pages.map((p) => [p.id, p]));
  const ids = posts.map((p) => p.id);
  const [likes, saves] =
    viewerId && ids.length
      ? await Promise.all([
          prisma.postLikes.findMany({ where: { user_id: viewerId, post_id: { in: ids } }, select: { post_id: true } }),
          prisma.postSaves.findMany({ where: { user_id: viewerId, post_id: { in: ids } }, select: { post_id: true } }),
        ])
      : [[], []];
  const liked = new Set(likes.map((l) => l.post_id));
  const saved = new Set(saves.map((s) => s.post_id));
  return posts.map((p) => ({ ...p, page: pageMap.get(p.page_id), is_liked: liked.has(p.id), is_saved: saved.has(p.id) }));
}

// ---------------------------------------------------------------- page-post feed / saved / boosts

/**
 * Ports get_page_feed. Score = boosted 1000 + followed page 200 + engagement (max 100)
 * + freshness bonus decaying to 0 over 30 hours. Fields are flat, as the SQL returned them.
 */
pagesRouter.get(
  "/feed",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const limit = clampInt(req.query.limit, 20, 1, 50);
    const offset = clampInt(req.query.offset, 0, 0, 10_000);
    const rows = await prisma.$queryRaw<unknown[]>(Prisma.sql`
      WITH followed AS (
        SELECT page_id FROM page_followers WHERE user_id = ${userId}::uuid
      ),
      active_boosts AS (
        SELECT DISTINCT post_id FROM post_boosts
        WHERE status = 'active' AND ends_at > now() AND reach_count < reach_target
      )
      SELECT
        pp.id, pp.page_id, pp.author_id, pp.content, pp.media_url, pp.media_type,
        pp.views_count, pp.unique_views_count, pp.likes_count, pp.comments_count, pp.saves_count,
        pp.created_at, pg.name AS page_name, pg.profile_image AS page_avatar,
        EXISTS(SELECT 1 FROM followed f WHERE f.page_id = pp.page_id) AS is_followed,
        EXISTS(SELECT 1 FROM active_boosts ab WHERE ab.post_id = pp.id) AS is_boosted,
        EXISTS(SELECT 1 FROM post_saves ps WHERE ps.post_id = pp.id AND ps.user_id = ${userId}::uuid) AS is_saved,
        EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id = pp.id AND pl.user_id = ${userId}::uuid) AS is_liked,
        (
          CASE WHEN EXISTS(SELECT 1 FROM active_boosts ab WHERE ab.post_id = pp.id) THEN 1000 ELSE 0 END
          + CASE WHEN EXISTS(SELECT 1 FROM followed f WHERE f.page_id = pp.page_id) THEN 200 ELSE 0 END
          + LEAST(pp.likes_count * 2 + pp.comments_count * 3 + pp.unique_views_count, 100)
          + GREATEST(0, 30 - EXTRACT(EPOCH FROM (now() - pp.created_at)) / 3600)
        )::float8 AS score
      FROM page_posts pp
      JOIN pages pg ON pg.id = pp.page_id
      ORDER BY score DESC, pp.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`);
    res.json(rows);
  })
);

pagesRouter.get("/boost-plans", (_req, res) => res.json(BOOST_PLANS));

pagesRouter.get(
  "/posts/saved",
  requireAuth,
  asyncHandler(async (req, res) => {
    const saves = await prisma.postSaves.findMany({
      where: { user_id: req.userId! },
      orderBy: { saved_at: "desc" },
      take: 100,
    });
    const posts = await prisma.pagePosts.findMany({ where: { id: { in: saves.map((s) => s.post_id) } } });
    const byId = new Map(posts.map((p) => [p.id, p]));
    const ordered = saves.flatMap((s) => (byId.has(s.post_id) ? [byId.get(s.post_id)!] : []));
    res.json(await hydratePosts(ordered, req.userId));
  })
);

// ---------------------------------------------------------------- page-post actions

const postBodySchema = z.object({
  content: z.string().max(5000).nullish(),
  media_url: z.string().url().nullish(),
  media_type: z.enum(["text", "image", "video"]).default("text"),
});

pagesRouter.patch(
  "/posts/:postId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = postBodySchema.partial().parse(req.body);
    const post = await assertPostManager(uuid.parse(req.params.postId), req.userId!);
    res.json(await prisma.pagePosts.update({ where: { id: post.id }, data: { ...body, updated_at: new Date() } }));
  })
);

pagesRouter.delete(
  "/posts/:postId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const post = await assertPostManager(uuid.parse(req.params.postId), req.userId!);
    await prisma.$transaction(async (tx) => {
      await purgePostData(tx, [post.id]);
      await tx.pagePosts.delete({ where: { id: post.id } });
    });
    res.status(204).send();
  })
);

pagesRouter.post(
  "/posts/:postId/like",
  requireAuth,
  asyncHandler(async (req, res) => {
    const postId = uuid.parse(req.params.postId);
    res.json(await prisma.$transaction((tx) => toggleLike(tx, req.userId!, postId, "page_post")));
  })
);

pagesRouter.post(
  "/posts/:postId/save",
  requireAuth,
  asyncHandler(async (req, res) => {
    const postId = uuid.parse(req.params.postId);
    res.json(await prisma.$transaction((tx) => toggleSave(tx, req.userId!, postId, "page_post")));
  })
);

pagesRouter.post(
  "/posts/:postId/view",
  requireAuth,
  asyncHandler(async (req, res) => {
    const postId = uuid.parse(req.params.postId);
    res.json(await prisma.$transaction((tx) => recordPageView(tx, req.userId!, postId)));
  })
);

const boostSchema = z.object({ plan: z.enum(Object.keys(BOOST_PLANS) as [BoostPlan, ...BoostPlan[]]) });

pagesRouter.post(
  "/posts/:postId/boost",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { plan } = boostSchema.parse(req.body);
    const postId = uuid.parse(req.params.postId);
    res.status(201).json(await prisma.$transaction((tx) => boostPagePost(tx, req.userId!, postId, plan)));
  })
);

pagesRouter.get(
  "/posts/:postId/comments",
  optionalAuth,
  asyncHandler(async (req, res) => {
    res.json(
      await prisma.postComments.findMany({
        where: { post_id: uuid.parse(req.params.postId) },
        orderBy: { created_at: "asc" },
      })
    );
  })
);

const commentSchema = z.object({ content: z.string().min(1).max(1000), parent_id: z.string().uuid().optional() });

pagesRouter.post(
  "/posts/:postId/comments",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = commentSchema.parse(req.body);
    const postId = uuid.parse(req.params.postId);
    const comment = await prisma.$transaction((tx) =>
      addComment(tx, req.userId!, postId, body.content, body.parent_id, "page_post")
    );
    res.status(201).json(comment);
  })
);

pagesRouter.patch(
  "/posts/:postId/comments/:commentId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { content } = z.object({ content: z.string().min(1).max(1000) }).parse(req.body);
    const commentId = uuid.parse(req.params.commentId);
    res.json(await prisma.$transaction((tx) => editComment(tx, req.userId!, commentId, content)));
  })
);

pagesRouter.delete(
  "/posts/:postId/comments/:commentId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const commentId = uuid.parse(req.params.commentId);
    res.json(await prisma.$transaction((tx) => deleteComment(tx, req.userId!, commentId)));
  })
);

// Ports forward_page_post_to_room.
pagesRouter.post(
  "/posts/:postId/forward",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = z.object({ room_id: z.string().uuid(), note: z.string().max(500).optional() }).parse(req.body);
    const postId = uuid.parse(req.params.postId);
    if (!(await prisma.pagePosts.findUnique({ where: { id: postId }, select: { id: true } }))) {
      throw new ApiError(404, "Post not found");
    }
    await assertCanSendToRoom(body.room_id, req.userId!);
    const message = await sendRoomMessage(body.room_id, req.userId!, {
      type: "shared_page_post",
      content: JSON.stringify({ page_post_id: postId, note: body.note ?? "" }),
    });
    res.status(201).json(message);
  })
);

// ---------------------------------------------------------------- pages

pagesRouter.get(
  "/",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const owner = req.query.owner === "me" && req.userId ? req.userId : undefined;
    const pages = await prisma.pages.findMany({
      where: {
        ...(owner ? { owner_id: owner } : {}),
        ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
      },
      orderBy: [{ followers_count: "desc" }, { created_at: "desc" }],
      take: clampInt(req.query.limit, 20, 1, 50),
      skip: clampInt(req.query.offset, 0, 0, 10_000),
    });
    let followed = new Set<string>();
    if (req.userId && pages.length) {
      const f = await prisma.pageFollowers.findMany({
        where: { user_id: req.userId, page_id: { in: pages.map((p) => p.id) } },
        select: { page_id: true },
      });
      followed = new Set(f.map((x) => x.page_id));
    }
    res.json(pages.map((p) => ({ ...p, is_followed: followed.has(p.id) })));
  })
);

pagesRouter.get(
  "/following",
  requireAuth,
  asyncHandler(async (req, res) => {
    const follows = await prisma.pageFollowers.findMany({
      where: { user_id: req.userId! },
      orderBy: { followed_at: "desc" },
    });
    const pages = await prisma.pages.findMany({ where: { id: { in: follows.map((f) => f.page_id) } } });
    const byId = new Map(pages.map((p) => [p.id, p]));
    res.json(follows.flatMap((f) => (byId.has(f.page_id) ? [{ ...byId.get(f.page_id)!, is_followed: true }] : [])));
  })
);

// Ports create_page: needs Professional rank or above; the number of pages is capped by rank.
pagesRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = createPageSchema.parse(req.body);
    const userId = req.userId!;
    const page = await prisma.$transaction(async (tx) => {
      await lockProfile(tx, userId); // serialises concurrent creates so the limit can't be beaten
      const profile = await tx.profiles.findUnique({ where: { user_id: userId }, select: { rank: true } });
      const rank = profile?.rank ?? "";
      const limit = PAGE_LIMITS[rank];
      if (!limit) throw new ApiError(403, "You need to be at least Professional level to create a page");
      const current = await tx.pages.count({ where: { owner_id: userId } });
      if (current >= limit) {
        throw new ApiError(403, `You have reached the maximum number of pages for your rank (${rank}). Limit: ${limit}`);
      }
      return tx.pages.create({
        data: {
          owner_id: userId,
          name: body.name,
          about: body.about ?? null,
          category: body.category ?? null,
          profile_image: body.profile_image ?? null,
          cover_image: body.cover_image ?? null,
          is_monetized: rank === "Master" || rank === "King",
        },
      });
    });
    res.status(201).json(page);
  })
);

pagesRouter.get(
  "/:pageId",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const pageId = uuid.parse(req.params.pageId);
    const page = await prisma.pages.findUnique({ where: { id: pageId } });
    if (!page) throw new ApiError(404, "Page not found");
    const [owner, follow] = await Promise.all([
      prisma.profiles.findUnique({
        where: { user_id: page.owner_id },
        select: { user_id: true, username: true, display_name: true, avatar_url: true, rank: true, is_verified: true },
      }),
      req.userId
        ? prisma.pageFollowers.findUnique({ where: { page_id_user_id: { page_id: pageId, user_id: req.userId } } })
        : null,
    ]);
    res.json({ ...page, owner, is_followed: Boolean(follow) });
  })
);

// Owner or super admin.
pagesRouter.patch(
  "/:pageId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = updatePageSchema.parse(req.body);
    const page = await assertPageManager(uuid.parse(req.params.pageId), req.userId!);
    res.json(await prisma.pages.update({ where: { id: page.id }, data: { ...body, updated_at: new Date() } }));
  })
);

// Owner or super admin. Removes the page's posts and everything attached to them.
pagesRouter.delete(
  "/:pageId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const page = await assertPageManager(uuid.parse(req.params.pageId), req.userId!);
    await prisma.$transaction(async (tx) => {
      const posts = await tx.pagePosts.findMany({ where: { page_id: page.id }, select: { id: true } });
      await purgePostData(tx, posts.map((p) => p.id));
      await tx.pagePosts.deleteMany({ where: { page_id: page.id } });
      await tx.pageFollowers.deleteMany({ where: { page_id: page.id } });
      await tx.pages.delete({ where: { id: page.id } });
    });
    res.status(204).send();
  })
);

// Ports follow_page. The SQL bumped followers_count even when you already followed;
// here it only changes when a follow row is really added or removed.
pagesRouter.post(
  "/:pageId/follow",
  requireAuth,
  asyncHandler(async (req, res) => {
    const pageId = uuid.parse(req.params.pageId);
    await prisma.$transaction(async (tx) => {
      if (!(await tx.pages.findUnique({ where: { id: pageId }, select: { id: true } }))) {
        throw new ApiError(404, "Page not found");
      }
      const added = await tx.pageFollowers.createMany({
        data: [{ page_id: pageId, user_id: req.userId! }],
        skipDuplicates: true,
      });
      if (added.count > 0) await tx.pages.update({ where: { id: pageId }, data: { followers_count: { increment: 1 } } });
    });
    res.json({ following: true });
  })
);

pagesRouter.delete(
  "/:pageId/follow",
  requireAuth,
  asyncHandler(async (req, res) => {
    const pageId = uuid.parse(req.params.pageId);
    await prisma.$transaction(async (tx) => {
      const removed = await tx.pageFollowers.deleteMany({ where: { page_id: pageId, user_id: req.userId! } });
      if (removed.count > 0) {
        await tx.pages.updateMany({ where: { id: pageId, followers_count: { gt: 0 } }, data: { followers_count: { decrement: 1 } } });
      }
    });
    res.json({ following: false });
  })
);

pagesRouter.get(
  "/:pageId/posts",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const before = typeof req.query.before === "string" ? new Date(req.query.before) : undefined;
    const posts = await prisma.pagePosts.findMany({
      where: { page_id: uuid.parse(req.params.pageId), ...(before ? { created_at: { lt: before } } : {}) },
      orderBy: { created_at: "desc" },
      take: clampInt(req.query.limit, 20, 1, 50),
    });
    res.json(await hydratePosts(posts, req.userId));
  })
);

// Only the page owner can post (the old RLS policy also required author_id = you).
pagesRouter.post(
  "/:pageId/posts",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = postBodySchema.parse(req.body);
    const page = await prisma.pages.findUnique({ where: { id: uuid.parse(req.params.pageId) } });
    if (!page) throw new ApiError(404, "Page not found");
    if (page.owner_id !== req.userId!) throw new ApiError(403, "Only the page owner can post");
    if (body.media_type === "text" ? !body.content?.trim() : !body.media_url) {
      throw new ApiError(400, body.media_type === "text" ? "Post content required" : "Media URL required");
    }
    const post = await prisma.pagePosts.create({
      data: {
        page_id: page.id,
        author_id: req.userId!,
        content: body.content ?? null,
        media_url: body.media_url ?? null,
        media_type: body.media_type,
      },
    });
    res.status(201).json(post);
  })
);
