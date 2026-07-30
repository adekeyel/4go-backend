import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, optionalAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";

export const profilesRouter = Router();

// Public-safe fields only — never leak coins/phone/suspension reason to other users.
const PUBLIC_FIELDS = {
  user_id: true,
  username: true,
  display_name: true,
  avatar_url: true,
  bio: true,
  interests: true,
  is_online: true,
  last_seen: true,
  rank: true,
  is_monetized: true,
  is_premium: true,
  is_verified: true,
  created_at: true,
} as const;

profilesRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const profile = await prisma.profiles.findUnique({ where: { user_id: req.userId! } });
    if (!profile) throw new ApiError(404, "Profile not found");
    res.json(profile);
  })
);

const updateSchema = z.object({
  display_name: z.string().min(1).max(60).optional(),
  bio: z.string().max(500).optional(),
  interests: z.array(z.string()).max(20).optional(),
  avatar_url: z.string().url().optional(),
  phone_number: z.string().max(20).optional(),
});

profilesRouter.patch(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = updateSchema.parse(req.body);
    const profile = await prisma.profiles.update({ where: { user_id: req.userId! }, data: body });
    res.json(profile);
  })
);

profilesRouter.get(
  "/:userId",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const profile = await prisma.profiles.findUnique({
      where: { user_id: req.params.userId },
      select: PUBLIC_FIELDS,
    });
    if (!profile) throw new ApiError(404, "Profile not found");
    res.json(profile);
  })
);

const searchSchema = z.object({ q: z.string().min(1).max(60) });

profilesRouter.get(
  "/",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { q } = searchSchema.parse(req.query);
    const profiles = await prisma.profiles.findMany({
      where: {
        OR: [
          { username: { contains: q, mode: "insensitive" } },
          { display_name: { contains: q, mode: "insensitive" } },
        ],
      },
      select: PUBLIC_FIELDS,
      take: 20,
    });
    res.json(profiles);
  })
);
