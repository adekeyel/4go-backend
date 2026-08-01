-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('super_admin', 'moderator', 'support', 'employee');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT,
    "phone" TEXT,
    "password_hash" TEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "user_agent" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "refresh_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_banners" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "advertiser_id" UUID,
    "image_url" TEXT NOT NULL,
    "target_url" TEXT NOT NULL,
    "placements" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "budget" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "position" TEXT NOT NULL DEFAULT 'middle',

    CONSTRAINT "ad_banners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_id" UUID,
    "actor_name" TEXT,
    "action" TEXT NOT NULL,
    "target_id" UUID,
    "target_label" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advertisers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "contact_email" TEXT,
    "contact_phone" TEXT,
    "notes" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "advertisers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL DEFAULT '{}',
    "label" TEXT,
    "category" TEXT NOT NULL DEFAULT 'general',
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "broadcast_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "channel" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "sent_by" UUID,
    "target_count" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "error_sample" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcast_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "room_id" UUID NOT NULL,
    "caller_id" UUID NOT NULL,
    "callee_id" UUID NOT NULL,
    "call_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "duration_seconds" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coin_purchases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payment_ref" TEXT,

    CONSTRAINT "coin_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contest_participants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "contest_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "rewarded" BOOLEAN NOT NULL DEFAULT false,
    "rewarded_at" TIMESTAMPTZ(6),
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "minutes_at_join" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "contest_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT NOT NULL,
    "description" TEXT,
    "reward_amount" INTEGER NOT NULL DEFAULT 1000,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "starts_at" TIMESTAMPTZ(6),
    "ends_at" TIMESTAMPTZ(6),
    "max_winners" INTEGER DEFAULT 10,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "criteria" TEXT NOT NULL DEFAULT 'online_minutes',
    "criteria_label" TEXT,

    CONSTRAINT "contests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_claims" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "claimed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_contacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" UUID NOT NULL,
    "phone_hash" TEXT NOT NULL,
    "contact_name" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_send_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "message_id" TEXT,
    "template_name" TEXT NOT NULL,
    "recipient_email" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error_message" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_send_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_send_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "retry_after_until" TIMESTAMPTZ(6),
    "batch_size" INTEGER NOT NULL DEFAULT 10,
    "send_delay_ms" INTEGER NOT NULL DEFAULT 200,
    "auth_email_ttl_minutes" INTEGER NOT NULL DEFAULT 15,
    "transactional_email_ttl_minutes" INTEGER NOT NULL DEFAULT 60,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_send_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_unsubscribe_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "token" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at" TIMESTAMPTZ(6),

    CONSTRAINT "email_unsubscribe_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_activity_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_activity_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "invited_user_id" UUID,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "friends" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "requester_id" UUID NOT NULL,
    "addressee_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "friends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sender_id" UUID NOT NULL,
    "receiver_id" UUID NOT NULL,
    "treasure_id" UUID NOT NULL,
    "room_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "message_id" UUID,

    CONSTRAINT "gift_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "global_notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "sent_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "global_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mentions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "mentioner_id" UUID NOT NULL,
    "mentioned_user_id" UUID NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "context_id" UUID,
    "preview" TEXT,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mentions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_reactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "emoji" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_views" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "viewed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "room_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'text',
    "content" TEXT,
    "media_url" TEXT,
    "duration" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMPTZ(6),
    "reply_to" UUID,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reporter_id" UUID NOT NULL,
    "target_user_id" UUID,
    "target_room_id" UUID,
    "target_message_id" UUID,
    "reason" TEXT NOT NULL,
    "details" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "muted_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "room_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "muted_by" UUID NOT NULL,
    "muted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "muted_until" TIMESTAMPTZ(6),
    "reason" TEXT,

    CONSTRAINT "muted_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_reads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "notification_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "read_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_reads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_followers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "page_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "followed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_followers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_post_unique_views" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "post_id" UUID NOT NULL,
    "viewer_id" UUID NOT NULL,
    "viewed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_post_unique_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_posts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "page_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "content" TEXT,
    "media_url" TEXT,
    "media_type" TEXT NOT NULL DEFAULT 'text',
    "views_count" INTEGER NOT NULL DEFAULT 0,
    "likes_count" INTEGER NOT NULL DEFAULT 0,
    "comments_count" INTEGER NOT NULL DEFAULT 0,
    "saves_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "about" TEXT,
    "category" TEXT,
    "profile_image" TEXT,
    "cover_image" TEXT,
    "followers_count" INTEGER NOT NULL DEFAULT 0,
    "is_monetized" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pinned_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "room_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "pinned_by" UUID NOT NULL,
    "pinned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pinned_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_boosts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "post_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "plan" TEXT NOT NULL,
    "coins_spent" INTEGER NOT NULL,
    "reach_target" INTEGER NOT NULL,
    "reach_count" INTEGER NOT NULL DEFAULT 0,
    "duration_hours" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_boosts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "parent_id" UUID,
    "edited_at" TIMESTAMPTZ(6),

    CONSTRAINT "post_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_likes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_likes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_saves" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "saved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_saves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "image_url" TEXT,
    "likes_count" INTEGER NOT NULL DEFAULT 0,
    "comments_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "username" TEXT,
    "display_name" TEXT,
    "avatar_url" TEXT,
    "bio" TEXT,
    "interests" TEXT[],
    "is_online" BOOLEAN DEFAULT false,
    "last_seen" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "phone_number" TEXT,
    "total_online_minutes" INTEGER NOT NULL DEFAULT 0,
    "rank" TEXT NOT NULL DEFAULT 'Amateur',
    "is_monetized" BOOLEAN NOT NULL DEFAULT false,
    "coins" INTEGER NOT NULL DEFAULT 0,
    "referral_code" TEXT,
    "purchased_coins" INTEGER NOT NULL DEFAULT 0,
    "earned_coins" INTEGER NOT NULL DEFAULT 0,
    "is_suspended" BOOLEAN NOT NULL DEFAULT false,
    "suspended_at" TIMESTAMPTZ(6),
    "suspended_reason" TEXT,
    "reward_coins" INTEGER NOT NULL DEFAULT 0,
    "is_premium" BOOLEAN NOT NULL DEFAULT false,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "referrer_id" UUID NOT NULL,
    "referred_id" UUID NOT NULL,
    "coins_rewarded" INTEGER NOT NULL DEFAULT 500,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_join_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "room_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fee_paid" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answers" TEXT[],

    CONSTRAINT "room_join_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "room_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_reads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "room_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "last_read_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_reads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL DEFAULT 'public',
    "avatar_url" TEXT,
    "created_by" UUID,
    "max_members" INTEGER DEFAULT 100,
    "is_active" BOOLEAN DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rules" TEXT,
    "join_fee" INTEGER NOT NULL DEFAULT 0,
    "join_questions" TEXT[],

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status_reactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "status_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "emoji" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "status_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status_views" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "status_id" UUID NOT NULL,
    "viewer_id" UUID NOT NULL,
    "viewed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "status_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "statuses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "media_url" TEXT,
    "caption" TEXT,
    "bg_color" TEXT,
    "text_content" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL DEFAULT (now() + '24:00:00'::interval),

    CONSTRAINT "statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "plan" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "amount_ngn" DECIMAL(12,2) NOT NULL,
    "payment_ref" TEXT,
    "current_period_start" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "current_period_end" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "super_admins" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "role" "AdminRole" NOT NULL DEFAULT 'super_admin',

    CONSTRAINT "super_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "subject" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "assigned_agent_id" UUID,
    "last_message" TEXT,
    "last_message_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unread_for_agent" INTEGER NOT NULL DEFAULT 0,
    "unread_for_user" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "is_agent" BOOLEAN NOT NULL DEFAULT false,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppressed_emails" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppressed_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'purchase',
    "description" TEXT,
    "reference_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasures" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "icon" TEXT NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "treasures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_blocks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "blocker_id" UUID NOT NULL,
    "blocked_id" UUID NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_applications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "amount_ngn" DECIMAL(12,2) NOT NULL DEFAULT 10000,
    "payment_ref" TEXT,
    "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMPTZ(6),
    "reviewed_by" UUID,
    "review_notes" TEXT,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "naira_amount" DECIMAL(12,2) NOT NULL,
    "bank_code" TEXT NOT NULL,
    "account_number" TEXT NOT NULL,
    "account_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "flutterwave_ref" TEXT,
    "processed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "refresh_sessions_user_id_idx" ON "refresh_sessions"("user_id");

-- CreateIndex
CREATE INDEX "ad_banners_status_idx" ON "ad_banners"("status");

-- CreateIndex
CREATE INDEX "admin_audit_logs_action_idx" ON "admin_audit_logs"("action");

-- CreateIndex
CREATE INDEX "admin_audit_logs_created_at_idx" ON "admin_audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "broadcast_deliveries_created_at_idx" ON "broadcast_deliveries"("created_at");

-- CreateIndex
CREATE INDEX "call_logs_callee_id_status_idx" ON "call_logs"("callee_id", "status");

-- CreateIndex
CREATE INDEX "call_logs_room_id_created_at_idx" ON "call_logs"("room_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "coin_purchases_payment_ref_key" ON "coin_purchases"("payment_ref");

-- CreateIndex
CREATE INDEX "contest_participants_contest_id_idx" ON "contest_participants"("contest_id");

-- CreateIndex
CREATE UNIQUE INDEX "contest_participants_contest_id_user_id_key" ON "contest_participants"("contest_id", "user_id");

-- CreateIndex
CREATE INDEX "device_contacts_phone_hash_idx" ON "device_contacts"("phone_hash");

-- CreateIndex
CREATE INDEX "device_contacts_owner_id_idx" ON "device_contacts"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_contacts_owner_id_phone_hash_key" ON "device_contacts"("owner_id", "phone_hash");

-- CreateIndex
CREATE INDEX "email_send_log_created_at_idx" ON "email_send_log"("created_at");

-- CreateIndex
CREATE INDEX "email_send_log_message_id_idx" ON "email_send_log"("message_id");

-- CreateIndex
CREATE INDEX "email_send_log_recipient_email_idx" ON "email_send_log"("recipient_email");

-- CreateIndex
CREATE UNIQUE INDEX "email_unsubscribe_tokens_token_key" ON "email_unsubscribe_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "email_unsubscribe_tokens_email_key" ON "email_unsubscribe_tokens"("email");

-- CreateIndex
CREATE INDEX "email_unsubscribe_tokens_token_idx" ON "email_unsubscribe_tokens"("token");

-- CreateIndex
CREATE INDEX "employee_activity_log_created_at_idx" ON "employee_activity_log"("created_at");

-- CreateIndex
CREATE INDEX "employee_activity_log_employee_id_created_at_idx" ON "employee_activity_log"("employee_id", "created_at");

-- CreateIndex
CREATE INDEX "employee_notifications_employee_id_created_at_idx" ON "employee_notifications"("employee_id", "created_at");

-- CreateIndex
CREATE INDEX "employee_notifications_invited_user_id_created_at_idx" ON "employee_notifications"("invited_user_id", "created_at");

-- CreateIndex
CREATE INDEX "friends_addressee_id_status_idx" ON "friends"("addressee_id", "status");

-- CreateIndex
CREATE INDEX "friends_requester_id_status_idx" ON "friends"("requester_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "friends_requester_id_addressee_id_key" ON "friends"("requester_id", "addressee_id");

-- CreateIndex
CREATE INDEX "global_notifications_created_at_idx" ON "global_notifications"("created_at");

-- CreateIndex
CREATE INDEX "mentions_mentioned_user_id_created_at_idx" ON "mentions"("mentioned_user_id", "created_at");

-- CreateIndex
CREATE INDEX "mentions_source_type_source_id_idx" ON "mentions"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "message_reactions_message_id_idx" ON "message_reactions"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_reactions_message_id_user_id_emoji_key" ON "message_reactions"("message_id", "user_id", "emoji");

-- CreateIndex
CREATE INDEX "message_views_message_id_idx" ON "message_views"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_views_user_id_message_id_key" ON "message_views"("user_id", "message_id");

-- CreateIndex
CREATE INDEX "messages_room_id_created_at_idx" ON "messages"("room_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_sender_id_idx" ON "messages"("sender_id");

-- CreateIndex
CREATE INDEX "moderation_reports_reporter_id_idx" ON "moderation_reports"("reporter_id");

-- CreateIndex
CREATE INDEX "moderation_reports_target_message_id_idx" ON "moderation_reports"("target_message_id");

-- CreateIndex
CREATE INDEX "moderation_reports_target_room_id_idx" ON "moderation_reports"("target_room_id");

-- CreateIndex
CREATE INDEX "moderation_reports_target_user_id_idx" ON "moderation_reports"("target_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "muted_members_room_id_user_id_key" ON "muted_members"("room_id", "user_id");

-- CreateIndex
CREATE INDEX "notification_reads_user_id_notification_id_idx" ON "notification_reads"("user_id", "notification_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_reads_notification_id_user_id_key" ON "notification_reads"("notification_id", "user_id");

-- CreateIndex
CREATE INDEX "page_followers_page_id_idx" ON "page_followers"("page_id");

-- CreateIndex
CREATE INDEX "page_followers_user_id_idx" ON "page_followers"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "page_followers_page_id_user_id_key" ON "page_followers"("page_id", "user_id");

-- CreateIndex
CREATE INDEX "page_post_unique_views_post_id_idx" ON "page_post_unique_views"("post_id");

-- CreateIndex
CREATE UNIQUE INDEX "page_post_unique_views_post_id_viewer_id_key" ON "page_post_unique_views"("post_id", "viewer_id");

-- CreateIndex
CREATE INDEX "page_posts_created_at_idx" ON "page_posts"("created_at");

-- CreateIndex
CREATE INDEX "page_posts_page_id_idx" ON "page_posts"("page_id");

-- CreateIndex
CREATE INDEX "pages_owner_id_idx" ON "pages"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "pinned_messages_room_id_message_id_key" ON "pinned_messages"("room_id", "message_id");

-- CreateIndex
CREATE INDEX "post_boosts_post_id_idx" ON "post_boosts"("post_id");

-- CreateIndex
CREATE INDEX "post_boosts_status_ends_at_idx" ON "post_boosts"("status", "ends_at");

-- CreateIndex
CREATE INDEX "post_comments_parent_id_idx" ON "post_comments"("parent_id");

-- CreateIndex
CREATE INDEX "post_comments_post_id_idx" ON "post_comments"("post_id");

-- CreateIndex
CREATE INDEX "post_likes_post_id_idx" ON "post_likes"("post_id");

-- CreateIndex
CREATE INDEX "post_likes_user_id_idx" ON "post_likes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "post_likes_user_id_post_id_key" ON "post_likes"("user_id", "post_id");

-- CreateIndex
CREATE INDEX "post_saves_user_id_idx" ON "post_saves"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "post_saves_user_id_post_id_key" ON "post_saves"("user_id", "post_id");

-- CreateIndex
CREATE INDEX "posts_created_at_idx" ON "posts"("created_at");

-- CreateIndex
CREATE INDEX "posts_user_id_idx" ON "posts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_user_id_key" ON "profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_username_key" ON "profiles"("username");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_referral_code_key" ON "profiles"("referral_code");

-- CreateIndex
CREATE INDEX "profiles_user_id_idx" ON "profiles"("user_id");

-- CreateIndex
CREATE INDEX "profiles_username_idx" ON "profiles"("username");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_user_id_endpoint_key" ON "push_subscriptions"("user_id", "endpoint");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_referred_id_key" ON "referrals"("referred_id");

-- CreateIndex
CREATE UNIQUE INDEX "room_join_requests_room_id_user_id_key" ON "room_join_requests"("room_id", "user_id");

-- CreateIndex
CREATE INDEX "room_members_room_id_user_id_idx" ON "room_members"("room_id", "user_id");

-- CreateIndex
CREATE INDEX "room_members_user_id_idx" ON "room_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "room_members_room_id_user_id_key" ON "room_members"("room_id", "user_id");

-- CreateIndex
CREATE INDEX "room_reads_user_id_room_id_idx" ON "room_reads"("user_id", "room_id");

-- CreateIndex
CREATE UNIQUE INDEX "room_reads_room_id_user_id_key" ON "room_reads"("room_id", "user_id");

-- CreateIndex
CREATE INDEX "status_reactions_status_id_idx" ON "status_reactions"("status_id");

-- CreateIndex
CREATE UNIQUE INDEX "status_reactions_status_id_user_id_key" ON "status_reactions"("status_id", "user_id");

-- CreateIndex
CREATE INDEX "status_views_status_id_idx" ON "status_views"("status_id");

-- CreateIndex
CREATE UNIQUE INDEX "status_views_status_id_viewer_id_key" ON "status_views"("status_id", "viewer_id");

-- CreateIndex
CREATE INDEX "statuses_expires_at_idx" ON "statuses"("expires_at");

-- CreateIndex
CREATE INDEX "statuses_user_id_created_at_idx" ON "statuses"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "subscriptions_user_id_status_current_period_end_idx" ON "subscriptions"("user_id", "status", "current_period_end");

-- CreateIndex
CREATE UNIQUE INDEX "super_admins_user_id_key" ON "super_admins"("user_id");

-- CreateIndex
CREATE INDEX "support_conversations_status_last_message_at_idx" ON "support_conversations"("status", "last_message_at");

-- CreateIndex
CREATE INDEX "support_conversations_user_id_idx" ON "support_conversations"("user_id");

-- CreateIndex
CREATE INDEX "support_messages_conversation_id_created_at_idx" ON "support_messages"("conversation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "suppressed_emails_email_key" ON "suppressed_emails"("email");

-- CreateIndex
CREATE INDEX "suppressed_emails_email_idx" ON "suppressed_emails"("email");

-- CreateIndex
CREATE INDEX "transactions_user_id_source_idx" ON "transactions"("user_id", "source");

-- CreateIndex
CREATE INDEX "transactions_user_id_created_at_idx" ON "transactions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "user_blocks_blocked_id_idx" ON "user_blocks"("blocked_id");

-- CreateIndex
CREATE INDEX "user_blocks_blocker_id_idx" ON "user_blocks"("blocker_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_blocks_blocker_id_blocked_id_key" ON "user_blocks"("blocker_id", "blocked_id");

-- CreateIndex
CREATE INDEX "verification_applications_status_idx" ON "verification_applications"("status");

-- CreateIndex
CREATE INDEX "verification_applications_user_id_idx" ON "verification_applications"("user_id");

-- AddForeignKey
ALTER TABLE "refresh_sessions" ADD CONSTRAINT "refresh_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
