import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { createPaymentLink, verifyTransaction } from "@/lib/flutterwave";
import { PRICES, assertCanApplyForVerification, fulfillPayment } from "@/lib/payments";

export const paymentsRouter = Router();

// What the app charges, so the frontend can show it without hard-coding.
paymentsRouter.get("/prices", (_req, res) => res.json({ currency: "NGN", coins_per_naira: 1, ...PRICES }));

paymentsRouter.use(requireAuth);

const initiateSchema = z.object({
  purpose: z.enum(["coins", "premium", "verification"]).default("coins"),
  // Only used for coins (₦1 = 1 coin). Premium and verification are priced by the server.
  amount: z.number().int().min(1).max(5_000_000).optional(),
  plan: z.enum(["monthly", "yearly"]).optional(),
  redirectUrl: z.string().url().optional(),
});

const TITLES = { coins: "4GO Coins", premium: "4GO Premium", verification: "4GO Verification" } as const;

// Only send people back to our own site after paying.
function safeRedirect(url: string | undefined, fallback: string) {
  try {
    if (url && new URL(url).origin === new URL(env.siteUrl).origin) return url;
  } catch {
    /* fall through */
  }
  return fallback;
}

paymentsRouter.post(
  "/initiate",
  asyncHandler(async (req, res) => {
    const body = initiateSchema.parse(req.body);
    const userId = req.userId!;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.email) throw new ApiError(400, "An email address is required to make a payment");

    const plan = body.plan ?? "monthly";
    let amount: number;
    let description: string;
    let redirect: string;
    if (body.purpose === "premium") {
      amount = PRICES.premium[plan];
      description = `4GO Premium ${plan === "yearly" ? "Yearly" : "Monthly"} subscription`;
      redirect = `${env.siteUrl}/premium`;
    } else if (body.purpose === "verification") {
      // Check before charging: paying and then being refused (rank too low, application already open) used to cost real money.
      await assertCanApplyForVerification(prisma, userId);
      amount = PRICES.verification;
      description = "4GO Verified Identity application fee";
      redirect = `${env.siteUrl}/verification`;
    } else {
      if (!body.amount) throw new ApiError(400, "amount is required");
      amount = body.amount;
      description = `Purchase ${amount} coins`;
      redirect = `${env.siteUrl}/treasures`;
    }

    const txRef = `4go-${body.purpose}-${userId}-${Date.now()}`;
    const link = await createPaymentLink({
      txRef,
      amount,
      redirectUrl: safeRedirect(body.redirectUrl, redirect),
      email: user.email,
      title: TITLES[body.purpose],
      description,
      meta: {
        purpose: body.purpose,
        plan: body.purpose === "premium" ? plan : null,
        coin_amount: body.purpose === "coins" ? amount : null,
        user_id: userId,
      },
    });
    res.json({ link, txRef });
  })
);

// Called from the page Flutterwave sends people back to. The webhook (routes/webhooks.ts) does the
// same job if the buyer closes the browser first, and it's safe for both to run.
paymentsRouter.post(
  "/verify",
  asyncHandler(async (req, res) => {
    // Digits only: the id is placed in a URL path sent to Flutterwave.
    const { transactionId } = z.object({ transactionId: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{1,20}$/)) }).parse(req.body);

    const verified = await verifyTransaction(transactionId);
    if (!verified || !verified.successful) throw new ApiError(400, "Payment not successful");

    const result = await fulfillPayment(verified, req.userId!);
    if (result.purpose === "premium") return res.json({ success: true, purpose: result.purpose, plan: result.plan });
    if (result.purpose === "verification") return res.json({ success: true, purpose: result.purpose, applicationId: result.applicationId });
    res.json({ success: true, coins: result.coins });
  })
);
