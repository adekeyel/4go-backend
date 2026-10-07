import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { assertRoomMember } from "./rooms";
import { hasCallPermission } from "@/lib/callPermissions";
import { emitToRoom, emitToUser } from "@/sockets";
import { isBlockedBetween } from "@/lib/social";
import { applyCallTransition } from "@/lib/callLifecycle";
import { buildIceServers } from "@/lib/iceServers";

export const callsRouter = Router();
callsRouter.use(requireAuth);

// STUN/TURN servers for the browser's peer connection (TURN credentials are minted per user, per request).
callsRouter.get(
  "/ice-servers",
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ iceServers: buildIceServers(req.userId!) });
  })
);

const startSchema = z.object({
  roomId: z.string().uuid(),
  calleeId: z.string().uuid(),
  callType: z.enum(["voice", "video"]),
});

// Places a call. The row starts as "ringing"; from here the SERVER moves it to answered / declined / cancelled /
// missed (see lib/callState.ts), so the history is right even if one side's app closes or loses signal.
// The row's id doubles as the WebRTC callId used for socket signaling.
callsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { roomId, calleeId, callType } = startSchema.parse(req.body);
    if (calleeId === req.userId!) throw new ApiError(400, "You can't call yourself");
    await assertRoomMember(roomId, req.userId!);
    await assertRoomMember(roomId, calleeId);

    const me = await prisma.profiles.findUnique({ where: { user_id: req.userId! }, select: { rank: true, is_suspended: true } });
    if (me?.is_suspended) throw new ApiError(403, "Account suspended");
    if (!hasCallPermission(callType, me?.rank)) {
      throw new ApiError(403, `Your rank doesn't permit ${callType} calls yet.`);
    }
    if (await isBlockedBetween(req.userId!, calleeId)) throw new ApiError(403, "You can't call this person");

    // If this caller is still "ringing" the same person from an earlier attempt (app crashed, double tap),
    // close the old attempt first so the callee isn't rung twice.
    const earlier = await prisma.callLogs.findMany({
      where: { caller_id: req.userId!, callee_id: calleeId, status: "ringing" },
      select: { id: true },
    });
    for (const e of earlier) await applyCallTransition(e.id, req.userId!, "cancelled");

    const call = await prisma.callLogs.create({
      data: { room_id: roomId, caller_id: req.userId!, callee_id: calleeId, call_type: callType, status: "ringing" },
    });
    emitToRoom(roomId, "call:log", call);
    res.status(201).json(call);
  })
);

const updateSchema = z.object({
  status: z.enum(["answered", "declined", "cancelled", "missed", "ended"]),
  duration_seconds: z.number().int().min(0).optional(),
});

// A participant reports what happened on their side. The server decides what that means (lib/callState.ts):
// it ignores reports that don't make sense (a late "cancelled" after the call was answered, a duplicate, a
// stranger) and works out the duration itself, so a client can't write a made-up call length.
callsRouter.patch(
  "/:callId",
  asyncHandler(async (req, res) => {
    const callId = z.string().uuid().parse(req.params.callId);
    const existing = await prisma.callLogs.findUnique({ where: { id: callId }, select: { caller_id: true, callee_id: true } });
    if (!existing) throw new ApiError(404, "Call not found");
    if (existing.caller_id !== req.userId! && existing.callee_id !== req.userId!) {
      throw new ApiError(403, "Not a participant in this call");
    }

    const body = updateSchema.parse(req.body);
    const call = await applyCallTransition(callId, req.userId!, body.status, body.duration_seconds);
    res.json(call);
  })
);

// Calls the current user didn't get to answer: nobody picked up (missed) or the caller hung up first (cancelled).
// A missed call counts as "not seen yet" until the person has either opened that chat or looked at their call
// history (POST /calls/seen) after it happened. That is what drives the badges, so they clear when you look,
// not at some unrelated moment. `since` (older apps) is only used for people who have never opened the history.
callsRouter.get(
  "/missed",
  asyncHandler(async (req, res) => {
    const me = req.userId!;
    const sinceParam = typeof req.query.since === "string" ? new Date(req.query.since) : null;
    const fallback = sinceParam && !Number.isNaN(sinceParam.getTime()) ? sinceParam : new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const calls = await prisma.$queryRaw<{ id: string; room_id: string; created_at: Date }[]>(Prisma.sql`
      SELECT c.id, c.room_id, c.created_at
        FROM call_logs c
        LEFT JOIN room_reads rr ON rr.room_id = c.room_id AND rr.user_id = ${me}::uuid
        LEFT JOIN call_history_state s ON s.user_id = ${me}::uuid
       WHERE c.callee_id = ${me}::uuid
         AND c.status IN ('missed', 'cancelled')
         AND c.duration_seconds = 0
         AND c.created_at > COALESCE(GREATEST(s.seen_at, s.cleared_at), ${fallback}::timestamptz)
         AND (rr.last_read_at IS NULL OR c.created_at > rr.last_read_at)
       ORDER BY c.created_at DESC
       LIMIT 200`);
    res.json(calls);
  })
);

// "I've looked at my call history": clears the missed-call badge for everything up to now.
callsRouter.post(
  "/seen",
  asyncHandler(async (req, res) => {
    const now = new Date();
    await prisma.callHistoryState.upsert({
      where: { user_id: req.userId! },
      create: { user_id: req.userId!, seen_at: now },
      update: { seen_at: now },
    });
    emitToUser(req.userId!, "calls:seen", { at: now.toISOString() }); // other tabs/devices update their badge
    res.status(204).send();
  })
);

// "Clear call log": hides everything up to now from THIS person's history (the other person keeps theirs).
callsRouter.post(
  "/clear",
  asyncHandler(async (req, res) => {
    const now = new Date();
    await prisma.callHistoryState.upsert({
      where: { user_id: req.userId! },
      create: { user_id: req.userId!, seen_at: now, cleared_at: now },
      update: { seen_at: now, cleared_at: now },
    });
    emitToUser(req.userId!, "calls:seen", { at: now.toISOString(), cleared: true });
    res.status(204).send();
  })
);

// My call history across every chat, newest first: calls I placed, received, missed. Ringing calls aren't included
// (they appear once they finish). Each entry carries the OTHER person's name and photo.
callsRouter.get(
  "/history",
  asyncHandler(async (req, res) => {
    const me = req.userId!;
    const { before, limit } = z
      .object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(40) })
      .parse(req.query);
    const state = await prisma.callHistoryState.findUnique({ where: { user_id: me }, select: { cleared_at: true } });
    const createdAt: { gt?: Date; lt?: Date } = {};
    if (state?.cleared_at) createdAt.gt = state.cleared_at;
    if (before) createdAt.lt = new Date(before);

    const rows = await prisma.callLogs.findMany({
      where: {
        OR: [{ caller_id: me }, { callee_id: me }],
        status: { not: "ringing" },
        ...(createdAt.gt || createdAt.lt ? { created_at: createdAt } : {}),
      },
      orderBy: { created_at: "desc" },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    const peerIds = [...new Set(page.map((c) => (c.caller_id === me ? c.callee_id : c.caller_id)))];
    const profiles = peerIds.length
      ? await prisma.profiles.findMany({ where: { user_id: { in: peerIds } }, select: { user_id: true, display_name: true, username: true, avatar_url: true } })
      : [];
    const byId = new Map(profiles.map((p) => [p.user_id, p]));

    res.json({
      hasMore,
      calls: page.map((c) => {
        const peerId = c.caller_id === me ? c.callee_id : c.caller_id;
        const peer = byId.get(peerId);
        return {
          id: c.id,
          room_id: c.room_id,
          direction: c.caller_id === me ? "outgoing" : "incoming",
          call_type: c.call_type,
          status: c.status,
          duration_seconds: c.duration_seconds,
          created_at: c.created_at,
          peer: { user_id: peerId, display_name: peer?.display_name ?? null, username: peer?.username ?? null, avatar_url: peer?.avatar_url ?? null },
        };
      }),
    });
  })
);

callsRouter.get(
  "/room/:roomId",
  asyncHandler(async (req, res) => {
    await assertRoomMember(req.params.roomId, req.userId!);
    const calls = await prisma.callLogs.findMany({
      where: { room_id: req.params.roomId },
      orderBy: { created_at: "desc" },
      take: 50,
    });
    res.json(calls.reverse());
  })
);
