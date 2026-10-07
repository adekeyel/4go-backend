import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, optionalAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { emitToRoom, emitToUser } from "@/sockets";
import { MAX_PINNED_CHATS, MUTE_FOREVER } from "@/lib/chatPrefs";
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

// The rooms I'm in (not DMs), with everything the Rooms list needs in one request: member count, the last message
// (as I would see it: not what I deleted for myself, nothing before "Clear chat") and my pin / mute / archive settings.
roomsRouter.get(
  "/mine/details",
  requireAuth,
  asyncHandler(async (req, res) => {
    const me = req.userId!;
    const memberships = await prisma.roomMembers.findMany({ where: { user_id: me }, select: { room_id: true } });
    const ids = memberships.map((m) => m.room_id);
    if (!ids.length) return res.json([]);

    const [rooms, counts, lastMessages, prefRows] = await Promise.all([
      prisma.rooms.findMany({ where: { id: { in: ids }, type: { not: "dm" }, is_active: true } }),
      prisma.roomMembers.groupBy({ by: ["room_id"], where: { room_id: { in: ids } }, _count: { room_id: true } }),
      prisma.$queryRaw<{ room_id: string; sender_id: string; type: string; content: string | null; created_at: Date; deleted_at: Date | null }[]>(Prisma.sql`
        SELECT DISTINCT ON (m.room_id) m.room_id, m.sender_id, m.type, m.content, m.created_at, m.deleted_at
          FROM messages m
          LEFT JOIN chat_prefs cp ON cp.room_id = m.room_id AND cp.user_id = ${me}::uuid
         WHERE m.room_id = ANY(${ids}::uuid[])
           AND (cp.cleared_at IS NULL OR m.created_at > cp.cleared_at)
           AND NOT EXISTS (SELECT 1 FROM message_deletions d WHERE d.message_id = m.id AND d.user_id = ${me}::uuid)
         ORDER BY m.room_id, m.created_at DESC`),
      prisma.chatPrefs.findMany({ where: { user_id: me, room_id: { in: ids } } }),
    ]);

    const senderIds = [...new Set(lastMessages.map((m) => m.sender_id))];
    const senders = senderIds.length
      ? await prisma.profiles.findMany({ where: { user_id: { in: senderIds } }, select: { user_id: true, display_name: true, username: true } })
      : [];
    const senderName = new Map(senders.map((p) => [p.user_id, p.display_name || p.username || "Someone"]));
    const countBy = new Map(counts.map((c) => [c.room_id, c._count.room_id]));
    const lastBy = new Map(lastMessages.map((m) => [m.room_id, m]));
    const prefBy = new Map(prefRows.map((p) => [p.room_id, p]));

    res.json(
      rooms.map((r) => {
        const last = lastBy.get(r.id);
        return {
          ...r,
          member_count: countBy.get(r.id) ?? 0,
          last_message: last
            ? { sender_id: last.sender_id, sender_name: last.sender_id === me ? "You" : senderName.get(last.sender_id) ?? "Someone", type: last.type, content: last.content, created_at: last.created_at, deleted_at: last.deleted_at }
            : null,
          ...prefsView(prefBy.get(r.id)),
        };
      })
    );
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
    const prefs = await prisma.chatPrefs.findMany({ where: { user_id: req.userId!, room_id: { in: roomIds }, cleared_at: { not: null } }, select: { room_id: true, cleared_at: true } });
    const clearedMap = new Map(prefs.map((p) => [p.room_id, p.cleared_at as Date]));

    const counts = await Promise.all(
      roomIds.map(async (room_id) => {
        // Unread starts after the later of: last time they read it, last time they cleared the chat.
        const read = readMap.get(room_id);
        const cleared = clearedMap.get(room_id);
        const last = read && cleared ? (read > cleared ? read : cleared) : read ?? cleared;
        const unread_count = await prisma.messages.count({
          where: {
            room_id,
            sender_id: { not: req.userId! },
            deleted_at: null, // a message deleted for everyone no longer counts as unread
            ...(last ? { created_at: { gt: last } } : {}),
          },
        });
        return { room_id, unread_count };
      })
    );
    res.json(counts.filter((c) => c.unread_count > 0));
  })
);

// ---- Per-person chat settings: pin, mute, archive, clear chat -------------------------------------------------
type PrefsRow = { pinned_at: Date | null; muted_until: Date | null; archived: boolean; cleared_at: Date | null } | null | undefined;

/** What the app needs to know about a chat's settings. "muted" is true only while the mute is still running. */
function prefsView(row: PrefsRow) {
  const now = Date.now();
  const mutedUntil = row?.muted_until && row.muted_until.getTime() > now ? row.muted_until : null;
  return {
    pinned_at: row?.pinned_at ?? null,
    muted_until: mutedUntil,
    archived: row?.archived ?? false,
    cleared_at: row?.cleared_at ?? null,
  };
}

const MUTE_DURATIONS_MS = { "8h": 8 * 3600 * 1000, "1w": 7 * 24 * 3600 * 1000 } as const;

const prefsSchema = z.object({
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  muted: z.enum(["off", "8h", "1w", "forever"]).optional(),
});

roomsRouter.get(
  "/prefs",
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await prisma.chatPrefs.findMany({ where: { user_id: req.userId! } });
    res.json(rows.map((r) => ({ room_id: r.room_id, ...prefsView(r) })));
  })
);

roomsRouter.put(
  "/:roomId/prefs",
  requireAuth,
  asyncHandler(async (req, res) => {
    const roomId = z.string().uuid().parse(req.params.roomId);
    const body = prefsSchema.parse(req.body);
    await assertRoomMember(roomId, req.userId!);

    const data: { pinned_at?: Date | null; muted_until?: Date | null; archived?: boolean; updated_at: Date } = { updated_at: new Date() };
    if (body.pinned !== undefined) {
      if (body.pinned) {
        // The limit applies per list: up to 3 pinned DMs AND up to 3 pinned rooms (they're shown in separate lists).
        const thisRoom = await prisma.rooms.findUnique({ where: { id: roomId }, select: { type: true } });
        const thisIsDm = thisRoom?.type === "dm";
        const pinnedRows = await prisma.chatPrefs.findMany({ where: { user_id: req.userId!, pinned_at: { not: null }, NOT: { room_id: roomId } }, select: { room_id: true } });
        const pinnedRooms = pinnedRows.length
          ? await prisma.rooms.findMany({ where: { id: { in: pinnedRows.map((r) => r.room_id) } }, select: { type: true } })
          : [];
        const sameKind = pinnedRooms.filter((r) => (r.type === "dm") === thisIsDm).length;
        if (sameKind >= MAX_PINNED_CHATS) throw new ApiError(400, `You can only pin up to ${MAX_PINNED_CHATS} ${thisIsDm ? "chats" : "rooms"}`);
        data.pinned_at = new Date();
      } else {
        data.pinned_at = null;
      }
    }
    if (body.archived !== undefined) {
      data.archived = body.archived;
      if (body.archived) data.pinned_at = null; // like WhatsApp: archiving unpins
    }
    if (body.muted !== undefined) {
      data.muted_until = body.muted === "off" ? null : body.muted === "forever" ? MUTE_FOREVER : new Date(Date.now() + MUTE_DURATIONS_MS[body.muted]);
    }

    const row = await prisma.chatPrefs.upsert({
      where: { user_id_room_id: { user_id: req.userId!, room_id: roomId } },
      create: { user_id: req.userId!, room_id: roomId, ...data },
      update: data,
    });
    const view = { room_id: roomId, ...prefsView(row) };
    emitToUser(req.userId!, "chat:prefs", view); // keeps the person's other tabs/devices in step
    res.json(view);
  })
);

// "Clear chat": hides everything up to now from this person's view only. The other person keeps their history.
roomsRouter.post(
  "/:roomId/clear",
  requireAuth,
  asyncHandler(async (req, res) => {
    const roomId = z.string().uuid().parse(req.params.roomId);
    await assertRoomMember(roomId, req.userId!);
    const now = new Date();
    const row = await prisma.chatPrefs.upsert({
      where: { user_id_room_id: { user_id: req.userId!, room_id: roomId } },
      create: { user_id: req.userId!, room_id: roomId, cleared_at: now },
      update: { cleared_at: now, updated_at: now },
    });
    const view = { room_id: roomId, ...prefsView(row) };
    emitToUser(req.userId!, "chat:prefs", view);
    emitToUser(req.userId!, "chat:cleared", { roomId, clearedAt: now.toISOString() });
    res.json(view);
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

    const [peers, lastMessages, unread, lastCalls, peerReads, prefRows] = await Promise.all([
      prisma.roomMembers.findMany({
        where: { room_id: { in: ids }, user_id: { not: me } },
        select: { room_id: true, user_id: true, last_delivered_at: true },
      }),
      prisma.$queryRaw<{ id: string; room_id: string; sender_id: string; type: string; content: string | null; created_at: Date; deleted_at: Date | null }[]>(Prisma.sql`
        SELECT DISTINCT ON (m.room_id) m.id, m.room_id, m.sender_id, m.type, m.content, m.created_at, m.deleted_at
          FROM messages m
          LEFT JOIN chat_prefs cp ON cp.room_id = m.room_id AND cp.user_id = ${me}::uuid
         WHERE m.room_id = ANY(${ids}::uuid[])
           AND (cp.cleared_at IS NULL OR m.created_at > cp.cleared_at)
           AND NOT EXISTS (SELECT 1 FROM message_deletions d WHERE d.message_id = m.id AND d.user_id = ${me}::uuid)
         ORDER BY m.room_id, m.created_at DESC`),
      prisma.$queryRaw<{ room_id: string; unread: number }[]>(Prisma.sql`
        SELECT m.room_id, count(*)::int AS unread
          FROM messages m
          LEFT JOIN room_reads rr ON rr.room_id = m.room_id AND rr.user_id = ${me}::uuid
          LEFT JOIN chat_prefs cp ON cp.room_id = m.room_id AND cp.user_id = ${me}::uuid
         WHERE m.room_id = ANY(${ids}::uuid[])
           AND m.sender_id <> ${me}::uuid
           AND (cp.cleared_at IS NULL OR m.created_at > cp.cleared_at)
           AND m.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM message_deletions d WHERE d.message_id = m.id AND d.user_id = ${me}::uuid)
           AND (rr.last_read_at IS NULL OR m.created_at > rr.last_read_at)
         GROUP BY m.room_id`),
      prisma.$queryRaw<{ id: string; room_id: string; caller_id: string; callee_id: string; call_type: string; status: string; duration_seconds: number; created_at: Date }[]>(Prisma.sql`
        SELECT DISTINCT ON (c.room_id) c.id, c.room_id, c.caller_id, c.callee_id, c.call_type, c.status, c.duration_seconds, c.created_at
          FROM call_logs c
          LEFT JOIN chat_prefs cp ON cp.room_id = c.room_id AND cp.user_id = ${me}::uuid
         WHERE c.room_id = ANY(${ids}::uuid[]) AND c.status <> 'ringing'
           AND (cp.cleared_at IS NULL OR c.created_at > cp.cleared_at)
         ORDER BY c.room_id, c.created_at DESC`),
      prisma.roomReads.findMany({ where: { room_id: { in: ids }, user_id: { not: me } }, select: { room_id: true, last_read_at: true } }),
      prisma.chatPrefs.findMany({ where: { room_id: { in: ids }, user_id: me } }),
    ]);
    const prefBy = new Map(prefRows.map((p) => [p.room_id, p]));

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
        ...prefsView(prefBy.get(p.room_id)),
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
