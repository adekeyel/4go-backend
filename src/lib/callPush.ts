import { prisma } from "@/lib/prisma";
import { sendPush } from "@/lib/push";

/**
 * Push notifications for calls (so a locked or closed phone rings, and a ringing phone stops).
 * The browser used to call the send-push function itself with whatever text it liked; now the server
 * builds the notification from the real call_logs row, so nobody can make another user's phone ring
 * with a forged caller or a made-up call.
 */

const INVITE_MAX_AGE_MS = 2 * 60_000;
const pushedInvites = new Map<string, number>(); // callId -> when, so repeated socket events can't spam a phone

function rememberInvite(callId: string): boolean {
  const now = Date.now();
  for (const [k, t] of pushedInvites) if (now - t > INVITE_MAX_AGE_MS * 2) pushedInvites.delete(k);
  if (pushedInvites.has(callId)) return false;
  pushedInvites.set(callId, now);
  return true;
}

export type VerifiedCall = {
  id: string;
  room_id: string;
  caller_id: string;
  callee_id: string;
  call_type: string;
  callerName: string;
  callerAvatarUrl: string | null;
};

/**
 * Check that a call invite is real: the row exists, was created by this caller for this callee in this room,
 * is fresh, and the call type matches. Returns the verified call plus the caller's real name and avatar, or null.
 */
export async function verifyInvite(
  callerId: string,
  p: { callId: string; roomId: string; calleeId: string; callType: string }
): Promise<VerifiedCall | null> {
  if (![p.callId, p.roomId, p.calleeId].every((v) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v))) return null;
  const call = await prisma.callLogs.findUnique({ where: { id: p.callId } });
  if (!call) return null;
  if (call.caller_id !== callerId || call.callee_id !== p.calleeId || call.room_id !== p.roomId) return null;
  if (call.call_type !== p.callType) return null;
  if (call.status !== "ringing") return null; // already answered, declined, cancelled or timed out
  if (Date.now() - call.created_at.getTime() > INVITE_MAX_AGE_MS) return null;
  const caller = await prisma.profiles.findUnique({ where: { user_id: callerId }, select: { display_name: true, username: true, avatar_url: true } });
  return {
    id: call.id,
    room_id: call.room_id,
    caller_id: call.caller_id,
    callee_id: call.callee_id,
    call_type: call.call_type,
    callerName: caller?.display_name ?? caller?.username ?? "Someone",
    callerAvatarUrl: caller?.avatar_url ?? null,
  };
}

/** Ring the callee's devices. Once per call. */
export async function pushIncomingCall(call: VerifiedCall, group = false) {
  if (!rememberInvite(call.id)) return;
  await sendPush([call.callee_id], {
    title: group ? `Group ${call.call_type} call` : `${call.callerName} is calling`,
    body: group ? `${call.callerName} added you to a call` : `Incoming ${call.call_type} call — tap to answer`,
    data: {
      navigateTo: `/call/${call.id}`,
      tag: `call-${call.id}`,
      kind: "incoming_call",
      callerName: call.callerName,
      callerId: call.caller_id,
      callType: call.call_type,
      roomId: call.room_id,
      callId: call.id,
    },
  });
}

/** Stop the ringing (and clear the notification) on the callee's devices once the call is answered, declined, cancelled or missed. */
export async function pushCallEnded(call: { id: string; room_id: string; callee_id: string }) {
  pushedInvites.delete(call.id);
  await sendPush([call.callee_id], {
    title: "Call ended",
    body: "The call has ended",
    data: { kind: "call_cancelled", tag: `call-${call.id}`, callId: call.id, roomId: call.room_id },
  });
}

/**
 * "Missed voice call" notification for the callee: nobody picked up, or the caller hung up while it was still ringing.
 * (Like WhatsApp, a call you didn't get to answer leaves a trace even if your phone was off.)
 */
export async function pushMissedCall(call: { id: string; room_id: string; caller_id: string; callee_id: string; call_type: string }) {
  const [caller, recent] = await Promise.all([
    prisma.profiles.findUnique({ where: { user_id: call.caller_id }, select: { display_name: true, username: true } }),
    // Several misses from the same person in a row become ONE notification that updates ("3 missed calls"),
    // instead of a pile of separate ones.
    prisma.callLogs.count({
      where: {
        caller_id: call.caller_id,
        callee_id: call.callee_id,
        status: { in: ["missed", "cancelled"] },
        duration_seconds: 0,
        created_at: { gt: new Date(Date.now() - 24 * 3600 * 1000) },
      },
    }),
  ]);
  const name = caller?.display_name ?? caller?.username ?? "Someone";
  const many = recent > 1;
  await sendPush([call.callee_id], {
    title: many ? `${recent} missed calls` : `Missed ${call.call_type} call`,
    body: many ? `${name} tried to call you ${recent} times` : `${name} tried to call you`,
    data: {
      navigateTo: `/room/${call.room_id}`,
      tag: `missed-${call.caller_id}`, // same tag = the newer one replaces the older
      kind: "missed_call",
      callId: call.id,
      roomId: call.room_id,
      callType: call.call_type, // lets the "Call back" button start the same kind of call
    },
  });
}
