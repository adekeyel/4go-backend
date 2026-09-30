# Push notifications setup (step 6)

1. Install the library:
   `npm i web-push && npm i -D @types/web-push`

2. Set these environment variables (Railway → Variables):
   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `VAPID_SUBJECT` (optional, defaults to `mailto:support@4go.com.ng`; the old function used `mailto:admin@4go.com.ng`)

   **Use the same VAPID key pair the Supabase `send-push` function used** (Supabase dashboard → Edge Functions →
   Secrets). Your 100 imported subscriptions were created against that public key. With new keys, every one of
   them is rejected by the push service and users would have to re-subscribe. Only generate a new pair
   (`npx web-push generate-vapid-keys`) if you're happy to make everyone re-enable notifications.

3. Without the keys the server logs one warning and push is silently skipped, so nothing else breaks.
