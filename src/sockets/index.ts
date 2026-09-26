import type { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import { verifyAccessToken } from "@/utils/jwt";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { hasCallPermission, CallType } from "@/lib/callPermissions";

interface AuthedSocket extends Socket {
  data: { userId: string };
}

let io: Server | undefined;

export function getIo(): Server {
  if (!io) throw new Error("Socket.io not initialized yet");
  return io;
}

/** Helper other route handlers can call to push a realtime event without importing socket.io directly. */
export function emitToRoom(roomId: string, event: string, payload: unknown) {
  getIo().to(`room:${roomId}`).emit(event, payload);
}

export function emitToUser(userId: string, event: string, payload: unknown) {
  getIo().to(`user:${userId}`).emit(event, payload);
}

const onlineCounts = new Map<string, number>(); // userId -> number of open sockets

async function setOnline(userId: string, online: boolean) {
  await prisma.profiles
    .updateMany({ where: { user_id: userId }, data: { is_online: online, last_seen: new Date() } })
    .catch((err) => console.error("failed to update presence", err));
  getIo().emit("presence:update", { userId, online });
}

export function initSockets(httpServer: HttpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: env.clientOrigins.length ? env.clientOrigins : true,
      credentials: true,
    },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error("Missing token"));
    try {
      const payload = verifyAccessToken(token);
      (socket as AuthedSocket).data.userId = payload.sub;
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", async (socket: Socket) => {
    const s = socket as AuthedSocket;
    const userId = s.data.userId;

    // Personal room for direct server->user pushes (notifications, friend requests, etc.)
    s.join(`user:${userId}`);

    const prevCount = onlineCounts.get(userId) ?? 0;
    onlineCounts.set(userId, prevCount + 1);
    if (prevCount === 0) await setOnline(userId, true);

    // --- Chat rooms ---
    s.on("room:join", (roomId: string) => {
      s.join(`room:${roomId}`);
    });
    s.on("room:leave", (roomId: string) => {
      s.leave(`room:${roomId}`);
    });

    // --- Typing indicators (replaces the Supabase broadcast `typing-${roomId}` channel) ---
    s.on("typing:start", ({ roomId, displayName }: { roomId: string; displayName: string }) => {
      s.to(`room:${roomId}`).emit("typing:start", { userId, displayName, roomId });
    });
    s.on("typing:stop", ({ roomId }: { roomId: string }) => {
      s.to(`room:${roomId}`).emit("typing:stop", { userId, roomId });
    });

    // --- Call signaling ---
    // Two events cover the whole flow, both addressed directly to the
    // recipient's personal `user:${id}` room so it reaches them wherever
    // they are in the app (not just while a specific chat screen is open):
    //
    //  call:invite  caller -> callee   { callId, roomId, calleeId, callType, callerName, callerAvatarUrl, sdp }
    //  call:signal  either direction   { callId, to, signal: { type: 'offer'|'answer'|'ice'|'ready'|'reject'|'leave', ... } }
    //
    // The REST route (POST /api/calls) is the source of truth for the
    // call_logs row and already checked the caller's rank; this handler
    // re-checks the *callee's* rank before ever letting the call ring, so a
    // client that skipped/patched the UI gate still can't receive a call
    // type their rank doesn't allow.
    s.on(
      "call:invite",
      async (payload: {
        callId: string;
        roomId: string;
        calleeId: string;
        callType: CallType;
        callerName: string;
        callerAvatarUrl?: string | null;
        sdp: unknown;
      }) => {
        const calleeProfile = await prisma.profiles.findUnique({
          where: { user_id: payload.calleeId },
          select: { rank: true },
        });

        if (!hasCallPermission(payload.callType, calleeProfile?.rank)) {
          await prisma.callLogs
            .update({ where: { id: payload.callId }, data: { status: "declined", duration_seconds: 0 } })
            .catch(() => undefined);
          s.emit("call:signal", {
            callId: payload.callId,
            from: payload.calleeId,
            signal: { type: "reject", reason: "rank_not_permitted" },
          });
          return;
        }

        getIo().to(`user:${payload.calleeId}`).emit("call:invite", {
          callId: payload.callId,
          roomId: payload.roomId,
          callerId: userId,
          callType: payload.callType,
          callerName: payload.callerName,
          callerAvatarUrl: payload.callerAvatarUrl ?? null,
          sdp: payload.sdp,
        });
      }
    );

    s.on("call:signal", ({ callId, to, signal }: { callId: string; to: string; signal: unknown }) => {
      getIo().to(`user:${to}`).emit("call:signal", { callId, from: userId, signal });
    });

    // --- Status/story reactions live-update channel ---
    s.on("status:join", (statusId: string) => s.join(`status:${statusId}`));
    s.on("status:leave", (statusId: string) => s.leave(`status:${statusId}`));

    s.on("disconnect", async () => {
      const count = (onlineCounts.get(userId) ?? 1) - 1;
      if (count <= 0) {
        onlineCounts.delete(userId);
        await setOnline(userId, false);
      } else {
        onlineCounts.set(userId, count);
      }
    });
  });

  return io;
}
