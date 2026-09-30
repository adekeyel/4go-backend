import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { isSuperAdmin } from "@/lib/roles";
import { creditRewardCoins } from "@/lib/coins";
import { logAdminAction } from "@/lib/audit";
import { recomputeProfileFlags } from "@/lib/profileFlags";

export const verificationRouter = Router();
verificationRouter.use(requireAuth);

const uuid = z.string().uuid();
const reviewSchema = z.object({ notes: z.string().max(1000).optional() });

async function requireAdmin(userId: string) {
  if (!(await isSuperAdmin(userId))) throw new ApiError(403, "Only admins can review verifications");
}

// Your own applications, newest first. Applications are created by the payment flow
// (POST /api/payments/verify with purpose "verification"), not here.
verificationRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    res.json(
      await prisma.verificationApplications.findMany({
        where: { user_id: req.userId! },
        orderBy: { created_at: "desc" },
      })
    );
  })
);

verificationRouter.get(
  "/admin/applications",
  asyncHandler(async (req, res) => {
    await requireAdmin(req.userId!);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const apps = await prisma.verificationApplications.findMany({
      where: status ? { status } : {},
      orderBy: { created_at: "desc" },
      take: limit,
      skip: offset,
    });
    const ids = [...new Set(apps.map((a) => a.user_id))];
    const profiles = ids.length
      ? await prisma.profiles.findMany({
          where: { user_id: { in: ids } },
          select: { user_id: true, username: true, display_name: true, avatar_url: true, rank: true, is_verified: true },
        })
      : [];
    const byId = new Map(profiles.map((p) => [p.user_id, p]));
    res.json(apps.map((a) => ({ ...a, profile: byId.get(a.user_id) ?? null })));
  })
);

// Ports approve_verification. Only pending applications can be approved (the SQL silently did
// nothing otherwise; this answers 409).
verificationRouter.post(
  "/admin/:applicationId/approve",
  asyncHandler(async (req, res) => {
    await requireAdmin(req.userId!);
    const id = uuid.parse(req.params.applicationId);
    const { notes } = reviewSchema.parse(req.body ?? {});
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.verificationApplications.updateMany({
        where: { id, status: "pending" },
        data: {
          status: "approved",
          is_verified: true,
          reviewed_at: new Date(),
          reviewed_by: req.userId!,
          review_notes: notes ?? null,
          updated_at: new Date(),
        },
      });
      if (count === 0) throw new ApiError(409, "Application not found or not pending");
      const app = await tx.verificationApplications.findUniqueOrThrow({ where: { id } });
      await recomputeProfileFlags(tx, app.user_id); // sets profiles.is_verified
      await logAdminAction(tx, req.userId!, "verification_approved", app.user_id, null, { application_id: id });
    });
    res.json({ approved: true });
  })
);

// Ports reject_verification. The fee was paid in naira, so a rejection refunds it as reward coins
// at ₦1 = 2 coins. (The SQL added them to `coins` only, leaving the coin buckets out of step, which
// later broke spending with "Insufficient bucket balance"; they now go through the reward bucket.)
verificationRouter.post(
  "/admin/:applicationId/reject",
  asyncHandler(async (req, res) => {
    await requireAdmin(req.userId!);
    const id = uuid.parse(req.params.applicationId);
    const { notes } = reviewSchema.parse(req.body ?? {});
    const refund = await prisma.$transaction(async (tx) => {
      const { count } = await tx.verificationApplications.updateMany({
        where: { id, status: "pending" },
        data: {
          status: "rejected",
          is_verified: false,
          reviewed_at: new Date(),
          reviewed_by: req.userId!,
          review_notes: notes ?? null,
          updated_at: new Date(),
        },
      });
      if (count === 0) throw new ApiError(409, "Application not found or not pending");
      const app = await tx.verificationApplications.findUniqueOrThrow({ where: { id } });

      const coins = Math.round(Number(app.amount_ngn) * 2);
      await creditRewardCoins(tx, app.user_id, coins, "Verification fee refunded", id);
      await recomputeProfileFlags(tx, app.user_id);
      await logAdminAction(tx, req.userId!, "verification_rejected", app.user_id, null, {
        application_id: id,
        refunded_coins: coins,
      });
      return coins;
    });
    res.json({ rejected: true, refunded_coins: refund });
  })
);
