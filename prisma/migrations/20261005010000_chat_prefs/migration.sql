-- Per-person chat settings: pin, mute, archive, clear chat.
CREATE TABLE "chat_prefs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "pinned_at" TIMESTAMPTZ(6),
    "muted_until" TIMESTAMPTZ(6),
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "cleared_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_prefs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_prefs_user_id_room_id_key" ON "chat_prefs"("user_id", "room_id");
CREATE INDEX "chat_prefs_room_id_idx" ON "chat_prefs"("room_id");
