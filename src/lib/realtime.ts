import { prisma } from "@/lib/prisma";
import { emitToUser } from "@/sockets";

/** Tell a user's open tabs that their own profile changed (premium, verified, coins, suspension…), so the UI refreshes without a reload. */
export function notifyProfileUpdated(userId: string, fields: Record<string, unknown> = {}) {
  emitToUser(userId, "profile:updated", { userId, ...fields });
}

/** Re-read the flags that admin actions change and push them to the user. */
export async function pushProfileFlags(userId: string) {
  const p = await prisma.profiles.findUnique({
    where: { user_id: userId },
    select: { is_premium: true, is_verified: true, is_suspended: true, is_monetized: true },
  });
  if (p) notifyProfileUpdated(userId, p);
}
