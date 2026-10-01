# Payments setup (step 8)

1. **New environment variable: `FLUTTERWAVE_WEBHOOK_HASH`.** Pick any long random string.
2. In the Flutterwave dashboard → Settings → Webhooks:
   - URL: `https://<your-api>/api/webhooks/flutterwave`
   - Secret hash: the same string as `FLUTTERWAVE_WEBHOOK_HASH`
   Without this the webhook answers 503 and nothing is lost, but then buyers who close the tab right after
   paying are still charged without getting their coins, premium or application. The webhook covers them, and
   it also reports payout results (`transfer.completed`).
3. No migration and no new npm packages.

What changed in behaviour
- Coins: ₦1 = 1 coin, and the coins credited can never exceed what was actually paid.
- Premium (₦2,500 monthly / ₦24,000 yearly) and verification (₦10,000) are priced by the server. Any `amount` the client sends for them is ignored.
- A payment can only be claimed by the account that made it.
- Premium expiry is now real: a background job (every 10 minutes) clears `profiles.is_premium` when a plan runs out.
  The first run after deploy also fixes existing stale flags.
- Payouts: approve a withdrawal (existing admin call), then `POST /api/payouts/:id/process`. Status goes
  pending → approved → processing → completed | failed (coins refunded).

If a payout is stuck in `processing` (Flutterwave timed out), check the Flutterwave dashboard, then
`POST /api/payouts/:id/complete` if the money left, or `POST /api/payouts/:id/fail` to refund the user.
