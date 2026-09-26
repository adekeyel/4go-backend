// Server-side mirror of public/src/lib/callPermissions.ts. Kept as the
// authoritative check — clients (web + native) also gate their UI on this
// ladder, but every call-related route/socket event re-checks it here so a
// modified client can never start or accept a call type its rank forbids.

export const VOICE_CALL_RANKS = ["Novice", "Learner", "Professional", "Expert", "Master"];
export const VIDEO_CALL_RANKS = ["Professional", "Expert", "Master"];

export type CallType = "voice" | "video";

export function canMakeVoiceCall(rank?: string | null): boolean {
  return VOICE_CALL_RANKS.includes(rank || "Amateur");
}

export function canMakeVideoCall(rank?: string | null): boolean {
  return VIDEO_CALL_RANKS.includes(rank || "Amateur");
}

export function hasCallPermission(type: CallType, rank?: string | null): boolean {
  return type === "video" ? canMakeVideoCall(rank) : canMakeVoiceCall(rank);
}
