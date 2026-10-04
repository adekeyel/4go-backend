import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, optionalAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { addOnlineMinutes } from "@/lib/rank";
import { setPresence } from "@/lib/presence";
import { emitToUser } from "@/sockets";

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
  total_online_minutes: true,
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
  username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/, "Letters, numbers, underscores only").optional(),
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

    if (body.username) {
      const taken = await prisma.profiles.findFirst({
        where: { username: body.username, user_id: { not: req.userId! } },
      });
      if (taken) throw new ApiError(409, "That username is taken");
    }

    const profile = await prisma.profiles.update({ where: { user_id: req.userId! }, data: body });
    res.json(profile);
  })
);

// Whether the current user is staff of any kind (replaces the has_admin_access RPC),
// used to decide whether to show the admin entry point.
profilesRouter.get(
  "/me/admin-access",
  requireAuth,
  asyncHandler(async (req, res) => {
    const admin = await prisma.superAdmins.findUnique({ where: { user_id: req.userId! } });
    // `role` lets the app show the right admin screens (ports get_admin_role).
    res.json({ isAdmin: !!admin, role: admin?.role ?? null });
  })
);

const presenceSchema = z.object({
  online: z.boolean(),
  // Minutes of active foreground time to credit since the last heartbeat
  // (mirrors the old `increment_online_minutes` RPC).
  minutesDelta: z.number().int().min(0).max(5).optional(),
});

// Called on a ~45s heartbeat by the client (web and native both). Also
// opportunistically sweeps anyone else who's gone stale (no heartbeat in the
// last 3 minutes) back to offline — the same "opportunistic cleanup"
// behavior the old `cleanup_stale_presence` RPC provided.
profilesRouter.post(
  "/me/presence",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { online, minutesDelta } = presenceSchema.parse(req.body);
    const now = new Date();

    // Detects the offline-to-online change atomically (and alerts the employee who invited this user).
    const notice = await setPresence(req.userId!, online, now);
    if (notice) emitToUser(notice.employeeId, "employee:notification", notice.notification);

    // Credit minutes and recompute rank / monetized / verified (ports increment_online_minutes).
    if (minutesDelta) await addOnlineMinutes(req.userId!, minutesDelta);

    // Stale presence (no heartbeat for 3 minutes) is cleared by the background job in lib/maintenance.ts
    // once a minute, instead of every heartbeat from every user running a table-wide update.

    res.status(204).send();
  })
);

// Top users by time online (public leaderboard).
profilesRouter.get(
  "/leaderboard",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const profiles = await prisma.profiles.findMany({
      orderBy: { total_online_minutes: "desc" },
      take: limit,
      select: PUBLIC_FIELDS,
    });
    res.json(profiles);
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

const searchSchema = z.object({ q: z.string().min(1).max(60).optional() });

profilesRouter.get(
  "/",
  optionalAuth,
  asyncHandler(async (req, res) => {
    // Batch lookup by id — used to attach sender profiles to a page of
    // messages in one round trip instead of one request per message.
    if (typeof req.query.ids === "string") {
      const ids = req.query.ids.split(",").filter(Boolean);
      if (!ids.length) return res.json([]);
      const profiles = await prisma.profiles.findMany({ where: { user_id: { in: ids } }, select: PUBLIC_FIELDS });
      return res.json(profiles);
    }

    // Exact username lookup for a short list (?usernames=a,b,c), e.g. the support agents.
    if (typeof req.query.usernames === "string") {
      const names = req.query.usernames.split(",").map((n) => n.trim()).filter(Boolean).slice(0, 20);
      if (!names.length) return res.json([]);
      const profiles = await prisma.profiles.findMany({
        where: { OR: names.map((n) => ({ username: { equals: n, mode: "insensitive" as const } })) },
        select: PUBLIC_FIELDS,
      });
      return res.json(profiles);
    }

    // Exact phone lookup, for "find a friend by phone number".
    if (typeof req.query.phone === "string" && req.query.phone.trim()) {
      const profiles = await prisma.profiles.findMany({
        where: { phone_number: req.query.phone.trim() },
        select: PUBLIC_FIELDS,
        take: 10,
      });
      return res.json(profiles);
    }

    const { q } = searchSchema.parse(req.query);
    if (!q) return res.json([]);
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
