import { prisma } from "@/lib/prisma";

/**
 * Premium status used to be kept right by database triggers and never expired on its own: once a
 * subscription ran out, profiles.is_premium stayed true forever (and /api/wallet and profiles kept
 * returning it). This sets it from the real subscription dates, both ways.
 */
export async function syncPremiumFlags() {
  await prisma.$executeRaw`
    UPDATE subscriptions SET status = 'expired', updated_at = now()
     WHERE status = 'active' AND current_period_end <= now()`;
  return prisma.$executeRaw`
    UPDATE profiles p
       SET is_premium = s.active
      FROM (SELECT p2.user_id,
                   EXISTS (SELECT 1 FROM subscriptions x
                            WHERE x.user_id = p2.user_id AND x.status = 'active' AND x.current_period_end > now()) AS active
              FROM profiles p2) s
     WHERE p.user_id = s.user_id AND p.is_premium IS DISTINCT FROM s.active`;
}

/** Start background upkeep. Call once at server start. */
export function startMaintenance() {
  const run = () => syncPremiumFlags().catch((e) => console.error("[maintenance] premium sync failed:", (e as Error).message));
  run();
  setInterval(run, 10 * 60_000).unref();
}
