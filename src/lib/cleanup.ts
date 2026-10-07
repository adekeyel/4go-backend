import { Tx } from "@/lib/coins";

/**
 * There are no ON DELETE CASCADE foreign keys any more, so deleting a message or a room has to remove what hangs
 * off it by hand. Gift rows are kept (they're money history) but detached from the deleted message.
 */
export async function deleteMessagesCascade(tx: Tx, messageIds: string[]) {
  if (!messageIds.length) return 0;
  await tx.messageReactions.deleteMany({ where: { message_id: { in: messageIds } } });
  await tx.messageViews.deleteMany({ where: { message_id: { in: messageIds } } });
  await tx.messageDeletions.deleteMany({ where: { message_id: { in: messageIds } } });
  await tx.pinnedMessages.deleteMany({ where: { message_id: { in: messageIds } } });
  await tx.mentions.deleteMany({ where: { source_type: "message", source_id: { in: messageIds } } });
  await tx.giftTransactions.updateMany({ where: { message_id: { in: messageIds } }, data: { message_id: null } });
  // Reports about the message stay (moderators still need them); they just lose the pointer's target row.
  await tx.messages.updateMany({ where: { reply_to: { in: messageIds } }, data: { reply_to: null } });
  const { count } = await tx.messages.deleteMany({ where: { id: { in: messageIds } } });
  return count;
}

export async function deleteRoomCascade(tx: Tx, roomId: string) {
  const ids = (await tx.messages.findMany({ where: { room_id: roomId }, select: { id: true } })).map((m) => m.id);
  for (let i = 0; i < ids.length; i += 5000) await deleteMessagesCascade(tx, ids.slice(i, i + 5000));
  await tx.roomMembers.deleteMany({ where: { room_id: roomId } });
  await tx.roomReads.deleteMany({ where: { room_id: roomId } });
  await tx.roomJoinRequests.deleteMany({ where: { room_id: roomId } });
  await tx.mutedMembers.deleteMany({ where: { room_id: roomId } });
  await tx.chatPrefs.deleteMany({ where: { room_id: roomId } });
  await tx.pinnedMessages.deleteMany({ where: { room_id: roomId } });
  await tx.callLogs.deleteMany({ where: { room_id: roomId } });
  await tx.giftTransactions.updateMany({ where: { room_id: roomId }, data: { room_id: null } });
  await tx.rooms.deleteMany({ where: { id: roomId } });
}
