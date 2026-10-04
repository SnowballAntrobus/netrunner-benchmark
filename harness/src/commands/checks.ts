/** Checks, all keyless: `determinism` (same seed twice, identical logs),
 *  `golden` (frozen rules-vs-rules games), `invariant` (no hidden
 *  information in any serialized state) and `selftest` (each checker
 *  catches planted defects). `fetch-rules` refreshes the rules snapshots. */
import { launchBrowser, runGame } from "../game.js";
import { golden } from "../golden.js";
import { firstDivergence, normalizeLog } from "../log.js";
import { fetchRules } from "../rules.js";
import { selftest, SUITES, type Suite } from "../selftest.js";
import type { Command } from "./args.js";
import { saveRecord, summarize } from "./games.js";

export const determinismCommand: Command = async ({ repoRoot, outDir, args }) => {
  const game = { repoRoot, seed: args.seed, corpPrecon: args.corp, runnerPrecon: args.runner };
  const browser = await launchBrowser();
  const first = await runGame(game, browser);
  const second = await runGame(game, browser);
  await browser.close();
  console.log("run 1:", summarize(first));
  console.log("run 2:", summarize(second));
  await saveRecord(outDir, `determinism-${args.seed}-a.json`, first);
  await saveRecord(outDir, `determinism-${args.seed}-b.json`, second);
  // Compared on normalized lines (wall-clock diagnostics masked); raw logs
  // are kept in out/.
  const a = normalizeLog(first.log);
  const b = normalizeLog(second.log);
  const bothCompleted = first.status === "completed" && second.status === "completed";
  if (bothCompleted && JSON.stringify(a) === JSON.stringify(b)) {
    console.log(`DETERMINISTIC: identical ${first.log.length}-line logs for seed ${args.seed}`);
    return 0;
  }
  const i = bothCompleted ? firstDivergence(a, b) : -1;
  if (i !== -1) {
    console.log(`NON-DETERMINISTIC: logs diverge at line ${i}:`);
    console.log(`  run 1: ${a[i] ?? "<end>"}`);
    console.log(`  run 2: ${b[i] ?? "<end>"}`);
  }
  return 1;
};

export const goldenCommand: Command = async ({ repoRoot, args }) =>
  golden(repoRoot, args.positional() === "record" ? "record" : "check");

export const invariantCommand: Command = async ({ repoRoot, outDir, args }) => {
  const seeds = args.str("seeds", "101,102,103,104,105").split(",").map((x) => parseInt(x, 10));
  const browser = await launchBrowser();
  let totalChecks = 0;
  let failed = 0;
  for (const seed of seeds) {
    const record = await runGame(
      { repoRoot, seed, corpPrecon: args.corp, runnerPrecon: args.runner, extraParams: "&invariant=1" },
      browser
    );
    const violations = record.invariantViolations ?? [];
    const checks = record.invariantChecks ?? 0;
    totalChecks += checks;
    const ok = record.status === "completed" && violations.length === 0 && checks > 0;
    if (!ok) failed++;
    console.log(`seed=${seed} ${ok ? "PASS" : "FAIL"} status=${record.status} checks=${checks} violations=${violations.length}`);
    for (const v of violations.slice(0, 5)) console.log("  ", JSON.stringify(v));
    await saveRecord(outDir, `invariant-${seed}.json`, record);
  }
  await browser.close();
  console.log(
    failed === 0
      ? `INVARIANT: ${totalChecks} state serializations across ${seeds.length} games, zero leaks`
      : `INVARIANT: FAILED for ${failed}/${seeds.length} games`
  );
  return failed === 0 ? 0 : 1;
};

export const selftestCommand: Command = async ({ repoRoot, outDir, args }) => {
  const wanted = args.str("suite", "") ? args.str("suite", "").split(",") : [...SUITES];
  const unknown = wanted.filter((x) => !(SUITES as string[]).includes(x));
  if (unknown.length) {
    console.error(`selftest: unknown suite(s) ${unknown.join(", ")} (have ${SUITES.join(", ")})`);
    return 2;
  }
  const outcomes = await selftest(repoRoot, outDir, wanted as Suite[]);
  const failed = outcomes.filter((o) => !o.ok);
  console.log(
    failed.length === 0
      ? `SELFTEST: all ${outcomes.length} checks passed (${wanted.join(", ")})`
      : `SELFTEST: ${failed.length}/${outcomes.length} checks FAILED`
  );
  return failed.length === 0 ? 0 : 1;
};

export const fetchRulesCommand: Command = async ({ repoRoot }) => {
  await fetchRules(repoRoot);
  return 0;
};
