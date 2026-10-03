import { Router } from "express";
import { prisma } from "@/lib/prisma";
import { asyncHandler } from "@/middleware/errorHandler";

// Public read of the few switches the app needs before sign-in (signups_enabled, maintenance_mode, upload limits…).
// Writing is super-admin only: PUT /api/admin/settings.
export const settingsRouter = Router();

const PUBLIC_KEYS = ["signups_enabled", "maintenance_mode", "min_age", "allow_media_uploads", "allow_voice_notes", "max_upload_mb", "max_room_members"];

settingsRouter.get(
  "/public",
  asyncHandler(async (_req, res) => {
    const rows = await prisma.appSettings.findMany({ where: { key: { in: PUBLIC_KEYS } }, select: { key: true, value: true } });
    res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  })
);
