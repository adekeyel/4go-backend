// Decides whether an ad event counts, and counts it. Each serve token (= one ad shown to one viewer for one
// video) can count one view, then at most one completion and one click, and only AFTER its view.
//
// The record of what has been counted lives in the database (video_ad_views), not in memory, so it stays
// correct across restarts and any number of server instances: the primary key makes a repeated view
// impossible, and the "only if still empty" updates make a repeated completion or click impossible, even
// when two instances handle them at the same moment.
import type { Tx } from "@/lib/coins";

export type AdEventType = "impression" | "completion" | "click";

/** One viewer can add at most this many views to the same ad per hour. Far above real watching, far below farming. */
export const MAX_VIEWS_PER_VIEWER_PER_AD_PER_HOUR = 60;
const HOUR_MS = 60 * 60 * 1000;

export interface AdEvent {
  adId: string;
  postId: string;
  nonce: string; // from the verified token
  viewerHash: string;
  type: AdEventType;
}

/** Records the event and bumps the ad's counter in the same transaction. Returns true if it was counted. */
export async function recordAdEvent(tx: Tx, e: AdEvent, now = new Date()): Promise<boolean> {
  if (e.type === "impression") {
    const recent = await tx.videoAdViews.count({
      where: { ad_id: e.adId, viewer_hash: e.viewerHash, created_at: { gt: new Date(now.getTime() - HOUR_MS) } },
    });
    if (recent >= MAX_VIEWS_PER_VIEWER_PER_AD_PER_HOUR) return false;

    // INSERT ... ON CONFLICT DO NOTHING: count is 0 if this token's view was already recorded.
    const { count } = await tx.videoAdViews.createMany({
      data: [{ nonce: e.nonce, ad_id: e.adId, post_id: e.postId, viewer_hash: e.viewerHash, created_at: now }],
      skipDuplicates: true,
    });
    if (count === 0) return false;
    await tx.videoAds.updateMany({ where: { id: e.adId }, data: { impressions: { increment: 1 } } });
    return true;
  }

  // Completion / click: a single UPDATE that only matches while the field is still empty, so it succeeds once.
  // No row at all (the view was never recorded, or was already purged) matches nothing either.
  const { count } =
    e.type === "completion"
      ? await tx.videoAdViews.updateMany({ where: { nonce: e.nonce, ad_id: e.adId, completed_at: null }, data: { completed_at: now } })
      : await tx.videoAdViews.updateMany({ where: { nonce: e.nonce, ad_id: e.adId, clicked_at: null }, data: { clicked_at: now } });
  if (count === 0) return false;
  await tx.videoAds.updateMany({
    where: { id: e.adId },
    data: e.type === "completion" ? { completions: { increment: 1 } } : { clicks: { increment: 1 } },
  });
  return true;
}

/** Delete records whose tokens can no longer be used (they expire after 2 hours; keep a day for safety). */
export async function purgeOldAdViews(tx: Pick<Tx, "videoAdViews">, now = new Date()) {
  const { count } = await tx.videoAdViews.deleteMany({ where: { created_at: { lt: new Date(now.getTime() - 24 * HOUR_MS) } } });
  return count;
}
