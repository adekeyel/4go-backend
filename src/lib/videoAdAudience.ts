// Who gets to see video ads at all. Right now: everyone except Premium members, judged on the VIEWER only
// (a Premium creator's videos still show ads to everyone else).

/**
 * `isPremium` is injected (the app passes lib/social's `isPremium`, which reads real subscription dates, so the
 * exemption ends the moment a plan runs out) to keep this decision testable without a database.
 */
export async function viewerSeesAds(
  userId: string | undefined,
  isPremium: (userId: string) => Promise<boolean>
): Promise<boolean> {
  if (!userId) return true; // guests have no account, so they can't be Premium
  return !(await isPremium(userId));
}
