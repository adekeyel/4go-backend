import { ApiError } from "@/middleware/errorHandler";
import { Tx, lockProfile, lockProfiles, spendCoins } from "@/lib/coins";
import { incrementOnlineMinutes } from "@/lib/rank";

type GiftInput = {
  senderId: string;
  receiverId: string;
  treasureId: string;
  roomId?: string | null;
  /** Set for gifts on a post: receiver must be monetized and the coins land in their withdrawable bucket. */
  messageId?: string | null;
};

/**
 * Ports `send_gift` (messageId absent) and `send_gift_to_post` (messageId present).
 *  - room gift : receiver gets spendable reward coins, transaction source "gift"
 *  - post gift : receiver gets withdrawable earned coins, transaction source "earning"
 *
 * Differences from the SQL, all guards the original lacked:
 *  - can't gift yourself (a monetized user could otherwise turn reward coins into withdrawable earned coins)
 *  - receiver must exist (the SQL silently burned the sender's coins if the UPDATE matched no row)
 *  - for post gifts, the message must exist and belong to the receiver
 */
export async function sendGift(tx: Tx, input: GiftInput) {
  const { senderId, receiverId, treasureId, roomId = null, messageId = null } = input;
  const toPost = Boolean(messageId);

  if (senderId === receiverId) throw new ApiError(400, "You can't send a gift to yourself");

  await lockProfiles(tx, [senderId, receiverId]);

  const receiver = await tx.profiles.findUnique({
    where: { user_id: receiverId },
    select: { is_monetized: true },
  });
  if (!receiver) throw new ApiError(404, "Recipient not found");
  if (toPost && !receiver.is_monetized) throw new ApiError(403, "This user cannot receive gifts on posts");

  if (toPost) {
    const message = await tx.messages.findUnique({ where: { id: messageId! }, select: { sender_id: true } });
    if (!message || message.sender_id !== receiverId) throw new ApiError(404, "Post not found");
  }

  const treasure = await tx.treasures.findUnique({ where: { id: treasureId } });
  if (!treasure) throw new ApiError(404, "Treasure not found");

  // Throws "Insufficient coins" / "Insufficient bucket balance" like the SQL.
  await spendCoins(tx, senderId, treasure.price);

  await tx.profiles.update({
    where: { user_id: receiverId },
    data: {
      coins: { increment: treasure.price },
      ...(toPost
        ? { earned_coins: { increment: treasure.price } }
        : { reward_coins: { increment: treasure.price } }),
    },
  });

  const gift = await tx.giftTransactions.create({
    data: {
      sender_id: senderId,
      receiver_id: receiverId,
      treasure_id: treasureId,
      room_id: roomId,
      message_id: messageId,
    },
  });

  await tx.transactions.createMany({
    data: [
      {
        user_id: senderId,
        amount: -treasure.price,
        source: "spend",
        description: `Sent ${treasure.name} ${toPost ? "on post" : "gift"}`,
        reference_id: gift.id,
      },
      {
        user_id: receiverId,
        amount: treasure.price,
        source: toPost ? "earning" : "gift",
        description: `${toPost ? "Earned" : "Received"} ${treasure.name} ${toPost ? "on post" : "gift"}`,
        reference_id: gift.id,
      },
    ],
  });

  return { gift_id: gift.id, price: treasure.price };
}

/**
 * Ports `spend_coins_for_progress` (the 2-argument version that replaced the fixed 10,000-coin one).
 * 10,000 coins buys 300 online minutes; amounts must be multiples of 5,000, minimum 5,000.
 * Uses incrementOnlineMinutes so rank AND monetized/verified flags update immediately
 * (the SQL only updated rank and left the flags to the next presence heartbeat).
 */
export async function spendCoinsForProgress(tx: Tx, userId: string, amount = 10000) {
  if (!Number.isInteger(amount) || amount < 5000) throw new ApiError(400, "Minimum amount is 5,000 coins");
  if (amount % 5000 !== 0) throw new ApiError(400, "Amount must be in multiples of 5,000 coins");

  const bonusMinutes = Math.round((amount / 10000) * 300);

  const balances = await lockProfile(tx, userId);
  if (balances.coins < amount) {
    throw new ApiError(400, `Insufficient coins. Need ${amount} coins.`);
  }

  await spendCoins(tx, userId, amount);
  const after = await incrementOnlineMinutes(tx, userId, bonusMinutes);

  await tx.transactions.create({
    data: {
      user_id: userId,
      amount: -amount,
      source: "spend",
      description: `Level up - ${bonusMinutes} minutes added`,
    },
  });

  return {
    new_rank: after.rank,
    total_minutes: after.total_online_minutes,
    coins_spent: amount,
    minutes_added: bonusMinutes,
    coins_remaining: balances.coins - amount,
  };
}
