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
    } catch (err) {
      console.error("[calls] sweeper failed:", (err as Error).message);
    } finally {
      running = false;
    }
  };
  setInterval(() => void tick(), 5_000).unref();
  void tick();
}
