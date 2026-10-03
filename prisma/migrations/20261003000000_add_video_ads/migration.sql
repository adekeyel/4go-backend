-- Video ads shown inside user-uploaded videos. One row = one ad with one slot.
--   status:               active | paused | ended
--   placement:            pre_roll (before the video) | mid_roll (at mid_roll_at_seconds) | post_roll (after the video)
--   min_video_seconds:    the ad only runs on videos LONGER than this (30 = "longer than 30 seconds")
--   target_page_ids:      empty = every page's videos; otherwise only videos on these pages
--   starts_at / ends_at:  optional campaign window (NULL = no limit on that side)
--   duration_seconds:     length of the ad itself, as reported by Cloudinary
CREATE TABLE "video_ads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "advertiser_id" UUID,
    "title" TEXT NOT NULL,
    "video_url" TEXT NOT NULL,
    "thumbnail_url" TEXT,
    "duration_seconds" INTEGER,
    "target_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "placement" TEXT NOT NULL DEFAULT 'pre_roll',
    "mid_roll_at_seconds" INTEGER,
    "min_video_seconds" INTEGER NOT NULL DEFAULT 30,
    "target_page_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "skippable" BOOLEAN NOT NULL DEFAULT true,
    "skip_after_seconds" INTEGER NOT NULL DEFAULT 5,
    "starts_at" TIMESTAMPTZ(6),
    "ends_at" TIMESTAMPTZ(6),
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "completions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "video_ads_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "video_ads_status_check" CHECK ("status" IN ('active', 'paused', 'ended')),
    CONSTRAINT "video_ads_placement_check" CHECK ("placement" IN ('pre_roll', 'mid_roll', 'post_roll')),
    -- a mid-roll needs a time; the other placements must not carry one
    CONSTRAINT "video_ads_mid_roll_time_check" CHECK (
        ("placement" = 'mid_roll' AND "mid_roll_at_seconds" IS NOT NULL AND "mid_roll_at_seconds" > 0)
        OR ("placement" <> 'mid_roll' AND "mid_roll_at_seconds" IS NULL)
    ),
    CONSTRAINT "video_ads_min_video_check" CHECK ("min_video_seconds" >= 0),
    CONSTRAINT "video_ads_skip_after_check" CHECK ("skip_after_seconds" >= 0),
    CONSTRAINT "video_ads_window_check" CHECK ("starts_at" IS NULL OR "ends_at" IS NULL OR "ends_at" > "starts_at")
);

CREATE INDEX "video_ads_status_placement_idx" ON "video_ads"("status", "placement");
