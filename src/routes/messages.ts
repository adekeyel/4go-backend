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
import { deliverToOnlineRecipients } from "@/lib/delivery";
import { canDeleteForEveryone } from "@/lib/messageRules";
import { clearedAtFor, mutedUserIds, unarchiveOnNewMessage } from "@/lib/chatPrefs";

export const messagesRouter = Router();
messagesRouter.use(requireAuth);

// Messages this person removed with "Delete for me" in this room (they never see them again).
async function hiddenMessageIds(roomId: string, userId: string): Promise<string[]> {
  const rows = await prisma.messageDeletions.findMany({ where: { room_id: roomId, user_id: userId }, select: { message_id: true } });
  return rows.map((r) => r.message_id);
}

messagesRouter.get(
  "/room/:roomId",
  asyncHandler(async (req, res) => {
    await assertRoomMember(req.params.roomId, req.userId!);
    const before = typeof req.query.before === "string" ? new Date(req.query.before) : undefined;
    const hidden = await hiddenMessageIds(req.params.roomId, req.userId!);
    const floor = await clearedAtFor(req.params.roomId, req.userId!); // "Clear chat": nothing older than this is shown
    const messages = await prisma.messages.findMany({
      where: {
        room_id: req.params.roomId,
        ...(hidden.length ? { id: { notIn: hidden } } : {}),
        ...(before || floor ? { created_at: { ...(before ? { lt: before } : {}), ...(floor ? { gt: floor } : {}) } } : {}),
      },
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
    const hidden = await hiddenMessageIds(req.params.roomId, req.userId!);
    const notHidden = hidden.length ? { id: { notIn: hidden } } : {};
    const floorAt = await clearedAtFor(req.params.roomId, req.userId!);
    const aboveFloor = floorAt ? { gt: floorAt } : {};
    const [before25, after25] = await Promise.all([
      prisma.messages.findMany({
        where: { room_id: req.params.roomId, ...notHidden, created_at: { lt: target.created_at, ...aboveFloor } },
        orderBy: { created_at: "desc" },
        take: 25,
      }),
      prisma.messages.findMany({
        where: { room_id: req.params.roomId, ...notHidden, created_at: { gte: target.created_at, ...aboveFloor } },
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
    const hidden = await hiddenMessageIds(req.params.roomId, req.userId!);
    const notHidden = hidden.length ? { id: { notIn: hidden } } : {};
    const clearedAt = await clearedAtFor(req.params.roomId, req.userId!);
    const aboveFloor = clearedAt ? { gt: clearedAt } : {};
    // Unread starts after whichever is later: the last time they read, or the last time they cleared the chat.
    const since = after && clearedAt ? (after > clearedAt ? after : clearedAt) : after ?? clearedAt;

    if (since) {
      // A message someone already deleted for everyone isn't "unread" any more.
      const firstUnread = await prisma.messages.findFirst({
        where: { room_id: req.params.roomId, ...notHidden, deleted_at: null, created_at: { gt: since }, sender_id: { not: req.userId! } },
        orderBy: { created_at: "asc" },
      });
      if (firstUnread) {
        const [unreadMessages, olderCount] = await Promise.all([
          prisma.messages.findMany({
            where: { room_id: req.params.roomId, ...notHidden, created_at: { gte: firstUnread.created_at } },
            orderBy: { created_at: "asc" },
          }),
          prisma.messages.count({ where: { room_id: req.params.roomId, ...notHidden, created_at: { lt: firstUnread.created_at, ...aboveFloor } } }),
        ]);
        return res.json({ messages: unreadMessages, hasMore: olderCount > 0 });
      }
    }

    const latest = await prisma.messages.findMany({
      where: { room_id: req.params.roomId, ...notHidden, ...(clearedAt ? { created_at: { gt: clearedAt } } : {}) },
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
  // True when this is a copy of a message from another chat (shows the "Forwarded" label).
  forwarded: z.boolean().optional(),
  // Chosen by the sender's app so it can show the message instantly and match it up with the saved one.
  // Not stored; it is only echoed back.
  client_id: z.string().max(64).optional(),
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
        forwarded: body.forwarded ?? false,
      },
    });

    // `client_id` lets the sender's own screen swap its "sending..." bubble for this one without showing it twice.
    const outgoing = body.client_id ? { ...message, client_id: body.client_id } : message;
    emitToRoom(req.params.roomId, "message:new", outgoing);
    // Global unread badges: notify every other member directly (even if they
    // have not opened this room), so counts update app-wide without each
    // client subscribing to every room channel.
    const members = await prisma.roomMembers.findMany({ where: { room_id: req.params.roomId }, select: { user_id: true } });
    await unarchiveOnNewMessage(req.params.roomId).catch(() => {}); // an archived chat pops back to the main list (unless muted)
    // People who muted this chat still get the message and the unread badge, just no sound / banner / push.
    const muted = await mutedUserIds(req.params.roomId, members.map((x) => x.user_id)).catch(() => new Set<string>());
    for (const m of members) {
      if (m.user_id !== req.userId!) {
        emitToUser(m.user_id, "message:notify", { muted: muted.has(m.user_id), roomId: message.room_id, messageId: message.id, senderId: message.sender_id, createdAt: message.created_at, type: message.type, content: message.content ? message.content.slice(0, 200) : null });
      }
    }
    void pushNewMessage(message); // ports notify_push_on_message; never throws, so it can't fail the send
    // Grey double tick: in a DM, tell the sender the moment the other person's app has it.
    const room = await prisma.rooms.findUnique({ where: { id: req.params.roomId }, select: { type: true } });
    if (room?.type === "dm") void deliverToOnlineRecipients(req.params.roomId, req.userId!);
    res.status(201).json(outgoing);
  })
);

const editSchema = z.object({ content: z.string().min(1).max(4000) });
messagesRouter.patch(
  "/:messageId",
  asyncHandler(async (req, res) => {
    const { content } = editSchema.parse(req.body);
    const message = await prisma.messages.findUnique({ where: { id: req.params.messageId } });
    if (!message || message.sender_id !== req.userId!) throw new ApiError(404, "Message not found");
    if (message.deleted_at) throw new ApiError(400, "This message was deleted");

    const updated = await prisma.messages.update({
      where: { id: message.id },
      data: { content, edited_at: new Date() },
    });
    emitToRoom(message.room_id, "message:edit", updated);
    res.json(updated);
  })
);

// Delete a message, WhatsApp style. ?scope=me hides it from the caller's view only (any room member);
// ?scope=everyone (the default) turns it into a "This message was deleted" tombstone for the whole chat:
// the sender within DELETE_FOR_EVERYONE_WINDOW_MS, or a room admin at any time. Reactions, views, pins and
// mention notices go with it; moderators use DELETE /api/admin/messages/:id for a hard delete.
messagesRouter.delete(
  "/:messageId",
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.messageId);
    const scope = z.enum(["me", "everyone"]).default("everyone").parse(req.query.scope ?? undefined);
    const message = await prisma.messages.findUnique({ where: { id } });
    if (!message) return res.status(204).send();
    const member = await assertRoomMember(message.room_id, req.userId!);

    if (scope === "me") {
      await prisma.messageDeletions.upsert({
        where: { message_id_user_id: { message_id: id, user_id: req.userId! } },
        create: { message_id: id, user_id: req.userId!, room_id: message.room_id },
        update: {},
      });
      // Keeps the person's other open tabs/devices in step.
      emitToUser(req.userId!, "message:hidden", { id, roomId: message.room_id });
      return res.status(204).send();
    }

    if (message.deleted_at) return res.status(204).send(); // already gone for everyone
    const isSender = message.sender_id === req.userId!;
    const isRoomAdmin = member.role === "admin";
    if (!isSender && !isRoomAdmin) throw new ApiError(403, "Only the sender or a room admin can delete this message for everyone");
    if (!canDeleteForEveryone({ isSender, isRoomAdmin, createdAt: message.created_at })) {
      throw new ApiError(403, "It's too late to delete this message for everyone. You can still delete it for yourself.");
    }

    const deletedAt = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.messageReactions.deleteMany({ where: { message_id: id } });
      await tx.messageViews.deleteMany({ where: { message_id: id } });
      await tx.pinnedMessages.deleteMany({ where: { message_id: id } });
      await tx.mentions.deleteMany({ where: { source_type: "message", source_id: id } });
      await tx.messages.update({
        where: { id },
        data: { deleted_at: deletedAt, content: null, media_url: null, duration: null, edited_at: null },
      });
    });
    emitToRoom(message.room_id, "message:revoked", { id, room_id: message.room_id, deleted_at: deletedAt.toISOString() });
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
    if (message.deleted_at) throw new ApiError(400, "This message was deleted");
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
