import { prisma } from "@/lib/prisma";
import { ApiError } from "@/middleware/errorHandler";
import { refundEarnedCoins } from "@/lib/coins";
import { logAdminAction } from "@/lib/audit";
import { startTransfer } from "@/lib/flutterwave";

/**
 * Bank payouts for withdrawals. Ports process-withdrawal, which had no login check at all (anyone who
 * knew a withdrawal id could trigger the transfer) and could be run twice at once for the same
 * withdrawal, paying it out twice. Status flow:
 *   pending -> approved (admin) -> processing (transfer started) -> completed | failed (refunded)
 */

const reference = (withdrawalId: string) => `4GO-WD-${withdrawalId}`; // fixed per withdrawal: Flutterwave refuses a second transfer with it

/** Mark a processing withdrawal failed and give the coins back (into the withdrawable earned bucket). */
async function failAndRefund(withdrawalId: string, description: string, adminId?: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.withdrawals.updateMany({
      where: { id: withdrawalId, status: "processing" },
      data: { status: "failed", processed_at: new Date() },
    });
    if (count === 0) return false; // someone else already settled it
    const w = await tx.withdrawals.findUniqueOrThrow({ where: { id: withdrawalId } });
    await refundEarnedCoins(tx, w.user_id, w.amount, description);
    if (adminId) await logAdminAction(tx, adminId, "withdrawal_failed", w.user_id, null, { withdrawal_id: withdrawalId, amount: w.amount });
    return true;
  });
}

export type PayoutResult =
  | { ok: true; reference: string }
  | { ok: false; refunded: true; error: string }
  | { ok: false; refunded: false; error: string };

/** Start the bank transfer for an approved (or pending) withdrawal. */
export async function startPayout(withdrawalId: string, adminId: string): Promise<PayoutResult> {
  const ref = reference(withdrawalId);

  // Claim first, in one atomic update: a double click or a second admin gets a 409 instead of a second transfer.
  const claimed = await prisma.withdrawals.updateMany({
    where: { id: withdrawalId, status: { in: ["pending", "approved"] }, flutterwave_ref: null },
    data: { status: "processing", flutterwave_ref: ref },
  });
  if (claimed.count === 0) {
    const w = await prisma.withdrawals.findUnique({ where: { id: withdrawalId }, select: { status: true } });
    if (!w) throw new ApiError(404, "Withdrawal not found");
    throw new ApiError(409, w.status === "processing" ? "A transfer has already been started for this withdrawal" : `Withdrawal already ${w.status}`);
  }

  const w = await prisma.withdrawals.findUniqueOrThrow({ where: { id: withdrawalId } });
  const outcome = await startTransfer({
    reference: ref,
    bankCode: w.bank_code,
    accountNumber: w.account_number,
    accountName: w.account_name,
    amountNgn: Number(w.naira_amount),
  });

  if (outcome.kind === "queued") {
    await prisma.$transaction((tx) => logAdminAction(tx, adminId, "withdrawal_payout_started", w.user_id, null, { withdrawal_id: withdrawalId, reference: ref }));
    return { ok: true, reference: ref };
  }
  if (outcome.kind === "rejected") {
    await failAndRefund(withdrawalId, "Withdrawal refund (transfer failed)", adminId);
    return { ok: false, refunded: true, error: outcome.message };
  }
  // Timeout or network error: the transfer may have gone through, so don't refund. It stays "processing"
  // until the webhook reports the result or an admin settles it (complete / fail).
  return { ok: false, refunded: false, error: `Transfer status unknown (${outcome.message}). Check the Flutterwave dashboard before settling it.` };
}

/** Ports admin_complete_withdrawal (manual settle). */
export async function completeWithdrawal(withdrawalId: string, adminId: string) {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.withdrawals.updateMany({
      where: { id: withdrawalId, status: { in: ["pending", "approved", "processing"] } },
      data: { status: "completed", processed_at: new Date() },
    });
    if (count === 0) {
      const w = await tx.withdrawals.findUnique({ where: { id: withdrawalId }, select: { status: true } });
      if (!w) throw new ApiError(404, "Withdrawal not found");
      throw new ApiError(409, `Cannot complete a ${w.status} withdrawal`);
    }
    const w = await tx.withdrawals.findUniqueOrThrow({ where: { id: withdrawalId } });
    await logAdminAction(tx, adminId, "withdrawal_completed", w.user_id, null, { withdrawal_id: withdrawalId, amount: w.amount });
  });
}

/** Manually fail a stuck "processing" withdrawal and refund it (use after confirming no money left Flutterwave). */
export async function failWithdrawal(withdrawalId: string, adminId: string) {
  const done = await failAndRefund(withdrawalId, "Withdrawal refund (transfer failed)", adminId);
  if (!done) throw new ApiError(409, "Only a withdrawal that's being processed can be failed");
}

/** Flutterwave's transfer.completed webhook: settle the matching withdrawal. */
export async function handleTransferEvent(data: { reference?: string; status?: string }) {
  if (!data.reference) return;
  const w = await prisma.withdrawals.findFirst({ where: { flutterwave_ref: data.reference }, select: { id: true } });
  if (!w) return;
  const status = String(data.status ?? "").toUpperCase();
  if (status === "SUCCESSFUL") {
    await prisma.withdrawals.updateMany({
      where: { id: w.id, status: "processing" },
      data: { status: "completed", processed_at: new Date() },
    });
  } else if (status === "FAILED") {
    await failAndRefund(w.id, "Withdrawal refund (transfer failed)");
  }
}
