# Deploy checklist: 4GO backend port

Everything in this zip goes over your project root (same layout as your `src.zip`: `prisma/`, `src/`).

## 1. Install
```
npm i web-push
npm i -D @types/web-push
```
(`resend`, `zod`, `express`, `@prisma/client` are already used by your project.)

## 2. Database
```
npx prisma migrate deploy
npx prisma generate
psql "$DATABASE_URL" -f prisma/backfill_page_post_unique_views.sql    # once, after the migrations
```
Migrations added, in order:
1. `20260929000000_add_manual_monetized`: `profiles.manual_monetized`
2. `20260929000100_add_page_posts_unique_views_count`: `page_posts.unique_views_count`
3. `20260929000200_add_email_queue`: the `email_queue` table
4. `20260930000000_seed_app_settings`: default rows for `app_settings` (safe to re-run)

## 3. Check it compiles (I could not run the TypeScript compiler against a generated Prisma client)
```
npx tsc --noEmit
```

## 4. Environment variables: see `ENV-VARS.md`
Required for the features to work: `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (same pair as Supabase `send-push`),
`PUBLIC_API_URL`, `FLUTTERWAVE_WEBHOOK_HASH`. Optional: `EMAIL_FROM`, `VAPID_SUBJECT`, `REQUIRE_PHONE_FOR_RESET`.

## 5. Flutterwave dashboard
Settings > Webhooks: URL `https://<your-api>/api/webhooks/flutterwave`, secret hash = `FLUTTERWAVE_WEBHOOK_HASH`.

## 6. Before you open it to users
- **Staff roles.** Moderators, support agents and employees can now only do what their role allows. Check
  `GET /api/admin/admins` and give each person the right role. Anyone who relied on being able to do everything will see 403s.
- Make one real small payment (coins) and one real payout in test mode and check both settle.
- Send one test push and one test email (`POST /api/broadcast/email` to yourself is the quickest check).
- Point the service worker's `pushsubscriptionchange` handler at `POST /api/push/rotate`.

## 6b. Added in the frontend-gaps step (B1 to B10)
- Call pushes are now sent by the server from the real call row. Remove the three `send-push` calls in `CallContext.tsx`.
- Sockets: joining a room now requires membership, and `call:invite` is verified against `POST /api/calls`. Clients that emit `call:invite` must create the call row first (they already do) and no longer need to send `callerName`.
- Hand-verified users now stay verified (the old recompute removed the badge whenever a subscription changed).
- Settings in `app_settings` are stored and editable but **nothing enforces them yet** (signups_enabled, maintenance_mode, ...).
- Message delete is now sender or room admin only (it was any member). Moderators use `DELETE /api/admin/messages/:id`.

## 7. Frontend
`frontend.zip` has `API-changes.md`: every old Supabase call mapped to its new endpoint, plus the socket events.

## What the server now does by itself (background jobs, started at boot)
| Job | Every | What |
|-----|-------|------|
| Email worker | 5 s (and right after anything is queued) | sends queued emails through Resend |
| Premium sync | 10 min | marks expired subscriptions and clears `is_premium` |
| Presence sweep | 1 min | marks users offline after 3 minutes without a heartbeat |

These run inside the server process. If you run several instances they are safe (the email queue claims rows with
`SKIP LOCKED`; the other two are idempotent updates).

## Not ported, on purpose
- `get_user_id_by_email`, `verify_reset_phone` (as a public call), the `update_updated_at_column` / `touch_push_subscription_updated_at` triggers,
  the pgmq helpers (`delete_email`, `move_to_dlq`, `read_email_batch`, `email_queue_dispatch`, `email_queue_wake`) and the `tg_*` triggers:
  replaced by code in the app (see the notes in each file).
- Email templates for magic link, invite, email change, reauthentication: no such flows in this backend.
- Emails still sitting in the old pgmq queues at cutover.

## Known limits
- Supabase cron export failed (permission error), so I could not read the original schedules. The only schedule found in the
  files was the email dispatcher.
- `updated_at` is set by the code that changes a row; I did not add a database trigger. A direct SQL edit won't bump it.
- Suspending a user ends their sessions at once, but an access token already issued keeps working for up to 15 minutes
  for actions other than sending messages.

## Files in this package

### New
- src/lib/callPush.ts
- src/lib/cleanup.ts
- src/lib/realtime.ts
- src/routes/settings.ts
- prisma/migrations/20260930000000_seed_app_settings/migration.sql
- prisma/backfill_page_post_unique_views.sql
- prisma/migrations/20260929000000_add_manual_monetized/migration.sql
- prisma/migrations/20260929000100_add_page_posts_unique_views_count/migration.sql
- prisma/migrations/20260929000200_add_email_queue/migration.sql
- src/lib/audit.ts
- src/lib/coins.ts
- src/lib/economy.ts
- src/lib/emailPolicy.ts
- src/lib/emailQueue.ts
- src/lib/emailTemplates.ts
- src/lib/employees.ts
- src/lib/flutterwave.ts
- src/lib/joinRequests.ts
- src/lib/maintenance.ts
- src/lib/pageEconomy.ts
- src/lib/payments.ts
- src/lib/payouts.ts
- src/lib/postActions.ts
- src/lib/presence.ts
- src/lib/profileFlags.ts
- src/lib/push.ts
- src/lib/rank.ts
- src/lib/referrals.ts
- src/lib/roles.ts
- src/lib/roomMessages.ts
- src/lib/social.ts
- src/lib/support.ts
- src/routes/ads.ts
- src/routes/broadcast.ts
- src/routes/contacts.ts
- src/routes/contests.ts
- src/routes/email.ts
- src/routes/employees.ts
- src/routes/notifications.ts
- src/routes/pages.ts
- src/routes/payouts.ts
- src/routes/push.ts
- src/routes/referrals.ts
- src/routes/roomStats.ts
- src/routes/statuses.ts
- src/routes/support.ts
- src/routes/verification.ts
- src/routes/webhooks.ts
### Replaced (diff these against your copies first if you've edited them since uploading)
- src/routes/calls.ts
- src/routes/feed.ts
- src/routes/pages.ts
- src/lib/postActions.ts
- src/routes/broadcast.ts
- src/routes/contacts.ts
- src/lib/profileFlags.ts
- prisma/schema.prisma
- src/index.ts
- src/lib/email.ts
- src/lib/env.ts
- src/middleware/auth.ts
- src/routes/admin.ts
- src/routes/auth.ts
- src/routes/feed.ts
- src/routes/friends.ts
- src/routes/mentions.ts
- src/routes/messages.ts
- src/routes/payments.ts
- src/routes/profiles.ts
- src/routes/rooms.ts
- src/routes/wallet.ts
- src/sockets/index.ts