-- Call lifecycle: the server now owns the state of every call.
--   status: ringing -> answered | declined | cancelled | missed
--   answered_at / ended_at let the server compute the real call duration.
ALTER TABLE "call_logs" ADD COLUMN "answered_at" TIMESTAMPTZ(6);
ALTER TABLE "call_logs" ADD COLUMN "ended_at" TIMESTAMPTZ(6);

-- Used by the "ringing for too long -> missed" sweeper.
CREATE INDEX "call_logs_status_created_at_idx" ON "call_logs"("status", "created_at");

-- Message delivery receipts (WhatsApp's grey double tick).
-- Everything sent to a member before this time has reached one of their devices.
-- Existing rows default to "now": messages that already exist count as delivered.
ALTER TABLE "room_members" ADD COLUMN "last_delivered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now();
