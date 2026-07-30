import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { emitToUser } from "@/sockets";

export const friendsRouter = Router();
friendsRouter.use(requireAuth);

friendsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const rows = await prisma.friends.findMany({
      where: {
        status: "accepted",
        OR: [{ requester_id: userId }, { addressee_id: userId }],
      },
    });
    const otherIds = rows.map((r) => (r.requester_id === userId ? r.addressee_id : r.requester_id));
    const profiles = otherIds.length
      ? await prisma.profiles.findMany({
          where: { user_id: { in: otherIds } },
          select: { user_id: true, username: true, display_name: true, avatar_url: true, is_online: true },
        })
      : [];
    res.json(profiles);
  })
);

friendsRouter.get(
  "/requests",
  asyncHandler(async (req, res) => {
    const rows = await prisma.friends.findMany({
      where: { addressee_id: req.userId!, status: "pending" },
      orderBy: { created_at: "desc" },
    });
    const ids = rows.map((r) => r.requester_id);
    const profiles = ids.length
      ? await prisma.profiles.findMany({
          where: { user_id: { in: ids } },
          select: { user_id: true, username: true, display_name: true, avatar_url: true },
        })
      : [];
    const profileMap = new Map(profiles.map((p) => [p.user_id, p]));
    res.json(rows.map((r) => ({ ...r, profile: profileMap.get(r.requester_id) })));
  })
);

const sendRequestSchema = z.object({ addresseeId: z.string().uuid() });

friendsRouter.post(
  "/requests",
  asyncHandler(async (req, res) => {
    const { addresseeId } = sendRequestSchema.parse(req.body);
    const userId = req.userId!;
    if (addresseeId === userId) throw new ApiError(400, "Can't friend yourself");

    const blocked = await prisma.userBlocks.findFirst({
      where: {
        OR: [
          { blocker_id: userId, blocked_id: addresseeId },
          { blocker_id: addresseeId, blocked_id: userId },
        ],
      },
    });
    if (blocked) throw new ApiError(403, "Unable to send request");

    const existing = await prisma.friends.findFirst({
      where: {
        OR: [
          { requester_id: userId, addressee_id: addresseeId },
          { requester_id: addresseeId, addressee_id: userId },
        ],
      },
    });
    if (existing) throw new ApiError(409, "A friend request already exists between these users");

    const request = await prisma.friends.create({
      data: { requester_id: userId, addressee_id: addresseeId, status: "pending" },
    });
    emitToUser(addresseeId, "friend:request", { requestId: request.id, from: userId });
    res.status(201).json(request);
  })
);

const respondSchema = z.object({ status: z.enum(["accepted", "declined"]) });

friendsRouter.patch(
  "/requests/:id",
  asyncHandler(async (req, res) => {
    const { status } = respondSchema.parse(req.body);
    const request = await prisma.friends.findUnique({ where: { id: req.params.id } });
    if (!request || request.addressee_id !== req.userId!) throw new ApiError(404, "Request not found");
    if (request.status !== "pending") throw new ApiError(409, "Request already resolved");

    const updated = await prisma.friends.update({ where: { id: request.id }, data: { status } });
    emitToUser(request.requester_id, "friend:response", { requestId: request.id, status });
    res.json(updated);
  })
);

friendsRouter.delete(
  "/:otherUserId",
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const { otherUserId } = req.params;
    await prisma.friends.deleteMany({
      where: {
        OR: [
          { requester_id: userId, addressee_id: otherUserId },
          { requester_id: otherUserId, addressee_id: userId },
        ],
      },
    });
    res.status(204).send();
  })
);

const blockSchema = z.object({ blockedId: z.string().uuid(), reason: z.string().max(200).optional() });

friendsRouter.post(
  "/block",
  asyncHandler(async (req, res) => {
    const { blockedId, reason } = blockSchema.parse(req.body);
    const userId = req.userId!;
    await prisma.$transaction([
      prisma.userBlocks.upsert({
        where: { blocker_id_blocked_id: { blocker_id: userId, blocked_id: blockedId } },
        create: { blocker_id: userId, blocked_id: blockedId, reason: reason ?? null },
        update: {},
      }),
      prisma.friends.deleteMany({
        where: {
          OR: [
            { requester_id: userId, addressee_id: blockedId },
            { requester_id: blockedId, addressee_id: userId },
          ],
        },
      }),
    ]);
    res.status(204).send();
  })
);

friendsRouter.delete(
  "/block/:blockedId",
  asyncHandler(async (req, res) => {
    await prisma.userBlocks
      .delete({
        where: { blocker_id_blocked_id: { blocker_id: req.userId!, blocked_id: req.params.blockedId } },
      })
      .catch(() => {});
    res.status(204).send();
  })
);
