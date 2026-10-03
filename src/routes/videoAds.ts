import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { uploadAdVideo } from "@/middleware/upload";
import { uploadBuffer, videoThumbnailUrl } from "@/lib/cloudinary";
import { logAdminAction } from "@/lib/audit";
import { selectAds } from "@/lib/videoAdSelect";

export const videoAdsRouter = Router();

const uuid = z.string().uuid();

// Ad videos are played inside every viewer's browser, so require https (a plain http video would be
// blocked as mixed content anyway). Links and images follow the same rule as banner ads: web addresses
// only, never javascript: or data: URLs.
const httpsUrl = z.string().url().max(2048).refine((u) => /^https:\/\//i.test(u), "Must be an https URL");
const webUrl = z.string().url().max(2048).refine((u) => /^https?:\/\//i.test(u), "Must be an http(s) URL");

// Same audience as banner ads (old RLS: moderators and super admins).
const staff = [requireAuth, requireRole("super_admin", "moderator")];

// ------------------------------------------------------------------------------ public: serving

// "Which ads play inside this video?" The player calls this once it knows the video's real length (from
// the browser's loaded metadata). The page comes from the post itself, not from the caller, so page targeting
// can't be spoofed and only genuine page-post videos ever get ads. Nothing is counted here: an ad is only
// counted when the player actually plays it (step 6).
const serveQuery = z.object({
  post_id: uuid,
  duration: z.coerce.number().min(0).max(86_400),
});

videoAdsRouter.get(
  "/serve",
  asyncHandler(async (req, res) => {
    const { post_id, duration } = serveQuery.parse(req.query);
    res.set("Cache-Control", "no-store"); // the pick is random per request

    const post = await prisma.pagePosts.findUnique({ where: { id: post_id }, select: { page_id: true, media_type: true } });
    if (!post || post.media_type !== "video") return res.json({ ads: [] });

    const now = new Date();
    // Status, campaign window and page targeting are filtered in the database. The "longer than N seconds"
    // check happens in selectAds, because Prisma won't compare a whole-number column to a fractional length.
    const candidates = await prisma.videoAds.findMany({
      where: {
        status: "active",
        AND: [
          { OR: [{ starts_at: null }, { starts_at: { lte: now } }] },
          { OR: [{ ends_at: null }, { ends_at: { gt: now } }] },
          { OR: [{ target_page_ids: { isEmpty: true } }, { target_page_ids: { has: post.page_id } }] },
        ],
      },
      select: {
        id: true, video_url: true, thumbnail_url: true, duration_seconds: true, target_url: true,
        placement: true, mid_roll_at_seconds: true, min_video_seconds: true, skippable: true, skip_after_seconds: true,
      },
    });

    // Only what the player needs: no budget, counters, targeting or admin fields.
    const ads = selectAds(candidates, duration).map(({ min_video_seconds: _min, ...ad }) => ad);
    res.json({ ads });
  })
);

// ------------------------------------------------------------------------------ admin: upload

// Step 1 of creating an ad: send the video file, get back its hosted URL, thumbnail and length.
// The length comes from Cloudinary, not from the browser, so it can be trusted.
videoAdsRouter.post(
  "/admin/upload",
  ...staff,
  uploadAdVideo("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError(400, "No file provided");
    const result = await uploadBuffer(req.file.buffer, {
      folder: `forego/video-ads/${req.userId}`,
      resourceType: "video",
    });
    res.status(201).json({
      video_url: result.url,
      thumbnail_url: videoThumbnailUrl(result.publicId),
      duration_seconds: result.duration != null ? Math.round(result.duration) : null,
    });
  })
);

// ------------------------------------------------------------------------------ admin: CRUD

const dateOrNull = z
  .string()
  .datetime({ offset: true })
  .nullish()
  .transform((v) => (v ? new Date(v) : null));

const fields = z.object({
  advertiser_id: z.string().uuid().nullish(),
  title: z.string().trim().min(1).max(150),
  video_url: httpsUrl,
  thumbnail_url: webUrl.nullish(),
  duration_seconds: z.number().int().min(0).max(86_400).nullish(),
  target_url: webUrl.nullish(),
  status: z.enum(["active", "paused", "ended"]).default("active"),
  // Where in the video the ad plays.
  placement: z.enum(["pre_roll", "mid_roll", "post_roll"]).default("pre_roll"),
  mid_roll_at_seconds: z.number().int().min(1).max(86_400).nullish(),
  // The ad only runs on videos LONGER than this many seconds.
  min_video_seconds: z.number().int().min(0).max(86_400).default(30),
  // Empty = videos on every page.
  target_page_ids: z.array(uuid).max(200).default([]),
  skippable: z.boolean().default(true),
  skip_after_seconds: z.number().int().min(0).max(60).default(5),
  // When the campaign runs. null = no limit on that side.
  starts_at: dateOrNull,
  ends_at: dateOrNull,
});

const createSchema = fields;
const patchSchema = fields.partial();

/** Rules that span several fields. Run on the full, merged ad so a PATCH can't produce an invalid combination. */
function checkRules(ad: {
  placement?: string;
  mid_roll_at_seconds?: number | null;
  starts_at?: Date | null;
  ends_at?: Date | null;
}) {
  if (ad.placement === "mid_roll" && ad.mid_roll_at_seconds == null) {
    throw new ApiError(400, "A mid-roll ad needs the time (in seconds) it should play at");
  }
  if (ad.placement !== "mid_roll" && ad.mid_roll_at_seconds != null) {
    throw new ApiError(400, "Only mid-roll ads can have a play time");
  }
  if (ad.starts_at && ad.ends_at && ad.ends_at <= ad.starts_at) {
    throw new ApiError(400, "The end date must be after the start date");
  }
}

/** The database has no foreign keys here, so check the references ourselves and give a readable error. */
async function checkReferences(advertiserId: string | null | undefined, pageIds: string[] | undefined) {
  if (advertiserId) {
    const found = await prisma.advertisers.findUnique({ where: { id: advertiserId }, select: { id: true } });
    if (!found) throw new ApiError(400, "That advertiser doesn't exist");
  }
  if (pageIds && pageIds.length > 0) {
    const unique = [...new Set(pageIds)];
    const count = await prisma.pages.count({ where: { id: { in: unique } } });
    if (count !== unique.length) throw new ApiError(400, "One or more of the selected pages don't exist");
  }
}

// Lets the admin screen find pages to target. ?q= searches by name (top 20 by followers);
// ?ids=a,b,c looks up specific pages (used to show the names of already-selected pages).
videoAdsRouter.get(
  "/admin/pages",
  ...staff,
  asyncHandler(async (req, res) => {
    const ids =
      typeof req.query.ids === "string" && req.query.ids
        ? req.query.ids.split(",").slice(0, 200).map((i) => uuid.parse(i))
        : null;
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    const where = ids ? { id: { in: ids } } : q ? { name: { contains: q, mode: "insensitive" as const } } : {};
    res.json(
      await prisma.pages.findMany({
        where,
        select: { id: true, name: true, profile_image: true, followers_count: true },
        orderBy: { followers_count: "desc" },
        take: ids ? 200 : 20,
      })
    );
  })
);

videoAdsRouter.get(
  "/admin/ads",
  ...staff,
  asyncHandler(async (_req, res) => {
    res.json(await prisma.videoAds.findMany({ orderBy: { created_at: "desc" } }));
  })
);

videoAdsRouter.post(
  "/admin/ads",
  ...staff,
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    checkRules(body);
    body.target_page_ids = [...new Set(body.target_page_ids)];
    await checkReferences(body.advertiser_id, body.target_page_ids);

    const ad = await prisma.$transaction(async (tx) => {
      const created = await tx.videoAds.create({
        data: { ...body, advertiser_id: body.advertiser_id ?? null, created_by: req.userId! },
      });
      await logAdminAction(tx, req.userId!, "video_ad_created", created.id, created.title, { placement: created.placement });
      return created;
    });
    res.status(201).json(ad);
  })
);

videoAdsRouter.patch(
  "/admin/ads/:adId",
  ...staff,
  asyncHandler(async (req, res) => {
    const id = uuid.parse(req.params.adId);
    const patch = patchSchema.parse(req.body);

    const existing = await prisma.videoAds.findUnique({ where: { id } });
    if (!existing) throw new ApiError(404, "Video ad not found");

    // Switching away from mid-roll drops the play time unless the caller set one explicitly
    // (which checkRules then rejects, as it should).
    if (patch.placement && patch.placement !== "mid_roll" && !("mid_roll_at_seconds" in patch)) {
      patch.mid_roll_at_seconds = null;
    }

    const merged = { ...existing, ...patch };
    checkRules(merged);
    if (patch.target_page_ids) patch.target_page_ids = [...new Set(patch.target_page_ids)];
    await checkReferences(patch.advertiser_id, patch.target_page_ids);

    const ad = await prisma.$transaction(async (tx) => {
      const updated = await tx.videoAds.update({ where: { id }, data: { ...patch, updated_at: new Date() } });
      const action = patch.status && patch.status !== existing.status ? `video_ad_${patch.status}` : "video_ad_updated";
      await logAdminAction(tx, req.userId!, action, id, updated.title, { changed: Object.keys(patch) });
      return updated;
    });
    res.json(ad);
  })
);

videoAdsRouter.delete(
  "/admin/ads/:adId",
  ...staff,
  asyncHandler(async (req, res) => {
    const id = uuid.parse(req.params.adId);
    await prisma.$transaction(async (tx) => {
      const existing = await tx.videoAds.findUnique({ where: { id }, select: { title: true } });
      if (!existing) throw new ApiError(404, "Video ad not found");
      await tx.videoAds.delete({ where: { id } });
      await logAdminAction(tx, req.userId!, "video_ad_deleted", id, existing.title, {});
    });
    res.status(204).send();
  })
);
