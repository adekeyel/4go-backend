import { env } from "@/lib/env";

/**
 * Plain-HTML versions of the React Email templates from the Supabase project (same copy, colours and
 * layout), so no React or @react-email packages are needed. Only signup (email verification) and recovery
 * (password reset) are ported, because those are the only flows this backend has. The magic-link, invite,
 * email-change and reauthentication templates have no matching feature here.
 */

export const SITE_NAME = "forego";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const GREEN = "#1daf5a"; // hsl(145, 72%, 40%)
const INK = "#0c1d14"; // hsl(150, 40%, 8%)
const MUTED = "#677e73"; // hsl(150, 10%, 45%)

function shell(preview: string, inner: string, footerHtml = "") {
  return `<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#ffffff;font-family:'Space Grotesk',Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preview)}</div>
<div style="padding:20px 25px;max-width:560px">${inner}${footerHtml}</div></body></html>`;
}

const h1 = (t: string) => `<h1 style="font-size:22px;font-weight:bold;color:${INK};margin:0 0 20px">${esc(t)}</h1>`;
const p = (t: string) => `<p style="font-size:14px;color:${MUTED};line-height:1.5;margin:0 0 25px">${t}</p>`;
const button = (href: string, label: string) =>
  `<a href="${esc(href)}" style="display:inline-block;background:${GREEN};color:#ffffff;font-size:14px;border-radius:16px;padding:12px 20px;text-decoration:none">${esc(label)}</a>`;
const small = (t: string) => `<p style="font-size:12px;color:#999999;margin:30px 0 0">${t}</p>`;

export function verificationEmail(args: { recipient: string; confirmationUrl: string }) {
  const html = shell(
    `Confirm your email for ${SITE_NAME}`,
    h1("Confirm your email") +
      p(`Thanks for signing up for <a href="${esc(env.siteUrl)}" style="color:inherit;text-decoration:underline"><strong>${SITE_NAME}</strong></a>!`) +
      p(`Please confirm your email address (<a href="mailto:${esc(args.recipient)}" style="color:inherit;text-decoration:underline">${esc(args.recipient)}</a>) by clicking the button below:`) +
      button(args.confirmationUrl, "Verify Email") +
      small("If you didn't create an account, you can safely ignore this email.")
  );
  const text = `Confirm your email\n\nThanks for signing up for ${SITE_NAME}!\n\nConfirm ${args.recipient} here: ${args.confirmationUrl}\n\nIf you didn't create an account, you can safely ignore this email.`;
  return { subject: "Confirm your email", html, text };
}

export function recoveryEmail(args: { confirmationUrl: string }) {
  const html = shell(
    `Reset your password for ${SITE_NAME}`,
    h1("Reset your password") +
      p(`We received a request to reset your password for ${SITE_NAME}. Click the button below to choose a new password.`) +
      button(args.confirmationUrl, "Reset Password") +
      small("If you didn't request a password reset, you can safely ignore this email. Your password will not be changed. This link expires in 1 hour.")
  );
  const text = `Reset your password\n\nWe received a request to reset your password for ${SITE_NAME}. Choose a new one here: ${args.confirmationUrl}\n\nThis link expires in 1 hour. If you didn't request it, you can safely ignore this email.`;
  return { subject: "Reset your password", html, text };
}

/** Marker the worker swaps for the recipient's unsubscribe link (or strips out if unsubscribe isn't configured). */
export const UNSUB_PLACEHOLDER = "%%UNSUBSCRIBE_URL%%";

/** Admin broadcast: same look as the original edge function, plus an unsubscribe footer. */
export function broadcastEmail(subject: string, message: string) {
  const body = esc(message).replace(/\n/g, "<br/>");
  const html = `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:24px">
    <div style="background:#fff;border-radius:16px;padding:28px;border:1px solid #e2e8f0">
      <h1 style="margin:0 0 16px;font-size:20px;color:#0f172a">${esc(subject)}</h1>
      <div style="font-size:15px;line-height:1.6;color:#334155">${body}</div>
    </div>
    <p style="text-align:center;color:#94a3b8;font-size:12px;margin-top:16px">Sent by 4GO • 4GO Technology LTD</p>
    <p data-unsub style="text-align:center;color:#94a3b8;font-size:12px;margin-top:4px"><a href="${UNSUB_PLACEHOLDER}" style="color:#94a3b8">Unsubscribe</a> from these emails</p>
  </div></body></html>`;
  return { html, text: `${message}\n\n--\nUnsubscribe: ${UNSUB_PLACEHOLDER}` };
}

export function unsubscribePage(kind: "confirm" | "done" | "invalid", opts: { email?: string; action?: string } = {}) {
  const card = (inner: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title></head>
<body style="margin:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif"><div style="max-width:440px;margin:60px auto;padding:0 16px">
<div style="background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px;text-align:center">${inner}</div></div></body></html>`;
  if (kind === "invalid")
    return card(`<h1 style="font-size:20px;color:${INK};margin:0 0 12px">Link not valid</h1><p style="color:${MUTED};font-size:14px;margin:0">This unsubscribe link is invalid or has expired.</p>`);
  if (kind === "done")
    return card(`<h1 style="font-size:20px;color:${INK};margin:0 0 12px">You're unsubscribed</h1><p style="color:${MUTED};font-size:14px;margin:0">${esc(opts.email ?? "This address")} won't receive any more announcement emails from ${SITE_NAME}. Account emails such as password resets are still sent.</p>`);
  return card(`<h1 style="font-size:20px;color:${INK};margin:0 0 12px">Unsubscribe?</h1><p style="color:${MUTED};font-size:14px;margin:0 0 20px">Stop announcement emails to ${esc(opts.email ?? "this address")}?</p>
<form method="post" action="${esc(opts.action ?? "")}"><button type="submit" style="background:${GREEN};color:#fff;border:0;border-radius:16px;padding:12px 20px;font-size:14px;cursor:pointer">Yes, unsubscribe me</button></form>`);
}
