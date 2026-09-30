-- Ported from Supabase migration 20260426050923.
-- page_posts.unique_views_count was missing from the Prisma init migration, so imported values were dropped.
ALTER TABLE "page_posts" ADD COLUMN IF NOT EXISTS "unique_views_count" INTEGER NOT NULL DEFAULT 0;

-- Best-effort backfill from the per-viewer rows. prisma/backfill_page_post_unique_views.sql restores the
-- exact exported values afterwards.
UPDATE "page_posts" pp
SET "unique_views_count" = v.c
FROM (SELECT "post_id", COUNT(*)::int AS c FROM "page_post_unique_views" GROUP BY "post_id") v
WHERE pp."id" = v."post_id" AND pp."unique_views_count" = 0;
