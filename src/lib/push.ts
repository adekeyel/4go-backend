import { mutedUserIds } from "@/lib/chatPrefs";
import webpush from "web-push";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";

/**
 * Web Push delivery. Ports the send-push edge function plus the three database triggers that called it
 * (notify_push_on_message, notify_push_on_mention, and the support-message alert).
 *
 * send-push used to be a public HTTP endpoint, so anyone holding the anon key could push arbitrary
 * notifications to any user. Here it's an internal function only; there is no route for it.
 *
 * Needs VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (and optionally VAPID_SUBJECT) in the environment.
 * Without them every call is a quiet no-op, so local development works without keys.
 */

let configured: boolean | null = null;
function ensureConfigured(): boolean {
  if (configured !== null) return configured;
  if (!env.vapid.publicKey || !env.vapid.privateKey) {
    console.warn("[push] VAPID keys not set; push notifications are disabled");
    return (configured = false);
  }
  webpush.setVapidDetails(env.vapid.subject, env.vapid.publicKey, env.vapid.privateKey);
  return (configured = true);
}

export type PushPayload = {
  title: string;
  body: string;
  /** e.g. { navigateTo: "/room/<id>", tag: "msg-<id>" } */
  data?: Record<string, unknown>;
};

const SEND_CONCURRENCY = 50;

/**
 * Send one notification to every device of the given users. Devices whose push service says they're
 * gone (404/410) are deleted. Never throws, so a push failure can't break the request that triggered it.
 */
export async function sendPush(userIds: string[], payload: PushPayload) {
  const result = { sent: 0, expired: 0, total: 0 };
  try {
    const ids = [...new Set(userIds)];
    if (!ids.length || !ensureConfigured()) return result;

    const subs = await prisma.pushSubscriptions.findMany({ where: { user_id: { in: ids } } });
    result.total = subs.length;
    const body = JSON.stringify({ title: payload.title, body: payload.body, data: payload.data ?? {} });
    const expired: string[] = [];

    // Big rooms can mean thousands of devices: send in bounded batches instead of all at once.
    for (let i = 0; i < subs.length; i += SEND_CONCURRENCY) {
      await Promise.all(
        subs.slice(i, i + SEND_CONCURRENCY).map(async (sub) => {
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              body,
              { TTL: 2_419_200, urgency: "high" }
            );
            result.sent++;
          } catch (err) {
            const status = (err as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) expired.push(sub.endpoint);
            else console.error("[push] send failed:", status, (err as Error).message);
          }
        })
      );
    }

    if (expired.length) {
      await prisma.pushSubscriptions.deleteMany({ where: { endpoint: { in: expired } } });
      result.expired = expired.length;
    }
  } catch (err) {
    console.error("[push] sendPush error:", (err as Error).message);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Push endpoints are URLs the client hands us and the server then POSTs to. Only accept the hosts
// real browsers' push services use, so nobody can register an internal address and turn push
// into a way to make the server call it. (Hosts seen in your data: fcm.googleapis.com,
// updates.push.services.mozilla.com, *.notify.windows.com.)
const PUSH_HOST_SUFFIXES = [
  "fcm.googleapis.com",
  ".push.services.mozilla.com",
  ".notify.windows.com",
  ".push.apple.com",
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return PUSH_HOST_SUFFIXES.some((s) => (s.startsWith(".") ? host.endsWith(s) : host === s));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// The three notifications the database used to fire.

type MessageLike = { id: string; room_id: string; sender_id: string; type: string; content: string | null };

function messagePreview(m: MessageLike): string {
  switch (m.type) {
    case "image":
      return "📷 Sent a photo";
    case "audio":
      return "🎤 Sent a voice note";
    case "video":
      return "🎬 Sent a video";
    // For these the content is JSON ({ post_id, note }); the SQL trigger put the raw JSON in the notification.
    case "shared_post":
    case "shared_page_post":
      return "🔗 Shared a post";
    default:
      return m.content ? m.content.slice(0, 100) : "New message";
  }
}

/** Ports notify_push_on_message: everyone in the room except the sender gets a push. */
export async function pushNewMessage(m: MessageLike) {
  try {
    const [room, sender, members] = await Promise.all([
      prisma.rooms.findUnique({ where: { id: m.room_id }, select: { name: true, type: true } }),
      prisma.profiles.findUnique({ where: { user_id: m.sender_id }, select: { display_name: true } }),
      prisma.roomMembers.findMany({
        where: { room_id: m.room_id, user_id: { not: m.sender_id } },
        select: { user_id: true },
      }),
    ]);
    if (!room || !members.length) return;
    const senderName = sender?.display_name ?? "Someone";
    const muted = await mutedUserIds(m.room_id, members.map((x) => x.user_id));
    const recipients = members.map((x) => x.user_id).filter((id) => !muted.has(id));
    if (!recipients.length) return;
    await sendPush(
      recipients,
      {
        title: room.type === "dm" ? senderName : `${senderName} in ${room.name}`,
        body: messagePreview(m),
        data: { navigateTo: `/room/${m.room_id}`, tag: `msg-${m.id}` },
      }
    );
  } catch (err) {
    console.error("[push] pushNewMessage error:", (err as Error).message);
  }
}

/** Ports notify_push_on_mention. */
export async function pushMention(input: {
  mentionerId: string;
  mentionedUserId: string;
  sourceType: "message" | "comment" | "post";
  sourceId: string;
  contextId?: string | null;
  preview?: string | null;
}) {
  try {
    const mentioner = await prisma.profiles.findUnique({
      where: { user_id: input.mentionerId },
      select: { display_name: true, username: true },
    });
    const name = mentioner?.display_name ?? mentioner?.username ?? "Someone";

    let navigateTo = "/";
    if (input.sourceType === "message") {
      navigateTo = `/room/${input.contextId ?? ""}?messageId=${input.sourceId}`;
    } else {
      navigateTo = `/?post=${input.contextId ?? input.sourceId}`;
      if (input.sourceType === "comment") navigateTo += `&comments=1&commentId=${input.sourceId}`;
    }

    await sendPush([input.mentionedUserId], {
      title: `${name} mentioned you`,
      body: (input.preview ?? "").slice(0, 120),
      data: { navigateTo, tag: `mention-${input.sourceId}-${input.mentionedUserId}` },
    });
  } catch (err) {
    console.error("[push] pushMention error:", (err as Error).message);
  }
}

/** Ports the alert in tg_support_message_bump: tell support staff a customer wrote in. */
export async function pushSupportMessage(input: {
  conversationId: string;
  senderId: string;
  content: string;
  agentIds: string[];
}) {
  try {
    if (!input.agentIds.length) return;
    const sender = await prisma.profiles.findUnique({
      where: { user_id: input.senderId },
      select: { display_name: true, username: true },
    });
    const name = sender?.display_name ?? sender?.username ?? "A user";
    await sendPush(input.agentIds, {
      title: "New support message",
      body: `${name}: ${input.content.slice(0, 100)}`,
      data: { navigateTo: "/super-admin", tag: `support-${input.conversationId}` },
    });
  } catch (err) {
    console.error("[push] pushSupportMessage error:", (err as Error).message);
  }
}
