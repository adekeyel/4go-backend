import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { Resend } from "resend";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { MAX_RETRIES, backoffSeconds, classifyProviderFailure, isExpired } from "@/lib/emailPolicy";
import { UNSUB_PLACEHOLDER } from "@/lib/emailTemplates";

/**
 * Email delivery. Replaces the Supabase pgmq queues, the pg_cron dispatcher and the Lovable email API
 * with a Postgres table (email_queue) and an in-process worker that sends through Resend.
 *
 *  - two queues: "auth" (verification, password reset; sent first, expires after 15 min) and
 *    "transactional" (broadcasts; expires after 60 min). Limits come from the email_send_state row.
 *  - real failures are retried up to 5 times with backoff, then parked as status "dlq"
 *  - rate limits (429) pause the whole worker instead of using up a message's retries
 *  - unsubscribed addresses (suppressed_emails) are skipped for everything except "auth" emails
 *  - every outcome is recorded in email_send_log
 *
 * Safe to run on several instances: rows are claimed with FOR UPDATE SKIP LOCKED.
 */

export type QueueName = "auth" | "transactional";

const CLAIM_SECONDS = 30; // like pgmq's visibility timeout: a claimed row stays hidden this long
const DEFAULT_BATCH = 10;
const DEFAULT_DELAY_MS = 200;
const DEFAULT_TTL: Record<QueueName, number> = { auth: 15, transactional: 60 };
const TICK_MS = 5000;

const resend = env.resendApiKey ? new Resend(env.resendApiKey) : null;
export const emailEnabled = Boolean(resend);

export function unsubscribeUrl(token: string): string | null {
  return env.apiUrl ? `${env.apiUrl}/api/email/unsubscribe?token=${token}` : null;
}

async function logSend(messageId: string, label: string, to: string, status: string, error?: string) {
  await prisma.emailSendLog
    .create({
      data: {
        message_id: messageId,
        template_name: label,
        recipient_email: to,
        status,
        error_message: error ? error.slice(0, 1000) : null,
      },
    })
    .catch((e) => console.error("[email] could not write send log:", (e as Error).message));
}

// ---------------------------------------------------------------- unsubscribe tokens

/** Ports ensure_unsub_token, for many addresses at once. */
export async function ensureUnsubTokens(emails: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const map = new Map<string, string>();
  for (let i = 0; i < unique.length; i += 1000) {
    const chunk = unique.slice(i, i + 1000);
    const existing = await prisma.emailUnsubscribeTokens.findMany({
      where: { email: { in: chunk } },
      select: { email: true, token: true },
    });
    existing.forEach((r) => map.set(r.email, r.token));
    const missing = chunk.filter((e) => !map.has(e));
    if (missing.length) {
      await prisma.emailUnsubscribeTokens.createMany({
        data: missing.map((email) => ({ email, token: crypto.randomBytes(32).toString("hex") })),
        skipDuplicates: true,
      });
      const created = await prisma.emailUnsubscribeTokens.findMany({
        where: { email: { in: missing } },
        select: { email: true, token: true },
      });
      created.forEach((r) => map.set(r.email, r.token));
    }
  }
  return map;
}

// ---------------------------------------------------------------- enqueue

export type OutgoingEmail = {
  queue: QueueName;
  to: string;
  subject: string;
  html: string;
  text?: string;
  label: string;
  unsubscribeToken?: string | null;
  from?: string;
};

/** Queue one email. Returns its message id, or null when email isn't configured (RESEND_API_KEY missing). */
export async function enqueueEmail(email: OutgoingEmail): Promise<string | null> {
  if (!resend) {
    console.warn(`[email] RESEND_API_KEY not set, skipping "${email.subject}" to ${email.to}`);
    return null;
  }
  const messageId = crypto.randomUUID();
  await prisma.emailQueue.create({
    data: {
      queue: email.queue,
      message_id: messageId,
      to_email: email.to.trim().toLowerCase(),
      from_email: email.from ?? env.emailFrom,
      subject: email.subject,
      html: email.html,
      text: email.text ?? null,
      label: email.label,
      unsubscribe_token: email.unsubscribeToken ?? null,
    },
  });
  if (email.queue === "auth") await logSend(messageId, email.label, email.to, "pending");
  kickEmailWorker();
  return messageId;
}

/** Queue many emails at once (broadcasts). Returns how many rows were added. */
export async function enqueueEmailsBulk(rows: OutgoingEmail[]): Promise<number> {
  if (!resend || !rows.length) return 0;
  const result = await prisma.emailQueue.createMany({
    data: rows.map((e) => ({
      queue: e.queue,
      message_id: crypto.randomUUID(),
      to_email: e.to.trim().toLowerCase(),
      from_email: e.from ?? env.emailFrom,
      subject: e.subject,
      html: e.html,
      text: e.text ?? null,
      label: e.label,
      unsubscribe_token: e.unsubscribeToken ?? null,
    })),
  });
  kickEmailWorker();
  return result.count;
}

// ---------------------------------------------------------------- worker

type Claimed = {
  id: string;
  queue: QueueName;
  message_id: string;
  to_email: string;
  from_email: string;
  subject: string;
  html: string;
  text: string | null;
  label: string;
  unsubscribe_token: string | null;
  attempts: number;
  queued_at: Date;
};

async function claimBatch(limit: number): Promise<Claimed[]> {
  // Auth emails first, then oldest first. Rows already claimed by another worker are skipped.
  return prisma.$queryRaw<Claimed[]>(Prisma.sql`
    UPDATE email_queue
       SET visible_at = now() + make_interval(secs => ${CLAIM_SECONDS}), updated_at = now()
     WHERE id IN (
       SELECT id FROM email_queue
        WHERE status = 'pending' AND visible_at <= now()
        ORDER BY (queue = 'auth') DESC, queued_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
    RETURNING id, queue, message_id, to_email, from_email, subject, html, text, label,
              unsubscribe_token, attempts, queued_at`);
}

async function toDlq(row: Claimed, reason: string) {
  await prisma.emailQueue.update({
    where: { id: row.id },
    data: { status: "dlq", error_message: reason.slice(0, 1000), updated_at: new Date() },
  });
  await logSend(row.message_id, row.label, row.to_email, "dlq", reason);
}

async function setCooldown(seconds: number) {
  const until = new Date(Date.now() + seconds * 1000);
  await prisma.emailSendState.upsert({
    where: { id: 1 },
    create: { id: 1, retry_after_until: until },
    update: { retry_after_until: until, updated_at: new Date() },
  });
  return until;
}

function personalise(row: Claimed) {
  const url = row.unsubscribe_token ? unsubscribeUrl(row.unsubscribe_token) : null;
  let html = row.html;
  let text = row.text ?? undefined;
  if (url) {
    html = html.split(UNSUB_PLACEHOLDER).join(url);
    text = text?.split(UNSUB_PLACEHOLDER).join(url);
  } else {
    html = html.replace(/<p data-unsub[\s\S]*?<\/p>/, "");
    text = text?.replace(/\n\n--\nUnsubscribe: .*$/s, "");
  }
  const headers: Record<string, string> = {};
  if (url) {
    headers["List-Unsubscribe"] = `<${url}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  return { html, text, headers };
}

/** Send one claimed email. Returns "stop" when the whole worker should pause. */
async function deliver(row: Claimed, ttl: Record<QueueName, number>): Promise<"ok" | "stop"> {
  if (isExpired(row.queued_at, ttl[row.queue] ?? 60)) {
    await toDlq(row, `TTL exceeded (${ttl[row.queue]} minutes)`);
    return "ok";
  }
  if (row.attempts >= MAX_RETRIES) {
    await toDlq(row, `Max retries (${MAX_RETRIES}) exceeded`);
    return "ok";
  }
  if (await prisma.emailSendLog.findFirst({ where: { message_id: row.message_id, status: "sent" }, select: { id: true } })) {
    await prisma.emailQueue.deleteMany({ where: { id: row.id } }); // another worker already sent it
    return "ok";
  }
  if (row.queue !== "auth" && (await prisma.suppressedEmails.findUnique({ where: { email: row.to_email }, select: { id: true } }))) {
    await prisma.emailQueue.deleteMany({ where: { id: row.id } });
    await logSend(row.message_id, row.label, row.to_email, "suppressed");
    return "ok";
  }

  const { html, text, headers } = personalise(row);
  try {
    const res: any = await resend!.emails.send({
      from: row.from_email,
      to: row.to_email,
      subject: row.subject,
      html,
      text,
      headers,
    });
    // The Resend SDK reports API errors in the result instead of throwing.
    if (res?.error) throw Object.assign(new Error(res.error.message ?? "Resend error"), { statusCode: res.error.statusCode, providerName: res.error.name });

    await logSend(row.message_id, row.label, row.to_email, "sent");
    await prisma.emailQueue.deleteMany({ where: { id: row.id } });
    return "ok";
  } catch (err) {
    const e = err as Error & { statusCode?: number; providerName?: string };
    const failure = classifyProviderFailure({ statusCode: e.statusCode, name: e.providerName });
    console.error("[email] send failed:", row.label, e.statusCode ?? "", e.message);

    if (failure.kind === "rate_limited" || failure.kind === "config") {
      // Not this message's fault: pause the worker, keep the message, don't use up a retry.
      const until = await setCooldown(failure.cooldownSeconds);
      await prisma.emailQueue.update({ where: { id: row.id }, data: { visible_at: until, updated_at: new Date() } });
      await logSend(row.message_id, row.label, row.to_email, failure.kind === "rate_limited" ? "rate_limited" : "failed", e.message);
      return "stop";
    }
    if (failure.kind === "permanent") {
      await toDlq(row, e.message);
      return "ok";
    }
    const attempts = row.attempts + 1;
    await prisma.emailQueue.update({
      where: { id: row.id },
      data: {
        attempts,
        error_message: e.message.slice(0, 1000),
        visible_at: new Date(Date.now() + backoffSeconds(attempts) * 1000),
        updated_at: new Date(),
      },
    });
    await logSend(row.message_id, row.label, row.to_email, "failed", e.message);
    return "ok";
  }
}

async function processBatch(): Promise<number> {
  const state = await prisma.emailSendState.findUnique({ where: { id: 1 } });
  if (state?.retry_after_until && state.retry_after_until > new Date()) return 0;

  const rows = await claimBatch(state?.batch_size ?? DEFAULT_BATCH);
  if (!rows.length) return 0;
  const delay = state?.send_delay_ms ?? DEFAULT_DELAY_MS;
  const ttl: Record<QueueName, number> = {
    auth: state?.auth_email_ttl_minutes ?? DEFAULT_TTL.auth,
    transactional: state?.transactional_email_ttl_minutes ?? DEFAULT_TTL.transactional,
  };

  for (let i = 0; i < rows.length; i++) {
    if ((await deliver(rows[i], ttl)) === "stop") {
      // Give the rest of the claimed batch back so it isn't stuck hidden for 30 seconds.
      const rest = rows.slice(i + 1).map((r) => r.id);
      if (rest.length) {
        const fresh = await prisma.emailSendState.findUnique({ where: { id: 1 } });
        await prisma.emailQueue.updateMany({ where: { id: { in: rest } }, data: { visible_at: fresh?.retry_after_until ?? new Date() } });
      }
      return 0;
    }
    if (i < rows.length - 1) await new Promise((r) => setTimeout(r, delay));
  }
  return rows.length;
}

let running = false;
export async function processEmailQueue() {
  if (running || !resend) return;
  running = true;
  try {
    // Keep going while there is work, so a big broadcast drains without waiting for the next tick.
    for (let i = 0; i < 1000; i++) if ((await processBatch()) === 0) break;
  } catch (err) {
    console.error("[email] worker error:", (err as Error).message);
  } finally {
    running = false;
  }
}

/** Process right away (used after enqueueing so password-reset emails don't wait for the next tick). */
export function kickEmailWorker() {
  if (resend) setImmediate(() => void processEmailQueue());
}

/** Start the background worker. Call once at server start. */
export function startEmailWorker() {
  if (!resend) {
    console.warn("[email] RESEND_API_KEY not set; email worker not started");
    return;
  }
  if (!env.apiUrl) console.warn("[email] PUBLIC_API_URL not set; broadcast emails will have no unsubscribe link");
  const timer = setInterval(() => void processEmailQueue(), TICK_MS);
  timer.unref();
  kickEmailWorker();
}
