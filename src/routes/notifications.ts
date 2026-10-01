import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler } from "@/middleware/errorHandler";

// The in-app notification centre: announcements sent with POST /api/broadcast/announce.
export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const items = await prisma.globalNotifications.findMany({ orderBy: { created_at: "desc" }, take: 50 });
    const reads = items.length
      ? await prisma.notificationReads.findMany({
          where: { user_id: req.userId!, notification_id: { in: items.map((i) => i.id) } },
          select: { notification_id: true },
        })
      : [];
    const read = new Set(reads.map((r) => r.notification_id));
    res.json(items.map((i) => ({ ...i, is_read: read.has(i.id) })));
  })
);

notificationsRouter.get(
  "/unread-count",
  asyncHandler(async (req, res) => {
    const reads = await prisma.notificationReads.findMany({
      where: { user_id: req.userId! },
      select: { notification_id: true },
    });
    const count = await prisma.globalNotifications.count({ where: { id: { notIn: reads.map((r) => r.notification_id) } } });
    res.json({ count });
  })
);

// Mark one notification read, or all of them when no id is given.
notificationsRouter.post(
  "/read",
  asyncHandler(async (req, res) => {
    const { notification_id } = z.object({ notification_id: z.string().uuid().optional() }).parse(req.body ?? {});
    const ids = notification_id
      ? [notification_id]
      : (await prisma.globalNotifications.findMany({ select: { id: true }, orderBy: { created_at: "desc" }, take: 500 })).map((n) => n.id);
    if (ids.length) {
      await prisma.notificationReads.createMany({
        data: ids.map((id) => ({ notification_id: id, user_id: req.userId! })),
        skipDuplicates: true,
      });
    }
    res.status(204).send();
  })
);
