import { Resend } from "resend";
import jwt from "jsonwebtoken";
import { env } from "./env";

const resend = env.resendApiKey ? new Resend(env.resendApiKey) : null;

async function sendEmail(to: string, subject: string, html: string, text: string) {
  if (!resend) {
    console.warn(`[email] RESEND_API_KEY not set — skipping send to ${to}: ${subject}`);
    return;
  }
  await resend.emails.send({ from: env.emailFrom, to, subject, html, text });
}

export async function sendVerificationEmail(email: string, userId: string) {
  const token = jwt.sign({ sub: userId, purpose: "email_verify" }, env.jwtAccessSecret, { expiresIn: "1d" });
  const link = `${env.siteUrl}/verify-email?token=${token}`;
  await sendEmail(
    email,
    "Confirm your email",
    `<p>Welcome to forego! Confirm your email to get started:</p><p><a href="${link}">Confirm email</a></p>`,
    `Welcome to forego! Confirm your email: ${link}`
  );
}

export async function sendPasswordResetEmail(email: string, userId: string) {
  const token = jwt.sign({ sub: userId, purpose: "password_reset" }, env.jwtAccessSecret, { expiresIn: "1h" });
  const link = `${env.siteUrl}/reset-password?token=${token}`;
  await sendEmail(
    email,
    "Reset your password",
    `<p>Reset your forego password:</p><p><a href="${link}">Reset password</a></p><p>This link expires in 1 hour.</p>`,
    `Reset your password: ${link} (expires in 1 hour)`
  );
}
