import { Prisma } from "@prisma/client";
import { ApiError } from "@/middleware/errorHandler";
import { Tx, lockProfile } from "@/lib/coins";
import { isPremium } from "@/lib/social";

/**
 * Ports record_page_post_view.
 *  - every view bumps views_count; the author's own views stop there
 *  - the first view by each other user bumps unique_views_count and may pay the author:
 *      King, or Premium Master : 1 coin per unique view
 *      Master                  : 1 coin every 2nd unique view
 *  - each unique view also counts toward any active boost's reach
 */
export async function recordPageView(tx: Tx, userId: string, postId: string) {
  const post = await tx.pagePosts.findUnique({ where: { id: postId }, select: { author_id: true } });
  if (!post) throw new ApiError(404, "Post not found");

  await tx.pagePosts.update({ where: { id: postId }, data: { views_count: { increment: 1 } } });
  if (post.author_id === userId) return { self_view: true };

  // Unique index decides races: only the request that actually inserts the row continues.
  const inserted = await tx.pagePostUniqueViews.createMany({
    data: [{ post_id: postId, viewer_id: userId }],
    skipDuplicates: true,
  });
  if (inserted.count === 0) return { already_viewed: true };

  const { unique_views_count: unique } = await tx.pagePosts.update({
    where: { id: postId },
    data: { unique_views_count: { increment: 1 } },
    select: { unique_views_count: true },
  });

  const owner = await tx.profiles.findUnique({ where: { user_id: post.author_id }, select: { rank: true } });
  if (owner && (owner.rank === "Master" || owner.rank === "King")) {
    const pays = owner.rank === "King" || (await isPremium(post.author_id)) || unique % 2 === 0;
    if (pays) {
      await tx.profiles.update({
        where: { user_id: post.author_id },
        data: { coins: { increment: 1 }, earned_coins: { increment: 1 } },
      });
      await tx.transactions.create({
        data: {
          user_id: post.author_id,
          amount: 1,
          source: "earning",
          description: "Page post unique-view earning",
          reference_id: postId,
        },
      });
    }
  }

  await tx.$executeRaw(Prisma.sql`
    UPDATE post_boosts
       SET reach_count = reach_count + 1,
           status = CASE WHEN reach_count + 1 >= reach_target THEN 'completed' ELSE status END
     WHERE post_id = ${postId}::uuid AND status = 'active' AND ends_at > now()`);

  return { recorded: true, unique_views: unique };
}

export const BOOST_PLANS = {
  tier_2k: { cost: 2000, reach: 1000, hours: 5 },
  tier_4k: { cost: 4000, reach: 2500, hours: 12 },
  tier_10k: { cost: 10000, reach: 6000, hours: 24 },
  tier_20k: { cost: 20000, reach: 15000, hours: 168 },
} as const;
export type BoostPlan = keyof typeof BOOST_PLANS;

/** Ports boost_page_post. Boosts can only be paid for with purchased coins. */
export async function boostPagePost(tx: Tx, userId: string, postId: string, plan: BoostPlan) {
  const post = await tx.pagePosts.findUnique({ where: { id: postId }, select: { author_id: true } });
  if (!post) throw new ApiError(404, "Post not found");
  if (post.author_id !== userId) throw new ApiError(403, "Only the post owner can boost");

  const { cost, reach, hours } = BOOST_PLANS[plan];

  const balances = await lockProfile(tx, userId);
  if (balances.purchased_coins < cost) {
    throw new ApiError(400, `You need ${cost} purchased coins to boost. Earned and gift coins cannot be used.`);
  }

  await tx.profiles.update({
    where: { user_id: userId },
    data: { purchased_coins: { decrement: cost }, coins: { decrement: cost } },
  });

  const boost = await tx.postBoosts.create({
    data: {
      post_id: postId,
      owner_id: userId,
      plan,
      coins_spent: cost,
      reach_target: reach,
      duration_hours: hours,
      ends_at: new Date(Date.now() + hours * 3600_000),
    },
  });

  await tx.transactions.create({
    data: {
      user_id: userId,
      amount: -cost,
      source: "spend",
      description: `Boosted page post (${plan})`,
      reference_id: boost.id,
    },
  });

  return boost;
}
