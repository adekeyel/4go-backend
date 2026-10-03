import { Prisma } from "@prisma/client";
import { Tx } from "@/lib/coins";

/**
 * Ports `recompute_profile_flags` (run by database triggers whenever a subscription or a
 * verification application changed). Call it after you change either:
 *   is_premium  = has an active, unexpired subscription
 *   is_verified = King rank, or an approved verification application, or already verified.
 *
 * Verified is deliberately one-way here: an admin can hand-verify someone (no application row), and the old
 * recompute would silently un-verify them the next time any subscription changed. Removing the badge is an
 * explicit admin action (POST /api/admin/users/:id/verified { enabled: false }).
 */
export async function recomputeProfileFlags(tx: Tx, userId: string) {
  await tx.$executeRaw(Prisma.sql`
    UPDATE profiles
       SET is_premium = EXISTS (
             SELECT 1 FROM subscriptions s
              WHERE s.user_id = ${userId}::uuid AND s.status = 'active' AND s.current_period_end > now()),
           is_verified = (
             is_verified
             OR rank = 'King'
             OR EXISTS (
               SELECT 1 FROM verification_applications v
                WHERE v.user_id = ${userId}::uuid AND v.status = 'approved' AND v.is_verified = true))
     WHERE user_id = ${userId}::uuid`);
}
