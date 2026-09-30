-- Ported from Supabase migration 20260815161714
-- Tracks monetization granted manually by a Super Admin so rank recalculation doesn't revoke it.
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "manual_monetized" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: anyone currently monetized who did NOT earn it via rank was granted manually.
UPDATE "profiles"
SET "manual_monetized" = true
WHERE "is_monetized" = true AND "rank" NOT IN ('Master', 'King');
