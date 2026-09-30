import { Prisma } from "@prisma/client";
import { ApiError } from "@/middleware/errorHandler";

/** Prisma interactive-transaction client. All helpers here must run inside prisma.$transaction. */
export type Tx = Prisma.TransactionClient;

type Balances = {
  coins: number;
  reward_coins: number;
  purchased_coins: number;
  earned_coins: number;
};

/**
 * SELECT ... FOR UPDATE on one profile row. Ports the row locking the original
 * plpgsql functions relied on (debit_user_coins, request_withdrawal, spend_coins_for_progress),
 * so concurrent requests can't spend or withdraw the same coins twice.
 */
export async function lockProfile(tx: Tx, userId: string): Promise<Balances> {
  const rows = await tx.$queryRaw<Balances[]>`
    SELECT coins,
           COALESCE(reward_coins, 0)    AS reward_coins,
           COALESCE(purchased_coins, 0) AS purchased_coins,
           COALESCE(earned_coins, 0)    AS earned_coins
    FROM profiles
    WHERE user_id = ${userId}::uuid
    FOR UPDATE`;
  if (!rows[0]) throw new ApiError(404, "Profile not found");
  return rows[0];
}

/**
 * Lock several profiles in a fixed (sorted) order. Two users gifting each other
 * at the same time would otherwise deadlock (A locks A then B, B locks B then A).
 */
export async function lockProfiles(tx: Tx, userIds: string[]): Promise<void> {
  const ids = [...new Set(userIds)].sort();
  await tx.$queryRaw`
    SELECT user_id FROM profiles
    WHERE user_id = ANY(${ids}::uuid[])
    ORDER BY user_id
    FOR UPDATE`;
}

/**
 * Ports `debit_user_coins` + the `coins = coins - amount` step every caller did.
 * Spend order is fixed: reward coins first, then earned, then purchased.
 */
export async function spendCoins(tx: Tx, userId: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  const b = await lockProfile(tx, userId);
  if (b.coins < amount) throw new ApiError(400, "Insufficient coins");

  let remaining = amount;
  const takeFrom = (bucket: number) => {
    const take = Math.min(bucket, remaining);
    remaining -= take;
    return bucket - take;
  };
  const reward = takeFrom(b.reward_coins);
  const earned = takeFrom(b.earned_coins);
  const purchased = takeFrom(b.purchased_coins);
  if (remaining > 0) throw new ApiError(400, "Insufficient bucket balance");

  await tx.profiles.update({
    where: { user_id: userId },
    data: {
      coins: { decrement: amount },
      reward_coins: reward,
      earned_coins: earned,
      purchased_coins: purchased,
    },
  });
}

/** Ports `credit_reward_coins`. Reward coins are spendable but not withdrawable. */
export async function creditRewardCoins(tx: Tx, userId: string, amount: number, description = "Reward") {
  if (amount <= 0) return;
  await tx.profiles.update({
    where: { user_id: userId },
    data: { coins: { increment: amount }, reward_coins: { increment: amount } },
  });
  await tx.transactions.create({
    data: { user_id: userId, amount, source: "reward", description },
  });
}

/** Ports `refund_earned_coins`. Refunded coins go back into the withdrawable earned bucket. */
export async function refundEarnedCoins(tx: Tx, userId: string, amount: number, description = "Withdrawal refund") {
  if (amount <= 0) return;
  await tx.profiles.update({
    where: { user_id: userId },
    data: { coins: { increment: amount }, earned_coins: { increment: amount } },
  });
  await tx.transactions.create({
    data: { user_id: userId, amount, source: "earning", description },
  });
}
