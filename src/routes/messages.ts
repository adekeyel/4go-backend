import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { assertRoomMember } from "./rooms";
import { emitToRoom } from "@/sockets";

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
