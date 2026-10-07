import { prisma } from "@/lib/prisma";

/** Muted "for ever" is stored as a date far in the future so one column covers every mute length. */
export const MUTE_FOREVER = new Date("2999-01-01T00:00:00.000Z");
export const MAX_PINNED_CHATS = 3; // same limit as WhatsApp

/** Of these people, who has muted this room right now? (Muted people still get the message and unread badge, but no push / sound / banner.) */
export async function mutedUserIds(roomId: string, userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const rows = await prisma.chatPrefs.findMany({
    where: { room_id: roomId, user_id: { in: userIds }, muted_until: { gt: new Date() } },
    select: { user_id: true },
  });
  return new Set(rows.map((r) => r.user_id));
}

/** A new message brings an archived chat back to the main list, unless that person muted it (WhatsApp behaviour). */
export async function unarchiveOnNewMessage(roomId: string) {
  const now = new Date();
  await prisma.chatPrefs.updateMany({
    where: { room_id: roomId, archived: true, OR: [{ muted_until: null }, { muted_until: { lte: now } }] },
    data: { archived: false, updated_at: now },
  });
}

/** When did this person last clear this chat? Messages at or before that moment are not shown to them. */
export async function clearedAtFor(roomId: string, userId: string): Promise<Date | null> {
  const row = await prisma.chatPrefs.findUnique({
    where: { user_id_room_id: { user_id: userId, room_id: roomId } },
    select: { cleared_at: true },
  });
  return row?.cleared_at ?? null;
}
