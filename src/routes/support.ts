import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { canSupport } from "@/lib/roles";
import { logAdminAction } from "@/lib/audit";
import { notifySupportParticipants, postSupportMessage } from "@/lib/support";

export const supportRouter = Router();
supportRouter.use(requireAuth);

const uuid = z.string().uuid();
const STATUSES = ["open", "escalated", "closed", "resolved"] as const;
const contentSchema = z.string().trim().min(1).max(4000);

/** Load a conversation the caller may use: its owner, or support staff. */
async function loadConversation(id: string, userId: string) {
  const conv = await prisma.supportConversations.findUnique({ where: { id } });
  if (!conv) throw new ApiError(404, "Conversation not found");
  const agent = await canSupport(userId);
  if (conv.user_id !== userId && !agent) throw new ApiError(404, "Conversation not found");
  return { conv, agent, isOwner: conv.user_id === userId };
}

// Your own conversations. Support staff can pass ?view=agent (with optional ?status= and ?assigned=me)
// to see everyone's, newest activity first.
supportRouter.get(
  "/conversations",
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const agentView = req.query.view === "agent";
    if (agentView && !(await canSupport(userId))) throw new ApiError(403, "Not authorized");

    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const convs = await prisma.supportConversations.findMany({
      where: {
        ...(agentView ? {} : { user_id: userId }),
        ...(status ? { status } : {}),
        ...(agentView && req.query.assigned === "me" ? { assigned_agent_id: userId } : {}),
      },
      orderBy: { last_message_at: "desc" },
      take: limit,
      skip: offset,
    });
    if (!agentView) return res.json(convs);

    const ids = [...new Set(convs.map((c) => c.user_id))];
    const profiles = ids.length
      ? await prisma.profiles.findMany({
          where: { user_id: { in: ids } },
          select: { user_id: true, username: true, display_name: true, avatar_url: true },
        })
      : [];
    const byId = new Map(profiles.map((p) => [p.user_id, p]));
    res.json(convs.map((c) => ({ ...c, user: byId.get(c.user_id) ?? null })));
  })
);

// Start a conversation with its first message.
supportRouter.post(
  "/conversations",
  asyncHandler(async (req, res) => {
    const body = z.object({ subject: z.string().trim().max(200).optional(), message: contentSchema }).parse(req.body);
    const userId = req.userId!;
    const { conv, message } = await prisma.$transaction(async (tx) => {
      const conv = await tx.supportConversations.create({ data: { user_id: userId, subject: body.subject ?? null } });
      const message = await postSupportMessage(tx, conv, userId, false, body.message);
      return { conv, message };
    });
    await notifySupportParticipants(conv, message);
    res.status(201).json({ conversation: await prisma.supportConversations.findUnique({ where: { id: conv.id } }), message });
  })
);

supportRouter.get(
  "/conversations/:conversationId",
  asyncHandler(async (req, res) => {
    const { conv, agent } = await loadConversation(uuid.parse(req.params.conversationId), req.userId!);
    const user = agent
      ? await prisma.profiles.findUnique({
          where: { user_id: conv.user_id },
          select: { user_id: true, username: true, display_name: true, avatar_url: true, rank: true, is_verified: true },
        })
      : undefined;
    res.json({ ...conv, ...(agent ? { user } : {}) });
  })
);

supportRouter.get(
  "/conversations/:conversationId/messages",
  asyncHandler(async (req, res) => {
    const { conv } = await loadConversation(uuid.parse(req.params.conversationId), req.userId!);
    res.json(
      await prisma.supportMessages.findMany({
        where: { conversation_id: conv.id },
        orderBy: { created_at: "asc" },
        take: 500,
      })
    );
  })
);

supportRouter.post(
  "/conversations/:conversationId/messages",
  asyncHandler(async (req, res) => {
    const { content } = z.object({ content: contentSchema }).parse(req.body);
    const userId = req.userId!;
    const { conv, agent, isOwner } = await loadConversation(uuid.parse(req.params.conversationId), userId);
    const isAgent = agent && !isOwner;
    const message = await prisma.$transaction((tx) => postSupportMessage(tx, conv, userId, isAgent, content));
    await notifySupportParticipants(conv, message);
    res.status(201).json(message);
  })
);

// Mark the conversation read for your side: the owner clears unread_for_user, support staff clear unread_for_agent.
supportRouter.post(
  "/conversations/:conversationId/read",
  asyncHandler(async (req, res) => {
    const { conv, isOwner } = await loadConversation(uuid.parse(req.params.conversationId), req.userId!);
    await prisma.supportConversations.update({
      where: { id: conv.id },
      data: isOwner ? { unread_for_user: 0 } : { unread_for_agent: 0 },
    });
    res.status(204).send();
  })
);

// Ports set_support_status (support staff only). The first agent to change the status is assigned.
supportRouter.patch(
  "/conversations/:conversationId/status",
  asyncHandler(async (req, res) => {
    const { status } = z.object({ status: z.enum(STATUSES) }).parse(req.body);
    const userId = req.userId!;
    if (!(await canSupport(userId))) throw new ApiError(403, "Not authorized");
    const id = uuid.parse(req.params.conversationId);

    const updated = await prisma.$transaction(async (tx) => {
      const conv = await tx.supportConversations.findUnique({ where: { id } });
      if (!conv) throw new ApiError(404, "Conversation not found");
      const next = await tx.supportConversations.update({
        where: { id },
        data: { status, assigned_agent_id: conv.assigned_agent_id ?? userId, updated_at: new Date() },
      });
      await logAdminAction(tx, userId, `support_status_${status}`, null, null, { conversation_id: id });
      return next;
    });
    res.json(updated);
  })
);
