import { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "@/utils/jwt";
import { prisma } from "@/lib/prisma";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

/**
 * Requires a valid access token (Authorization: Bearer <token>).
 * On success, sets req.userId. This is the equivalent of Supabase's
 * "authenticated" role check — use it on any route that used to rely on
 * `auth.uid()` in an RLS policy.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing access token" });
  }

  try {
    const payload = verifyAccessToken(token);
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired access token" });
  }
}

/** Like requireAuth, but doesn't reject the request if no/invalid token is present. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) {
    try {
      const payload = verifyAccessToken(token);
      req.userId = payload.sub;
    } catch {
      // ignore invalid token, proceed as guest
    }
  }
  next();
}

/**
 * Requires the caller to be a super_admin. Mirrors the old
 * `is_super_admin()` Postgres function used throughout the admin RLS
 * policies and RPCs.
 */
export async function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.userId) return res.status(401).json({ error: "Unauthorized" });
  const admin = await prisma.superAdmins.findUnique({ where: { user_id: req.userId } });
  if (!admin) return res.status(403).json({ error: "Admin access required" });
  next();
}
