import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { Tx, creditRewardCoins } from "@/lib/coins";

export const REFERRAL_BONUS_COINS = 500;

/**
 * Ports generate_referral_code (8 upper-case hex characters). Signup used to generate lower-case
 * codes while every imported code is upper-case, so lookups below ignore case.
 */
export function generateReferralCode(): string {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

/**
 * Ports process_referral. Call it server-side while creating the new account only.
 * (In Supabase the client called it with the new user's id, which let a signed-in user claim
 * referrals for other people's accounts and collect the bonus.)
 * Unknown codes, self-referrals and already-referred users are silently ignored, so signup never fails on them.
 */
export async function processReferral(tx: Tx, rawCode: string | undefined | null, newUserId: string) {
  const code = rawCode?.trim();
  if (!code) return null;

  const referrer = await tx.profiles.findFirst({
    where: { referral_code: { equals: code, mode: "insensitive" } },
    select: { user_id: true },
  });
  if (!referrer || referrer.user_id === newUserId) return null;

  // referred_id is unique, so a second attempt inserts nothing.
  const inserted = await tx.referrals.createMany({
    data: [{ referrer_id: referrer.user_id, referred_id: newUserId, coins_rewarded: REFERRAL_BONUS_COINS }],
    skipDuplicates: true,
  });
  if (inserted.count === 0) return null;

  const referral = await tx.referrals.findUnique({ where: { referred_id: newUserId }, select: { id: true } });
  await creditRewardCoins(tx, referrer.user_id, REFERRAL_BONUS_COINS, "Referral bonus", referral?.id ?? null);
  return referrer.user_id;
}

/** Accounts created before referral codes existed get one on first request. */
export async function ensureReferralCode(userId: string): Promise<string> {
  const profile = await prisma.profiles.findUnique({ where: { user_id: userId }, select: { referral_code: true } });
  if (profile?.referral_code) return profile.referral_code;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const updated = await prisma.profiles.update({
        where: { user_id: userId },
        data: { referral_code: generateReferralCode() },
        select: { referral_code: true },
      });
      return updated.referral_code!;
    } catch (err: any) {
      if (err?.code !== "P2002") throw err; // unique collision: try another code
    }
  }
  throw new Error("Could not generate a referral code");
}
