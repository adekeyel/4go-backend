import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { assertRoomMember } from "./rooms";
import { emitToRoom, emitToUser } from "@/sockets";
import { assertCanSendToRoom } from "@/lib/roomMessages";
import { pushNewMessage } from "@/lib/push";
import { deleteMessagesCascade } from "@/lib/cleanup";

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

const idList = (v: unknown) =>
  typeof v === "string" ? [...new Set(v.split(",").map((x) => x.trim()).filter((x) => /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 200) : [];

// Reactions for a batch of messages (?ids=a,b,c, up to 200), so a chat screen loads them in one call.
// Returns the raw rows; group by message_id on the client.
messagesRouter.get(
  "/room/:roomId/reactions",
  asyncHandler(async (req, res) => {
    await assertRoomMember(req.params.roomId, req.userId!);
    const ids = idList(req.query.ids);
    if (!ids.length) return res.json([]);
    const msgs = await prisma.messages.findMany({ where: { id: { in: ids }, room_id: req.params.roomId }, select: { id: true } });
    res.json(
      await prisma.messageReactions.findMany({ where: { message_id: { in: msgs.map((m) => m.id) } }, orderBy: { created_at: "asc" } })
    );
  })
);

// How many people have viewed each of YOUR messages in this room (?ids=a,b,c). Other people's messages are left out.
messagesRouter.get(
  "/room/:roomId/views",
  asyncHandler(async (req, res) => {
    await assertRoomMember(req.params.roomId, req.userId!);
    const ids = idList(req.query.ids);
    if (!ids.length) return res.json({});
    const mine = await prisma.messages.findMany({
      where: { id: { in: ids }, room_id: req.params.roomId, sender_id: req.userId! },
      select: { id: true },
    });
    const groups = mine.length
      ? await prisma.messageViews.groupBy({ by: ["message_id"], where: { message_id: { in: mine.map((m) => m.id) } }, _count: { message_id: true } })
      : [];
    const counts: Record<string, number> = Object.fromEntries(mine.map((m) => [m.id, 0]));
    for (const g of groups) counts[g.message_id] = g._count.message_id;
    res.json(counts);
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
    // Membership + suspended sender + blocked DM + announcements-channel rules (were DB triggers/RLS).
    await assertCanSendToRoom(req.params.roomId, req.userId!);
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
    void pushNewMessage(message); // ports notify_push_on_message; never throws, so it can't fail the send
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

// Delete a message: the sender, or an admin of the room. (Before, ANY member could delete ANY message.)
// Reactions, views, pins and mention notices go with it; moderators use DELETE /api/admin/messages/:id.
messagesRouter.delete(
  "/:messageId",
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.messageId);
    const message = await prisma.messages.findUnique({ where: { id } });
    if (!message) return res.status(204).send();
    if (message.sender_id !== req.userId!) {
      const member = await assertRoomMember(message.room_id, req.userId!);
      if (member.role !== "admin") throw new ApiError(403, "Only the sender or a room admin can delete this message");
    }
    await prisma.$transaction((tx) => deleteMessagesCascade(tx, [id]));
    emitToRoom(message.room_id, "message:delete", { id });
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

// Remove your own reaction. The emoji goes in the URL (URL-encoded).
messagesRouter.delete(
  "/:messageId/reactions/:emoji",
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.messageId);
    const emoji = z.string().min(1).max(16).parse(req.params.emoji);
    const message = await prisma.messages.findUnique({ where: { id }, select: { room_id: true } });
    if (!message) return res.status(204).send();
    await assertRoomMember(message.room_id, req.userId!);
    const { count } = await prisma.messageReactions.deleteMany({ where: { message_id: id, user_id: req.userId!, emoji } });
    if (count > 0) emitToRoom(message.room_id, "reaction:removed", { message_id: id, user_id: req.userId!, emoji });
    res.status(204).send();
  })
);

// Everyone's reactions on one message.
messagesRouter.get(
  "/:messageId/reactions",
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.messageId);
    const message = await prisma.messages.findUnique({ where: { id }, select: { room_id: true } });
    if (!message) throw new ApiError(404, "Message not found");
    await assertRoomMember(message.room_id, req.userId!);
    res.json(await prisma.messageReactions.findMany({ where: { message_id: id }, orderBy: { created_at: "asc" } }));
  })
);

// Ports record_message_view. The first time another member views a monetized user's message,
// the sender earns 1 coin if it's an image, a video, or a text of 100+ characters, outside DMs.
// (The SQL didn't check that the viewer belonged to the room; this does.)
messagesRouter.post(
  "/:messageId/view",
  asyncHandler(async (req, res) => {
    const messageId = z.string().uuid().parse(req.params.messageId);
    const userId = req.userId!;
    const message = await prisma.messages.findUnique({
      where: { id: messageId },
      select: { sender_id: true, type: true, content: true, room_id: true },
    });
    if (!message) throw new ApiError(404, "Message not found");
    await assertRoomMember(message.room_id, userId);
    if (message.sender_id === userId) return res.json({ self_view: true });

    const result = await prisma.$transaction(async (tx) => {
      const inserted = await tx.messageViews.createMany({
        data: [{ user_id: userId, message_id: messageId }],
        skipDuplicates: true,
      });
      if (inserted.count === 0) {
        return { already_viewed: true, view_count: await tx.messageViews.count({ where: { message_id: messageId } }) };
      }

      const [sender, room] = await Promise.all([
        tx.profiles.findUnique({ where: { user_id: message.sender_id }, select: { is_monetized: true } }),
        tx.rooms.findUnique({ where: { id: message.room_id }, select: { type: true } }),
      ]);
      const qualifies =
        message.type === "image" ||
        message.type === "video" ||
        (message.type === "text" && (message.content?.length ?? 0) >= 100);
      if (sender?.is_monetized && room?.type !== "dm" && qualifies) {
        await tx.profiles.update({
          where: { user_id: message.sender_id },
          data: { coins: { increment: 1 }, earned_coins: { increment: 1 } },
        });
        await tx.transactions.create({
          data: {
            user_id: message.sender_id,
            amount: 1,
            source: "earning",
            description: "View earning on post",
            reference_id: messageId,
          },
        });
      }
      return { recorded: true, view_count: await tx.messageViews.count({ where: { message_id: messageId } }) };
    });
    res.json(result);
  })
);
