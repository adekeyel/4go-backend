import { prisma } from "@/lib/prisma";
import { Tx } from "@/lib/coins";

/** Ports `calculate_rank`. Thresholds are total online minutes. */
export function calculateRank(minutes: number): string {
  if (minutes >= 120000) return "King";
  if (minutes >= 60000) return "Master";
  if (minutes >= 26400) return "Expert";
  if (minutes >= 7200) return "Professional";
  if (minutes >= 900) return "Learner";
  if (minutes >= 120) return "Novice";
  return "Amateur";
}

/**
 * Ports the latest `increment_online_minutes` (Supabase migration 20260815161714).
 * Adds minutes, then recomputes rank, is_monetized and is_verified:
 *  - monetized = Master/King rank, OR owns a room with 1000+ members, OR was granted manually
 *  - verified  = already verified, OR King rank
 */
export async function incrementOnlineMinutes(tx: Tx, userId: string, minutes = 1) {
  const updated = await tx.profiles.update({
    where: { user_id: userId },
    data: { total_online_minutes: { increment: minutes } },
    select: { total_online_minutes: true, manual_monetized: true, is_verified: true },
  });

  const rank = calculateRank(updated.total_online_minutes);

  // Only look at rooms this user created (index on created_by), rather than
  // counting members across every room in the table on each heartbeat.
  const [{ ok }] = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM rooms r
      WHERE r.created_by = ${userId}::uuid
        AND (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) >= 1000
    ) AS ok`;

  return tx.profiles.update({
    where: { user_id: userId },
    data: {
      rank,
      is_monetized: rank === "Master" || rank === "King" || ok || updated.manual_monetized,
      is_verified: updated.is_verified || rank === "King",
    },
    select: { rank: true, total_online_minutes: true, is_monetized: true, is_verified: true },
  });
}

/** Convenience wrapper for callers that aren't already inside a transaction. */
export function addOnlineMinutes(userId: string, minutes: number) {
  return prisma.$transaction((tx) => incrementOnlineMinutes(tx, userId, minutes));
}
