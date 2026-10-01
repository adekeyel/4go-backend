import { Router } from "express";
import { z } from "zod";
import jwtLib from "jsonwebtoken";
import ms from "@/utils/ms";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { hashPassword, verifyPassword } from "@/utils/password";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "@/utils/jwt";
import { asyncHandler, ApiError } from "@/middleware/errorHandler";
import { requireAuth } from "@/middleware/auth";
import { sendPasswordResetEmail, sendVerificationEmail } from "@/lib/email";
import { generateReferralCode, processReferral } from "@/lib/referrals";

export const authRouter = Router();

const REFRESH_COOKIE = "forego_refresh";

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: env.isProd,
    sameSite: "lax" as const,
    path: "/api/auth",
    maxAge: ms(env.jwtRefreshTtl),
  };
}

function getRefreshToken(req: import("express").Request): string | undefined {
  // Web clients: httpOnly cookie. Mobile clients (React Native has no cookie
  // jar by default): the refresh token is also returned in the JSON body on
  // login/signup/refresh, and the mobile app sends it back explicitly here.
  return req.cookies?.[REFRESH_COOKIE] || req.body?.refreshToken;
}

async function issueSession(userId: string, userAgent: string | undefined, ip: string | undefined) {
  const session = await prisma.refreshSession.create({
    data: {
      user_id: userId,
      user_agent: userAgent ?? null,
      ip: ip ?? null,
      expires_at: new Date(Date.now() + ms(env.jwtRefreshTtl)),
    },
  });
  const accessToken = signAccessToken(userId);
  const refreshToken = signRefreshToken(userId, session.id);
  return { accessToken, refreshToken };
}

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  // The native app collects a real username at signup; the web app doesn't
  // ask for one until the post-login "set up your profile" step, so this is
  // left null here rather than auto-generating a throwaway one.
  username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/, "Letters, numbers, underscores only").optional(),
  displayName: z.string().min(1).max(60).optional(),
  referralCode: z.string().max(32).optional(),
});

authRouter.post(
  "/signup",
  asyncHandler(async (req, res) => {
    const body = signupSchema.parse(req.body);
    const email = body.email.toLowerCase().trim();

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new ApiError(409, "An account with this email already exists");

    let username: string | null = null;
    if (body.username) {
      const taken = await prisma.profiles.findUnique({ where: { username: body.username } });
      if (taken) throw new ApiError(409, "That username is taken");
      username = body.username;
    }

    const password_hash = await hashPassword(body.password);

    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({ data: { email, password_hash } });
      await tx.profiles.create({
        data: {
          user_id: u.id,
          username,
          display_name: body.displayName ?? username ?? email.split("@")[0],
          referral_code: generateReferralCode(),
        },
      });
      // Ports process_referral: pays the referrer 500 reward coins when a valid code is supplied.
      await processReferral(tx, body.referralCode, u.id);
      return u;
    });

    const { accessToken, refreshToken } = await issueSession(user.id, req.headers["user-agent"], req.ip);
    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions());

    // Fire-and-forget email verification; signup should not fail if email sending fails.
    sendVerificationEmail(email, user.id).catch((err) => console.error("verification email failed", err));

    // refreshToken is included for mobile clients (no cookie jar); web clients
    // ignore this field and rely on the httpOnly cookie set above.
    res.status(201).json({ accessToken, refreshToken, userId: user.id });
  })
);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const email = body.email.toLowerCase().trim();

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new ApiError(401, "Invalid email or password");

    const valid = await verifyPassword(body.password, user.password_hash);
    if (!valid) throw new ApiError(401, "Invalid email or password");

    const profile = await prisma.profiles.findUnique({ where: { user_id: user.id } });
    if (profile?.is_suspended) {
      throw new ApiError(403, profile.suspended_reason || "This account has been suspended");
    }

    const { accessToken, refreshToken } = await issueSession(user.id, req.headers["user-agent"], req.ip);
    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions());

    res.json({ accessToken, refreshToken, userId: user.id });
  })
);

authRouter.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const token = getRefreshToken(req);
    if (!token) throw new ApiError(401, "No refresh token");

    let payload;
    try {
      payload = verifyRefreshToken(token);
    } catch {
      throw new ApiError(401, "Invalid refresh token");
    }

    const session = await prisma.refreshSession.findUnique({ where: { id: payload.sid } });
    if (!session || session.revoked_at || session.expires_at < new Date()) {
      throw new ApiError(401, "Session expired, please log in again");
    }

    // Rotate: revoke the old session row, issue a new one. This means a
    // stolen refresh token only works once before the legitimate user's
    // next refresh invalidates it (both fail together, which surfaces the
    // theft rather than allowing silent parallel use).
    const owner = await prisma.profiles.findUnique({ where: { user_id: session.user_id }, select: { is_suspended: true, suspended_reason: true } });
    if (owner?.is_suspended) throw new ApiError(403, owner.suspended_reason || "This account has been suspended");

    await prisma.refreshSession.update({ where: { id: session.id }, data: { revoked_at: new Date() } });
    const { accessToken, refreshToken } = await issueSession(session.user_id, req.headers["user-agent"], req.ip);
    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions());

    res.json({ accessToken, refreshToken, userId: session.user_id });
  })
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const token = getRefreshToken(req);
    if (token) {
      try {
        const payload = verifyRefreshToken(token);
        await prisma.refreshSession.update({
          where: { id: payload.sid },
          data: { revoked_at: new Date() },
        }).catch(() => {});
      } catch {
        // token already invalid; nothing to revoke
      }
    }
    res.clearCookie(REFRESH_COOKIE, { path: "/api/auth" });
    res.status(204).send();
  })
);

authRouter.post(
  "/logout-all",
  requireAuth,
  asyncHandler(async (req, res) => {
    await prisma.refreshSession.updateMany({
      where: { user_id: req.userId!, revoked_at: null },
      data: { revoked_at: new Date() },
    });
    res.clearCookie(REFRESH_COOKIE, { path: "/api/auth" });
    res.status(204).send();
  })
);

const forgotPasswordSchema = z.object({ email: z.string().email(), phone: z.string().max(30).optional() });

// Ports the comparison in verify_reset_phone (spaces and dashes ignored).
const normalizePhone = (v?: string | null) => (v ?? "").replace(/[\s\-()]/g, "");

authRouter.post(
  "/forgot-password",
  asyncHandler(async (req, res) => {
    const { email, phone } = forgotPasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });

    // Optional second factor (set REQUIRE_PHONE_FOR_RESET=true): when the account has a phone number on file,
    // it must be supplied and match. This replaces the verify_reset_phone check, which was a separate public
    // call that confirmed whether a guessed phone number was right and so let anyone discover a person's number.
    // Here a mismatch is silent, exactly like an unknown email. Accounts with no phone number on file
    // aren't locked out; the email link is their only proof.
    let allowed = true;
    if (user && env.requirePhoneForReset) {
      const profile = await prisma.profiles.findUnique({ where: { user_id: user.id }, select: { phone_number: true } });
      const onFile = normalizePhone(profile?.phone_number);
      allowed = !onFile || onFile === normalizePhone(phone);
    }

    // Always respond 200 regardless of whether the account exists, to avoid
    // leaking which emails are registered.
    if (user && allowed) {
      await sendPasswordResetEmail(user.email!, user.id).catch((err) =>
        console.error("password reset email failed", err)
      );
    }
    res.status(200).json({ message: "If that email exists, a reset link has been sent." });
  })
);

const resetPasswordSchema = z.object({
  token: z.string(),
  newPassword: z.string().min(8),
});

authRouter.post(
  "/reset-password",
  asyncHandler(async (req, res) => {
    const { token, newPassword } = resetPasswordSchema.parse(req.body);
    // Reset tokens are signed access-style JWTs with a dedicated purpose claim;
    // see lib/email.ts for how they're minted.
    let decoded: { sub: string; purpose: string };
    try {
      decoded = jwtLib.verify(token, env.jwtAccessSecret) as { sub: string; purpose: string };
    } catch {
      throw new ApiError(400, "Reset link is invalid or has expired");
    }
    if (decoded.purpose !== "password_reset") throw new ApiError(400, "Invalid reset token");

    const password_hash = await hashPassword(newPassword);
    await prisma.user.update({ where: { id: decoded.sub }, data: { password_hash } });
    // Revoke all existing sessions on password change.
    await prisma.refreshSession.updateMany({
      where: { user_id: decoded.sub, revoked_at: null },
      data: { revoked_at: new Date() },
    });

    res.json({ message: "Password updated. Please log in again." });
  })
);

const verifyEmailSchema = z.object({ token: z.string() });

authRouter.post(
  "/verify-email",
  asyncHandler(async (req, res) => {
    const { token } = verifyEmailSchema.parse(req.body);
    let decoded: { sub: string; purpose: string };
    try {
      decoded = jwtLib.verify(token, env.jwtAccessSecret) as { sub: string; purpose: string };
    } catch {
      throw new ApiError(400, "Verification link is invalid or has expired");
    }
    if (decoded.purpose !== "email_verify") throw new ApiError(400, "Invalid verification token");
    await prisma.user.update({ where: { id: decoded.sub }, data: { email_verified_at: new Date() } });
    res.json({ message: "Email verified" });
  })
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      include: { profile: true },
    });
    if (!user) throw new ApiError(404, "User not found");
    res.json({
      id: user.id,
      email: user.email,
      emailVerified: Boolean(user.email_verified_at),
      profile: user.profile,
    });
  })
);
