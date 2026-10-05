import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, optionalAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { emitToRoom } from "@/sockets";
import { createJoinRequest, reviewJoinRequest } from "@/lib/joinRequests";
import { Prisma } from "@prisma/client";

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
    const types = typeof req.query.type === "string" ? req.query.type.split(",") : ["public"];
    const q = typeof req.query.q === "string" ? req.query.q.trim() : undefined;

    const rooms = await prisma.rooms.findMany({
      where: {
        type: { in: types },
        is_active: true,
        ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
      },
      orderBy: { created_at: "desc" },
      take: 50,
    });
    const roomIds = rooms.map((r) => r.id);
    const counts = roomIds.length
      ? await prisma.roomMembers.groupBy({ by: ["room_id"], where: { room_id: { in: roomIds } }, _count: { room_id: true } })
      : [];
    const countMap = new Map(counts.map((c) => [c.room_id, c._count.room_id]));
    const enriched = rooms
      .map((r) => ({ ...r, member_count: countMap.get(r.id) || 0 }))
      .sort((a, b) => b.member_count - a.member_count);
    res.json(enriched);
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

// Unread message count per room for the current user (replaces the old
// get_unread_counts RPC): messages from others created after the user's
// last_read_at for that room (or all of them if they've never opened it).
roomsRouter.get(
  "/unread-counts",
  requireAuth,
  asyncHandler(async (req, res) => {
    const memberships = await prisma.roomMembers.findMany({ where: { user_id: req.userId! }, select: { room_id: true } });
    const roomIds = memberships.map((m) => m.room_id);
    if (!roomIds.length) return res.json([]);

    const reads = await prisma.roomReads.findMany({ where: { user_id: req.userId!, room_id: { in: roomIds } } });
    const readMap = new Map(reads.map((r) => [r.room_id, r.last_read_at]));

    const counts = await Promise.all(
      roomIds.map(async (room_id) => {
        const last = readMap.get(room_id);
        const unread_count = await prisma.messages.count({
          where: {
            room_id,
            sender_id: { not: req.userId! },
            ...(last ? { created_at: { gt: last } } : {}),
          },
        });
        return { room_id, unread_count };
      })
    );
    res.json(counts.filter((c) => c.unread_count > 0));
  })
);

// Everything the DM list needs in ONE request: for each of my direct-message rooms, who the other person is, the
// last message, how many I haven't read, the last finished call, and whether they've read/received my messages.
// (The list used to open every chat and download 50 messages each, which got slower with every friend added.)
roomsRouter.get(
  "/dms/summary",
  requireAuth,
  asyncHandler(async (req, res) => {
    const me = req.userId!;
    const mine = await prisma.roomMembers.findMany({ where: { user_id: me }, select: { room_id: true } });
    if (!mine.length) return res.json([]);
    const dms = await prisma.rooms.findMany({ where: { id: { in: mine.map((m) => m.room_id) }, type: "dm" }, select: { id: true } });
    const ids = dms.map((d) => d.id);
    if (!ids.length) return res.json([]);

    const [peers, lastMessages, unread, lastCalls, peerReads] = await Promise.all([
      prisma.roomMembers.findMany({
        where: { room_id: { in: ids }, user_id: { not: me } },
        select: { room_id: true, user_id: true, last_delivered_at: true },
      }),
      prisma.$queryRaw<{ id: string; room_id: string; sender_id: string; type: string; content: string | null; created_at: Date }[]>(Prisma.sql`
        SELECT DISTINCT ON (room_id) id, room_id, sender_id, type, content, created_at
          FROM messages
         WHERE room_id = ANY(${ids}::uuid[])
         ORDER BY room_id, created_at DESC`),
      prisma.$queryRaw<{ room_id: string; unread: number }[]>(Prisma.sql`
        SELECT m.room_id, count(*)::int AS unread
          FROM messages m
          LEFT JOIN room_reads rr ON rr.room_id = m.room_id AND rr.user_id = ${me}::uuid
         WHERE m.room_id = ANY(${ids}::uuid[])
           AND m.sender_id <> ${me}::uuid
           AND (rr.last_read_at IS NULL OR m.created_at > rr.last_read_at)
         GROUP BY m.room_id`),
      prisma.$queryRaw<{ id: string; room_id: string; caller_id: string; callee_id: string; call_type: string; status: string; duration_seconds: number; created_at: Date }[]>(Prisma.sql`
        SELECT DISTINCT ON (room_id) id, room_id, caller_id, callee_id, call_type, status, duration_seconds, created_at
          FROM call_logs
         WHERE room_id = ANY(${ids}::uuid[]) AND status <> 'ringing'
         ORDER BY room_id, created_at DESC`),
      prisma.roomReads.findMany({ where: { room_id: { in: ids }, user_id: { not: me } }, select: { room_id: true, last_read_at: true } }),
    ]);

    const msgBy = new Map(lastMessages.map((m) => [m.room_id, m]));
    const unreadBy = new Map(unread.map((u) => [u.room_id, u.unread]));
    const callBy = new Map(lastCalls.map((c) => [c.room_id, c]));
    const readBy = new Map(peerReads.map((r) => [r.room_id, r.last_read_at]));

    res.json(
      peers.map((p) => ({
        room_id: p.room_id,
        peer_id: p.user_id,
        last_message: msgBy.get(p.room_id) ?? null,
        last_call: callBy.get(p.room_id) ?? null,
        unread: unreadBy.get(p.room_id) ?? 0,
        peer_last_read_at: readBy.get(p.room_id) ?? null,
        peer_last_delivered_at: p.last_delivered_at,
      }))
    );
  })
);

const ROOM_CREATE_RANKS = ["Learner", "Professional", "Expert", "Master"];
const PRIVATE_ROOM_RANKS = ["Expert", "Master"];

const createRoomSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  type: z.enum(["public", "private"]).default("public"),
  rules: z.string().max(500).optional(),
  join_fee: z.number().int().min(0).max(100000).optional(),
  join_questions: z.array(z.string().max(200)).max(5).optional(),
});

roomsRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = createRoomSchema.parse(req.body);

    const me = await prisma.profiles.findUnique({ where: { user_id: req.userId! }, select: { rank: true } });
    const rank = me?.rank || "Amateur";
    if (!ROOM_CREATE_RANKS.includes(rank)) {
      throw new ApiError(403, "You need at least the Learner rank to create rooms.");
    }
    if (body.type === "private" && !PRIVATE_ROOM_RANKS.includes(rank)) {
      throw new ApiError(403, "You need at least the Expert rank to create a private room.");
    }

    const room = await prisma.$transaction(async (tx) => {
      const r = await tx.rooms.create({
        data: {
          name: body.name,
          description: body.description ?? null,
          type: body.type,
          created_by: req.userId!,
          ...(body.type === "private"
            ? {
                rules: body.rules ?? null,
                join_fee: body.join_fee ?? 0,
                join_questions: body.join_questions ?? [],
              }
            : {}),
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

const updateRoomSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  rules: z.string().max(500).optional(),
  join_fee: z.number().int().min(0).max(100000).optional(),
  join_questions: z.array(z.string().max(200)).max(5).optional(),
});

roomsRouter.patch(
  "/:roomId",
  requireAuth,
  asyncHandler(async (req, res) => {
    await assertRoomAdmin(req.params.roomId, req.userId!);
    const body = updateRoomSchema.parse(req.body);
    const room = await prisma.rooms.update({ where: { id: req.params.roomId }, data: body });
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

// --- Direct messages (1:1 rooms) ---
// Ported from the old `get_or_create_dm_room` Postgres function: find the
// existing type="dm" room shared by these two users, or create one.
roomsRouter.post(
  "/dm/:userId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const otherUserId = req.params.userId;
    if (otherUserId === req.userId) throw new ApiError(400, "Can't start a DM with yourself");

    const otherProfile = await prisma.profiles.findUnique({ where: { user_id: otherUserId } });
    if (!otherProfile) throw new ApiError(404, "User not found");

    const myMemberships = await prisma.roomMembers.findMany({
      where: { user_id: req.userId! },
      select: { room_id: true },
    });
    const myRoomIds = myMemberships.map((m) => m.room_id);

    if (myRoomIds.length) {
      const sharedMemberships = await prisma.roomMembers.findMany({
        where: { user_id: otherUserId, room_id: { in: myRoomIds } },
        select: { room_id: true },
      });
      if (sharedMemberships.length) {
        const existingDm = await prisma.rooms.findFirst({
          where: { id: { in: sharedMemberships.map((m) => m.room_id) }, type: "dm" },
        });
        if (existingDm) return res.json(existingDm);
      }
    }

    const room = await prisma.$transaction(async (tx) => {
      const r = await tx.rooms.create({
        data: {
          name: otherProfile.display_name || otherProfile.username || "Direct Message",
          type: "dm",
          created_by: req.userId!,
          max_members: 2,
        },
      });
      await tx.roomMembers.createMany({
        data: [
          { room_id: r.id, user_id: req.userId!, role: "member" },
          { room_id: r.id, user_id: otherUserId, role: "member" },
        ],
      });
      return r;
    });
    res.status(201).json(room);
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
          select: { user_id: true, username: true, display_name: true, avatar_url: true, is_online: true, last_seen: true },
        })
      : [];
    const profileMap = new Map(profiles.map((p) => [p.user_id, p]));
    res.json(members.map((m) => ({ ...m, profile: profileMap.get(m.user_id) })));
  })
);

// One-stop status check for a room's chat screen: am I a member/admin, am I
// muted, and (if not a member) what's my join-request status. Consolidates
// what used to be three separate Supabase queries.
roomsRouter.get(
  "/:roomId/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const [membership, mute, joinRequest] = await Promise.all([
      prisma.roomMembers.findUnique({ where: { room_id_user_id: { room_id: req.params.roomId, user_id: req.userId! } } }),
      prisma.mutedMembers.findUnique({ where: { room_id_user_id: { room_id: req.params.roomId, user_id: req.userId! } } }),
      prisma.roomJoinRequests.findUnique({ where: { room_id_user_id: { room_id: req.params.roomId, user_id: req.userId! } } }),
    ]);
    res.json({
      isMember: !!membership,
      role: membership?.role ?? null,
      isMuted: !!mute && (!mute.muted_until || mute.muted_until > new Date()),
      joinRequestStatus: joinRequest?.status ?? null,
    });
  })
);

// --- Read receipts (replaces the room_reads RLS + realtime subscription) ---

roomsRouter.post(
  "/:roomId/read",
  requireAuth,
  asyncHandler(async (req, res) => {
    await assertRoomMember(req.params.roomId, req.userId!);
    const row = await prisma.roomReads.upsert({
      where: { room_id_user_id: { room_id: req.params.roomId, user_id: req.userId! } },
      create: { room_id: req.params.roomId, user_id: req.userId!, last_read_at: new Date() },
      update: { last_read_at: new Date() },
    });
    emitToRoom(req.params.roomId, "room:read", { roomId: req.params.roomId, userId: req.userId!, lastReadAt: row.last_read_at });
    res.json(row);
  })
);

roomsRouter.get(
  "/:roomId/reads",
  requireAuth,
  asyncHandler(async (req, res) => {
    await assertRoomMember(req.params.roomId, req.userId!);
    const rows = await prisma.roomReads.findMany({ where: { room_id: req.params.roomId } });
    res.json(rows);
  })
);

// Read AND delivered times for every member (the older /reads only has read times, and the native app depends on its shape).
roomsRouter.get(
  "/:roomId/receipts",
  requireAuth,
  asyncHandler(async (req, res) => {
    await assertRoomMember(req.params.roomId, req.userId!);
    const [members, reads] = await Promise.all([
      prisma.roomMembers.findMany({ where: { room_id: req.params.roomId }, select: { user_id: true, last_delivered_at: true } }),
      prisma.roomReads.findMany({ where: { room_id: req.params.roomId }, select: { user_id: true, last_read_at: true } }),
    ]);
    const readBy = new Map(reads.map((r) => [r.user_id, r.last_read_at]));
    res.json(members.map((m) => ({ user_id: m.user_id, last_read_at: readBy.get(m.user_id) ?? null, last_delivered_at: m.last_delivered_at })));
  })
);

// --- Pinned messages (group chats only, mirrors the pinned_messages table) ---

roomsRouter.get(
  "/:roomId/pinned",
  requireAuth,
  asyncHandler(async (req, res) => {
    await assertRoomMember(req.params.roomId, req.userId!);
    const pins = await prisma.pinnedMessages.findMany({ where: { room_id: req.params.roomId }, orderBy: { pinned_at: "desc" } });
    const ids = pins.map((p) => p.message_id);
    const messages = ids.length ? await prisma.messages.findMany({ where: { id: { in: ids } } }) : [];
    const messageMap = new Map(messages.map((m) => [m.id, m]));
    res.json(pins.map((p) => ({ ...p, message: messageMap.get(p.message_id) })).filter((p) => p.message));
  })
);

roomsRouter.post(
  "/:roomId/pinned/:messageId",
  requireAuth,
  asyncHandler(async (req, res) => {
    await assertRoomMember(req.params.roomId, req.userId!);
    const message = await prisma.messages.findUnique({ where: { id: req.params.messageId } });
    if (!message || message.room_id !== req.params.roomId) throw new ApiError(404, "Message not found");

    const pin = await prisma.pinnedMessages.upsert({
      where: { room_id_message_id: { room_id: req.params.roomId, message_id: req.params.messageId } },
      create: { room_id: req.params.roomId, message_id: req.params.messageId, pinned_by: req.userId! },
      update: {},
    });
    emitToRoom(req.params.roomId, "message:pin", { roomId: req.params.roomId, messageId: req.params.messageId });
    res.status(201).json(pin);
  })
);

roomsRouter.delete(
  "/:roomId/pinned/:messageId",
  requireAuth,
  asyncHandler(async (req, res) => {
    await assertRoomMember(req.params.roomId, req.userId!);
    await prisma.pinnedMessages
      .delete({ where: { room_id_message_id: { room_id: req.params.roomId, message_id: req.params.messageId } } })
      .catch(() => {});
    emitToRoom(req.params.roomId, "message:unpin", { roomId: req.params.roomId, messageId: req.params.messageId });
    res.status(204).send();
  })
);

// --- Private room join requests (replaces the room_join_requests RLS + approve/reject RPCs) ---

const joinRequestSchema = z.object({ answers: z.array(z.string()).optional() });

roomsRouter.get(
  "/:roomId/join-requests/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const request = await prisma.roomJoinRequests.findUnique({
      where: { room_id_user_id: { room_id: req.params.roomId, user_id: req.userId! } },
    });
    res.json(request);
  })
);

roomsRouter.post(
  "/:roomId/join-requests",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { answers } = joinRequestSchema.parse(req.body);
    const room = await prisma.rooms.findUnique({ where: { id: req.params.roomId } });
    if (!room) throw new ApiError(404, "Room not found");

    // Duplicate / already-a-member checks happen inside createJoinRequest, in the same transaction as the fee.
    const request = await createJoinRequest(req.userId!, room, answers);
    res.status(201).json(request);
  })
);

roomsRouter.get(
  "/:roomId/join-requests",
  requireAuth,
  asyncHandler(async (req, res) => {
    await assertRoomAdmin(req.params.roomId, req.userId!);
    const requests = await prisma.roomJoinRequests.findMany({
      where: { room_id: req.params.roomId, status: "pending" },
      orderBy: { created_at: "asc" },
    });
    const ids = requests.map((r) => r.user_id);
    const profiles = ids.length
      ? await prisma.profiles.findMany({
          where: { user_id: { in: ids } },
          select: { user_id: true, username: true, display_name: true, avatar_url: true },
        })
      : [];
    const profileMap = new Map(profiles.map((p) => [p.user_id, p]));
    res.json(requests.map((r) => ({ ...r, profile: profileMap.get(r.user_id) })));
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

    await reviewJoinRequest(request, decision);
    res.json({ status: decision === "approve" ? "approved" : "rejected" });
  })
);
