import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, optionalAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";

export const roomsRouter = Router();

/** Throws unless the user is a member of the room. Mirrors the old room_members-based RLS policies. */
export async function assertRoomMember(roomId: string, userId: string) {
  const member = await prisma.roomMembers.findUnique({
    where: { room_id_user_id: { room_id: roomId, user_id: userId } },
  });
  if (!member) throw new ApiError(403, "You're not a member of this room");
  return member;
}

export async function assertRoomAdmin(roomId: string, userId: string) {
  const member = await assertRoomMember(roomId, userId);
  if (member.role !== "admin") throw new ApiError(403, "Admins only");
  return member;
}

roomsRouter.get(
  "/",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const rooms = await prisma.rooms.findMany({
      where: { type: "public", is_active: true },
      orderBy: { created_at: "desc" },
      take: 50,
    });
    res.json(rooms);
  })
);

roomsRouter.get(
  "/mine",
  requireAuth,
  asyncHandler(async (req, res) => {
    const memberships = await prisma.roomMembers.findMany({ where: { user_id: req.userId! } });
    const roomIds = memberships.map((m) => m.room_id);
    const rooms = roomIds.length
      ? await prisma.rooms.findMany({ where: { id: { in: roomIds } } })
      : [];
    res.json(rooms);
  })
);

const createRoomSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  type: z.enum(["public", "private"]).default("public"),
});

roomsRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = createRoomSchema.parse(req.body);
    const room = await prisma.$transaction(async (tx) => {
      const r = await tx.rooms.create({
        data: {
          name: body.name,
          description: body.description ?? null,
          type: body.type,
          created_by: req.userId!,
        },
      });
      await tx.roomMembers.create({ data: { room_id: r.id, user_id: req.userId!, role: "admin" } });
      return r;
    });
    res.status(201).json(room);
  })
);

roomsRouter.get(
  "/:roomId",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const room = await prisma.rooms.findUnique({ where: { id: req.params.roomId } });
    if (!room) throw new ApiError(404, "Room not found");
    res.json(room);
  })
);

roomsRouter.post(
  "/:roomId/join",
  requireAuth,
  asyncHandler(async (req, res) => {
    const room = await prisma.rooms.findUnique({ where: { id: req.params.roomId } });
    if (!room || !room.is_active) throw new ApiError(404, "Room not found");

    const existing = await prisma.roomMembers.findUnique({
      where: { room_id_user_id: { room_id: room.id, user_id: req.userId! } },
    });
    if (existing) return res.status(200).json(existing);

    if (room.type === "private") {
      throw new ApiError(403, "This room requires an approved join request");
    }

    const member = await prisma.roomMembers.create({
      data: { room_id: room.id, user_id: req.userId!, role: "member" },
    });
    res.status(201).json(member);
  })
);

roomsRouter.post(
  "/:roomId/leave",
  requireAuth,
  asyncHandler(async (req, res) => {
    await prisma.roomMembers.deleteMany({ where: { room_id: req.params.roomId, user_id: req.userId! } });
    res.status(204).send();
  })
);

roomsRouter.get(
  "/:roomId/members",
  requireAuth,
  asyncHandler(async (req, res) => {
    await assertRoomMember(req.params.roomId, req.userId!);
    const members = await prisma.roomMembers.findMany({ where: { room_id: req.params.roomId } });
    const ids = members.map((m) => m.user_id);
    const profiles = ids.length
      ? await prisma.profiles.findMany({
          where: { user_id: { in: ids } },
          select: { user_id: true, username: true, display_name: true, avatar_url: true, is_online: true },
        })
      : [];
    const profileMap = new Map(profiles.map((p) => [p.user_id, p]));
    res.json(members.map((m) => ({ ...m, profile: profileMap.get(m.user_id) })));
  })
);

// --- Private room join requests (replaces the room_join_requests RLS + approve/reject RPCs) ---

const joinRequestSchema = z.object({ answers: z.array(z.string()).optional() });

roomsRouter.post(
  "/:roomId/join-requests",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { answers } = joinRequestSchema.parse(req.body);
    const room = await prisma.rooms.findUnique({ where: { id: req.params.roomId } });
    if (!room) throw new ApiError(404, "Room not found");

    const request = await prisma.roomJoinRequests.create({
      data: {
        room_id: room.id,
        user_id: req.userId!,
        fee_paid: room.join_fee ?? 0,
        answers: answers ?? [],
        status: "pending",
      },
    });
    res.status(201).json(request);
  })
);

const reviewRequestSchema = z.object({ decision: z.enum(["approve", "reject"]) });

roomsRouter.patch(
  "/:roomId/join-requests/:requestId",
  requireAuth,
  asyncHandler(async (req, res) => {
    await assertRoomAdmin(req.params.roomId, req.userId!);
    const { decision } = reviewRequestSchema.parse(req.body);
    const request = await prisma.roomJoinRequests.findUnique({ where: { id: req.params.requestId } });
    if (!request || request.room_id !== req.params.roomId) throw new ApiError(404, "Request not found");

    if (decision === "approve") {
      await prisma.$transaction([
        prisma.roomJoinRequests.update({ where: { id: request.id }, data: { status: "approved" } }),
        prisma.roomMembers.create({ data: { room_id: request.room_id, user_id: request.user_id, role: "member" } }),
      ]);
    } else {
      await prisma.roomJoinRequests.update({ where: { id: request.id }, data: { status: "rejected" } });
    }
    res.json({ status: decision === "approve" ? "approved" : "rejected" });
  })
);
