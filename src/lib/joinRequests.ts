import { prisma } from "@/lib/prisma";
import { ApiError } from "@/middleware/errorHandler";
import { creditRewardCoins, spendCoins } from "@/lib/coins";

/**
 * Private-room join requests with a joining fee. The fee moves like this:
 *   request  : taken from the requester (reward, then earned, then purchased coins)
 *   approve  : paid to the room's creator as withdrawable earnings
 *   reject   : refunded to the requester as reward coins ("Room join fee refunded")
 * The Express version only changed the `coins` total: the fee was never paid to the creator on approval,
 * and the coin buckets drifted away from the total, so later spending failed.
 */

export async function createJoinRequest(
  userId: string,
  room: { id: string; name: string; join_fee: number | null },
  answers: string[] | undefined
) {
  const fee = room.join_fee ?? 0;
  return prisma.$transaction(async (tx) => {
    const prior = await tx.roomJoinRequests.findUnique({
      where: { room_id_user_id: { room_id: room.id, user_id: userId } },
    });
    if (prior?.status === "pending") throw new ApiError(409, "Join request already sent");
    if (prior?.status === "approved") {
      // "approved" only blocks you while you're still in the room; someone who left or was removed can ask again.
      const stillMember = await tx.roomMembers.findUnique({
        where: { room_id_user_id: { room_id: room.id, user_id: userId } },
        select: { id: true },
      });
      if (stillMember) throw new ApiError(409, "You're already a member");
    }

    if (fee > 0) {
      try {
        await spendCoins(tx, userId, fee);
      } catch (err) {
        if (err instanceof ApiError && err.status === 400) throw new ApiError(400, `Not enough coins. You need ${fee} coins to request.`);
        throw err;
      }
      await tx.transactions.create({
        data: { user_id: userId, amount: -fee, source: "spend", description: `Room join fee: ${room.name}` },
      });
    }
    // (room_id, user_id) is unique, so a previously rejected request is reopened instead of colliding.
    return tx.roomJoinRequests.upsert({
      where: { room_id_user_id: { room_id: room.id, user_id: userId } },
      create: { room_id: room.id, user_id: userId, fee_paid: fee, answers: answers ?? [], status: "pending" },
      update: { fee_paid: fee, answers: answers ?? [], status: "pending", updated_at: new Date() },
    });
  });
}

/** Ports approve_join_request / reject_join_request. A request can be settled exactly once. */
export async function reviewJoinRequest(
  request: { id: string; room_id: string; user_id: string; fee_paid: number },
  decision: "approve" | "reject"
) {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.roomJoinRequests.updateMany({
      where: { id: request.id, room_id: request.room_id, status: "pending" },
      data: { status: decision === "approve" ? "approved" : "rejected", updated_at: new Date() },
    });
    if (count === 0) throw new ApiError(409, "Request not found or already processed");

    if (decision === "approve") {
      await tx.roomMembers.createMany({
        data: [{ room_id: request.room_id, user_id: request.user_id, role: "member" }],
        skipDuplicates: true,
      });
      if (request.fee_paid > 0) {
        const room = await tx.rooms.findUnique({ where: { id: request.room_id }, select: { created_by: true } });
        if (room?.created_by) {
          await tx.profiles.update({
            where: { user_id: room.created_by },
            data: { coins: { increment: request.fee_paid }, earned_coins: { increment: request.fee_paid } },
          });
          await tx.transactions.create({
            data: { user_id: room.created_by, amount: request.fee_paid, source: "earning", description: "Room joining fee received" },
          });
        }
      }
    } else if (request.fee_paid > 0) {
      await creditRewardCoins(tx, request.user_id, request.fee_paid, "Room join fee refunded");
    }
  });
}
