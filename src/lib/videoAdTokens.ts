// Signed, single-purpose tokens that tie an ad event (view / completed / click) to a real serve.
// The serve endpoint hands one out with every ad; an event only counts if it presents a token that was
// signed for that exact ad and post and hasn't expired. Without this anyone could POST made-up events.
// Built as a factory (no env import) so it can be tested on its own.
import crypto from "crypto";

export const AD_TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // generous: covers a long video with a post-roll

export function createAdTokenSigner(secret: string) {
  // Derive a separate key so these tokens can never be confused with (or used as) login tokens.
  const key = crypto.createHmac("sha256", secret).update("video-ad-events/v1").digest();
  const sign = (adId: string, postId: string, exp: number, nonce: string) =>
    crypto.createHmac("sha256", key).update(`${adId}|${postId}|${exp}|${nonce}`).digest("base64url");

  // Separate key again for hashing viewers (account id or IP) into the per-viewer cap.
  const viewerKey = crypto.createHmac("sha256", secret).update("video-ad-viewer/v1").digest();

  return {
    /** Stable, non-reversible stand-in for a viewer (account id or address) so the raw value is never stored. */
    hashViewer(viewer: string): string {
      return crypto.createHmac("sha256", viewerKey).update(viewer).digest("base64url").slice(0, 32);
    },
    issue(adId: string, postId: string, now = Date.now()): string {
      const exp = now + AD_TOKEN_TTL_MS;
      const nonce = crypto.randomBytes(12).toString("base64url");
      return `${exp}.${nonce}.${sign(adId, postId, exp, nonce)}`;
    },
    /** Returns the token's identity if it's genuine and unexpired for this ad + post, otherwise null. */
    verify(token: string, adId: string, postId: string, now = Date.now()): { nonce: string; exp: number } | null {
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      const [expStr, nonce, sig] = parts;
      const exp = Number(expStr);
      if (!Number.isFinite(exp) || exp < now || exp > now + AD_TOKEN_TTL_MS + 60_000) return null;
      const given = Buffer.from(sig);
      const expected = Buffer.from(sign(adId, postId, exp, nonce));
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
      return { nonce, exp };
    },
  };
}
