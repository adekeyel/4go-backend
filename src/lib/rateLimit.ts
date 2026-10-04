// Small in-memory sliding-window limiter. Per server instance, which is fine for the soft limits it's used
// for (anything that must be exact lives in the database instead).

export function createRateLimiter(windowMs: number) {
  const hits = new Map<string, number[]>();
  return {
    /** Records an attempt and returns whether it's within `max` per window. */
    allow(key: string, max: number, now = Date.now()): boolean {
      const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      return true;
    },
    sweep(now = Date.now()) {
      for (const [key, times] of hits) if (!times.some((t) => t > now - windowMs)) hits.delete(key);
    },
    size: () => hits.size,
  };
}
