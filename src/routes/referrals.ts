import { Router } from "express";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler } from "@/middleware/errorHandler";
import { REFERRAL_BONUS_COINS, ensureReferralCode } from "@/lib/referrals";

export const referralsRouter = Router();
referralsRouter.use(requireAuth);

// Your referral code, how many people you've referred, and who they are (newest first).
// Referrals are created at signup (POST /api/auth/signup with `referralCode`), never through this router.
referralsRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const [code, referrals] = await Promise.all([
      ensureReferralCode(userId),
      prisma.referrals.findMany({ where: { referrer_id: userId }, orderBy: { created_at: "desc" }, take: 100 }),
    ]);
    const total = await prisma.referrals.count({ where: { referrer_id: userId } });
    const profiles = referrals.length
      ? await prisma.profiles.findMany({
          where: { user_id: { in: referrals.map((r) => r.referred_id) } },
          select: { user_id: true, username: true, display_name: true, avatar_url: true },
        })
      : [];
    const byId = new Map(profiles.map((p) => [p.user_id, p]));
    res.json({
      code,
      bonus_per_referral: REFERRAL_BONUS_COINS,
      total,
      referrals: referrals.map((r) => ({
        id: r.id,
        created_at: r.created_at,
        coins_rewarded: r.coins_rewarded,
        referred: byId.get(r.referred_id) ?? null,
      })),
    });
  })
);

// Were you referred by someone? (Ports the "view own referral entry" policy.)
referralsRouter.get(
  "/referred-by",
  asyncHandler(async (req, res) => {
    const entry = await prisma.referrals.findUnique({ where: { referred_id: req.userId! } });
    if (!entry) return res.json(null);
    const referrer = await prisma.profiles.findUnique({
      where: { user_id: entry.referrer_id },
      select: { user_id: true, username: true, display_name: true, avatar_url: true },
    });
    res.json({ created_at: entry.created_at, referrer });
  })
);
