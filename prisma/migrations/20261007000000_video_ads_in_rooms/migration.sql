-- Video ads can now also play inside videos shared in chat rooms.
ALTER TABLE "video_ads" ADD COLUMN "show_in_rooms" BOOLEAN NOT NULL DEFAULT false;

-- Ads that already run on "all pages" start running in room videos too. Ads aimed at specific pages do not:
-- a room video isn't part of any page, so those advertisers never bought it.
UPDATE "video_ads" SET "show_in_rooms" = true WHERE cardinality("target_page_ids") = 0;
