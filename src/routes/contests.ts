import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { isSuperAdmin } from "@/lib/roles";

export const contestsRouter = Router();
contestsRouter.use(requireAuth);

const uuid = z.string().uuid();
const CRITERIA = ["online_minutes", "messages_sent", "referrals", "coins_earned"] as const;
const STATUSES = ["draft", "active", "ended"] as const;

async function requireAdmin(userId: string) {
  if (!(await isSuperAdmin(userId))) throw new ApiError(403, "Only admins can do this");
}

// ---- reading -------------------------------------------------------------

contestsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const contests = await prisma.contests.findMany({
      where: status ? { status } : {},
      orderBy: { created_at: "desc" },
    });
    const ids = contests.map((c) => c.id);
    const [counts, mine] = ids.length
      ? await Promise.all([
          prisma.contestParticipants.groupBy({ by: ["contest_id"], where: { contest_id: { in: ids } }, _count: { _all: true } }),
          prisma.contestParticipants.findMany({ where: { contest_id: { in: ids }, user_id: req.userId! } }),
        ])
      : [[], []];
    const countMap = new Map(counts.map((c) => [c.contest_id, c._count._all]));
    const joined = new Map(mine.map((m) => [m.contest_id, m]));
    res.json(
      contests.map((c) => ({
        ...c,
        participant_count: countMap.get(c.id) ?? 0,
        joined: joined.has(c.id),
        rewarded: joined.get(c.id)?.rewarded ?? false,
      }))
    );
  })
);

contestsRouter.get(
  "/:contestId",
  asyncHandler(async (req, res) => {
    const id = uuid.parse(req.params.contestId);
    const contest = await prisma.contests.findUnique({ where: { id } });
    if (!contest) throw new ApiError(404, "Contest not found");
    const [count, mine] = await Promise.all([
      prisma.contestParticipants.count({ where: { contest_id: id } }),
      prisma.contestParticipants.findUnique({ where: { contest_id_user_id: { contest_id: id, user_id: req.userId! } } }),
    ]);
    res.json({ ...contest, participant_count: count, joined: Boolean(mine), rewarded: mine?.rewarded ?? false });
  })
);

/**
 * Ports get_contest_leaderboard. Score depends on the contest's criteria:
 *   online_minutes: minutes online since you joined      messages_sent: messages sent since joining
 *   referrals: referrals made since joining              coins_earned: coins earned since joining
 * Coins earned used to read the lifetime earned_coins balance, which also drops when someone withdraws,
 * so it now sums earning transactions since joining (withdrawal refunds excluded).
 */
contestsRouter.get(
  "/:contestId/leaderboard",
  asyncHandler(async (req, res) => {
    const id = uuid.parse(req.params.contestId);
    const contest = await prisma.contests.findUnique({ where: { id }, select: { criteria: true } });
    if (!contest) throw new ApiError(404, "Contest not found");
    const criteria = contest.criteria || "online_minutes";

    const rows = await prisma.$queryRaw<unknown[]>(Prisma.sql`
      SELECT p.user_id, p.display_name, p.username, p.avatar_url, p.rank, cp.joined_at,
        GREATEST(0, p.total_online_minutes - cp.minutes_at_join)::int AS online_minutes_since_join,
        (CASE ${criteria}::text
           WHEN 'messages_sent' THEN (SELECT count(*) FROM messages m WHERE m.sender_id = p.user_id AND m.created_at >= cp.joined_at)
           WHEN 'referrals' THEN (SELECT count(*) FROM referrals r WHERE r.referrer_id = p.user_id AND r.created_at >= cp.joined_at)
           WHEN 'coins_earned' THEN (SELECT COALESCE(SUM(t.amount), 0) FROM transactions t
                                     WHERE t.user_id = p.user_id AND t.source = 'earning' AND t.amount > 0
                                       AND t.created_at >= cp.joined_at
                                       AND COALESCE(t.description, '') NOT LIKE 'Withdrawal%')
           ELSE GREATEST(0, p.total_online_minutes - cp.minutes_at_join)
         END)::int AS score,
        ${criteria}::text AS criteria,
        cp.rewarded, cp.rewarded_at
      FROM contest_participants cp
      JOIN profiles p ON p.user_id = cp.user_id
      WHERE cp.contest_id = ${id}::uuid
      ORDER BY score DESC, cp.joined_at ASC`);
    res.json(rows);
  })
);

// ---- joining -------------------------------------------------------------

// Ports the participant insert + trigger capture_contest_join_minutes (remember your online
// minutes at join time so only minutes earned afterwards count). The old policy let anyone insert
// a row for any contest; joining now requires an active contest inside its start/end window.
contestsRouter.post(
  "/:contestId/join",
  asyncHandler(async (req, res) => {
    const id = uuid.parse(req.params.contestId);
    const userId = req.userId!;
    const result = await prisma.$transaction(async (tx) => {
      const contest = await tx.contests.findUnique({ where: { id } });
      if (!contest) throw new ApiError(404, "Contest not found");
      const now = new Date();
      if (contest.status !== "active") throw new ApiError(400, "This contest isn't open for joining");
      if (contest.starts_at && contest.starts_at > now) throw new ApiError(400, "This contest hasn't started yet");
      if (contest.ends_at && contest.ends_at < now) throw new ApiError(400, "This contest has ended");

      const profile = await tx.profiles.findUnique({ where: { user_id: userId }, select: { total_online_minutes: true } });
      const inserted = await tx.contestParticipants.createMany({
        data: [{ contest_id: id, user_id: userId, minutes_at_join: profile?.total_online_minutes ?? 0 }],
        skipDuplicates: true,
      });
      return { joined: true, already_joined: inserted.count === 0 };
    });
    res.status(result.already_joined ? 200 : 201).json(result);
  })
);

// ---- admin ----------------------------------------------------------------

const contestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullish(),
  reward_amount: z.number().int().min(1).max(10_000_000),
  status: z.enum(STATUSES).default("draft"),
  starts_at: z.string().datetime().nullish(),
  ends_at: z.string().datetime().nullish(),
  max_winners: z.number().int().min(1).max(1000).nullish(),
  criteria: z.enum(CRITERIA).default("online_minutes"),
  criteria_label: z.string().max(120).nullish(),
});

const toDates = <T extends { starts_at?: string | null; ends_at?: string | null }>(b: T) => ({
  ...b,
  starts_at: b.starts_at === undefined ? undefined : b.starts_at ? new Date(b.starts_at) : null,
  ends_at: b.ends_at === undefined ? undefined : b.ends_at ? new Date(b.ends_at) : null,
});

contestsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    await requireAdmin(req.userId!);
    const body = toDates(contestSchema.parse(req.body));
    res.status(201).json(await prisma.contests.create({ data: { ...body, created_by: req.userId! } as any }));
  })
);

contestsRouter.patch(
  "/:contestId",
  asyncHandler(async (req, res) => {
    await requireAdmin(req.userId!);
    const id = uuid.parse(req.params.contestId);
    const body = toDates(contestSchema.partial().parse(req.body));
    if (!(await prisma.contests.findUnique({ where: { id }, select: { id: true } }))) throw new ApiError(404, "Contest not found");
    res.json(await prisma.contests.update({ where: { id }, data: { ...body, updated_at: new Date() } as any }));
  })
);

// Removes the contest and its participants. Coins already paid out stay with the winners.
contestsRouter.delete(
  "/:contestId",
  asyncHandler(async (req, res) => {
    await requireAdmin(req.userId!);
    const id = uuid.parse(req.params.contestId);
    await prisma.$transaction(async (tx) => {
      await tx.contestParticipants.deleteMany({ where: { contest_id: id } });
      await tx.contests.deleteMany({ where: { id } });
    });
    res.status(204).send();
  })
);

// Ports reward_contest_participant: pays the contest's reward into the winner's withdrawable
// (earned) coins. The status-guarded update means a double click can't pay twice.
contestsRouter.post(
  "/:contestId/participants/:userId/reward",
  asyncHandler(async (req, res) => {
    await requireAdmin(req.userId!);
    const contestId = uuid.parse(req.params.contestId);
    const winnerId = uuid.parse(req.params.userId);
    await prisma.$transaction(async (tx) => {
      const [contest, participant] = await Promise.all([
        tx.contests.findUnique({ where: { id: contestId }, select: { reward_amount: true, title: true } }),
        tx.contestParticipants.findUnique({ where: { contest_id_user_id: { contest_id: contestId, user_id: winnerId } } }),
      ]);
      if (!contest) throw new ApiError(404, "Contest not found");
      if (!participant) throw new ApiError(404, "User is not a participant in this contest");

      const { count } = await tx.contestParticipants.updateMany({
        where: { contest_id: contestId, user_id: winnerId, rewarded: false },
        data: { rewarded: true, rewarded_at: new Date() },
      });
      if (count === 0) throw new ApiError(409, "User already rewarded");

      await tx.profiles.update({
        where: { user_id: winnerId },
        data: { coins: { increment: contest.reward_amount }, earned_coins: { increment: contest.reward_amount } },
      });
      await tx.transactions.create({
        data: {
          user_id: winnerId,
          amount: contest.reward_amount,
          source: "earning",
          description: `Contest reward: ${contest.title}`,
          reference_id: contestId,
        },
      });
    });
    res.json({ rewarded: true });
  })
);
