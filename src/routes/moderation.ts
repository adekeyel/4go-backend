import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler } from "@/middleware/errorHandler";

export const moderationRouter = Router();
moderationRouter.use(requireAuth);

const reportSchema = z.object({
  targetUserId: z.string().uuid().optional(),
  targetRoomId: z.string().uuid().optional(),
  targetMessageId: z.string().uuid().optional(),
  reason: z.string().min(1).max(100),
  details: z.string().max(1000).optional(),
});

moderationRouter.post(
  "/reports",
  asyncHandler(async (req, res) => {
    const body = reportSchema.parse(req.body);
    const report = await prisma.moderationReports.create({
      data: {
        reporter_id: req.userId!,
        target_user_id: body.targetUserId ?? null,
        target_room_id: body.targetRoomId ?? null,
        target_message_id: body.targetMessageId ?? null,
        reason: body.reason,
        details: body.details ?? null,
      },
    });
    res.status(201).json(report);
  })
);
