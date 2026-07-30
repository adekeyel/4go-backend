import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";

export const walletRouter = Router();
walletRouter.use(requireAuth);

walletRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const profile = await prisma.profiles.findUnique({ where: { user_id: req.userId! } });
    if (!profile) throw new ApiError(404, "Profile not found");
    res.json({
      coins: profile.coins,
      purchased_coins: profile.purchased_coins,
      earned_coins: profile.earned_coins,
      reward_coins: profile.reward_coins,
      is_premium: profile.is_premium,
      rank: profile.rank,
    });
  })
);

walletRouter.get(
  "/transactions",
  asyncHandler(async (req, res) => {
    const transactions = await prisma.transactions.findMany({
      where: { user_id: req.userId! },
      orderBy: { created_at: "desc" },
      take: 200,
    });
    res.json(transactions);
  })
);

walletRouter.get(
  "/withdrawals",
  asyncHandler(async (req, res) => {
    const withdrawals = await prisma.withdrawals.findMany({
      where: { user_id: req.userId! },
      orderBy: { created_at: "desc" },
      take: 50,
    });
    res.json(withdrawals);
  })
);

const withdrawSchema = z.object({
  amount: z.number().int().positive(),
  bank_code: z.string().min(1),
  account_number: z.string().min(1),
  account_name: z.string().min(1),
});

// Coins <-> Naira conversion and rank-based limits, ported directly from the
// original `request_withdrawal` Postgres function so the rules stay identical
// after the migration off Supabase.
const COINS_PER_NAIRA = 2; // naira = amount / 2

walletRouter.post(
  "/withdrawals",
  asyncHandler(async (req, res) => {
    const body = withdrawSchema.parse(req.body);

    const withdrawal = await prisma.$transaction(async (tx) => {
      const profile = await tx.profiles.findUnique({ where: { user_id: req.userId! } });
      if (!profile) throw new ApiError(404, "Profile not found");
      if (!["Master", "King"].includes(profile.rank)) {
        throw new ApiError(403, "Only Master rank users can withdraw");
      }

      const isKing = profile.rank === "King";
      const withdrawable = profile.earned_coins + profile.purchased_coins;

      const activeSub = await tx.subscriptions.findFirst({
        where: { user_id: req.userId!, status: "active", current_period_end: { gt: new Date() } },
      });
      const isPremium = Boolean(activeSub);

      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const nextMonthStart = new Date(monthStart);
      nextMonthStart.setMonth(nextMonthStart.getMonth() + 1);

      const activeThisMonth = await tx.withdrawals.findFirst({
        where: {
          user_id: req.userId!,
          status: { in: ["pending", "approved", "processing", "completed", "paid", "success"] },
          created_at: { gte: monthStart, lt: nextMonthStart },
        },
      });
      if (activeThisMonth) throw new ApiError(429, "You can only make one withdrawal request per calendar month");

      const isFirstWithdrawal = !(await tx.withdrawals.findFirst({
        where: { user_id: req.userId!, status: { notIn: ["rejected", "failed"] } },
      }));

      let minCoins: number;
      let maxCoins: number;
      if (isFirstWithdrawal) {
        if (isKing) [minCoins, maxCoins] = [2000, 50000];
        else if (isPremium) [minCoins, maxCoins] = [2000, 5000];
        else [minCoins, maxCoins] = [3000, 20000];
      } else {
        if (isKing) [minCoins, maxCoins] = [20000, 5000000];
        else if (isPremium) [minCoins, maxCoins] = [20000, 1000000];
        else [minCoins, maxCoins] = [40000, 100000];
      }

      if (body.amount < minCoins) throw new ApiError(400, `Minimum withdrawal is ${minCoins} coins`);
      if (body.amount > maxCoins) throw new ApiError(400, `Maximum withdrawal is ${maxCoins} coins`);
      if (body.amount > profile.coins) throw new ApiError(400, "Insufficient coin balance");
      if (body.amount > withdrawable) {
        throw new ApiError(400, `Insufficient withdrawable balance (${withdrawable} coins available)`);
      }

      const take = Math.min(profile.earned_coins, body.amount);
      const newEarned = profile.earned_coins - take;
      const newPurchased = profile.purchased_coins - (body.amount - take);
      const naira = body.amount / COINS_PER_NAIRA;

      await tx.profiles.update({
        where: { user_id: req.userId! },
        data: { coins: { decrement: body.amount }, earned_coins: newEarned, purchased_coins: newPurchased },
      });

      const w = await tx.withdrawals.create({
        data: {
          user_id: req.userId!,
          amount: body.amount,
          naira_amount: naira,
          bank_code: body.bank_code,
          account_number: body.account_number,
          account_name: body.account_name,
          status: "pending",
        },
      });

      await tx.transactions.create({
        data: {
          user_id: req.userId!,
          amount: -body.amount,
          source: "withdrawal",
          description: `Withdrawal of ₦${naira}`,
          reference_id: w.id,
        },
      });

      return w;
    });

    res.status(201).json(withdrawal);
  })
);

// --- Daily claim, ported 1:1 from the original `claim_daily_reward` function:
// 100 coins per claim, 6-hour cooldown between claims, max 3 claims per UTC day. ---

const CLAIM_COOLDOWN_HOURS = 6;
const CLAIM_REWARD_COINS = 100;
const MAX_CLAIMS_PER_DAY = 3;

function utcDayStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

walletRouter.get(
  "/daily-claim/status",
  asyncHandler(async (req, res) => {
    const claimsToday = await prisma.dailyClaims.count({
      where: { user_id: req.userId!, claimed_at: { gte: utcDayStart() } },
    });
    const last = await prisma.dailyClaims.findFirst({
      where: { user_id: req.userId! },
      orderBy: { claimed_at: "desc" },
    });
    const nextAt = last ? new Date(last.claimed_at.getTime() + CLAIM_COOLDOWN_HOURS * 3600_000) : null;
    const canClaim = claimsToday < MAX_CLAIMS_PER_DAY && (!nextAt || nextAt <= new Date());
    res.json({ canClaim, claimsToday, maxPerDay: MAX_CLAIMS_PER_DAY, nextClaimAt: nextAt });
  })
);

walletRouter.post(
  "/daily-claim",
  asyncHandler(async (req, res) => {
    const claimsToday = await prisma.dailyClaims.count({
      where: { user_id: req.userId!, claimed_at: { gte: utcDayStart() } },
    });
    if (claimsToday >= MAX_CLAIMS_PER_DAY) {
      throw new ApiError(429, "You have already claimed 3 times today");
    }

    const last = await prisma.dailyClaims.findFirst({
      where: { user_id: req.userId! },
      orderBy: { claimed_at: "desc" },
    });
    if (last) {
      const hoursSince = (Date.now() - last.claimed_at.getTime()) / 3600_000;
      if (hoursSince < CLAIM_COOLDOWN_HOURS) {
        const nextClaimAt = new Date(last.claimed_at.getTime() + CLAIM_COOLDOWN_HOURS * 3600_000);
        throw new ApiError(429, `Please wait ${Math.ceil(CLAIM_COOLDOWN_HOURS - hoursSince)} more hour(s) before claiming again`);
      }
    }

    await prisma.$transaction([
      prisma.dailyClaims.create({ data: { user_id: req.userId! } }),
      prisma.profiles.update({
        where: { user_id: req.userId! },
        data: { reward_coins: { increment: CLAIM_REWARD_COINS }, coins: { increment: CLAIM_REWARD_COINS } },
      }),
      prisma.transactions.create({
        data: {
          user_id: req.userId!,
          amount: CLAIM_REWARD_COINS,
          source: "reward",
          description: "Daily activity reward",
        },
      }),
    ]);

    res.json({ coinsAwarded: CLAIM_REWARD_COINS });
  })
);
