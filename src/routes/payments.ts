import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";

export const paymentsRouter = Router();
paymentsRouter.use(requireAuth);

const initiateSchema = z.object({
  amount: z.number().positive(),
  purpose: z.enum(["coins", "premium", "verification"]).default("coins"),
  plan: z.enum(["monthly", "yearly"]).optional(),
  coinAmount: z.number().int().positive().optional(),
  redirectUrl: z.string().url().optional(),
});

const TITLES: Record<string, string> = {
  coins: "4GO Coins",
  premium: "4GO Premium",
  verification: "4GO Verification",
};

paymentsRouter.post(
  "/initiate",
  asyncHandler(async (req, res) => {
    const body = initiateSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.userId! } });
    if (!user?.email) throw new ApiError(400, "An email address is required to make a payment");

    const txRef = `4go-${body.purpose}-${req.userId}-${Date.now()}`;
    const defaultRedirect: Record<string, string> = {
      coins: `${env.siteUrl}/treasures`,
      premium: `${env.siteUrl}/premium`,
      verification: `${env.siteUrl}/verification`,
    };
    const descriptions: Record<string, string> = {
      coins: `Purchase ${body.coinAmount ?? body.amount} coins`,
      premium: `4GO Premium ${body.plan === "yearly" ? "Yearly" : "Monthly"} subscription`,
      verification: "4GO Verified Identity application fee",
    };

    const response = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.flutterwave.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tx_ref: txRef,
        amount: body.amount,
        currency: "NGN",
        redirect_url: body.redirectUrl || defaultRedirect[body.purpose],
        customer: { email: user.email },
        customizations: {
          title: TITLES[body.purpose],
          description: descriptions[body.purpose],
          logo: `${env.siteUrl}/icons/icon-192.png`,
        },
        meta: {
          purpose: body.purpose,
          plan: body.plan ?? null,
          coin_amount: body.coinAmount ?? null,
          user_id: req.userId,
        },
      }),
    });

    const data = (await response.json()) as { status: string; data?: { link: string } };
    if (data.status !== "success" || !data.data?.link) {
      throw new ApiError(502, "Payment provider error");
    }
    res.json({ link: data.data.link, txRef });
  })
);

const verifySchema = z.object({ transactionId: z.string() });

interface FlutterwaveVerifyResponse {
  status: string;
  data: {
    status: string;
    amount: number;
    tx_ref: string;
    meta?: { purpose?: string; plan?: string; coin_amount?: number };
  };
}

paymentsRouter.post(
  "/verify",
  asyncHandler(async (req, res) => {
    const { transactionId } = verifySchema.parse(req.body);
    const userId = req.userId!;

    const response = await fetch(`https://api.flutterwave.com/v3/transactions/${transactionId}/verify`, {
      headers: { Authorization: `Bearer ${env.flutterwave.secretKey}` },
    });
    const data = (await response.json()) as FlutterwaveVerifyResponse;

    if (data.status !== "success" || data.data.status !== "successful") {
      throw new ApiError(400, "Payment not successful");
    }

    const meta = data.data.meta ?? {};
    const purpose: "coins" | "premium" | "verification" =
      meta.purpose === "premium" || meta.purpose === "verification" ? meta.purpose : "coins";
    const paidAmount = Number(data.data.amount) || 0;
    const txRef = data.data.tx_ref || String(transactionId);

    if (purpose === "premium") {
      const plan = meta.plan === "yearly" ? "yearly" : "monthly";
      const expected = plan === "yearly" ? 24000 : 2500;
      if (paidAmount + 1 < expected) throw new ApiError(400, "Underpaid for premium");

      await activatePremium(userId, plan, paidAmount, txRef);
      return res.json({ success: true, purpose, plan });
    }

    if (purpose === "verification") {
      const expected = 10000;
      if (paidAmount + 1 < expected) throw new ApiError(400, "Underpaid for verification");
      const applicationId = await submitVerificationApplication(userId, paidAmount, txRef);
      return res.json({ success: true, purpose, applicationId });
    }

    const coinAmount = Math.floor(meta.coin_amount || paidAmount);
    await buyCoins(userId, coinAmount, txRef);
    res.json({ success: true, coins: coinAmount });
  })
);

// --- Ported 1:1 from the original Postgres functions so behavior (idempotency,
// rank gates, transaction bookkeeping) matches exactly. ---

async function buyCoins(userId: string, amount: number, paymentRef: string) {
  if (amount <= 0) throw new ApiError(400, "Invalid coin amount");
  const ref = paymentRef.trim();
  if (!ref) throw new ApiError(400, "Verified payment reference is required");

  await prisma.$transaction(async (tx) => {
    const existing = await tx.coinPurchases.findUnique({ where: { payment_ref: ref } });
    if (existing) return; // already credited (webhook/verify called twice) — idempotent no-op

    await tx.coinPurchases.create({ data: { user_id: userId, amount, payment_ref: ref } });
    await tx.profiles.update({
      where: { user_id: userId },
      data: { coins: { increment: amount }, purchased_coins: { increment: amount } },
    });
    await tx.transactions.create({
      data: { user_id: userId, amount, source: "purchase", description: `Flutterwave coin purchase: ${ref}` },
    });
  });
}

async function activatePremium(userId: string, plan: "monthly" | "yearly", amountNgn: number, paymentRef: string) {
  const periodDays = plan === "monthly" ? 30 : 365;

  await prisma.$transaction(async (tx) => {
    const existingActive = await tx.subscriptions.findFirst({
      where: { user_id: userId, status: "active", current_period_end: { gt: new Date() } },
      orderBy: { current_period_end: "desc" },
    });
    const start = existingActive?.current_period_end ?? new Date();
    const end = new Date(start.getTime() + periodDays * 86_400_000);

    await tx.subscriptions.updateMany({ where: { user_id: userId, status: "active" }, data: { status: "expired" } });

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

    await tx.profiles.update({ where: { user_id: userId }, data: { is_premium: true } });

    await tx.transactions.create({
      data: {
        user_id: userId,
        amount: 0,
        source: "purchase",
        description: `Premium ${plan} subscription (₦${amountNgn})`,
        reference_id: sub.id,
      },
    });

    return sub.id;
  });
}

async function submitVerificationApplication(userId: string, amountNgn: number, paymentRef: string) {
  const profile = await prisma.profiles.findUnique({ where: { user_id: userId } });
  if (!profile || !["Professional", "Expert", "Master"].includes(profile.rank)) {
    throw new ApiError(403, "Verification requires Professional rank or higher");
  }

  const existing = await prisma.verificationApplications.findFirst({
    where: { user_id: userId, status: { in: ["pending", "approved"] } },
    orderBy: { created_at: "desc" },
  });
  if (existing) return existing.id; // idempotent: return the existing application

  return prisma.$transaction(async (tx) => {
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
