import { prisma } from "@/lib/prisma";

/** Ports `is_super_admin`: only the super_admin role (moderators and support staff don't count). */
export async function isSuperAdmin(userId: string): Promise<boolean> {
  return Boolean(await prisma.superAdmins.findFirst({ where: { user_id: userId, role: "super_admin" } }));
}

/** Ports `can_moderate`: super_admin or moderator. */
export async function canModerate(userId: string): Promise<boolean> {
  return Boolean(
    await prisma.superAdmins.findFirst({ where: { user_id: userId, role: { in: ["super_admin", "moderator"] } } })
  );
}

/** Ports `can_support`: super_admin or support agent. */
export async function canSupport(userId: string): Promise<boolean> {
  return Boolean(
    await prisma.superAdmins.findFirst({ where: { user_id: userId, role: { in: ["super_admin", "support"] } } })
  );
}

/** Ports `get_admin_role`: the caller's admin role, or null for normal users. */
export async function getAdminRole(userId: string): Promise<string | null> {
  const row = await prisma.superAdmins.findUnique({ where: { user_id: userId }, select: { role: true } });
  return row?.role ?? null;
}
