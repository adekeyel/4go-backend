import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/middleware/errorHandler";
import { Tx, lockProfile } from "@/lib/coins";
import { recomputeProfileFlags } from "@/lib/profileFlags";
import type { VerifiedTransaction } from "@/lib/flutterwave";

/** Prices are decided here, never by the client. */
export const PRICES = {
  premium: { monthly: 2500, yearly: 24000 },
  verification: 10000,
} as const;

export type Purpose = "coins" | "premium" | "verification";
const uuid = z.string().uuid();

// ---------------------------------------------------------------- coins

/** Ports buy_coins. The unique payment_ref makes it safe to call twice (redirect + webhook). */
export async function buyCoins(userId: string, amount: number, paymentRef: string) {
  if (amount <= 0) throw new ApiError(400, "Invalid coin amount");
  const ref = paymentRef.trim();
  if (!ref) throw new ApiError(400, "Verified payment reference is required");

  return prisma.$transaction(async (tx) => {
    // INSERT ... ON CONFLICT DO NOTHING, like the SQL: only the request that inserts the row credits the coins.
    const { count } = await tx.coinPurchases.createMany({
      data: [{ user_id: userId, amount, payment_ref: ref }],
      skipDuplicates: true,
    });
    if (count === 0) return false; // already credited
    await tx.profiles.update({
      where: { user_id: userId },
      data: { coins: { increment: amount }, purchased_coins: { increment: amount } },
    });
    await tx.transactions.create({
      data: { user_id: userId, amount, source: "purchase", description: `Flutterwave coin purchase: ${ref}` },
    });
    return true;
  });
}

// ---------------------------------------------------------------- premium

/**
 * Ports activate_premium. A plan bought while one is still running stacks on top of its end date.
 * Unlike the SQL (and the earlier Express port) it is idempotent on the payment reference: verifying the
 * same payment twice used to add a second period for one payment.
 */
export async function activatePremium(userId: string, plan: "monthly" | "yearly", amountNgn: number, paymentRef: string) {
  const periodDays = plan === "monthly" ? 30 : 365;
  return prisma.$transaction(async (tx) => {
    await lockProfile(tx, userId); // serialises concurrent verify/webhook calls for this user

    const already = await tx.subscriptions.findFirst({ where: { user_id: userId, payment_ref: paymentRef }, select: { id: true } });
    if (already) return { id: already.id, created: false };

    const existing = await tx.subscriptions.findFirst({
      where: { user_id: userId, status: "active", current_period_end: { gt: new Date() } },
      orderBy: { current_period_end: "desc" },
    });
    const start = existing?.current_period_end ?? new Date();
    const end = new Date(start.getTime() + periodDays * 86_400_000);

    await tx.subscriptions.updateMany({
      where: { user_id: userId, status: "active" },
      data: { status: "expired", updated_at: new Date() },
    });
    const sub = await tx.subscriptions.create({
      data: {
        user_id: userId,
        plan,
        status: "active",
        amount_ngn: amountNgn,
        payment_ref: paymentRef,
        current_period_start: new Date(),
        current_period_end: end,
      },
    });
    await recomputeProfileFlags(tx, userId); // replaces the trigger that kept profiles.is_premium in step
    await tx.transactions.create({
      data: {
        user_id: userId,
        amount: 0,
        source: "purchase",
        description: `Premium ${plan} subscription (₦${amountNgn})`,
        reference_id: sub.id,
      },
    });
    return { id: sub.id, created: true };
  });
}

// ---------------------------------------------------------------- verification

/** Ranks that can apply (King is verified automatically by rank). */
export const VERIFICATION_ELIGIBLE_RANKS = ["Professional", "Expert", "Master"];

/** Throws if this user can't (or needn't) pay for a verification application. Used before charging. */
export async function assertCanApplyForVerification(tx: Tx | typeof prisma, userId: string) {
  const profile = await tx.profiles.findUnique({ where: { user_id: userId }, select: { rank: true } });
  if (!profile || !VERIFICATION_ELIGIBLE_RANKS.includes(profile.rank)) {
    throw new ApiError(403, "Verification requires Professional rank or higher");
  }
  const open = await tx.verificationApplications.findFirst({
    where: { user_id: userId, status: { in: ["pending", "approved"] } },
    select: { id: true },
  });
  if (open) throw new ApiError(409, "You already have a verification application in progress or approved");
}

/** Ports submit_verification_application. One transaction behind a row lock, idempotent. */
export async function submitVerificationApplication(userId: string, amountNgn: number, paymentRef: string) {
  return prisma.$transaction(async (tx) => {
    await lockProfile(tx, userId);
    const samePayment = await tx.verificationApplications.findFirst({ where: { user_id: userId, payment_ref: paymentRef }, select: { id: true } });
    if (samePayment) return samePayment.id;
    const existing = await tx.verificationApplications.findFirst({
      where: { user_id: userId, status: { in: ["pending", "approved"] } },
      orderBy: { created_at: "desc" },
    });
    if (existing) return existing.id; // idempotent: return the existing application

    const profile = await tx.profiles.findUnique({ where: { user_id: userId }, select: { rank: true } });
    if (!profile || !VERIFICATION_ELIGIBLE_RANKS.includes(profile.rank)) {
      throw new ApiError(403, "Verification requires Professional rank or higher");
    }
    const app = await tx.verificationApplications.create({
      data: { user_id: userId, amount_ngn: amountNgn, payment_ref: paymentRef, status: "pending" },
    });
    await tx.transactions.create({
      data: {
        user_id: userId,
        amount: 0,
        source: "purchase",
        description: `Verification application fee (₦${amountNgn})`,
        reference_id: app.id,
      },
    });
    return app.id;
  });
}

// ---------------------------------------------------------------- fulfilment

export type Fulfilment =
  | { purpose: "coins"; userId: string; coins: number; credited: boolean }
  | { purpose: "premium"; userId: string; plan: "monthly" | "yearly" }
  | { purpose: "verification"; userId: string; applicationId: string };

/**
 * Turn a payment that Flutterwave itself confirmed into what was bought. Used by both the signed-in
 * "verify" call and the webhook. The checks that were missing before:
 *  - the payment must belong to the account claiming it (meta.user_id and the tx_ref both name the buyer).
 *    Previously anyone could submit somebody else's transaction id and be credited with their purchase.
 *  - currency must be NGN
 *  - coins credited never exceed what was paid (₦1 = 1 coin). Previously the credited amount came from
 *    client-supplied metadata, so paying ₦1 could buy a million coins.
 */
export async function fulfillPayment(tx: VerifiedTransaction, expectedUserId?: string): Promise<Fulfilment> {
  if (!tx.successful) throw new ApiError(400, "Payment not successful");
  if (tx.currency !== "NGN") throw new ApiError(400, "Unsupported payment currency");

  const ownerId = tx.meta.user_id;
  if (!ownerId || !uuid.safeParse(ownerId).success) throw new ApiError(400, "Unrecognised payment");
  if (expectedUserId && ownerId !== expectedUserId) throw new ApiError(403, "This payment belongs to another account");

  const purpose: Purpose = tx.meta.purpose === "premium" || tx.meta.purpose === "verification" ? tx.meta.purpose : "coins";
  if (!tx.txRef.startsWith(`4go-${purpose}-${ownerId}-`)) throw new ApiError(400, "Unrecognised payment reference");

  if (purpose === "premium") {
    const plan = tx.meta.plan === "yearly" ? "yearly" : "monthly";
    if (tx.amount + 1 < PRICES.premium[plan]) throw new ApiError(400, "Underpaid for premium");
    await activatePremium(ownerId, plan, tx.amount, tx.txRef);
    return { purpose, userId: ownerId, plan };
  }

  if (purpose === "verification") {
    if (tx.amount + 1 < PRICES.verification) throw new ApiError(400, "Underpaid for verification");
    const applicationId = await submitVerificationApplication(ownerId, tx.amount, tx.txRef);
    return { purpose, userId: ownerId, applicationId };
  }

  const paid = Math.floor(tx.amount);
  const requested = Math.floor(Number(tx.meta.coin_amount) || paid);
  const coins = Math.min(requested, paid);
  const credited = await buyCoins(ownerId, coins, tx.txRef);
  return { purpose, userId: ownerId, coins, credited };
}
