# Step 1: calls

## Apply (backend: forego-backend-railway)
1. Unzip `step1-calls-BACKEND.zip` over the backend folder (same paths, it overwrites 11 files and adds 6 new ones + 1 migration).
2. Run:
       npx prisma migrate deploy
       npx prisma generate
   (migration only ADDS columns: call_logs.answered_at / ended_at, room_members.last_delivered_at. Nothing is dropped.)
3. Deploy / restart. The server now starts a small "ringing too long -> missed" sweeper.

## Apply (frontend)
Unzip `step1-calls-FRONTEND.zip` over the frontend folder (4 files). Deploy.
Users get the new service worker the next time they open the app.

## TURN relay (strongly recommended, this is what makes calls work on mobile data)
Add to the backend environment (Railway > backend service > Variables):
    TURN_URLS=turn:HOST:80,turns:HOST:443?transport=tcp
    TURN_USERNAME=...
    TURN_CREDENTIAL=...
Free option: a Metered.ca account (their free tier includes a TURN relay): create credentials in their dashboard and copy the URLs/username/password.
Own coturn server instead: set TURN_URLS and TURN_SHARED_SECRET (coturn `use-auth-secret`).
Check it works: log in on the site and open  <your-api>/api/calls/ice-servers  (needs the login token, easiest from the browser network tab): the response should list a `turn:` entry.

## Quick test (two phones/browsers, two accounts that are DM friends, both Novice+ rank)
1. A calls B, B answers, talk 20s, hang up  -> both chats show "Voice call  Outgoing/Incoming · 0:20".
2. A calls B, A hangs up before B answers  -> B sees "Missed voice call" (+ push notification), A sees "Cancelled call".
3. A calls B, B does nothing  -> after ~45s both screens stop ringing; B: "Missed voice call", A: "No answer".
4. A calls B, B declines  -> A: "Call declined", B: "You declined".
5. Close B's app completely, A calls B, tap the notification on B -> B's phone now rings/answers (before: "Waiting for the call signal" forever).
6. During a call switch one phone from wifi to mobile data -> call should recover within ~15s instead of dying.
