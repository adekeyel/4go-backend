import { prisma } from "@/lib/prisma";

export type EmployeeNotice = { employeeId: string; notification: { id: string; title: string; body: string; created_at: Date } };

/**
 * Ports the tg_notify_employee_on_active trigger. When someone an employee invited comes online, the
 * employee gets a notification: at most one per invited user per 12 hours, and only if the person who
 * invited them is still an employee. Supabase delivered these through Realtime; the caller now emits the
 * returned notice over the socket as `employee:notification`.
 */
export async function notifyEmployeeOnActive(invitedUserId: string): Promise<EmployeeNotice | null> {
  try {
    const referral = await prisma.referrals.findUnique({ where: { referred_id: invitedUserId }, select: { referrer_id: true } });
    if (!referral) return null;

    const isEmployee = await prisma.superAdmins.findFirst({
      where: { user_id: referral.referrer_id, role: "employee" },
      select: { id: true },
    });
    if (!isEmployee) return null;

    const recent = await prisma.employeeNotifications.findFirst({
      where: { invited_user_id: invitedUserId, created_at: { gt: new Date(Date.now() - 12 * 3600_000) } },
      select: { id: true },
    });
    if (recent) return null;

    const profile = await prisma.profiles.findUnique({ where: { user_id: invitedUserId }, select: { display_name: true, username: true } });
    const name = profile?.display_name ?? profile?.username ?? "Someone you invited";
    const notification = await prisma.employeeNotifications.create({
      data: {
        employee_id: referral.referrer_id,
        invited_user_id: invitedUserId,
        title: "Invited user active",
        body: `${name} just came online. Keep the momentum going!`,
      },
      select: { id: true, title: true, body: true, created_at: true },
    });
    return { employeeId: referral.referrer_id, notification };
  } catch (err) {
    console.error("[employees] notify failed:", (err as Error).message); // never break presence over an alert
    return null;
  }
}
