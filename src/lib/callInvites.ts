import { RING_TIMEOUT_MS } from "@/lib/callState";

/**
 * Calls that are ringing right now, kept in memory (they only live for ~45 seconds).
 *
 * Why: the invite (with the WebRTC offer) used to be sent over the socket exactly once. A callee whose
 * app was closed, locked, or briefly offline never got it, so tapping the "incoming call" notification
 * opened a screen that said "Waiting for the call signal..." forever. Now the callee's app asks for any
 * pending invites as soon as it is connected and listening (socket event "call:pending"), and the server
 * replays them, together with the caller's network candidates that arrived in the meantime.
 */

export interface PendingInvite {
  callId: string;
  roomId: string;
  callerId: string;
  calleeId: string;
  callType: string;
  callerName: string;
  callerAvatarUrl: string | null;
  sdp: unknown;
  createdAt: number;
  /** ICE candidates the caller sent before the callee picked up. */
  signals: { from: string; signal: unknown }[];
}

const invites = new Map<string, PendingInvite>();
const MAX_BUFFERED_SIGNALS = 200;

function prune() {
  const now = Date.now();
  for (const [id, inv] of invites) if (now - inv.createdAt > RING_TIMEOUT_MS + 15_000) invites.delete(id);
}

export function rememberInvite(inv: Omit<PendingInvite, "createdAt" | "signals">) {
  prune();
  invites.set(inv.callId, { ...inv, createdAt: Date.now(), signals: [] });
}

export function forgetInvite(callId: string) {
  invites.delete(callId);
}

/** Keep the caller's ICE candidates for a callee who hasn't answered (or connected) yet. */
export function bufferCallerSignal(callId: string, from: string, to: string, signal: unknown) {
  const inv = invites.get(callId);
  if (!inv || inv.callerId !== from || inv.calleeId !== to) return;
  if (inv.signals.length < MAX_BUFFERED_SIGNALS) inv.signals.push({ from, signal });
}

export function pendingInvitesFor(userId: string): PendingInvite[] {
  prune();
  const now = Date.now();
  return [...invites.values()].filter((i) => i.calleeId === userId && now - i.createdAt < RING_TIMEOUT_MS);
}
