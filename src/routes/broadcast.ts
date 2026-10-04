import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getIo } from "@/sockets";
import { sendPush } from "@/lib/push";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { isSuperAdmin } from "@/lib/roles";
import { logAdminAction } from "@/lib/audit";
import { ANNOUNCEMENTS_ROOM_NAME, sendRoomMessage } from "@/lib/roomMessages";
import { broadcastEmail } from "@/lib/emailTemplates";
import { enqueueEmailsBulk, emailEnabled, ensureUnsubTokens } from "@/lib/emailQueue";

// Ports the admin-broadcast edge function. Super admins only (the function checked role = super_admin).
export const broadcastRouter = Router();
broadcastRouter.use(requireAuth, asyncHandler(async (req, _res, next) => {
  if (!(await isSuperAdmin(req.userId!))) throw new ApiError(403, "Only Super Admins can broadcast");
  next();
}));

const announceSchema = z.object({
  title: z.string().trim().min(1).max(150),
  message: z.string().trim().min(1).max(4000),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
});

// In-app announcement: notification centre entry + a post in the announcements room, which every user is
// added to. The room message also pushes a notification to everyone.
broadcastRouter.post(
  "/announce",
  asyncHandler(async (req, res) => {
    const body = announceSchema.parse(req.body);
    const adminId = req.userId!;

    const announcement = await prisma.globalNotifications.create({
      data: { title: body.title, message: body.message, priority: body.priority, sent_by: adminId },
    });

    let room = await prisma.rooms.findFirst({ where: { name: ANNOUNCEMENTS_ROOM_NAME } });
    if (!room) {
      room = await prisma.rooms.create({
        data: {
          name: ANNOUNCEMENTS_ROOM_NAME,
          type: "public",
          created_by: adminId,
          description: "Official 4GO announcements",
          max_members: 1_000_000,
        },
      });
    }

    const profiles = await prisma.profiles.findMany({ select: { user_id: true } });
    for (let i = 0; i < profiles.length; i += 500) {
      await prisma.roomMembers.createMany({
        data: profiles.slice(i, i + 500).map((p) => ({ room_id: room!.id, user_id: p.user_id, role: "member" })),
        skipDuplicates: true,
      });
    }

    await sendRoomMessage(room.id, adminId, { type: "text", content: `📢 ${body.title}\n\n${body.message}` });

    await prisma.broadcastDeliveries.create({
      data: {
        channel: "announce",
        title: body.title,
        body: body.message,
        sent_by: adminId,
        target_count: profiles.length,
        success_count: profiles.length,
        failure_count: 0,
      },
    });
    getIo().emit("notification:new", {
      id: announcement.id,
      title: announcement.title,
      message: announcement.message,
      priority: announcement.priority,
      created_at: announcement.created_at,
    });
    await prisma.$transaction((tx) => logAdminAction(tx, adminId, "broadcast_announce", null, body.title, { recipients: profiles.length }));
    res.json({ ok: true, recipients: profiles.length });
  })
);

const emailSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(10000),
});

// Email campaign to every account with an email address. Emails are queued and sent in the background
// (about 5 per second); progress shows in GET /email/stats. Unsubscribed addresses are skipped at send time.
broadcastRouter.post(
  "/email",
  asyncHandler(async (req, res) => {
    if (!emailEnabled) throw new ApiError(503, "Email isn't configured (RESEND_API_KEY missing)");
    const body = emailSchema.parse(req.body);
    const adminId = req.userId!;

    // A double-click or retry would otherwise email everyone twice.
    const duplicate = await prisma.broadcastDeliveries.findFirst({
      where: { channel: "email", title: body.subject, body: body.message, created_at: { gt: new Date(Date.now() - 5 * 60_000) } },
      select: { id: true },
    });
    if (duplicate) throw new ApiError(409, "This exact campaign was already sent in the last 5 minutes");

    const { html, text } = broadcastEmail(body.subject, body.message);
    let queued = 0;
    let cursor: string | undefined;
    for (;;) {
      const users = await prisma.user.findMany({
        where: { email: { not: null } },
        select: { id: true, email: true },
        orderBy: { id: "asc" },
        take: 1000,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!users.length) break;
      cursor = users[users.length - 1].id;

      const emails = users.map((u) => u.email!.toLowerCase());
      const tokens = await ensureUnsubTokens(emails);
      queued += await enqueueEmailsBulk(
        [...new Set(emails)].map((to) => ({
          queue: "transactional" as const,
          to,
          subject: body.subject,
          html,
          text,
          label: "admin_broadcast",
          unsubscribeToken: tokens.get(to) ?? null,
        }))
      );
      if (users.length < 1000) break;
    }

    await prisma.broadcastDeliveries.create({
      data: {
        channel: "email",
        title: body.subject,
        body: body.message,
        sent_by: adminId,
        target_count: queued,
        success_count: 0,
        failure_count: 0,
        error_sample: "Queued for delivery, see live status in the Email tab",
      },
    });
    await prisma.$transaction((tx) => logAdminAction(tx, adminId, "broadcast_email", null, body.subject, { queued }));
    res.json({ ok: true, recipients: queued });
  })
);

// Ports mode "resend_dlq" (and resend_failed_broadcast_emails): put campaign emails that ran out of
// retries back in the queue with fresh retry counts and a new message id.
broadcastRouter.post(
  "/email/resend-failed",
  asyncHandler(async (req, res) => {
    const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE email_queue
         SET status = 'pending', attempts = 0, error_message = NULL, visible_at = now(), queued_at = now(),
             updated_at = now(), message_id = gen_random_uuid()::text
       WHERE status = 'dlq' AND label = 'admin_broadcast'
       RETURNING id`);
    await prisma.$transaction((tx) => logAdminAction(tx, req.userId!, "broadcast_email_resend", null, null, { requeued: rows.length }));
    res.json({ ok: true, requeued: rows.length });
  })
);

// Ports admin_email_campaign_stats: each campaign email counted once by its latest status
// (sent / failed / dlq / rate_limited / suppressed), plus how many are still waiting in the queue.
broadcastRouter.get(
  "/email/stats",
  asyncHandler(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    const since = new Date(Date.now() - days * 86_400_000);
    const [rows, waiting] = await Promise.all([
      prisma.$queryRaw<{ status: string; count: number }[]>(Prisma.sql`
        SELECT latest.status, count(*)::int AS count
          FROM (SELECT DISTINCT ON (message_id) message_id, status, created_at
                  FROM email_send_log
                 WHERE message_id IS NOT NULL AND template_name = 'admin_broadcast'
                 ORDER BY message_id, created_at DESC) latest
         WHERE latest.created_at >= ${since}
         GROUP BY latest.status`),
      prisma.emailQueue.count({ where: { label: "admin_broadcast", status: "pending" } }),
    ]);
    res.json({ since, waiting, stats: rows });
  })
);

// Recent broadcasts, newest first.
broadcastRouter.get(
  "/deliveries",
  asyncHandler(async (req, res) => {
    const since = typeof req.query.since === "string" && !isNaN(Date.parse(req.query.since)) ? new Date(req.query.since) : undefined;
    res.json(await prisma.broadcastDeliveries.findMany({ where: since ? { created_at: { gte: since } } : {}, orderBy: { created_at: "desc" }, take: 50 }));
  })
);

// Push notification to every device (Broadcast screen, "push" channel). Optional ?url opens a page when tapped.
// Sent in the background in bounded batches; the response says how many people will be tried.
broadcastRouter.post(
  "/push",
  asyncHandler(async (req, res) => {
    const body = z
      .object({ title: z.string().trim().min(1).max(100), body: z.string().trim().min(1).max(500), url: z.string().max(300).optional() })
      .parse(req.body);
    const adminId = req.userId!;
    const duplicate = await prisma.broadcastDeliveries.findFirst({
      where: { channel: "push", title: body.title, body: body.body, created_at: { gt: new Date(Date.now() - 2 * 60_000) } },
      select: { id: true },
    });
    if (duplicate) throw new ApiError(409, "This exact push was already sent in the last 2 minutes");

    const users = (await prisma.pushSubscriptions.findMany({ distinct: ["user_id"], select: { user_id: true } })).map((u) => u.user_id);
    const delivery = await prisma.broadcastDeliveries.create({
      data: { channel: "push", title: body.title, body: body.body, sent_by: adminId, target_count: users.length, success_count: 0, failure_count: 0, error_sample: "Sending…" },
    });
    void (async () => {
      let sent = 0;
      let total = 0;
      for (let i = 0; i < users.length; i += 500) {
        const r = await sendPush(users.slice(i, i + 500), { title: body.title, body: body.body, data: body.url ? { navigateTo: body.url } : {} });
        sent += r.sent;
        total += r.total;
      }
      await prisma.broadcastDeliveries
        .update({ where: { id: delivery.id }, data: { success_count: sent, failure_count: total - sent, error_sample: null } })
        .catch(() => {});
    })();
    await prisma.$transaction((tx) => logAdminAction(tx, adminId, "broadcast_push", null, body.title, { users: users.length }));
    res.json({ ok: true, recipients: users.length });
  })
);

// The send log (one row per email attempt) for the Delivery screen. ?since=ISO, ?status=, ?q=<address contains>, ?limit
broadcastRouter.get(
  "/email/log",
  asyncHandler(async (req, res) => {
    const since = typeof req.query.since === "string" && !isNaN(Date.parse(req.query.since)) ? new Date(req.query.since) : new Date(Date.now() - 7 * 86_400_000);
    const status = typeof req.query.status === "string" && req.query.status ? req.query.status : undefined;
    const q = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    res.json(
      await prisma.emailSendLog.findMany({
        where: { created_at: { gte: since }, ...(status ? { status } : {}), ...(q ? { recipient_email: { contains: q, mode: "insensitive" } } : {}) },
        orderBy: { created_at: "desc" },
        take: limit,
      })
    );
  })
);
