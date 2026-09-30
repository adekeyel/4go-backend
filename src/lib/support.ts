import { Tx } from "@/lib/coins";
import { logAdminAction } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { emitToUser } from "@/sockets";
import { pushSupportMessage } from "@/lib/push";

type Conversation = { id: string; user_id: string; status: string; assigned_agent_id: string | null };

/**
 * Ports the `tg_support_message_bump` trigger, which ran on every support message insert:
 *  - a customer replying to a closed/resolved conversation reopens it
 *  - keeps last_message / last_message_at and the two unread counters up to date
 *  - the first agent to reply becomes the assigned agent
 *  - agent replies are written to the admin audit log
 * `isAgent` is decided by the server (caller is support staff and not the conversation's owner);
 * Supabase trusted a client-supplied flag, so any customer could post as an agent.
 */
export async function postSupportMessage(
  tx: Tx,
  conv: Conversation,
  senderId: string,
  isAgent: boolean,
  content: string
) {
  const message = await tx.supportMessages.create({
    data: { conversation_id: conv.id, sender_id: senderId, is_agent: isAgent, content },
  });

  await tx.supportConversations.update({
    where: { id: conv.id },
    data: {
      last_message: content.slice(0, 200),
      last_message_at: message.created_at,
      updated_at: new Date(),
      status: !isAgent && (conv.status === "closed" || conv.status === "resolved") ? "open" : conv.status,
      unread_for_agent: isAgent ? 0 : { increment: 1 },
      unread_for_user: isAgent ? { increment: 1 } : 0,
      ...(isAgent && !conv.assigned_agent_id ? { assigned_agent_id: senderId } : {}),
    },
  });

  if (isAgent) {
    await logAdminAction(tx, senderId, "support_reply", conv.user_id, null, {
      conversation_id: conv.id,
      preview: content.slice(0, 120),
    });
  }
  return message;
}

/** Live-push a new support message to whoever needs to see it (call after the transaction commits). */
export async function notifySupportParticipants(conv: Conversation, message: { id: string; is_agent: boolean; content: string; sender_id: string }) {
  const payload = { conversationId: conv.id, messageId: message.id, preview: message.content.slice(0, 100) };
  if (message.is_agent) {
    emitToUser(conv.user_id, "support:message", payload);
    return;
  }
  // Customer wrote in: tell every support agent, live and by push.
  const agents = await prisma.superAdmins.findMany({
    where: { role: { in: ["super_admin", "support"] } },
    select: { user_id: true },
  });
  for (const a of agents) emitToUser(a.user_id, "support:message", { ...payload, fromUserId: message.sender_id });
  void pushSupportMessage({
    conversationId: conv.id,
    senderId: message.sender_id,
    content: message.content,
    agentIds: agents.map((a) => a.user_id),
  });
}
