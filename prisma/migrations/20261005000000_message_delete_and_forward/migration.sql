-- Delete for everyone (tombstone), forward label, and delete for me.
ALTER TABLE "messages" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);
ALTER TABLE "messages" ADD COLUMN "forwarded" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "message_deletions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "message_deletions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "message_deletions_message_id_user_id_key" ON "message_deletions"("message_id", "user_id");
CREATE INDEX "message_deletions_user_id_room_id_idx" ON "message_deletions"("user_id", "room_id");
