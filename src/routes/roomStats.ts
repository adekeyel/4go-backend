import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler } from "@/middleware/errorHandler";

// Ports get_room_member_counts. Mounted at /api/rooms/member-counts (before the rooms router so it isn't read as a room id).
export const roomStatsRouter = Router();

roomStatsRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { room_ids } = z.object({ room_ids: z.array(z.string().uuid()).max(200) }).parse(req.body);
    if (!room_ids.length) return res.json([]);
    const counts = await prisma.roomMembers.groupBy({ by: ["room_id"], where: { room_id: { in: room_ids } }, _count: { _all: true } });
    res.json(counts.map((c) => ({ room_id: c.room_id, member_count: c._count._all })));
  })
);
