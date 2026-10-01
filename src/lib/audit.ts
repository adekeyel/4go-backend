import { Prisma } from "@prisma/client";
import { Tx } from "@/lib/coins";

/** Ports `log_admin_action`: one row in admin_audit_logs, with the actor's name captured at the time. */
export async function logAdminAction(
  tx: Tx,
  actorId: string,
  action: string,
  targetId: string | null = null,
  targetLabel: string | null = null,
  details: Prisma.InputJsonObject = {}
) {
  const actor = await tx.profiles.findUnique({
    where: { user_id: actorId },
    select: { display_name: true, username: true },
  });
  await tx.adminAuditLogs.create({
    data: {
      actor_id: actorId,
      actor_name: actor?.display_name ?? actor?.username ?? null,
      action,
      target_id: targetId,
      target_label: targetLabel,
      details,
    },
  });
}

/** Display name for audit entries (the SQL used COALESCE(display_name, username)). */
export async function userLabel(tx: Tx, userId: string): Promise<string | null> {
  const p = await tx.profiles.findUnique({ where: { user_id: userId }, select: { display_name: true, username: true } });
  return p?.display_name ?? p?.username ?? null;
}
