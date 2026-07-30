import type { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import { verifyAccessToken } from "@/utils/jwt";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";

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

    // --- Call signaling (replaces the Supabase `call-signal-${roomId}` broadcast channel) ---
    // Payload shape is intentionally opaque here — it's whatever the WebRTC
    // client (useCall.ts) needs: { type: 'offer'|'answer'|'ice-candidate'|'end'|'reject', ... }
    s.on("call:signal", ({ roomId, signal }: { roomId: string; signal: unknown }) => {
      s.to(`room:${roomId}`).emit("call:signal", { fromUserId: userId, signal });
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
