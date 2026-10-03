import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { lockProfile, creditRewardCoins } from "@/lib/coins";
import { isPremium as userIsPremium } from "@/lib/social";
import { sendGift, spendCoinsForProgress } from "@/lib/economy";

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
      is_premium: await userIsPremium(req.userId!), // from the subscription dates, so it flips off when a plan runs out
      rank: profile.rank,
    });
  })
);

// Active premium subscription (replaces the direct subscriptions table read).
walletRouter.get(
  "/subscription",
  asyncHandler(async (req, res) => {
    const sub = await prisma.subscriptions.findFirst({
      where: { user_id: req.userId!, status: "active" },
      orderBy: { current_period_end: "desc" },
      select: { plan: true, status: true, current_period_end: true },
    });
    res.json(sub && sub.current_period_end > new Date() ? sub : null);
  })
);

// Latest verification application for the current user.
walletRouter.get(
  "/verification",
  asyncHandler(async (req, res) => {
    const app = await prisma.verificationApplications.findFirst({
      where: { user_id: req.userId! },
      orderBy: { created_at: "desc" },
    });
    res.json(app);
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
      // Row lock (the SQL used FOR UPDATE) so two parallel requests can't both pass the balance checks.
      await lockProfile(tx, req.userId!);
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

      // Calendar month in UTC, like the SQL's date_trunc('month', now()); server time zone must not matter.
      const nowUtc = new Date();
      const monthStart = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), 1));
      const nextMonthStart = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth() + 1, 1));

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
    res.json({
      canClaim, claimsToday, maxPerDay: MAX_CLAIMS_PER_DAY, nextClaimAt: nextAt,
      // same values under the names the old claim RPC used
      can_claim: canClaim, claims_today: claimsToday, max_per_day: MAX_CLAIMS_PER_DAY, next_claim_at: nextAt,
    });
  })
);

walletRouter.post(
  "/daily-claim",
  asyncHandler(async (req, res) => {
    // Checks and the credit share one transaction behind a row lock, so firing
    // several claim requests in parallel can't bypass the cooldown or daily cap.
    const claimId = await prisma.$transaction(async (tx) => {
      await lockProfile(tx, req.userId!);

      const claimsToday = await tx.dailyClaims.count({
        where: { user_id: req.userId!, claimed_at: { gte: utcDayStart() } },
      });
      if (claimsToday >= MAX_CLAIMS_PER_DAY) {
        throw new ApiError(429, "You have already claimed 3 times today");
      }

      const last = await tx.dailyClaims.findFirst({
        where: { user_id: req.userId! },
        orderBy: { claimed_at: "desc" },
      });
      if (last) {
        const hoursSince = (Date.now() - last.claimed_at.getTime()) / 3600_000;
        if (hoursSince < CLAIM_COOLDOWN_HOURS) {
          throw new ApiError(429, `Please wait ${Math.ceil(CLAIM_COOLDOWN_HOURS - hoursSince)} more hour(s) before claiming again`);
        }
      }

      const claim = await tx.dailyClaims.create({ data: { user_id: req.userId! } });
      await creditRewardCoins(tx, req.userId!, CLAIM_REWARD_COINS, "Daily activity reward", claim.id);
      return claim.id;
    });

    // coins_awarded is the name the old RPC result used, so existing UI code keeps working.
    res.json({ coinsAwarded: CLAIM_REWARD_COINS, coins_awarded: CLAIM_REWARD_COINS, claimId });
  })
);

// The two optional "visit our sponsor" boosts after a claim (+100 each). The page used to credit these itself
// through a client-callable credit function, so anyone could mint coins. Now the server decides:
//   stage 1 is allowed once per claim, stage 2 only after stage 1, both only on your latest claim and
//   only within 15 minutes of it. A repeated request is a no-op that reports alreadyGranted.
const BOOST_COINS = 100;
const BOOST_WINDOW_MS = 15 * 60_000;
walletRouter.post(
  "/daily-claim/boost",
  asyncHandler(async (req, res) => {
    const { stage } = z.object({ stage: z.union([z.literal(1), z.literal(2)]) }).parse(req.body);
    const result = await prisma.$transaction(async (tx) => {
      await lockProfile(tx, req.userId!);
      const claim = await tx.dailyClaims.findFirst({ where: { user_id: req.userId! }, orderBy: { claimed_at: "desc" } });
      if (!claim || Date.now() - claim.claimed_at.getTime() > BOOST_WINDOW_MS) throw new ApiError(409, "No recent claim to boost");

      const label = (n: number) => `Sponsor boost reward (stage ${n})`;
      const done = async (n: number) =>
        (await tx.transactions.count({ where: { user_id: req.userId!, reference_id: claim.id, description: label(n) } })) > 0;

      if (await done(stage)) return { alreadyGranted: true, coinsAwarded: 0 };
      if (stage === 2 && !(await done(1))) throw new ApiError(409, "Complete the first boost before the final one");
      await creditRewardCoins(tx, req.userId!, BOOST_COINS, label(stage), claim.id);
      return { alreadyGranted: false, coinsAwarded: BOOST_COINS };
    });
    res.json(result);
  })
);

// --- Treasures, gifts and level-up (ports of send_gift, send_gift_to_post, spend_coins_for_progress) ---

walletRouter.get(
  "/treasures",
  asyncHandler(async (_req, res) => {
    res.json(await prisma.treasures.findMany({ orderBy: { sort_order: "asc" } }));
  })
);

// Gifts you've sent and received (ports the "view own gifts" policy), newest first.
walletRouter.get(
  "/gifts",
  asyncHandler(async (req, res) => {
    const me = req.userId!;
    const direction = req.query.direction === "sent" || req.query.direction === "received" ? req.query.direction : "all";
    const gifts = await prisma.giftTransactions.findMany({
      where:
        direction === "sent"
          ? { sender_id: me }
          : direction === "received"
            ? { receiver_id: me }
            : { OR: [{ sender_id: me }, { receiver_id: me }] },
      orderBy: { created_at: "desc" },
      take: 100,
    });
    const userIds = [...new Set(gifts.flatMap((g) => [g.sender_id, g.receiver_id]))];
    const treasureIds = [...new Set(gifts.map((g) => g.treasure_id))];
    const [profiles, treasures] = await Promise.all([
      userIds.length
        ? prisma.profiles.findMany({
            where: { user_id: { in: userIds } },
            select: { user_id: true, username: true, display_name: true, avatar_url: true },
          })
        : [],
      treasureIds.length ? prisma.treasures.findMany({ where: { id: { in: treasureIds } } }) : [],
    ]);
    const profileMap = new Map(profiles.map((p) => [p.user_id, p]));
    const treasureMap = new Map(treasures.map((t) => [t.id, t]));
    res.json(
      gifts.map((g) => ({
        ...g,
        direction: g.sender_id === me ? "sent" : "received",
        sender: profileMap.get(g.sender_id) ?? null,
        receiver: profileMap.get(g.receiver_id) ?? null,
        treasure: treasureMap.get(g.treasure_id) ?? null,
      }))
    );
  })
);

const giftSchema = z.object({
  receiver_id: z.string().uuid(),
  treasure_id: z.string().uuid(),
  room_id: z.string().uuid().nullish(),
});

// Gift a user from a room. Receiver gets spendable reward coins.
walletRouter.post(
  "/gifts",
  asyncHandler(async (req, res) => {
    const body = giftSchema.parse(req.body);
    const result = await prisma.$transaction((tx) =>
      sendGift(tx, {
        senderId: req.userId!,
        receiverId: body.receiver_id,
        treasureId: body.treasure_id,
        roomId: body.room_id,
      })
    );
    res.status(201).json(result);
  })
);

const postGiftSchema = giftSchema.extend({ message_id: z.string().uuid() });

// Gift on a post. Receiver must be monetized; coins land in their withdrawable balance.
walletRouter.post(
  "/gifts/post",
  asyncHandler(async (req, res) => {
    const body = postGiftSchema.parse(req.body);
    const result = await prisma.$transaction((tx) =>
      sendGift(tx, {
        senderId: req.userId!,
        receiverId: body.receiver_id,
        treasureId: body.treasure_id,
        roomId: body.room_id,
        messageId: body.message_id,
      })
    );
    res.status(201).json(result);
  })
);

const levelUpSchema = z.object({ amount: z.number().int().optional() });

// Spend coins for online minutes (10,000 coins = 300 minutes; multiples of 5,000).
walletRouter.post(
  "/level-up",
  asyncHandler(async (req, res) => {
    const { amount } = levelUpSchema.parse(req.body ?? {});
    const result = await prisma.$transaction((tx) => spendCoinsForProgress(tx, req.userId!, amount));
    res.json(result);
  })
);
