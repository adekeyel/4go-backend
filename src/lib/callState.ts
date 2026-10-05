/**
 * The rules for how a call moves from state to state. Pure functions only (no database, no sockets),
 * so every rule can be tested on its own. callLifecycle.ts applies the result.
 *
 *   ringing --(callee answers)--> answered --(either side hangs up)--> answered + ended_at
 *   ringing --(callee declines)-> declined
 *   ringing --(caller hangs up)-> cancelled   (the callee sees this as a MISSED call)
 *   ringing --(nobody picks up)-> missed      (set by the server after RING_TIMEOUT_MS)
 *
 * The server decides, not the browsers. That is what makes missed calls reliable: before, a missed call
 * was only recorded if the callee's own browser happened to be open and send the update.
 */

/** How long a call rings before it counts as missed. */
export const RING_TIMEOUT_MS = 45_000;

export type CallStatus = "ringing" | "answered" | "declined" | "cancelled" | "missed";

/** What a client can ask for. "ended" = "I hung up a call that was connected". */
export type CallRequest = "answered" | "declined" | "cancelled" | "missed" | "ended";

export interface CallSnapshot {
  status: string;
  caller_id: string;
  callee_id: string;
  created_at: Date;
  answered_at: Date | null;
  ended_at: Date | null;
}

/** Columns to write. Only the keys present change. */
export interface CallPatch {
  status?: CallStatus;
  answered_at?: Date;
  ended_at?: Date;
  duration_seconds?: number;
}

const MAX_CLIENT_DURATION_S = 12 * 60 * 60;

function clampDuration(seconds: number | undefined): number {
  if (!Number.isFinite(seconds) || !seconds || seconds < 0) return 0;
  return Math.min(Math.round(seconds), MAX_CLIENT_DURATION_S);
}

/**
 * Decide what to write for `request` made by `actorId` (null = the server itself, e.g. the timeout sweeper).
 * Returns null when nothing should change. Always safe to call twice with the same input.
 */
export function planTransition(
  call: CallSnapshot,
  actorId: string | null,
  request: CallRequest,
  now: Date,
  clientDurationSeconds?: number
): CallPatch | null {
  const isSystem = actorId === null;
  const isCaller = actorId === call.caller_id;
  const isCallee = actorId === call.callee_id;
  if (!isSystem && !isCaller && !isCallee) return null; // not a participant
  if (call.ended_at) return null; // already over

  if (call.status === "ringing") {
    switch (request) {
      case "answered":
        if (isCallee) return { status: "answered", answered_at: now };
        if (isCaller) return closedAnsweredCall(now, clientDurationSeconds); // older web builds report the finished call this way
        return null;

      case "ended":
        // The call connected but this server never heard "answered" (older callee build): record it as answered.
        if (isSystem) return null;
        return closedAnsweredCall(now, clientDurationSeconds);

      case "declined":
        return isCallee ? { status: "declined", ended_at: now, duration_seconds: 0 } : null;

      case "cancelled":
        return isCaller ? { status: "cancelled", ended_at: now, duration_seconds: 0 } : null;

      case "missed":
        // The callee's browser (busy / ring timeout) or the server's sweeper. The caller can't mark itself missed.
        return isCallee || isSystem ? { status: "missed", ended_at: now, duration_seconds: 0 } : null;
    }
  }

  if (call.status === "answered") {
    if (isSystem) return null;
    // A second "answered" from the callee is just a retry or a double tap; it must not hang up the call.
    if (request === "answered" && isCallee) return null;
    // Anything else from a participant means the call is over (including a cancel that raced the answer).
    const startedAt = call.answered_at ?? call.created_at;
    const seconds = Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000));
    return { ended_at: now, duration_seconds: seconds };
  }

  return null; // declined / cancelled / missed are final
}

function closedAnsweredCall(now: Date, clientDurationSeconds?: number): CallPatch {
  const d = clampDuration(clientDurationSeconds);
  return { status: "answered", answered_at: new Date(now.getTime() - d * 1000), ended_at: now, duration_seconds: d };
}

/** What to tell people after a change. */
export function describeChange(before: Pick<CallSnapshot, "status">, after: Pick<CallSnapshot, "status">) {
  const wasRinging = before.status === "ringing";
  return {
    /** The phone should stop ringing (and clear its notification) everywhere. */
    stopRinging: wasRinging && after.status !== "ringing",
    /** The callee should be told they missed a call: nobody picked up, or the caller gave up first. */
    calleeMissedIt: wasRinging && (after.status === "missed" || after.status === "cancelled"),
  };
}
