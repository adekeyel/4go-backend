import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireSuperAdmin } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { emitToUser } from "@/sockets";

export const adminRouter = Router();
adminRouter.use(requireAuth, requireSuperAdmin);

adminRouter.get(
  "/users",
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const users = await prisma.profiles.findMany({
      where: q
        ? { OR: [{ username: { contains: q, mode: "insensitive" } }, { display_name: { contains: q, mode: "insensitive" } }] }
        : {},
      orderBy: { created_at: "desc" },
      take: 200,
    });
    res.json(users);
  })
);

const suspendSchema = z.object({ reason: z.string().min(1).max(300) });

adminRouter.post(
  "/users/:userId/suspend",
  asyncHandler(async (req, res) => {
    const { reason } = suspendSchema.parse(req.body);
    await prisma.profiles.update({
      where: { user_id: req.params.userId },
      data: { is_suspended: true, suspended_at: new Date(), suspended_reason: reason },
    });
    await prisma.refreshSession.updateMany({
      where: { user_id: req.params.userId, revoked_at: null },
      data: { revoked_at: new Date() },
    });
    emitToUser(req.params.userId, "account:suspended", { reason });
    res.status(204).send();
  })
);

adminRouter.post(
  "/users/:userId/unsuspend",
  asyncHandler(async (req, res) => {
    await prisma.profiles.update({
      where: { user_id: req.params.userId },
      data: { is_suspended: false, suspended_at: null, suspended_reason: null },
    });
    res.status(204).send();
  })
);

adminRouter.delete(
  "/users/:userId",
  asyncHandler(async (req, res) => {
    // Cascades via FK onDelete: Cascade from users -> profiles/refresh_sessions;
    // other tables reference user_id as a plain scalar (no FK), so related rows
    // (posts, messages, etc.) are intentionally left in place for moderation history.
    await prisma.user.delete({ where: { id: req.params.userId } });
    res.status(204).send();
  })
);

adminRouter.get(
  "/reports",
  asyncHandler(async (req, res) => {
    const reports = await prisma.moderationReports.findMany({
      orderBy: { created_at: "desc" },
      take: 200,
    });
    res.json(reports);
  })
);

const resolveReportSchema = z.object({ status: z.enum(["resolved", "dismissed"]) });

adminRouter.patch(
  "/reports/:id",
  asyncHandler(async (req, res) => {
    const { status } = resolveReportSchema.parse(req.body);
    const report = await prisma.moderationReports.update({ where: { id: req.params.id }, data: { status } });
    res.json(report);
  })
);

adminRouter.get(
  "/withdrawals",
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : "pending";
    const withdrawals = await prisma.withdrawals.findMany({ where: { status }, orderBy: { created_at: "desc" } });
    res.json(withdrawals);
  })
);

const withdrawalDecisionSchema = z.object({ decision: z.enum(["approve", "reject"]) });

adminRouter.patch(
  "/withdrawals/:id",
  asyncHandler(async (req, res) => {
    const { decision } = withdrawalDecisionSchema.parse(req.body);
    const withdrawal = await prisma.withdrawals.findUnique({ where: { id: req.params.id } });
    if (!withdrawal) throw new ApiError(404, "Withdrawal not found");

    if (decision === "reject") {
      // Refund the reserved coins back to the user.
      await prisma.$transaction([
        prisma.withdrawals.update({ where: { id: withdrawal.id }, data: { status: "rejected", processed_at: new Date() } }),
        prisma.profiles.update({
          where: { user_id: withdrawal.user_id },
          data: { coins: { increment: withdrawal.amount }, earned_coins: { increment: withdrawal.amount } },
        }),
      ]);
    } else {
      await prisma.withdrawals.update({
        where: { id: withdrawal.id },
        data: { status: "approved", processed_at: new Date() },
      });
    }
    res.json({ status: decision === "approve" ? "approved" : "rejected" });
  })
);
