import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { canModerate, isSuperAdmin } from "@/lib/roles";
import { resolveBankAccount } from "@/lib/flutterwave";
import { completeWithdrawal, failWithdrawal, startPayout } from "@/lib/payouts";

export const payoutsRouter = Router();
payoutsRouter.use(requireAuth);

const uuid = z.string().uuid();

// Checking an account costs a Flutterwave call and reveals the holder's name, so it needs a login
// (the old function was public) and is capped per user.
const recent = new Map<string, number[]>();
function allowResolve(userId: string): boolean {
  const now = Date.now();
  const hits = (recent.get(userId) ?? []).filter((t) => now - t < 3_600_000);
  if (hits.length >= 20) return false;
  hits.push(now);
  recent.set(userId, hits);
  return true;
}

// Ports resolve-account: look up the account holder's name before a withdrawal request.
payoutsRouter.post(
  "/resolve-account",
  asyncHandler(async (req, res) => {
    const body = z.object({ account_number: z.string().regex(/^\d{10}$/, "Account number must be 10 digits"), account_bank: z.string().min(1).max(20) }).parse(req.body);
    if (!allowResolve(req.userId!)) throw new ApiError(429, "Too many lookups, try again later");
    const result = await resolveBankAccount(body.account_number, body.account_bank);
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, account_name: result.account_name, account_number: result.account_number });
  })
);

// Money out: super admin only.
payoutsRouter.post(
  "/:withdrawalId/process",
  asyncHandler(async (req, res) => {
    if (!(await isSuperAdmin(req.userId!))) throw new ApiError(403, "Only Super Admins can send payouts");
    const result = await startPayout(uuid.parse(req.params.withdrawalId), req.userId!);
    if (result.ok) return res.json({ success: true, message: "Transfer initiated", ref: result.reference });
    res.status(result.refunded ? 400 : 502).json({ success: false, refunded: result.refunded, error: result.error });
  })
);

// Mark a withdrawal paid by hand (moderators can, like admin_complete_withdrawal).
payoutsRouter.post(
  "/:withdrawalId/complete",
  asyncHandler(async (req, res) => {
    if (!(await canModerate(req.userId!))) throw new ApiError(403, "Not authorized");
    await completeWithdrawal(uuid.parse(req.params.withdrawalId), req.userId!);
    res.json({ status: "completed" });
  })
);

// Fail a stuck "processing" withdrawal and refund it (super admin only).
payoutsRouter.post(
  "/:withdrawalId/fail",
  asyncHandler(async (req, res) => {
    if (!(await isSuperAdmin(req.userId!))) throw new ApiError(403, "Only Super Admins can do this");
    await failWithdrawal(uuid.parse(req.params.withdrawalId), req.userId!);
    res.json({ status: "failed" });
  })
);
