import { prisma } from "@/lib/prisma";
import { getIo, emitToRoom } from "@/sockets";

/**
 * Delivery receipts for direct messages (WhatsApp's grey double tick).
 *
 * room_members.last_delivered_at = "everything sent to this person before this time has reached one of
 * their devices". It moves forward in two situations:
 *   1. a message is sent while the recipient has the app open (socket connected), and
 *   2. the recipient's app connects (so messages sent while they were offline are delivered the moment they're back).
 *
 * "Read" (blue ticks) already exists separately in room_reads.last_read_at.
 */

export function isUserOnline(userId: string): boolean {
  return (getIo().sockets.adapter.rooms.get(`user:${userId}`)?.size ?? 0) > 0;
}

/** A message was just stored in a DM: mark it delivered for every recipient who is online right now. */
export async function deliverToOnlineRecipients(roomId: string, senderId: string) {
  try {
    const others = await prisma.roomMembers.findMany({
      where: { room_id: roomId, user_id: { not: senderId } },
      select: { user_id: true },
    });
    const now = new Date();
    for (const o of others) {
      if (!isUserOnline(o.user_id)) continue;
      await prisma.roomMembers.updateMany({ where: { room_id: roomId, user_id: o.user_id }, data: { last_delivered_at: now } });
      emitToRoom(roomId, "room:delivered", { roomId, userId: o.user_id, deliveredAt: now });
    }
  } catch (err) {
    console.error("[delivery] deliverToOnlineRecipients failed:", (err as Error).message);
  }
}

/** The user's app just connected: everything waiting for them in their DMs counts as delivered. */
export async function markDeliveredOnConnect(userId: string) {
  try {
    const mine = await prisma.roomMembers.findMany({ where: { user_id: userId }, select: { room_id: true } });
    if (!mine.length) return;
    const dms = await prisma.rooms.findMany({ where: { id: { in: mine.map((m) => m.room_id) }, type: "dm" }, select: { id: true } });
    if (!dms.length) return;
    const now = new Date();
    await prisma.roomMembers.updateMany({ where: { user_id: userId, room_id: { in: dms.map((d) => d.id) } }, data: { last_delivered_at: now } });
    for (const d of dms) emitToRoom(d.id, "room:delivered", { roomId: d.id, userId, deliveredAt: now });
  } catch (err) {
    console.error("[delivery] markDeliveredOnConnect failed:", (err as Error).message);
  }
}
