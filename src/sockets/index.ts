import type { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import { verifyAccessToken } from "@/utils/jwt";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { hasCallPermission, CallType } from "@/lib/callPermissions";
import { setPresence } from "@/lib/presence";
import { verifyInvite, pushIncomingCall } from "@/lib/callPush";
import { getAdminRole } from "@/lib/roles";
import { rememberInvite, forgetInvite, bufferCallerSignal, pendingInvitesFor } from "@/lib/callInvites";
import { markDeliveredOnConnect } from "@/lib/delivery";

const UUID_RE = /^[0-9a-f-]{36}$/i;

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
  const notice = await setPresence(userId, online).catch((err) => {
    console.error("failed to update presence", err);
    return null;
  });
  getIo().emit("presence:update", { userId, online });
  if (notice) emitToUser(notice.employeeId, "employee:notification", notice.notification); // was Supabase Realtime
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
    // Anything sent to this person while they were away has now reached them (grey double tick for the sender).
    void markDeliveredOnConnect(userId);

    // --- Chat rooms ---
    // Only members get a room's live messages, typing and reactions (before, any signed-in user could join any room id).
    s.on("room:join", async (roomId: string) => {
      if (typeof roomId !== "string" || !/^[0-9a-f-]{36}$/i.test(roomId)) return;
      const member = await prisma.roomMembers
        .findUnique({ where: { room_id_user_id: { room_id: roomId, user_id: userId } }, select: { user_id: true } })
        .catch(() => null);
      if (member) s.join(`room:${roomId}`);
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
        group?: boolean;
        sdp: unknown;
      }) => {
        try {
          // The call row (created through POST /api/calls) is the source of truth. The caller's name and avatar
          // come from their profile, not from the message, so an invite can't be forged or impersonate someone.
          const call = await verifyInvite(userId, payload ?? ({} as never));
          if (!call) return;

          const calleeProfile = await prisma.profiles.findUnique({
            where: { user_id: call.callee_id },
            select: { rank: true },
          });

          if (!hasCallPermission(call.call_type as CallType, calleeProfile?.rank)) {
            const changed = await prisma.callLogs
              .updateMany({
                where: { id: call.id, status: "ringing" },
                data: { status: "declined", duration_seconds: 0, ended_at: new Date() },
              })
              .catch(() => ({ count: 0 }));
            const declined = changed.count ? await prisma.callLogs.findUnique({ where: { id: call.id } }) : null;
            if (declined) {
              emitToRoom(call.room_id, "call:log", declined);
              emitToUser(call.caller_id, "call:updated", declined);
            }
            forgetInvite(call.id);
            s.emit("call:signal", {
              callId: call.id,
              from: call.callee_id,
              signal: { type: "reject", reason: "rank_not_permitted" },
            });
            return;
          }

          // Kept for the ringing period so a callee who connects a moment later (tapping the push notification,
          // coming back online) still gets it: see the "call:pending" handler below.
          rememberInvite({
            callId: call.id,
            roomId: call.room_id,
            callerId: userId,
            calleeId: call.callee_id,
            callType: call.call_type,
            callerName: call.callerName,
            callerAvatarUrl: call.callerAvatarUrl,
            sdp: payload.sdp,
          });
          getIo().to(`user:${call.callee_id}`).emit("call:invite", {
            callId: call.id,
            roomId: call.room_id,
            callerId: userId,
            callType: call.call_type,
            callerName: call.callerName,
            callerAvatarUrl: call.callerAvatarUrl,
            sdp: payload.sdp,
          });
          void pushIncomingCall(call, Boolean(payload.group)); // rings a locked/closed phone; once per call
          // Tell the caller whether the other person's app is reachable right now ("Ringing…") or only the push
          // notification can reach them ("Calling…"), like WhatsApp's two states.
          const reachable = (await getIo().in(`user:${call.callee_id}`).fetchSockets()).length > 0;
          s.emit("call:ringing", { callId: call.id, reachable });
        } catch (err) {
          console.error("[socket] call:invite failed:", (err as Error).message);
        }
      }
    );

    s.on("call:signal", ({ callId, to, signal }: { callId: string; to: string; signal: unknown }) => {
      if (typeof callId !== "string" || typeof to !== "string" || !UUID_RE.test(to)) return;
      // The caller's network candidates (ICE) start flowing the instant the call is placed, long before a ringing
      // callee taps Answer. Keep them so they aren't lost (see lib/callInvites.ts).
      if ((signal as { type?: string } | null)?.type === "ice") bufferCallerSignal(callId, userId, to, signal);
      getIo().to(`user:${to}`).emit("call:signal", { callId, from: userId, signal });
    });

    // The client sends this once it is connected AND listening. Any call ringing for this user right now
    // (placed while their app was closed, or while they were reconnecting) is replayed with its offer.
    s.on("call:pending", () => {
      for (const inv of pendingInvitesFor(userId)) {
        s.emit("call:invite", {
          callId: inv.callId,
          roomId: inv.roomId,
          callerId: inv.callerId,
          callType: inv.callType,
          callerName: inv.callerName,
          callerAvatarUrl: inv.callerAvatarUrl,
          sdp: inv.sdp,
        });
        for (const sig of inv.signals) s.emit("call:signal", { callId: inv.callId, from: sig.from, signal: sig.signal });
        getIo().to(`user:${inv.callerId}`).emit("call:ringing", { callId: inv.callId, reachable: true }); // their app just came online
      }
    });

    // --- Status/story reactions live-update channel ---
    s.on("status:join", (statusId: string) => {
      if (typeof statusId === "string" && /^[0-9a-f-]{36}$/i.test(statusId)) s.join(`status:${statusId}`);
    });
    s.on("status:leave", (statusId: string) => s.leave(`status:${statusId}`));

    // --- Support chat: a conversation room shared by the user who owns it and the staff answering it ---
    // Joined with support:join { conversationId }; typing events go to everyone else in it.
    s.on("support:join", async (conversationId: string) => {
      if (typeof conversationId !== "string" || !/^[0-9a-f-]{36}$/i.test(conversationId)) return;
      const conv = await prisma.supportConversations.findUnique({ where: { id: conversationId }, select: { user_id: true } }).catch(() => null);
      if (!conv) return;
      if (conv.user_id === userId || (await getAdminRole(userId).catch(() => null))) s.join(`support:${conversationId}`);
    });
    s.on("support:leave", (conversationId: string) => s.leave(`support:${conversationId}`));
    s.on("support:typing", ({ conversationId, typing }: { conversationId: string; typing: boolean }) => {
      if (s.rooms.has(`support:${conversationId}`)) s.to(`support:${conversationId}`).emit("support:typing", { conversationId, userId, typing: Boolean(typing) });
    });

    s.on("disconnect", async () => {
      const count = (onlineCounts.get(userId) ?? 1) - 1;
      if (count <= 0) {
        onlineCounts.delete(userId);
        await setOnline(userId, false);
        // If they don't come back within a moment, close whatever call they left open (tab closed, signal lost).
        setTimeout(() => {
          if (onlineCounts.has(userId)) return;
          void import("@/lib/callLifecycle")
            .then((m) => m.endCallsLeftBehind(userId))
            .catch((err) => console.error("[calls] cleanup after disconnect failed:", (err as Error).message));
        }, 25_000).unref();
      } else {
        onlineCounts.set(userId, count);
      }
    });
  });

  return io;
}
