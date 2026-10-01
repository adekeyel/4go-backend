# Email setup (step 7)

The Supabase email system (pgmq queues, pg_cron dispatcher, Lovable email API) is replaced by a table
(`email_queue`) and a background worker inside your Express server that sends through Resend.

1. Run the migration: `npx prisma migrate deploy && npx prisma generate`
2. Environment variables (Railway → Variables):
   - `RESEND_API_KEY` (you already use it)
   - `EMAIL_FROM` (optional, default `forego <notify@notify.4go.com.ng>`; the domain must be verified in Resend)
   - **`PUBLIC_API_URL`**: the public address of this backend, e.g. `https://api.4go.com.ng`. **New.** It builds
     the unsubscribe links in broadcast emails. If it's missing, broadcasts still send but without an
     unsubscribe link or header, which you should not do for real campaigns.
3. No new npm packages (`resend` is already used).

How it behaves
- Verification and password-reset emails go in the `auth` queue: sent first, expire after 15 minutes, retried up to 5 times.
- Broadcast emails go in the `transactional` queue: expire after 60 minutes. Sending runs at about 5 per second.
  Tune it in the `email_send_state` row (`batch_size`, `send_delay_ms`, `auth_email_ttl_minutes`, `transactional_email_ttl_minutes`).
- A Resend rate limit (429) or a bad key / unverified domain (401/403) pauses the whole worker for 1 or 5 minutes
  instead of using up each message's retries. Invalid recipient addresses (400/422) go straight to `status = 'dlq'`.
- `email_send_log` records every outcome (`sent`, `failed`, `dlq`, `rate_limited`, `suppressed`).
- Addresses in `suppressed_emails` (your imported unsubscribes) never get broadcasts. Account emails (password reset) still send.
- Several server instances can run at once; they never send the same email twice.

Not migrated
- Emails still sitting in the old pgmq queues aren't in the export. Anything pending at cutover should be re-sent by hand.
- The magic-link, invite, email-change and reauthentication templates: this backend has no such flows.
