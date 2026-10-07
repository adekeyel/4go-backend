/**
 * WhatsApp lets you "delete for everyone" only for a limited time after sending (currently 2 days 12 hours).
 * Group admins can always remove a message for everyone. Shared by the server (enforced) and the app (hides the button).
 */
export const DELETE_FOR_EVERYONE_WINDOW_MS = (2 * 24 + 12) * 60 * 60 * 1000;

export function canDeleteForEveryone(opts: { isSender: boolean; isRoomAdmin: boolean; createdAt: string | Date; now?: number }) {
  if (opts.isRoomAdmin) return true;
  if (!opts.isSender) return false;
  const age = (opts.now ?? Date.now()) - new Date(opts.createdAt).getTime();
  return age <= DELETE_FOR_EVERYONE_WINDOW_MS;
}
