import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { assertRoomMember } from "./rooms";
import { hasCallPermission } from "@/lib/callPermissions";
import { emitToRoom } from "@/sockets";
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
// Optionally only those after `since`. Drives the "missed calls" badge.
callsRouter.get(
  "/missed",
  asyncHandler(async (req, res) => {
    const since = typeof req.query.since === "string" ? new Date(req.query.since) : undefined;
    const calls = await prisma.callLogs.findMany({
      where: {
        callee_id: req.userId!,
        status: { in: ["missed", "cancelled"] },
        duration_seconds: 0,
        ...(since && !Number.isNaN(since.getTime()) ? { created_at: { gt: since } } : {}),
      },
      select: { id: true, room_id: true, created_at: true },
    });
    res.json(calls);
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
