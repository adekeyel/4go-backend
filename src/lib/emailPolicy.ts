/**
 * Pure decision logic for the email worker (no I/O), so it can be tested on its own.
 * Ports the rules in process-email-queue, adapted to Resend's error codes.
 */

export const MAX_RETRIES = 5;

export type Failure =
  | { kind: "rate_limited"; cooldownSeconds: number } // 429 / quota: pause everything, don't count against the message
  | { kind: "config"; cooldownSeconds: number }       // 401/403: bad key or unverified domain: pause, don't burn retries
  | { kind: "permanent" }                              // 400/422: e.g. invalid recipient; retrying can't help
  | { kind: "transient" };                             // network / 5xx: retry with backoff

const NAME_TO_STATUS: Record<string, number> = {
  rate_limit_exceeded: 429,
  daily_quota_exceeded: 429,
  monthly_quota_exceeded: 429,
  missing_api_key: 401,
  invalid_api_key: 401,
  restricted_api_key: 401,
  validation_error: 422,
  invalid_from_address: 422,
  invalid_parameter: 422,
  missing_required_field: 422,
};

export function classifyProviderFailure(input: { statusCode?: number | null; name?: string | null }): Failure {
  const status = input.statusCode ?? (input.name ? NAME_TO_STATUS[input.name] : undefined);
  if (status === 429) return { kind: "rate_limited", cooldownSeconds: 60 };
  if (status === 401 || status === 403) return { kind: "config", cooldownSeconds: 300 };
  if (status === 400 || status === 422) return { kind: "permanent" };
  return { kind: "transient" };
}

/** Seconds to wait before retrying after the Nth real failure: 30s, 60s, 120s ... capped at 10 minutes. */
export function backoffSeconds(failedAttempts: number): number {
  return Math.min(30 * 2 ** Math.max(failedAttempts - 1, 0), 600);
}

export function isExpired(queuedAt: Date, ttlMinutes: number, now = Date.now()): boolean {
  return now - queuedAt.getTime() > ttlMinutes * 60_000;
}
