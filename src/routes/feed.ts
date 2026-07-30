import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, optionalAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";

export const feedRouter = Router();

feedRouter.get(
  "/",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const cursor = typeof req.query.before === "string" ? new Date(req.query.before) : undefined;
    const posts = await prisma.posts.findMany({
      where: cursor ? { created_at: { lt: cursor } } : {},
      orderBy: { created_at: "desc" },
      take: 20,
    });
    const userIds = [...new Set(posts.map((p) => p.user_id))];
    const profiles = userIds.length
      ? await prisma.profiles.findMany({
          where: { user_id: { in: userIds } },
          select: { user_id: true, username: true, display_name: true, avatar_url: true, rank: true },
        })
      : [];
    const profileMap = new Map(profiles.map((p) => [p.user_id, p]));

    let likedSet = new Set<string>();
    if (req.userId) {
      const likes = await prisma.postLikes.findMany({
        where: { user_id: req.userId, post_id: { in: posts.map((p) => p.id) } },
      });
      likedSet = new Set(likes.map((l) => l.post_id));
    }

    res.json(
      posts.map((p) => ({ ...p, profile: profileMap.get(p.user_id), is_liked: likedSet.has(p.id) }))
    );
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

feedRouter.delete(
  "/:postId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const post = await prisma.posts.findUnique({ where: { id: req.params.postId } });
    if (!post || post.user_id !== req.userId!) throw new ApiError(404, "Post not found");
    await prisma.posts.delete({ where: { id: post.id } });
    res.status(204).send();
  })
);

feedRouter.post(
  "/:postId/like",
  requireAuth,
  asyncHandler(async (req, res) => {
    const postId = req.params.postId;
    const existing = await prisma.postLikes.findUnique({
      where: { user_id_post_id: { post_id: postId, user_id: req.userId! } },
    });
    if (existing) {
      await prisma.$transaction([
        prisma.postLikes.delete({ where: { id: existing.id } }),
        prisma.posts.update({ where: { id: postId }, data: { likes_count: { decrement: 1 } } }),
      ]);
      return res.json({ liked: false });
    }
    await prisma.$transaction([
      prisma.postLikes.create({ data: { post_id: postId, user_id: req.userId! } }),
      prisma.posts.update({ where: { id: postId }, data: { likes_count: { increment: 1 } } }),
    ]);
    res.json({ liked: true });
  })
);

feedRouter.get(
  "/:postId/comments",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const comments = await prisma.postComments.findMany({
      where: { post_id: req.params.postId },
      orderBy: { created_at: "asc" },
    });
    res.json(comments);
  })
);

const commentSchema = z.object({ content: z.string().min(1).max(1000), parent_id: z.string().uuid().optional() });

feedRouter.post(
  "/:postId/comments",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = commentSchema.parse(req.body);
    const comment = await prisma.$transaction(async (tx) => {
      const c = await tx.postComments.create({
        data: {
          post_id: req.params.postId,
          user_id: req.userId!,
          content: body.content,
          parent_id: body.parent_id ?? null,
        },
      });
      await tx.posts.update({ where: { id: req.params.postId }, data: { comments_count: { increment: 1 } } });
      return c;
    });
    res.status(201).json(comment);
  })
);
