import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { assertRoomMember } from "./rooms";
import { hasCallPermission } from "@/lib/callPermissions";

export const callsRouter = Router();
callsRouter.use(requireAuth);

const startSchema = z.object({
  roomId: z.string().uuid(),
  calleeId: z.string().uuid(),
  callType: z.enum(["voice", "video"]),
});

// Creates the call_logs row the moment a call is placed (status starts as
// "cancelled" and is corrected to "answered"/"declined"/"missed" by the
// PATCH below once the call is resolved — same convention the web client
// uses when writing straight to Supabase). The row's id doubles as the
// WebRTC callId used for socket signaling.
callsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { roomId, calleeId, callType } = startSchema.parse(req.body);
    await assertRoomMember(roomId, req.userId!);
    await assertRoomMember(roomId, calleeId);

    const me = await prisma.profiles.findUnique({ where: { user_id: req.userId! }, select: { rank: true } });
    if (!hasCallPermission(callType, me?.rank)) {
      throw new ApiError(403, `Your rank doesn't permit ${callType} calls yet.`);
    }

    const call = await prisma.callLogs.create({
      data: { room_id: roomId, caller_id: req.userId!, callee_id: calleeId, call_type: callType, status: "cancelled" },
    });
    res.status(201).json(call);
  })
);

const updateSchema = z.object({
  status: z.enum(["answered", "declined", "cancelled", "missed"]),
  duration_seconds: z.number().int().min(0).optional(),
});

callsRouter.patch(
  "/:callId",
  asyncHandler(async (req, res) => {
    const call = await prisma.callLogs.findUnique({ where: { id: req.params.callId } });
    if (!call) throw new ApiError(404, "Call not found");
    if (call.caller_id !== req.userId! && call.callee_id !== req.userId!) {
      throw new ApiError(403, "Not a participant in this call");
    }

    const body = updateSchema.parse(req.body);
    const updated = await prisma.callLogs.update({
      where: { id: call.id },
      data: { status: body.status, duration_seconds: body.duration_seconds ?? call.duration_seconds },
    });
    res.json(updated);
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
