/** Minimal "15m" / "180d" / "1h" -> milliseconds parser (avoids pulling in the `ms` package). */
export default function ms(duration: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d|w)$/.exec(duration.trim());
  if (!match) throw new Error(`Invalid duration string: ${duration}`);
  const value = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return value * multipliers[unit];
}
