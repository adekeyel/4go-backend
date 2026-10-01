import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { logAdminAction } from "@/lib/audit";

export const adsRouter = Router();

const uuid = z.string().uuid();
// Links and images come from admins but end up in every user's browser: allow web addresses only
// (not javascript: or data: URLs).
const webUrl = z.string().url().max(2048).refine((u) => /^https?:\/\//i.test(u), "Must be an http(s) URL");

// ------------------------------------------------------------------------------ public

// Active banners. Optional ?placement=home|room|menu|feed|profile|dm and ?position=top|middle.
adsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const placement = typeof req.query.placement === "string" ? req.query.placement : undefined;
    const position = typeof req.query.position === "string" ? req.query.position : undefined;
    const banners = await prisma.adBanners.findMany({
      where: { status: "active", ...(placement ? { placements: { has: placement } } : {}), ...(position ? { position } : {}) },
      orderBy: { created_at: "desc" },
      select: { id: true, image_url: true, target_url: true, placements: true, position: true },
    });
    res.json(banners);
  })
);

// Ports track_ad_event (callable without logging in, as before). The original let a script bump the
// counters as fast as it liked; the same address repeating the same event for the same banner within
// 30 seconds is now counted once.
const seen = new Map<string, number>();
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [k, t] of seen) if (t < cutoff) seen.delete(k);
}, 60_000).unref();

adsRouter.post(
  "/:bannerId/events",
  asyncHandler(async (req, res) => {
    const bannerId = uuid.parse(req.params.bannerId);
    const { event } = z.object({ event: z.enum(["impression", "click"]) }).parse(req.body);
    const key = `${req.ip}|${bannerId}|${event}`;
    const now = Date.now();
    if ((seen.get(key) ?? 0) > now - 30_000) return res.status(204).send();
    seen.set(key, now);

    await prisma.adBanners.updateMany({
      where: { id: bannerId, status: "active" },
      data: event === "impression" ? { impressions: { increment: 1 } } : { clicks: { increment: 1 } },
    });
    res.status(204).send();
  })
);

// ------------------------------------------------------------------------------ admin (moderators and super admins, like the old RLS)

const staff = [requireAuth, requireRole("super_admin", "moderator")];

adsRouter.get(
  "/admin/banners",
  ...staff,
  asyncHandler(async (_req, res) => {
    const banners = await prisma.adBanners.findMany({ orderBy: { created_at: "desc" } });
    res.json(banners.map((b) => ({ ...b, budget: Number(b.budget) })));
  })
);

const bannerSchema = z.object({
  advertiser_id: z.string().uuid().nullish(),
  image_url: webUrl,
  target_url: webUrl,
  placements: z.array(z.enum(["home", "room", "menu", "feed", "profile", "dm"])).min(1),
  budget: z.number().min(0).max(1_000_000_000).default(0),
  status: z.enum(["active", "paused", "ended"]).default("active"),
  position: z.enum(["top", "middle"]).default("middle"),
});

adsRouter.post(
  "/admin/banners",
  ...staff,
  asyncHandler(async (req, res) => {
    const body = bannerSchema.parse(req.body);
    const banner = await prisma.$transaction(async (tx) => {
      const created = await tx.adBanners.create({ data: { ...body, advertiser_id: body.advertiser_id ?? null, created_by: req.userId! } });
      await logAdminAction(tx, req.userId!, "ad_banner_created", null, null, { banner_id: created.id });
      return created;
    });
    res.status(201).json({ ...banner, budget: Number(banner.budget) });
  })
);

adsRouter.patch(
  "/admin/banners/:bannerId",
  ...staff,
  asyncHandler(async (req, res) => {
    const id = uuid.parse(req.params.bannerId);
    const body = bannerSchema.partial().parse(req.body);
    const { count } = await prisma.adBanners.updateMany({ where: { id }, data: body });
    if (count === 0) throw new ApiError(404, "Banner not found");
    const banner = await prisma.adBanners.findUniqueOrThrow({ where: { id } });
    res.json({ ...banner, budget: Number(banner.budget) });
  })
);

adsRouter.delete(
  "/admin/banners/:bannerId",
  ...staff,
  asyncHandler(async (req, res) => {
    const id = uuid.parse(req.params.bannerId);
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.adBanners.deleteMany({ where: { id } });
      if (count === 0) throw new ApiError(404, "Banner not found");
      await logAdminAction(tx, req.userId!, "ad_banner_deleted", null, null, { banner_id: id });
    });
    res.status(204).send();
  })
);

adsRouter.get(
  "/admin/advertisers",
  ...staff,
  asyncHandler(async (_req, res) => {
    res.json(await prisma.advertisers.findMany({ orderBy: { created_at: "desc" } }));
  })
);

const advertiserSchema = z.object({
  name: z.string().trim().min(1).max(150),
  contact_email: z.string().email().nullish(),
  contact_phone: z.string().max(40).nullish(),
  notes: z.string().max(2000).nullish(),
});

adsRouter.post(
  "/admin/advertisers",
  ...staff,
  asyncHandler(async (req, res) => {
    const body = advertiserSchema.parse(req.body);
    res.status(201).json(await prisma.advertisers.create({ data: { ...body, created_by: req.userId! } }));
  })
);

adsRouter.patch(
  "/admin/advertisers/:advertiserId",
  ...staff,
  asyncHandler(async (req, res) => {
    const id = uuid.parse(req.params.advertiserId);
    const { count } = await prisma.advertisers.updateMany({ where: { id }, data: advertiserSchema.partial().parse(req.body) });
    if (count === 0) throw new ApiError(404, "Advertiser not found");
    res.json(await prisma.advertisers.findUniqueOrThrow({ where: { id } }));
  })
);

// Deleting an advertiser keeps their banners (the link is simply cleared), so no campaign vanishes by accident.
adsRouter.delete(
  "/admin/advertisers/:advertiserId",
  ...staff,
  asyncHandler(async (req, res) => {
    const id = uuid.parse(req.params.advertiserId);
    await prisma.$transaction(async (tx) => {
      await tx.adBanners.updateMany({ where: { advertiser_id: id }, data: { advertiser_id: null } });
      const { count } = await tx.advertisers.deleteMany({ where: { id } });
      if (count === 0) throw new ApiError(404, "Advertiser not found");
    });
    res.status(204).send();
  })
);
