import { prisma } from "@/lib/prisma";

/** Ports `is_blocked_between`. */
export async function isBlockedBetween(a: string, b: string): Promise<boolean> {
  return Boolean(
    await prisma.userBlocks.findFirst({
      where: {
        OR: [
          { blocker_id: a, blocked_id: b },
          { blocker_id: b, blocked_id: a },
        ],
      },
      select: { id: true },
    })
  );
}

/** Ports `is_premium`: an active subscription that hasn't expired. */
export async function isPremium(userId: string): Promise<boolean> {
  return Boolean(
    await prisma.subscriptions.findFirst({
      where: { user_id: userId, status: "active", current_period_end: { gt: new Date() } },
      select: { id: true },
    })
  );
}

/** Ports `are_friends`. */
export async function areFriends(a: string, b: string): Promise<boolean> {
  return Boolean(
    await prisma.friends.findFirst({
      where: {
        status: "accepted",
        OR: [
          { requester_id: a, addressee_id: b },
          { requester_id: b, addressee_id: a },
        ],
      },
      select: { id: true },
    })
  );
}
