-- Per-person call history state: "seen" marker (missed-call badge) and "clear call log" marker.
CREATE TABLE "call_history_state" (
    "user_id" UUID NOT NULL,
    "seen_at" TIMESTAMPTZ(6),
    "cleared_at" TIMESTAMPTZ(6),
    CONSTRAINT "call_history_state_pkey" PRIMARY KEY ("user_id")
);

-- Speeds up "my calls" (history + missed badge): look up by either side of the call.
CREATE INDEX "call_logs_caller_id_created_at_idx" ON "call_logs"("caller_id", "created_at");
CREATE INDEX "call_logs_callee_id_created_at_idx" ON "call_logs"("callee_id", "created_at");
