import { mutedUserIds } from "@/lib/chatPrefs";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/middleware/errorHandler";
import { emitToRoom, emitToUser } from "@/sockets";
import { canModerate } from "@/lib/roles";
import { isBlockedBetween } from "@/lib/social";
import { pushNewMessage } from "@/lib/push";

export const ANNOUNCEMENTS_ROOM_NAME = "📢 4GO Announcements";

/**
 * Everything the database enforced when a message was inserted, in one place:
 *  - membership                                   (RLS on messages)
 *  - suspended accounts can't send                (trigger block_suspended_message)
 *  - DMs are closed once either side blocks       (function can_send_room_message)
 *  - announcements channel is staff-only          (trigger enforce_announcement_broadcast)
 */
export async function assertCanSendToRoom(roomId: string, userId: string) {
  const room = await prisma.rooms.findUnique({ where: { id: roomId }, select: { type: true, name: true } });
  if (!room) throw new ApiError(404, "Room not found");

  const member = await prisma.roomMembers.findUnique({
    where: { room_id_user_id: { room_id: roomId, user_id: userId } },
    select: { id: true },
  });
  if (!member) throw new ApiError(403, "You're not a member of this room");

  const profile = await prisma.profiles.findUnique({ where: { user_id: userId }, select: { is_suspended: true } });
  if (profile?.is_suspended) throw new ApiError(403, "Account suspended");

  if (room.type === "dm") {
    const other = await prisma.roomMembers.findFirst({
      where: { room_id: roomId, user_id: { not: userId } },
      select: { user_id: true },
    });
    if (other && (await isBlockedBetween(userId, other.user_id))) {
      throw new ApiError(403, "You can't send messages in this conversation");
    }
  }

  if (room.name === ANNOUNCEMENTS_ROOM_NAME && !(await canModerate(userId))) {
    throw new ApiError(403, "Only admins and moderators can post in the announcements channel");
  }
}

/** Insert a message and push it to the room and to every other member's notification channel. */
export async function sendRoomMessage(
  roomId: string,
  senderId: string,
  data: { type: string; content: string | null }
) {
  const message = await prisma.messages.create({
    data: { room_id: roomId, sender_id: senderId, type: data.type, content: data.content },
  });

  emitToRoom(roomId, "message:new", message);
  const members = await prisma.roomMembers.findMany({ where: { room_id: roomId }, select: { user_id: true } });
  const muted = await mutedUserIds(roomId, members.map((x) => x.user_id)).catch(() => new Set<string>());
  for (const m of members) {
    if (m.user_id !== senderId) {
      emitToUser(m.user_id, "message:notify", {
        muted: muted.has(m.user_id),
        roomId,
        messageId: message.id,
        senderId,
        createdAt: message.created_at,
        type: message.type,
        content: message.content ? message.content.slice(0, 200) : null,
      });
    }
  }
  void pushNewMessage(message);
  return message;
}
