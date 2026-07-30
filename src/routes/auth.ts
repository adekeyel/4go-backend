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
import crypto from "crypto";

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
  username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/, "Letters, numbers, underscores only"),
  displayName: z.string().min(1).max(60).optional(),
});

authRouter.post(
  "/signup",
  asyncHandler(async (req, res) => {
    const body = signupSchema.parse(req.body);
    const email = body.email.toLowerCase().trim();

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new ApiError(409, "An account with this email already exists");

    const existingUsername = await prisma.profiles.findUnique({ where: { username: body.username } });
    if (existingUsername) throw new ApiError(409, "That username is taken");

    const password_hash = await hashPassword(body.password);

    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({ data: { email, password_hash } });
      await tx.profiles.create({
        data: {
          user_id: u.id,
          username: body.username,
          display_name: body.displayName ?? body.username,
          referral_code: crypto.randomBytes(4).toString("hex"),
        },
      });
      return u;
    });

    const { accessToken, refreshToken } = await issueSession(user.id, req.headers["user-agent"], req.ip);
    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions());

    // Fire-and-forget email verification; signup should not fail if email sending fails.
    sendVerificationEmail(email, user.id).catch((err) => console.error("verification email failed", err));

    res.status(201).json({ accessToken, userId: user.id });
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

    res.json({ accessToken, userId: user.id });
  })
);

authRouter.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE];
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
    await prisma.refreshSession.update({ where: { id: session.id }, data: { revoked_at: new Date() } });
    const { accessToken, refreshToken } = await issueSession(session.user_id, req.headers["user-agent"], req.ip);
    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions());

    res.json({ accessToken, userId: session.user_id });
  })
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE];
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

const forgotPasswordSchema = z.object({ email: z.string().email() });

authRouter.post(
  "/forgot-password",
  asyncHandler(async (req, res) => {
    const { email } = forgotPasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    // Always respond 200 regardless of whether the account exists, to avoid
    // leaking which emails are registered.
    if (user) {
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
