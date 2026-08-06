/** Log normalization shared by the determinism and golden-log commands.
 *
 *  The engine embeds wall-clock diagnostics in otherwise deterministic logs
 *  (RunCalculator: "execution time of NNN ms"). Comparisons run on
 *  normalized lines; raw logs are always preserved in the saved records. */
export function normalizeLog(lines: string[]): string[] {
  return lines.map((line) => line.replace(/\d+ ms/g, "N ms"));
}

/** First index at which two normalized logs differ, or -1 if identical. */
export function firstDivergence(a: string[], b: string[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return i;
  }
  return -1;
}
