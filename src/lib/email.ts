import jwt from "jsonwebtoken";
import { env } from "./env";
import { enqueueEmail } from "./emailQueue";
import { recoveryEmail, verificationEmail } from "./emailTemplates";

// Account emails go through the email queue (src/lib/emailQueue.ts): they're retried on failure,
// logged in email_send_log, and sent ahead of any broadcast. Same signatures as before.

export async function sendVerificationEmail(email: string, userId: string) {
  const token = jwt.sign({ sub: userId, purpose: "email_verify" }, env.jwtAccessSecret, { expiresIn: "1d" });
  const link = `${env.siteUrl}/verify-email?token=${token}`;
  const mail = verificationEmail({ recipient: email, confirmationUrl: link });
  await enqueueEmail({ queue: "auth", to: email, label: "signup", ...mail });
}

export async function sendPasswordResetEmail(email: string, userId: string) {
  const token = jwt.sign({ sub: userId, purpose: "password_reset" }, env.jwtAccessSecret, { expiresIn: "1h" });
  const link = `${env.siteUrl}/reset-password?token=${token}`;
  const mail = recoveryEmail({ confirmationUrl: link });
  await enqueueEmail({ queue: "auth", to: email, label: "recovery", ...mail });
}
