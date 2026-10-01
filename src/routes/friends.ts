import { Router } from "express";
import { Prisma } from "@prisma/client";
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

// --- People you may know (ports get_people_you_may_know) ---
// Candidates are people who share a room with you OR are friends of your friends (the earlier version only
// looked at shared rooms, so someone in no rooms got nothing). Anyone you already have any friend row with
// (accepted, pending or declined) and anyone blocked either way is left out. Ranked by shared rooms + mutual friends.
friendsRouter.get(
  "/suggestions",
  asyncHandler(async (req, res) => {
    const me = req.userId!;
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const rows = await prisma.$queryRaw<unknown[]>(Prisma.sql`
      WITH my_friends AS (
        SELECT CASE WHEN requester_id = ${me}::uuid THEN addressee_id ELSE requester_id END AS friend_id
          FROM friends
         WHERE (requester_id = ${me}::uuid OR addressee_id = ${me}::uuid) AND status = 'accepted'
      ),
      related AS (
        SELECT CASE WHEN requester_id = ${me}::uuid THEN addressee_id ELSE requester_id END AS other_id
          FROM friends
         WHERE requester_id = ${me}::uuid OR addressee_id = ${me}::uuid
      ),
      room_peers AS (
        SELECT rm.user_id AS candidate_id, count(DISTINCT rm.room_id) AS shared_rooms
          FROM room_members rm
          JOIN room_members mine ON mine.room_id = rm.room_id AND mine.user_id = ${me}::uuid
         WHERE rm.user_id <> ${me}::uuid
         GROUP BY rm.user_id
      ),
      fof AS (
        SELECT CASE WHEN f.requester_id = mf.friend_id THEN f.addressee_id ELSE f.requester_id END AS candidate_id,
               count(DISTINCT mf.friend_id) AS mutual_friends
          FROM my_friends mf
          JOIN friends f ON (f.requester_id = mf.friend_id OR f.addressee_id = mf.friend_id) AND f.status = 'accepted'
         WHERE CASE WHEN f.requester_id = mf.friend_id THEN f.addressee_id ELSE f.requester_id END <> ${me}::uuid
         GROUP BY 1
      ),
      candidates AS (
        SELECT COALESCE(rp.candidate_id, fof.candidate_id) AS candidate_id,
               COALESCE(rp.shared_rooms, 0) AS shared_rooms,
               COALESCE(fof.mutual_friends, 0) AS mutual_friends
          FROM room_peers rp FULL OUTER JOIN fof ON rp.candidate_id = fof.candidate_id
      )
      SELECT p.user_id, p.display_name, p.username, p.avatar_url,
             c.shared_rooms::int AS shared_rooms, c.mutual_friends::int AS mutual_friends
        FROM candidates c
        JOIN profiles p ON p.user_id = c.candidate_id
       WHERE c.candidate_id NOT IN (SELECT other_id FROM related)
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks ub
            WHERE (ub.blocker_id = ${me}::uuid AND ub.blocked_id = c.candidate_id)
               OR (ub.blocker_id = c.candidate_id AND ub.blocked_id = ${me}::uuid))
       ORDER BY (c.shared_rooms + c.mutual_friends) DESC, p.display_name
       LIMIT ${limit}`);
    res.json(rows);
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

friendsRouter.get(
  "/block",
  asyncHandler(async (req, res) => {
    const rows = await prisma.userBlocks.findMany({
      where: { blocker_id: req.userId! },
      orderBy: { created_at: "desc" },
    });
    res.json(rows);
  })
);
