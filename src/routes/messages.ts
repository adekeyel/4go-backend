import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { assertRoomMember } from "./rooms";
import { emitToRoom, emitToUser } from "@/sockets";

export const messagesRouter = Router();
messagesRouter.use(requireAuth);

messagesRouter.get(
  "/room/:roomId",
  asyncHandler(async (req, res) => {
    await assertRoomMember(req.params.roomId, req.userId!);
    const before = typeof req.query.before === "string" ? new Date(req.query.before) : undefined;
    const messages = await prisma.messages.findMany({
      where: { room_id: req.params.roomId, ...(before ? { created_at: { lt: before } } : {}) },
      orderBy: { created_at: "desc" },
      take: 50,
    });
    res.json(messages.reverse());
  })
);

// Fetch specific messages by id within a room — used to resolve "replying to
// ..." previews when the original message isn't in the currently-loaded page.
messagesRouter.get(
  "/room/:roomId/by-ids",
  asyncHandler(async (req, res) => {
    await assertRoomMember(req.params.roomId, req.userId!);
    const ids = typeof req.query.ids === "string" ? req.query.ids.split(",").filter(Boolean) : [];
    if (!ids.length) return res.json([]);
    const messages = await prisma.messages.findMany({ where: { id: { in: ids }, room_id: req.params.roomId } });
    res.json(messages);
  })
);

// Deep-link support (e.g. a mention notification linking to a specific
// message): return a window centered on it instead of the latest page.
messagesRouter.get(
  "/room/:roomId/around/:messageId",
  asyncHandler(async (req, res) => {
    await assertRoomMember(req.params.roomId, req.userId!);
    const target = await prisma.messages.findUnique({ where: { id: req.params.messageId } });
    if (!target || target.room_id !== req.params.roomId) throw new ApiError(404, "Message not found");
    const [before25, after25] = await Promise.all([
      prisma.messages.findMany({
        where: { room_id: req.params.roomId, created_at: { lt: target.created_at } },
        orderBy: { created_at: "desc" },
        take: 25,
      }),
      prisma.messages.findMany({
        where: { room_id: req.params.roomId, created_at: { gte: target.created_at } },
        orderBy: { created_at: "asc" },
        take: 25,
      }),
    ]);
    res.json({ messages: [...before25.reverse(), ...after25], hasMoreBefore: before25.length === 25 });
  })
);

// On entering a room: jump straight to the first unread message (by someone
// else) sent after `after`, loading everything from there forward, plus
// whether older messages exist above it. Falls back to the latest page when
// there's no unread cursor or nothing unread.
messagesRouter.get(
  "/room/:roomId/unread",
  asyncHandler(async (req, res) => {
    await assertRoomMember(req.params.roomId, req.userId!);
    const after = typeof req.query.after === "string" ? new Date(req.query.after) : null;

    if (after) {
      const firstUnread = await prisma.messages.findFirst({
        where: { room_id: req.params.roomId, created_at: { gt: after }, sender_id: { not: req.userId! } },
        orderBy: { created_at: "asc" },
      });
      if (firstUnread) {
        const [unreadMessages, olderCount] = await Promise.all([
          prisma.messages.findMany({
            where: { room_id: req.params.roomId, created_at: { gte: firstUnread.created_at } },
            orderBy: { created_at: "asc" },
          }),
          prisma.messages.count({ where: { room_id: req.params.roomId, created_at: { lt: firstUnread.created_at } } }),
        ]);
        return res.json({ messages: unreadMessages, hasMore: olderCount > 0 });
      }
    }

    const latest = await prisma.messages.findMany({
      where: { room_id: req.params.roomId },
      orderBy: { created_at: "desc" },
      take: 50,
    });
    res.json({ messages: latest.reverse(), hasMore: latest.length === 50 });
  })
);

const sendSchema = z.object({
  type: z.enum(["text", "image", "video", "audio", "file"]).default("text"),
  content: z.string().max(4000).optional(),
  media_url: z.string().url().optional(),
  duration: z.number().int().optional(),
  reply_to: z.string().uuid().optional(),
});

messagesRouter.post(
  "/room/:roomId",
  asyncHandler(async (req, res) => {
    await assertRoomMember(req.params.roomId, req.userId!);
    const body = sendSchema.parse(req.body);
    if (body.type === "text" && !body.content?.trim()) throw new ApiError(400, "Message content required");

    const message = await prisma.messages.create({
      data: {
        room_id: req.params.roomId,
        sender_id: req.userId!,
        type: body.type,
        content: body.content ?? null,
        media_url: body.media_url ?? null,
        duration: body.duration ?? null,
        reply_to: body.reply_to ?? null,
      },
    });

    emitToRoom(req.params.roomId, "message:new", message);
    // Global unread badges: notify every other member directly (even if they
    // have not opened this room), so counts update app-wide without each
    // client subscribing to every room channel.
    const members = await prisma.roomMembers.findMany({ where: { room_id: req.params.roomId }, select: { user_id: true } });
    for (const m of members) {
      if (m.user_id !== req.userId!) {
        emitToUser(m.user_id, "message:notify", { roomId: message.room_id, messageId: message.id, senderId: message.sender_id, createdAt: message.created_at, type: message.type, content: message.content ? message.content.slice(0, 200) : null });
      }
    }
    res.status(201).json(message);
  })
);

const editSchema = z.object({ content: z.string().min(1).max(4000) });
messagesRouter.patch(
  "/:messageId",
  asyncHandler(async (req, res) => {
    const { content } = editSchema.parse(req.body);
    const message = await prisma.messages.findUnique({ where: { id: req.params.messageId } });
    if (!message || message.sender_id !== req.userId!) throw new ApiError(404, "Message not found");

    const updated = await prisma.messages.update({
      where: { id: message.id },
      data: { content, edited_at: new Date() },
    });
    emitToRoom(message.room_id, "message:edit", updated);
    res.json(updated);
  })
);

messagesRouter.delete(
  "/:messageId",
  asyncHandler(async (req, res) => {
    const message = await prisma.messages.findUnique({ where: { id: req.params.messageId } });
    if (!message) return res.status(204).send();
    if (message.sender_id !== req.userId!) {
      await assertRoomMember(message.room_id, req.userId!); // allow room admins to moderate
    }
    await prisma.messages.delete({ where: { id: message.id } });
    emitToRoom(message.room_id, "message:delete", { id: message.id });
    res.status(204).send();
  })
);

// --- Reactions ---
const reactSchema = z.object({ emoji: z.string().min(1).max(8) });

messagesRouter.post(
  "/:messageId/reactions",
  asyncHandler(async (req, res) => {
    const { emoji } = reactSchema.parse(req.body);
    const message = await prisma.messages.findUnique({ where: { id: req.params.messageId } });
    if (!message) throw new ApiError(404, "Message not found");
    await assertRoomMember(message.room_id, req.userId!);

    const reaction = await prisma.messageReactions.upsert({
      where: {
        message_id_user_id_emoji: { message_id: message.id, user_id: req.userId!, emoji },
      },
      create: { message_id: message.id, user_id: req.userId!, emoji },
      update: {},
    });
    emitToRoom(message.room_id, "reaction:new", reaction);
    res.status(201).json(reaction);
  })
);
