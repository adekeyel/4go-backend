-- Record of ads shown, so view / completion / click counting is exact across restarts and several server
-- instances. One row per serve token that produced a view.
--   completed_at / clicked_at: set once, the first time that event arrives (NULL = hasn't happened)
--   viewer_hash:               keyed hash of the account (or address for guests) - used for the per-viewer cap
-- Rows are only needed while their token is valid (2 hours); a maintenance job deletes older ones.
CREATE TABLE "video_ad_views" (
    "nonce" TEXT NOT NULL,
    "ad_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "viewer_hash" TEXT NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "clicked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "video_ad_views_pkey" PRIMARY KEY ("nonce")
);

CREATE INDEX "video_ad_views_ad_id_viewer_hash_created_at_idx" ON "video_ad_views"("ad_id", "viewer_hash", "created_at");
CREATE INDEX "video_ad_views_created_at_idx" ON "video_ad_views"("created_at");
