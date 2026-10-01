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

export type AdminRoleName = "super_admin" | "moderator" | "support" | "employee";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminRole?: AdminRoleName;
    }
  }
}

/**
 * Allow only admins holding one of the listed roles. The old requireSuperAdmin accepted ANY row in
 * super_admins, so moderators, support agents and employees all passed as super admins; the original
 * database checked the role each time (is_super_admin, can_moderate, can_support).
 *   requireRole("super_admin")                 is_super_admin()
 *   requireRole("super_admin", "moderator")    can_moderate()
 *   requireRole("super_admin", "support")      can_support()
 */
export function requireRole(...roles: AdminRoleName[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.userId) return res.status(401).json({ error: "Unauthorized" });
      const admin = await prisma.superAdmins.findUnique({ where: { user_id: req.userId }, select: { role: true } });
      if (!admin || !roles.includes(admin.role as AdminRoleName)) {
        return res.status(403).json({ error: "You don't have permission to do this" });
      }
      req.adminRole = admin.role as AdminRoleName;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Only real super admins (role = super_admin). */
export const requireSuperAdmin = requireRole("super_admin");
