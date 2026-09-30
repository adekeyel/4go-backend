import { Prisma } from "@prisma/client";
import { ApiError } from "@/middleware/errorHandler";
import { Tx } from "@/lib/coins";

/**
 * Likes, comments and saves work on two kinds of post that share the same
 * post_likes / post_comments / post_saves tables: user posts ("posts") and page posts ("page_posts").
 * There are no foreign keys, so every action checks the post exists first.
 */
export type Target = "post" | "page_post";

export async function findTarget(tx: Tx, postId: string): Promise<Target | null> {
  if (await tx.posts.findUnique({ where: { id: postId }, select: { id: true } })) return "post";
  if (await tx.pagePosts.findUnique({ where: { id: postId }, select: { id: true } })) return "page_post";
  return null;
}

export async function requireTarget(tx: Tx, postId: string, expected?: Target): Promise<Target> {
  const t = await findTarget(tx, postId);
  if (!t || (expected && t !== expected)) throw new ApiError(404, "Post not found");
  return t;
}

// Counters never go below zero (the SQL used GREATEST(x - 1, 0)); the `gt: 0` guard does that atomically.
type CounterField = "likes_count" | "comments_count" | "saves_count";

async function bump(tx: Tx, target: Target, id: string, field: CounterField, delta: 1 | -1) {
  const up = delta === 1;
  if (target === "post") {
    if (field === "likes_count") {
      await tx.posts.updateMany({ where: up ? { id } : { id, likes_count: { gt: 0 } }, data: { likes_count: up ? { increment: 1 } : { decrement: 1 } } });
    } else if (field === "comments_count") {
      await tx.posts.updateMany({ where: up ? { id } : { id, comments_count: { gt: 0 } }, data: { comments_count: up ? { increment: 1 } : { decrement: 1 } } });
    } // user posts have no saves counter
    return;
  }
  if (field === "likes_count") {
    await tx.pagePosts.updateMany({ where: up ? { id } : { id, likes_count: { gt: 0 } }, data: { likes_count: up ? { increment: 1 } : { decrement: 1 } } });
  } else if (field === "comments_count") {
    await tx.pagePosts.updateMany({ where: up ? { id } : { id, comments_count: { gt: 0 } }, data: { comments_count: up ? { increment: 1 } : { decrement: 1 } } });
  } else {
    await tx.pagePosts.updateMany({ where: up ? { id } : { id, saves_count: { gt: 0 } }, data: { saves_count: up ? { increment: 1 } : { decrement: 1 } } });
  }
}

/** Ports toggle_post_like / toggle_page_post_like. Race-safe: the unique index decides who wins. */
export async function toggleLike(tx: Tx, userId: string, postId: string, expected?: Target) {
  const target = await requireTarget(tx, postId, expected);
  const removed = await tx.postLikes.deleteMany({ where: { user_id: userId, post_id: postId } });
  if (removed.count > 0) {
    await bump(tx, target, postId, "likes_count", -1);
    return { liked: false };
  }
  const added = await tx.postLikes.createMany({ data: [{ user_id: userId, post_id: postId }], skipDuplicates: true });
  if (added.count > 0) await bump(tx, target, postId, "likes_count", 1);
  return { liked: true };
}

/** Save / unsave. Page posts also keep saves_count, which nothing maintained in the Supabase version. */
export async function toggleSave(tx: Tx, userId: string, postId: string, expected?: Target) {
  const target = await requireTarget(tx, postId, expected);
  const removed = await tx.postSaves.deleteMany({ where: { user_id: userId, post_id: postId } });
  if (removed.count > 0) {
    await bump(tx, target, postId, "saves_count", -1);
    return { saved: false };
  }
  const added = await tx.postSaves.createMany({ data: [{ user_id: userId, post_id: postId }], skipDuplicates: true });
  if (added.count > 0) await bump(tx, target, postId, "saves_count", 1);
  return { saved: true };
}

/** Ports add_post_comment / add_page_post_comment. */
export async function addComment(
  tx: Tx,
  userId: string,
  postId: string,
  content: string,
  parentId: string | null | undefined,
  expected?: Target
) {
  const target = await requireTarget(tx, postId, expected);
  if (parentId) {
    const parent = await tx.postComments.findUnique({ where: { id: parentId }, select: { post_id: true } });
    if (!parent || parent.post_id !== postId) throw new ApiError(400, "Parent comment not found on this post");
  }
  const comment = await tx.postComments.create({
    data: { user_id: userId, post_id: postId, content, parent_id: parentId ?? null },
  });
  await bump(tx, target, postId, "comments_count", 1);
  return comment;
}

/** Ports edit_post_comment. */
export async function editComment(tx: Tx, userId: string, commentId: string, content: string) {
  const { count } = await tx.postComments.updateMany({
    where: { id: commentId, user_id: userId },
    data: { content, edited_at: new Date() },
  });
  if (count === 0) throw new ApiError(404, "Comment not found or not yours");
  return tx.postComments.findUnique({ where: { id: commentId } });
}

/**
 * Delete your own comment and its replies. (Supabase allowed the delete through RLS but never
 * decremented comments_count and, via ON DELETE CASCADE, removed replies.)
 */
export async function deleteComment(tx: Tx, userId: string, commentId: string) {
  const comment = await tx.postComments.findUnique({ where: { id: commentId } });
  if (!comment || comment.user_id !== userId) throw new ApiError(404, "Comment not found or not yours");

  const ids = [comment.id];
  for (let frontier = [comment.id]; frontier.length; ) {
    const kids = await tx.postComments.findMany({ where: { parent_id: { in: frontier } }, select: { id: true } });
    frontier = kids.map((k) => k.id);
    ids.push(...frontier);
  }
  await tx.postComments.deleteMany({ where: { id: { in: ids } } });

  const n = ids.length;
  await tx.$executeRaw(Prisma.sql`UPDATE posts SET comments_count = GREATEST(comments_count - ${n}, 0) WHERE id = ${comment.post_id}::uuid`);
  await tx.$executeRaw(Prisma.sql`UPDATE page_posts SET comments_count = GREATEST(comments_count - ${n}, 0) WHERE id = ${comment.post_id}::uuid`);
  return { deleted: n };
}

/** Remove everything hanging off a set of posts (there are no ON DELETE CASCADE foreign keys any more). */
export async function purgePostData(tx: Tx, postIds: string[]) {
  if (!postIds.length) return;
  await tx.postLikes.deleteMany({ where: { post_id: { in: postIds } } });
  await tx.postComments.deleteMany({ where: { post_id: { in: postIds } } });
  await tx.postSaves.deleteMany({ where: { post_id: { in: postIds } } });
  await tx.pagePostUniqueViews.deleteMany({ where: { post_id: { in: postIds } } });
  await tx.postBoosts.deleteMany({ where: { post_id: { in: postIds } } });
}
