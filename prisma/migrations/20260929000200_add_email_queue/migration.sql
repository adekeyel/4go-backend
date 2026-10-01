-- Replaces the Supabase pgmq queues (auth_emails, transactional_emails and their dead-letter queues).
-- One row per email. status: pending (waiting or retrying) | dlq (gave up; can be re-queued by an admin).
-- Rows are deleted once the email is sent; email_send_log keeps the history.
CREATE TABLE "email_queue" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "queue" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "to_email" TEXT NOT NULL,
    "from_email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "text" TEXT,
    "label" TEXT NOT NULL,
    "unsubscribe_token" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "visible_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "error_message" TEXT,
    "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "email_queue_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "email_queue_message_id_key" ON "email_queue"("message_id");
CREATE INDEX "email_queue_status_queue_visible_at_idx" ON "email_queue"("status", "queue", "visible_at");
CREATE INDEX "email_queue_label_status_idx" ON "email_queue"("label", "status");
