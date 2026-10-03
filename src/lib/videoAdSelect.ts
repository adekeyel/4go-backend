// Decides which video ads play inside one particular video. Pure functions (no database, no clock)
// so the rules can be tested on their own; the route in routes/videoAds.ts feeds it the candidates.

export interface AdCandidate {
  id: string;
  placement: string; // pre_roll | mid_roll | post_roll
  mid_roll_at_seconds: number | null;
  min_video_seconds: number;
}

/** A mid-roll must leave at least this much of the video after it, so it never lands on the very end. */
export const MID_ROLL_MIN_TAIL_SECONDS = 5;
/** Two mid-rolls in one video are kept at least this far apart, so viewers aren't hit by back-to-back ads. */
export const MID_ROLL_MIN_GAP_SECONDS = 30;

/** "Longer than N seconds" is strict: a video of exactly N seconds gets no ad. */
export const isLongEnough = (ad: Pick<AdCandidate, "min_video_seconds">, durationSeconds: number) =>
  durationSeconds > ad.min_video_seconds;

function pickOne<T>(items: T[], rng: () => number): T | null {
  if (items.length === 0) return null;
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
}

/**
 * Given every ad that is already allowed for this video's page and the current date, choose what plays:
 * at most one pre-roll, at most one post-roll, and at most one mid-roll per play time. Ads competing for the
 * same slot are rotated at random. The result is in playback order: pre-roll, mid-rolls by time, post-roll.
 */
export function selectAds<T extends AdCandidate>(
  candidates: T[],
  durationSeconds: number,
  rng: () => number = Math.random
): T[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  const eligible = candidates.filter((ad) => isLongEnough(ad, durationSeconds));

  const pre = pickOne(eligible.filter((a) => a.placement === "pre_roll"), rng);
  const post = pickOne(eligible.filter((a) => a.placement === "post_roll"), rng);

  // Mid-rolls: only where the video actually reaches that point (with room to spare), one ad per time.
  const byTime = new Map<number, T[]>();
  for (const ad of eligible) {
    const at = ad.mid_roll_at_seconds;
    if (ad.placement !== "mid_roll" || at == null) continue;
    if (at >= durationSeconds - MID_ROLL_MIN_TAIL_SECONDS) continue;
    byTime.set(at, [...(byTime.get(at) ?? []), ad]);
  }
  const mids: T[] = [];
  for (const at of [...byTime.keys()].sort((a, b) => a - b)) {
    const last = mids[mids.length - 1];
    if (last && at - (last.mid_roll_at_seconds as number) < MID_ROLL_MIN_GAP_SECONDS) continue;
    mids.push(pickOne(byTime.get(at)!, rng)!);
  }

  return [...(pre ? [pre] : []), ...mids, ...(post ? [post] : [])];
}
