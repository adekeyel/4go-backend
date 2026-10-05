import crypto from "crypto";
import { env } from "@/lib/env";

/**
 * The STUN/TURN servers a browser should use for a call.
 * STUN lets two devices find each other when the network allows it; TURN relays the media when it doesn't.
 * See TURN_* in lib/env.ts. With nothing configured this returns STUN only (calls work on friendly networks).
 */
export function buildIceServers(userId: string): { urls: string | string[]; username?: string; credential?: string }[] {
  const servers: { urls: string | string[]; username?: string; credential?: string }[] = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ];
  const { urls, username, credential, sharedSecret, ttlSeconds } = env.turn;
  if (!urls.length) return servers;

  if (sharedSecret) {
    // coturn "use-auth-secret": a short-lived username/password derived from the secret, nothing permanent is sent to browsers.
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const user = `${expires}:${userId}`;
    servers.push({ urls, username: user, credential: crypto.createHmac("sha1", sharedSecret).update(user).digest("base64") });
  } else if (username && credential) {
    servers.push({ urls, username, credential });
  }
  return servers;
}
