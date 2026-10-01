import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { emitToUser } from "@/sockets";
import { refundEarnedCoins } from "@/lib/coins";
import { getAdminRole } from "@/lib/roles";
import { logAdminAction, userLabel } from "@/lib/audit";

export const adminRouter = Router();
adminRouter.use(requireAuth);

/**
 * Who may do what mirrors the original database functions. Before, ONE check guarded this whole router and
 * passed any staff row, so a support agent or employee could suspend users, delete accounts and approve withdrawals.
 *   superOnly    is_super_admin(): money settings, deleting accounts, managing staff, devices, audit log
 *   modOrSuper   can_moderate():  suspensions, reports, withdrawal review
 *   staffLookup  super admin, moderator or support: finding a user to help them
 */
const superOnly = requireRole("super_admin");
const modOrSuper = requireRole("super_admin", "moderator");
const staffLookup = requireRole("super_admin", "moderator", "support");

const uuid = z.string().uuid();
const clampInt = (v: unknown, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : fallback;
};

// Staff accounts can only be changed by a super admin, and nobody can act on themselves this way.
async function assertCanActOnUser(actorId: string, actorRole: string | undefined, targetId: string) {
  if (actorId === targetId) throw new ApiError(400, "You can't do this to your own account");
  const targetRole = await getAdminRole(targetId);
  if (targetRole && actorRole !== "super_admin") throw new ApiError(403, "Only a Super Admin can act on a staff account");
}

// ------------------------------------------------------------------------------------------ who am I

// Ports get_admin_role. Any signed-in user can ask; normal users get { role: null }.
adminRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    res.json({ role: await getAdminRole(req.userId!) });
  })
);

// ------------------------------------------------------------------------------------------ users

// Staff look-up. Super admins get whole profiles; moderators and support get only what they need
// (no phone number or coin balances).
adminRouter.get(
  "/users",
  staffLookup,
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const users = await prisma.profiles.findMany({
      where: q
        ? { OR: [{ username: { contains: q, mode: "insensitive" } }, { display_name: { contains: q, mode: "insensitive" } }] }
        : {},
      orderBy: { created_at: "desc" },
      take: 200,
    });
    if (req.adminRole === "super_admin") return res.json(users);
    res.json(
      users.map((u) => ({
        user_id: u.user_id,
        username: u.username,
        display_name: u.display_name,
        avatar_url: u.avatar_url,
        rank: u.rank,
        is_suspended: u.is_suspended,
        suspended_reason: u.suspended_reason,
        created_at: u.created_at,
      }))
    );
  })
);

// Ports admin_user_detail.
adminRouter.get(
  "/users/:userId/detail",
  superOnly,
  asyncHandler(async (req, res) => {
    const id = uuid.parse(req.params.userId);
    const [p, account, referrals] = await Promise.all([
      prisma.profiles.findUnique({ where: { user_id: id } }),
      prisma.user.findUnique({ where: { id }, select: { email: true } }),
      prisma.referrals.findMany({ where: { referrer_id: id }, orderBy: { created_at: "desc" } }),
    ]);
    if (!p) throw new ApiError(404, "User not found");
    const referred = referrals.length
      ? await prisma.profiles.findMany({
          where: { user_id: { in: referrals.map((r) => r.referred_id) } },
          select: { user_id: true, display_name: true, username: true, avatar_url: true },
        })
      : [];
    const byId = new Map(referred.map((r) => [r.user_id, r]));
    res.json({
      user_id: p.user_id,
      display_name: p.display_name,
      username: p.username,
      avatar_url: p.avatar_url,
      phone_number: p.phone_number,
      email: account?.email ?? null,
      created_at: p.created_at,
      rank: p.rank,
      coins: p.coins,
      earned_coins: p.earned_coins,
      purchased_coins: p.purchased_coins,
      reward_coins: p.reward_coins,
      withdrawable_coins: (p.earned_coins ?? 0) + (p.purchased_coins ?? 0),
      total_online_minutes: p.total_online_minutes,
      is_premium: p.is_premium,
      is_verified: p.is_verified,
      is_monetized: p.is_monetized,
      is_suspended: p.is_suspended,
      is_online: p.is_online,
      last_seen: p.last_seen,
      referral_code: p.referral_code,
      referrals: referrals.map((r) => ({ ...(byId.get(r.referred_id) ?? { user_id: r.referred_id }), joined_at: r.created_at })),
    });
  })
);

const suspendSchema = z.object({ reason: z.string().trim().min(1).max(300) });

// Ports admin_suspend_user, plus what the Express version already did: end every session and tell the user live.
adminRouter.post(
  "/users/:userId/suspend",
  modOrSuper,
  asyncHandler(async (req, res) => {
    const { reason } = suspendSchema.parse(req.body);
    const userId = uuid.parse(req.params.userId);
    await assertCanActOnUser(req.userId!, req.adminRole, userId);

    await prisma.$transaction(async (tx) => {
      const { count } = await tx.profiles.updateMany({
        where: { user_id: userId },
        data: { is_suspended: true, suspended_at: new Date(), suspended_reason: reason },
      });
      if (count === 0) throw new ApiError(404, "User not found");
      await tx.refreshSession.updateMany({ where: { user_id: userId, revoked_at: null }, data: { revoked_at: new Date() } });
      await logAdminAction(tx, req.userId!, "user_suspended", userId, await userLabel(tx, userId), { reason });
    });
    emitToUser(userId, "account:suspended", { reason });
    res.status(204).send();
  })
);

adminRouter.post(
  "/users/:userId/unsuspend",
  modOrSuper,
  asyncHandler(async (req, res) => {
    const userId = uuid.parse(req.params.userId);
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.profiles.updateMany({
        where: { user_id: userId },
        data: { is_suspended: false, suspended_at: null, suspended_reason: null },
      });
      if (count === 0) throw new ApiError(404, "User not found");
      await logAdminAction(tx, req.userId!, "user_unsuspended", userId, await userLabel(tx, userId));
    });
    res.status(204).send();
  })
);

// Ports admin_set_monetized. Sets manual_monetized too, so the rank recalculation doesn't undo it.
adminRouter.post(
  "/users/:userId/monetized",
  superOnly,
  asyncHandler(async (req, res) => {
    const { value } = z.object({ value: z.boolean() }).parse(req.body);
    const userId = uuid.parse(req.params.userId);
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.profiles.updateMany({
        where: { user_id: userId },
        data: { is_monetized: value, manual_monetized: value },
      });
      if (count === 0) throw new ApiError(404, "User not found");
      await logAdminAction(tx, req.userId!, value ? "user_monetized" : "user_unmonetized", userId, await userLabel(tx, userId));
    });
    res.json({ is_monetized: value });
  })
);

// Ports the admin-delete-user edge function. Removes the login, profile and sessions (cascade) and also
// the personal data that would otherwise live on: push devices (the server would keep notifying a deleted
// account's phone), uploaded contact hashes, staff role. Posts, messages and similar are kept for moderation history.
// Unlike the edge function it refuses to delete staff accounts: remove the admin role first.
adminRouter.delete(
  "/users/:userId",
  superOnly,
  asyncHandler(async (req, res) => {
    const userId = uuid.parse(req.params.userId);
    await assertCanActOnUser(req.userId!, req.adminRole, userId);
    await prisma.$transaction(async (tx) => {
      const label = await userLabel(tx, userId);
      await tx.pushSubscriptions.deleteMany({ where: { user_id: userId } });
      await tx.deviceContacts.deleteMany({ where: { owner_id: userId } });
      await tx.superAdmins.deleteMany({ where: { user_id: userId } });
      const { count } = await tx.user.deleteMany({ where: { id: userId } });
      if (count === 0) throw new ApiError(404, "User not found");
      await tx.profiles.deleteMany({ where: { user_id: userId } }); // in case the profile wasn't tied to the login by a foreign key
      await logAdminAction(tx, req.userId!, "user_deleted", userId, label);
    });
    res.status(204).send();
  })
);

// ------------------------------------------------------------------------------------------ reports

adminRouter.get(
  "/reports",
  modOrSuper,
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    res.json(
      await prisma.moderationReports.findMany({
        where: status ? { status } : {},
        orderBy: { created_at: "desc" },
        take: 200,
      })
    );
  })
);

// Ports admin_reported_messages: reports about messages, with the message and both people. ?types=image,video filters by message type.
adminRouter.get(
  "/reports/messages",
  modOrSuper,
  asyncHandler(async (req, res) => {
    const types = typeof req.query.types === "string" && req.query.types ? req.query.types.split(",").map((t) => t.trim()).filter(Boolean) : null;
    const rows = await prisma.$queryRaw<unknown[]>(Prisma.sql`
      SELECT r.id AS report_id, r.reason, r.details, r.status, r.created_at AS reported_at,
             r.reporter_id, rp.display_name AS reporter_name,
             m.id AS message_id, m.type AS message_type, m.content, m.media_url,
             m.sender_id, sp.display_name AS sender_name, sp.username AS sender_username, m.room_id
        FROM moderation_reports r
        JOIN messages m ON m.id = r.target_message_id
        LEFT JOIN profiles rp ON rp.user_id = r.reporter_id
        LEFT JOIN profiles sp ON sp.user_id = m.sender_id
       WHERE r.target_message_id IS NOT NULL
         AND (${types}::text[] IS NULL OR m.type = ANY(${types}::text[]))
       ORDER BY r.created_at DESC
       LIMIT 300`);
    res.json(rows);
  })
);

// Ports admin_flagged_accounts: people ranked by how often they've been reported.
adminRouter.get(
  "/flagged-accounts",
  modOrSuper,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.$queryRaw<unknown[]>(Prisma.sql`
      SELECT p.user_id, p.display_name, p.username, p.avatar_url, p.is_suspended,
             count(r.id)::int AS report_count, max(r.created_at) AS last_reported
        FROM moderation_reports r
        JOIN profiles p ON p.user_id = r.target_user_id
       WHERE r.target_user_id IS NOT NULL
       GROUP BY p.user_id, p.display_name, p.username, p.avatar_url, p.is_suspended
       ORDER BY count(r.id) DESC, max(r.created_at) DESC
       LIMIT 200`);
    res.json(rows);
  })
);

const resolveReportSchema = z.object({ status: z.enum(["resolved", "dismissed"]) });

adminRouter.patch(
  "/reports/:id",
  modOrSuper,
  asyncHandler(async (req, res) => {
    const { status } = resolveReportSchema.parse(req.body);
    const id = uuid.parse(req.params.id);
    const report = await prisma.$transaction(async (tx) => {
      const existing = await tx.moderationReports.findUnique({ where: { id } });
      if (!existing) throw new ApiError(404, "Report not found");
      const updated = await tx.moderationReports.update({ where: { id }, data: { status } });
      await logAdminAction(tx, req.userId!, `report_${status}`, existing.target_user_id, null, { report_id: id });
      return updated;
    });
    res.json(report);
  })
);

// ------------------------------------------------------------------------------------------ withdrawals
// Review only. Sending the money is POST /api/payouts/:id/process (super admin).

adminRouter.get(
  "/withdrawals",
  modOrSuper,
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : "pending";
    res.json(await prisma.withdrawals.findMany({ where: { status }, orderBy: { created_at: "desc" } }));
  })
);

const withdrawalDecisionSchema = z.object({ decision: z.enum(["approve", "reject"]) });

adminRouter.patch(
  "/withdrawals/:id",
  modOrSuper,
  asyncHandler(async (req, res) => {
    const { decision } = withdrawalDecisionSchema.parse(req.body);
    const id = uuid.parse(req.params.id);

    await prisma.$transaction(async (tx) => {
      if (decision === "reject") {
        // Ports admin_reject_withdrawal: pending or approved only, and atomic so a double click can't refund twice.
        const { count } = await tx.withdrawals.updateMany({
          where: { id, status: { in: ["pending", "approved"] } },
          data: { status: "rejected", processed_at: new Date() },
        });
        if (count === 0) throw new ApiError(409, "This withdrawal has already been processed");
        const w = await tx.withdrawals.findUniqueOrThrow({ where: { id } });
        await refundEarnedCoins(tx, w.user_id, w.amount, "Withdrawal rejected by admin");
        await logAdminAction(tx, req.userId!, "withdrawal_rejected", w.user_id, null, { withdrawal_id: id, amount: w.amount });
      } else {
        // Only a pending withdrawal can be approved. Without this a rejected (and already refunded)
        // withdrawal could be flipped back to approved and then paid out as well.
        const { count } = await tx.withdrawals.updateMany({
          where: { id, status: "pending" },
          data: { status: "approved", processed_at: new Date() },
        });
        if (count === 0) {
          const w = await tx.withdrawals.findUnique({ where: { id }, select: { status: true } });
          if (!w) throw new ApiError(404, "Withdrawal not found");
          throw new ApiError(409, `Only a pending withdrawal can be approved (this one is ${w.status})`);
        }
        const w = await tx.withdrawals.findUniqueOrThrow({ where: { id } });
        await logAdminAction(tx, req.userId!, "withdrawal_approved", w.user_id, null, { withdrawal_id: id, amount: w.amount });
      }
    });
    res.json({ status: decision === "approve" ? "approved" : "rejected" });
  })
);

// ------------------------------------------------------------------------------------------ staff

// Ports admin_list_admins.
adminRouter.get(
  "/admins",
  superOnly,
  asyncHandler(async (_req, res) => {
    const admins = await prisma.superAdmins.findMany({ orderBy: { created_at: "asc" } });
    const profiles = admins.length
      ? await prisma.profiles.findMany({
          where: { user_id: { in: admins.map((a) => a.user_id) } },
          select: { user_id: true, display_name: true, username: true, avatar_url: true, phone_number: true },
        })
      : [];
    const byId = new Map(profiles.map((p) => [p.user_id, p]));
    res.json(
      admins.map((a) => ({
        user_id: a.user_id,
        display_name: byId.get(a.user_id)?.display_name ?? null,
        username: byId.get(a.user_id)?.username ?? null,
        avatar_url: byId.get(a.user_id)?.avatar_url ?? null,
        phone_number: byId.get(a.user_id)?.phone_number ?? null,
        role: a.role,
        admin_since: a.created_at,
      }))
    );
  })
);

const addAdminSchema = z.object({
  user_id: z.string().uuid(),
  role: z.enum(["super_admin", "moderator", "support", "employee"]).default("moderator"),
});

// Ports admin_add_admin (add, or change an existing staff member's role).
adminRouter.post(
  "/admins",
  superOnly,
  asyncHandler(async (req, res) => {
    const body = addAdminSchema.parse(req.body);
    const adminId = req.userId!;
    if (adminId === body.user_id && body.role !== "super_admin") throw new ApiError(400, "You cannot change your own Super Admin role");

    await prisma.$transaction(async (tx) => {
      if (!(await tx.profiles.findUnique({ where: { user_id: body.user_id }, select: { user_id: true } }))) {
        throw new ApiError(404, "User not found");
      }
      const existing = await tx.superAdmins.findUnique({ where: { user_id: body.user_id }, select: { role: true } });
      await tx.superAdmins.upsert({
        where: { user_id: body.user_id },
        create: { user_id: body.user_id, role: body.role },
        update: { role: body.role },
      });
      await logAdminAction(tx, adminId, existing ? "admin_role_changed" : "admin_added", body.user_id, await userLabel(tx, body.user_id), {
        old_role: existing?.role ?? null,
        new_role: body.role,
      });
    });
    res.status(201).json({ user_id: body.user_id, role: body.role });
  })
);

// Ports admin_remove_admin.
adminRouter.delete(
  "/admins/:userId",
  superOnly,
  asyncHandler(async (req, res) => {
    const target = uuid.parse(req.params.userId);
    if (target === req.userId!) throw new ApiError(400, "You cannot remove your own Super Admin account");
    await prisma.$transaction(async (tx) => {
      const existing = await tx.superAdmins.findUnique({ where: { user_id: target }, select: { role: true } });
      if (!existing) throw new ApiError(400, "This user is not an admin");
      await tx.superAdmins.delete({ where: { user_id: target } });
      await logAdminAction(tx, req.userId!, "admin_removed", target, await userLabel(tx, target), { old_role: existing.role });
    });
    res.status(204).send();
  })
);

// ------------------------------------------------------------------------------------------ statistics
// Ports the admin_* statistics functions. Days are UTC calendar days, like the database.

// admin_platform_stats
adminRouter.get(
  "/stats/platform",
  modOrSuper,
  asyncHandler(async (_req, res) => {
    const [row] = await prisma.$queryRaw<Record<string, number>[]>(Prisma.sql`
      WITH d AS (SELECT date_trunc('day', now()) AS today)
      SELECT
        (SELECT count(*) FROM profiles)::int AS total_users,
        (SELECT count(*) FROM profiles WHERE is_online)::int AS online_users,
        (SELECT count(*) FROM profiles WHERE is_suspended)::int AS suspended_users,
        (SELECT count(*) FROM profiles WHERE is_verified)::int AS verified_users,
        (SELECT count(*) FROM profiles WHERE is_premium)::int AS premium_users,
        (SELECT count(*) FROM profiles WHERE last_seen >= (SELECT today FROM d))::int AS active_today,
        (SELECT count(*) FROM profiles WHERE created_at >= (SELECT today FROM d))::int AS new_today,
        (SELECT count(*) FROM messages WHERE created_at >= (SELECT today FROM d))::int AS messages_today,
        (SELECT count(*) FROM messages)::int AS total_messages,
        (SELECT count(*) FROM rooms)::int AS total_rooms,
        (SELECT count(*) FROM rooms WHERE type <> 'dm')::int AS group_rooms,
        (SELECT count(*) FROM rooms WHERE type = 'dm')::int AS dm_rooms,
        (SELECT count(*) FROM moderation_reports WHERE status = 'pending')::int AS pending_reports,
        (SELECT count(*) FROM moderation_reports)::int AS total_reports,
        (SELECT COALESCE(sum(amount_ngn), 0) FROM subscriptions)::float8 AS total_revenue,
        (SELECT count(*) FROM subscriptions WHERE status = 'active' AND current_period_end > now())::int AS active_subs,
        (SELECT COALESCE(sum(amount_ngn), 0) FROM subscriptions WHERE status = 'active' AND current_period_end > now())::float8 AS mrr,
        (SELECT count(*) FROM withdrawals WHERE status = 'pending')::int AS pending_withdrawals`);
    res.json(row);
  })
);

// admin_daily_metrics: one row per day, oldest first (?days=14).
adminRouter.get(
  "/stats/daily",
  modOrSuper,
  asyncHandler(async (req, res) => {
    const days = clampInt(req.query.days, 14, 1, 365);
    const rows = await prisma.$queryRaw<unknown[]>(Prisma.sql`
      WITH days AS (
        SELECT generate_series(date_trunc('day', now()) - make_interval(days => ${days} - 1), date_trunc('day', now()), '1 day')::date AS day
      )
      SELECT d.day,
        (SELECT count(*) FROM profiles p WHERE p.created_at::date = d.day)::int AS new_users,
        (SELECT count(*) FROM messages m WHERE m.created_at::date = d.day)::int AS messages,
        (SELECT count(DISTINCT m.sender_id) FROM messages m WHERE m.created_at::date = d.day)::int AS active_users,
        (SELECT count(*) FROM subscriptions s WHERE s.created_at::date = d.day)::int AS new_subs
      FROM days d ORDER BY d.day`);
    res.json(rows);
  })
);

// admin_active_users_windows
adminRouter.get(
  "/stats/active-windows",
  superOnly,
  asyncHandler(async (_req, res) => {
    const [row] = await prisma.$queryRaw<Record<string, number>[]>(Prisma.sql`
      SELECT
        (SELECT count(*) FROM profiles)::int AS total_users,
        (SELECT count(*) FROM profiles WHERE is_online)::int AS online_now,
        (SELECT count(*) FROM profiles WHERE last_seen >= now() - interval '7 days')::int AS active_7,
        (SELECT count(*) FROM profiles WHERE last_seen >= now() - interval '14 days')::int AS active_14,
        (SELECT count(*) FROM profiles WHERE last_seen >= now() - interval '21 days')::int AS active_21,
        (SELECT count(*) FROM profiles WHERE last_seen >= now() - interval '30 days')::int AS active_30`);
    res.json(row);
  })
);

// admin_active_users_list: ?days=0 means online right now; otherwise seen in the last N days. Up to 500.
adminRouter.get(
  "/stats/active-users",
  superOnly,
  asyncHandler(async (req, res) => {
    const days = clampInt(req.query.days, 0, 0, 365);
    const rows = await prisma.$queryRaw<unknown[]>(Prisma.sql`
      SELECT p.user_id, p.display_name, p.username, p.avatar_url, p.is_online, p.last_seen
        FROM profiles p
       WHERE (CASE WHEN ${days} = 0 THEN p.is_online ELSE p.last_seen >= now() - make_interval(days => ${days}) END)
       ORDER BY p.is_online DESC NULLS LAST, p.last_seen DESC NULLS LAST
       LIMIT 500`);
    res.json(rows);
  })
);

// admin_message_type_breakdown
adminRouter.get(
  "/stats/message-types",
  modOrSuper,
  asyncHandler(async (_req, res) => {
    res.json(
      await prisma.$queryRaw<unknown[]>(Prisma.sql`
        SELECT m.type, count(*)::int AS count FROM messages m GROUP BY m.type ORDER BY count(*) DESC`)
    );
  })
);

// admin_get_chat_activity: who is sending the most messages (?days=7&limit=50).
adminRouter.get(
  "/stats/chat-activity",
  modOrSuper,
  asyncHandler(async (req, res) => {
    const days = clampInt(req.query.days, 7, 1, 365);
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const rows = await prisma.$queryRaw<unknown[]>(Prisma.sql`
      SELECT p.user_id, p.display_name, p.username, p.avatar_url, p.rank,
             COALESCE(c.cnt, 0)::int AS message_count, p.total_online_minutes, p.is_online, p.is_suspended
        FROM profiles p
        LEFT JOIN (SELECT sender_id, count(*) AS cnt FROM messages
                    WHERE created_at > now() - make_interval(days => ${days}) GROUP BY sender_id) c
          ON c.sender_id = p.user_id
       ORDER BY message_count DESC NULLS LAST, p.total_online_minutes DESC NULLS LAST
       LIMIT ${limit}`);
    res.json(rows);
  })
);

// ------------------------------------------------------------------------------------------ audit + security

// The admin audit trail, newest first. Filter with ?action=, ?actor=<user id>, page with ?before=<iso time>.
adminRouter.get(
  "/audit-logs",
  superOnly,
  asyncHandler(async (req, res) => {
    const before = typeof req.query.before === "string" ? new Date(req.query.before) : undefined;
    res.json(
      await prisma.adminAuditLogs.findMany({
        where: {
          ...(typeof req.query.action === "string" ? { action: req.query.action } : {}),
          ...(typeof req.query.actor === "string" && uuid.safeParse(req.query.actor).success ? { actor_id: req.query.actor } : {}),
          ...(before && !Number.isNaN(before.getTime()) ? { created_at: { lt: before } } : {}),
        },
        orderBy: { created_at: "desc" },
        take: clampInt(req.query.limit, 100, 1, 300),
      })
    );
  })
);

// Ports admin_devices: registered push devices with their owners. The endpoint is a secret URL that
// lets anyone holding it push to that device, so only its host and last characters are shown (the SQL returned it whole).
adminRouter.get(
  "/devices",
  superOnly,
  asyncHandler(async (_req, res) => {
    const devices = await prisma.pushSubscriptions.findMany({ orderBy: { updated_at: "desc" }, take: 300 });
    const profiles = devices.length
      ? await prisma.profiles.findMany({
          where: { user_id: { in: [...new Set(devices.map((d) => d.user_id))] } },
          select: { user_id: true, display_name: true, username: true, avatar_url: true, is_online: true },
        })
      : [];
    const byId = new Map(profiles.map((p) => [p.user_id, p]));
    res.json(
      devices.map((d) => {
        let host = "";
        try {
          host = new URL(d.endpoint).hostname;
        } catch {
          /* leave blank */
        }
        const p = byId.get(d.user_id);
        return {
          id: d.id,
          user_id: d.user_id,
          display_name: p?.display_name ?? null,
          username: p?.username ?? null,
          avatar_url: p?.avatar_url ?? null,
          is_online: p?.is_online ?? null,
          endpoint_host: host,
          endpoint_tail: d.endpoint.slice(-8),
          created_at: d.created_at,
          updated_at: d.updated_at,
        };
      })
    );
  })
);

// Ports admin_security_overview.
adminRouter.get(
  "/security-overview",
  superOnly,
  asyncHandler(async (_req, res) => {
    const [row] = await prisma.$queryRaw<Record<string, number>[]>(Prisma.sql`
      SELECT
        (SELECT count(*) FROM push_subscriptions)::int AS total_devices,
        (SELECT count(*) FROM (SELECT user_id FROM push_subscriptions GROUP BY user_id HAVING count(*) > 1) x)::int AS multi_device_users,
        (SELECT count(*) FROM profiles WHERE last_seen > now() - interval '24 hours')::int AS active_sessions_24h,
        (SELECT count(*) FROM profiles WHERE is_suspended = true)::int AS suspended_accounts,
        (SELECT count(*) FROM (SELECT target_user_id FROM moderation_reports WHERE target_user_id IS NOT NULL GROUP BY target_user_id HAVING count(*) >= 2) y)::int AS flagged_accounts,
        (SELECT count(*) FROM withdrawals WHERE status = 'pending')::int AS pending_withdrawals,
        (SELECT count(*) FROM withdrawals WHERE naira_amount >= 50000 AND status = 'pending')::int AS large_withdrawals`);
    res.json(row);
  })
);
