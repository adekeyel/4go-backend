# Environment variables added by the port (steps 6–9b)

| Variable | Needed for | Notes |
|----------|-----------|-------|
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | push notifications | Use the same pair Supabase `send-push` used. `VAPID_SUBJECT` optional |
| `PUBLIC_API_URL` | email unsubscribe links | e.g. `https://api.4go.com.ng` |
| `EMAIL_FROM` | email sender | optional; domain must be verified in Resend |
| `FLUTTERWAVE_WEBHOOK_HASH` | payment + payout webhook | same value as the "Secret hash" in the Flutterwave dashboard |
| `REQUIRE_PHONE_FOR_RESET` | password-reset phone check | optional, `true` to turn on (see below) |

`REQUIRE_PHONE_FOR_RESET=true`: "forgot password" then also needs `phone` in the request body, and only sends the link
if it matches the phone number on the account (spaces and dashes ignored). Accounts with no phone number on file can
still reset by email. A wrong or missing phone looks exactly like an unknown email (silent), so nobody can use it to
discover someone's number. Leave it off until your frontend sends `phone`.
