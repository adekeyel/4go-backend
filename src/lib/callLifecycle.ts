import { prisma } from "@/lib/prisma";
import { emitToRoom, emitToUser } from "@/sockets";
import { pushCallEnded, pushMissedCall } from "@/lib/callPush";
import { forgetInvite } from "@/lib/callInvites";
import { RING_TIMEOUT_MS, CallRequest, planTransition, describeChange } from "@/lib/callState";

/**
 * Applies a call event to the database and tells everyone who needs to know.
 * actorId = the user who did it, or null for the server's own timeout.
 * Returns the call as it is now (or null if there is no such call).
 */
export async function applyCallTransition(callId: string, actorId: string | null, request: CallRequest, clientDurationSeconds?: number) {
  const before = await prisma.callLogs.findUnique({ where: { id: callId } });
  if (!before) return null;

  const patch = planTransition(before, actorId, request, new Date(), clientDurationSeconds);
  if (!patch) return before;

  // The WHERE re-checks the state we planned from, so two events arriving together (a cancel and an answer,
  // or the timeout and a decline) can't both win: the loser updates zero rows and we return what's stored.
  const written = await prisma.callLogs.updateMany({ where: { id: before.id, status: before.status, ended_at: null }, data: patch });
  const after = (await prisma.callLogs.findUnique({ where: { id: before.id } })) ?? before;
  if (written.count === 0) return after;

  const change = describeChange(before, after);
  emitToRoom(after.room_id, "call:log", after);
  // Both people hear about every change: the callee's missed-call badge, and the caller's screen stops ringing
  // when the call times out or the other side declines.
  emitToUser(after.caller_id, "call:updated", after);
  emitToUser(after.callee_id, "call:updated", after);
  if (change.stopRinging) {
    forgetInvite(after.id);
    void pushCallEnded(after);
  }
  if (change.calleeMissedIt) void pushMissedCall(after);
  return after;
}

/**
 * Called some seconds after a person's LAST connection drops (closed the tab, lost signal, phone died) and they
 * haven't come back. Closes what they left open so the history is right:
 *  - a call they were placing that nobody had picked up yet -> "cancelled" (the callee sees it as missed)
 *  - a call that was connected -> ended, with the length measured by the server
 * A call that is ringing FOR them is left alone: it keeps ringing through push and is marked missed at 45s.
 */
export async function endCallsLeftBehind(userId: string) {
  const open = await prisma.callLogs.findMany({
    where: { ended_at: null, status: { in: ["ringing", "answered"] }, OR: [{ caller_id: userId }, { callee_id: userId }] },
    select: { id: true, status: true, caller_id: true },
  });
  for (const c of open) {
    if (c.status === "answered") await applyCallTransition(c.id, userId, "ended");
    else if (c.caller_id === userId) await applyCallTransition(c.id, userId, "cancelled");
  }
}

/**
 * Every few seconds: any call still ringing after RING_TIMEOUT_MS is a missed call. Runs on the server, so it
 * works even when the callee's app is closed or offline. Also runs once at start-up, which clears calls that
 * were ringing when the server restarted.
 */
export function startCallSweeper() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const stale = await prisma.callLogs.findMany({
        where: { status: "ringing", created_at: { lt: new Date(Date.now() - RING_TIMEOUT_MS) } },
        select: { id: true },
        take: 100,
      });
      for (const c of stale) await applyCallTransition(c.id, null, "missed");

      // Safety net: a connected call nobody ever closed (both apps died) shouldn't stay "in progress" for ever.
      const stuck = await prisma.callLogs.findMany({
        where: { status: "answered", ended_at: null, answered_at: { lt: new Date(Date.now() - 6 * 60 * 60 * 1000) } },
        select: { id: true, caller_id: true },
        take: 100,
      });
      for (const c of stuck) await applyCallTransition(c.id, c.caller_id, "ended");
    } catch (err) {
      console.error("[calls] sweeper failed:", (err as Error).message);
    } finally {
      running = false;
    }
  };
  setInterval(() => void tick(), 5_000).unref();
  void tick();
}
