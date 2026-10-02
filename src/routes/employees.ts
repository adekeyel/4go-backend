import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { canModerate } from "@/lib/roles";

// The sales-team ("employee") area. An employee's team is the people who signed up with their referral
// code (referrals table) and the people those people referred (the downline).
export const employeesRouter = Router();
employeesRouter.use(requireAuth);

const uuid = z.string().uuid();
const modOrSuper = requireRole("super_admin", "moderator");
const clampInt = (v: unknown, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : fallback;
};
const dateParam = (v: unknown) => {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

// ----------------------------------------------------------------------------------- staff views

// admin_list_employees
employeesRouter.get(
  "/admin/list",
  modOrSuper,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.$queryRaw<unknown[]>(Prisma.sql`
      SELECT sa.user_id, p.display_name, p.username, p.avatar_url, p.phone_number, sa.created_at AS employee_since,
        (SELECT count(*) FROM referrals rf WHERE rf.referrer_id = sa.user_id)::int AS total_invited,
        (SELECT count(*) FROM referrals rf JOIN profiles pp ON pp.user_id = rf.referred_id
          WHERE rf.referrer_id = sa.user_id AND pp.last_seen >= now() - interval '7 days')::int AS active_7,
        (SELECT count(*) FROM referrals rf JOIN profiles pp ON pp.user_id = rf.referred_id
          WHERE rf.referrer_id = sa.user_id AND pp.last_seen >= now() - interval '30 days')::int AS active_30
        FROM super_admins sa
        JOIN profiles p ON p.user_id = sa.user_id
       WHERE sa.role = 'employee'
       ORDER BY sa.created_at DESC`);
    res.json(rows);
  })
);

// admin_employee_activity_log: ?employee=<id>&from=<iso>&to=<iso>&limit=500
employeesRouter.get(
  "/admin/activity-log",
  modOrSuper,
  asyncHandler(async (req, res) => {
    const employee = typeof req.query.employee === "string" && uuid.safeParse(req.query.employee).success ? req.query.employee : null;
    const from = dateParam(req.query.from);
    const to = dateParam(req.query.to);
    const limit = clampInt(req.query.limit, 500, 1, 2000);
    const rows = await prisma.$queryRaw<unknown[]>(Prisma.sql`
      SELECT l.id, l.employee_id, p.display_name AS employee_name, p.username AS employee_username, p.avatar_url,
             l.action, l.detail, l.meta, l.created_at
        FROM employee_activity_log l
        LEFT JOIN profiles p ON p.user_id = l.employee_id
       WHERE (${employee}::uuid IS NULL OR l.employee_id = ${employee}::uuid)
         AND (${from}::timestamptz IS NULL OR l.created_at >= ${from}::timestamptz)
         AND (${to}::timestamptz IS NULL OR l.created_at <= ${to}::timestamptz)
       ORDER BY l.created_at DESC
       LIMIT ${limit}`);
    res.json(rows);
  })
);

// ----------------------------------------------------------------------------------- an employee's own area

// log_employee_activity. The employee is always you (the SQL took the employee as a parameter, so anyone
// could write entries into somebody else's log). Silently ignored unless you hold the employee role.
const activitySchema = z.object({
  action: z.string().trim().min(1).max(100),
  detail: z.string().trim().max(500).optional(),
  meta: z.record(z.unknown()).refine((m) => JSON.stringify(m).length <= 4000, "meta is too large").optional(),
});

employeesRouter.post(
  "/me/activity",
  asyncHandler(async (req, res) => {
    const body = activitySchema.parse(req.body);
    const isEmployee = await prisma.superAdmins.findFirst({ where: { user_id: req.userId!, role: "employee" }, select: { id: true } });
    if (isEmployee) {
      await prisma.employeeActivityLog.create({
        data: { employee_id: req.userId!, action: body.action, detail: body.detail || null, meta: (body.meta ?? {}) as Prisma.InputJsonObject },
      });
    }
    res.status(204).send();
  })
);

employeesRouter.get(
  "/me/notifications",
  asyncHandler(async (req, res) => {
    res.json(
      await prisma.employeeNotifications.findMany({
        where: { employee_id: req.userId! },
        orderBy: { created_at: "desc" },
        take: clampInt(req.query.limit, 50, 1, 200),
      })
    );
  })
);

employeesRouter.get(
  "/me/notifications/unread-count",
  asyncHandler(async (req, res) => {
    res.json({ count: await prisma.employeeNotifications.count({ where: { employee_id: req.userId!, read_at: null } }) });
  })
);

// mark_employee_notifications_read: marks all of yours read.
employeesRouter.post(
  "/me/notifications/read",
  asyncHandler(async (req, res) => {
    await prisma.employeeNotifications.updateMany({ where: { employee_id: req.userId!, read_at: null }, data: { read_at: new Date() } });
    res.status(204).send();
  })
);

// ----------------------------------------------------------------------------------- one employee's team
// Visible to that employee and to moderators / super admins.

employeesRouter.use(
  "/:employeeId",
  asyncHandler(async (req, _res, next) => {
    const employeeId = uuid.parse(req.params.employeeId);
    if (employeeId !== req.userId! && !(await canModerate(req.userId!))) throw new ApiError(403, "Not authorized");
    next();
  })
);

// employee_pipeline_stats
employeesRouter.get(
  "/:employeeId/pipeline",
  asyncHandler(async (req, res) => {
    const id = req.params.employeeId;
    const [row] = await prisma.$queryRaw<Record<string, number>[]>(Prisma.sql`
      SELECT
        (SELECT count(*) FROM referrals rf WHERE rf.referrer_id = ${id}::uuid)::int AS total_invited,
        (SELECT count(*) FROM referrals rf JOIN profiles p ON p.user_id = rf.referred_id WHERE rf.referrer_id = ${id}::uuid AND p.last_seen >= now() - interval '7 days')::int AS active_7,
        (SELECT count(*) FROM referrals rf JOIN profiles p ON p.user_id = rf.referred_id WHERE rf.referrer_id = ${id}::uuid AND p.last_seen >= now() - interval '14 days')::int AS active_14,
        (SELECT count(*) FROM referrals rf JOIN profiles p ON p.user_id = rf.referred_id WHERE rf.referrer_id = ${id}::uuid AND p.last_seen >= now() - interval '21 days')::int AS active_21,
        (SELECT count(*) FROM referrals rf JOIN profiles p ON p.user_id = rf.referred_id WHERE rf.referrer_id = ${id}::uuid AND p.last_seen >= now() - interval '30 days')::int AS active_30,
        (SELECT count(*) FROM referrals rf JOIN profiles p ON p.user_id = rf.referred_id WHERE rf.referrer_id = ${id}::uuid AND p.is_online)::int AS online_now,
        (SELECT count(*) FROM referrals r1 JOIN referrals r2 ON r2.referrer_id = r1.referred_id WHERE r1.referrer_id = ${id}::uuid)::int AS downline`);
    res.json(row);
  })
);

// employee_invited_users: people they invited directly (up to 1000, newest first), with how many each invited in turn.
employeesRouter.get(
  "/:employeeId/invited",
  asyncHandler(async (req, res) => {
    const id = req.params.employeeId;
    res.json(
      await prisma.$queryRaw<unknown[]>(Prisma.sql`
        SELECT p.user_id, p.display_name, p.username, p.avatar_url, p.rank, p.is_online, p.last_seen,
               rf.created_at AS joined_at,
               (SELECT count(*) FROM referrals r2 WHERE r2.referrer_id = p.user_id)::int AS sub_referrals
          FROM referrals rf
          JOIN profiles p ON p.user_id = rf.referred_id
         WHERE rf.referrer_id = ${id}::uuid
         ORDER BY rf.created_at DESC
         LIMIT 1000`)
    );
  })
);

// employee_downline: people invited by the people they invited (up to 1000), with who brought each in.
employeesRouter.get(
  "/:employeeId/downline",
  asyncHandler(async (req, res) => {
    const id = req.params.employeeId;
    res.json(
      await prisma.$queryRaw<unknown[]>(Prisma.sql`
        SELECT p.user_id, p.display_name, p.username, p.avatar_url, p.is_online, p.last_seen,
               r2.created_at AS joined_at, rp.user_id AS referrer_id, rp.display_name AS referrer_name, rp.username AS referrer_username
          FROM referrals r1
          JOIN referrals r2 ON r2.referrer_id = r1.referred_id
          JOIN profiles p ON p.user_id = r2.referred_id
          JOIN profiles rp ON rp.user_id = r2.referrer_id
         WHERE r1.referrer_id = ${id}::uuid
         ORDER BY r2.created_at DESC
         LIMIT 1000`)
    );
  })
);
