import { prisma } from "@/lib/prisma";
import { notifyEmployeeOnActive, EmployeeNotice } from "@/lib/employees";

/**
 * Set a user online or offline. Returns the notification created for the employee who invited this person
 * when they came online, if any, so the caller can push it live (ports the tg_notify_employee_on_active trigger).
 *
 * "Offline to online" is detected by the update itself (`WHERE is_online = false`), which matches a row at
 * most once, so a socket connect and a heartbeat arriving together can't both raise an alert.
 */
export async function setPresence(userId: string, online: boolean, now = new Date()): Promise<EmployeeNotice | null> {
  if (!online) {
    await prisma.profiles.updateMany({ where: { user_id: userId }, data: { is_online: false, last_seen: now } });
    return null;
  }
  const flipped = await prisma.profiles.updateMany({
    where: { user_id: userId, OR: [{ is_online: false }, { is_online: null }] }, // is_online is nullable; null counts as offline
    data: { is_online: true, last_seen: now },
  });
  if (flipped.count === 0) {
    await prisma.profiles.updateMany({ where: { user_id: userId }, data: { is_online: true, last_seen: now } });
    return null;
  }
  return notifyEmployeeOnActive(userId);
}
