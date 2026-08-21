/** $/MTok by model prefix. AS OF 2026-08-21 — verify against
 *  https://platform.claude.com/docs/en/about-claude/pricing before
 *  relying on the $ column for reporting. Longest-prefix match; unknown
 *  models (including "mock") get NO estimate — the report shows dashes,
 *  never a guess. For OpenRouter models (D13) the report prefers the
 *  provider-REPORTED per-call cost on the game record over any entry
 *  here. Cache-write rate is the 5-minute TTL our client uses. */
export interface ModelPrices {
  prefix: string;
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  note?: string;
}

export const PRICES: ModelPrices[] = [
  { prefix: "claude-haiku-4-5", in: 1.0, out: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
  {
    prefix: "claude-sonnet-5",
    in: 2.0,
    out: 10.0,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    note: "promotional through 2026-08-31; standard 3/15 after",
  },
  { prefix: "claude-opus-5", in: 5.0, out: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
];

export function pricesFor(model: string): ModelPrices | null {
  let best: ModelPrices | null = null;
  for (const p of PRICES) {
    if (model.startsWith(p.prefix) && (!best || p.prefix.length > best.prefix.length)) {
      best = p;
    }
  }
  return best;
}

export function estimateCostUsd(
  model: string,
  usage: { tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number }
): number | null {
  const p = pricesFor(model);
  if (!p) return null;
  return (
    (usage.tokensIn * p.in +
      usage.tokensOut * p.out +
      usage.cacheRead * p.cacheRead +
      usage.cacheWrite * p.cacheWrite) /
    1e6
  );
}
