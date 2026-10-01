import crypto from "crypto";
import { Router } from "express";
import { env } from "@/lib/env";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { verifyTransaction } from "@/lib/flutterwave";
import { fulfillPayment } from "@/lib/payments";
import { handleTransferEvent } from "@/lib/payouts";

export const webhooksRouter = Router();

function sameSecret(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Flutterwave webhook: set the URL to https://<your-api>/api/webhooks/flutterwave and the "Secret hash"
 * to FLUTTERWAVE_WEBHOOK_HASH. It covers what the redirect can't: a buyer who pays and then closes the
 * tab used to be charged without getting their coins, premium or application. It also settles payouts
 * (transfer.completed). The body is never trusted for amounts: payments are re-checked with Flutterwave.
 */
webhooksRouter.post(
  "/flutterwave",
  asyncHandler(async (req, res) => {
    if (!env.flutterwave.webhookHash) throw new ApiError(503, "Webhook not configured");
    const sent = req.header("verif-hash") ?? "";
    if (!sent || !sameSecret(sent, env.flutterwave.webhookHash)) throw new ApiError(401, "Invalid signature");

    const event = String(req.body?.event ?? "");
    const data = req.body?.data ?? {};

    try {
      if (event === "charge.completed" && String(data.status).toLowerCase() === "successful" && data.id) {
        const verified = await verifyTransaction(data.id);
        if (verified?.successful) await fulfillPayment(verified); // no expectedUserId: the owner comes from the verified payment
      } else if (event === "transfer.completed") {
        await handleTransferEvent(data);
      }
    } catch (err) {
      // A payment we reject (unknown reference, underpaid, ...) will never succeed on retry: answer 200 so
      // Flutterwave stops. Anything else (database down, provider timeout) answers 500 so it retries.
      if (err instanceof ApiError && err.status < 500) console.warn("[webhook] ignored:", event, err.message);
      else throw err;
    }
    res.sendStatus(200);
  })
);
