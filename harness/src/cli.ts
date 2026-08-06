/** Harness CLI (M1 scope).
 *
 *    tsx src/cli.ts run-game    [--seed N] [--corp "Gateway Corp"] [--runner "Gateway Runner"]
 *    tsx src/cli.ts batch       [--games N] [--seed N] [--corp ...] [--runner ...]
 *    tsx src/cli.ts determinism [--seed N]   # same seed twice, logs must match
 *    tsx src/cli.ts golden record|check      # golden-log regression fixtures
 *
 *  Game records are written to harness/out/ as JSON; batch also writes a
 *  summary. Exit code is non-zero on any failed acceptance condition.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, runGame, type GameRecord } from "./game.js";
import { golden } from "./golden.js";
import { normalizeLog, firstDivergence } from "./log.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = join(repoRoot, "harness", "out");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > -1 ? process.argv[i + 1] : undefined;
  return v ?? fallback;
}

function summarize(r: GameRecord): string {
  const score = `${r.corpAgendaPoints ?? "-"}:${r.runnerAgendaPoints ?? "-"} (corp:runner AP)`;
  return (
    `seed=${r.seed} status=${r.status} winner=${r.winner ?? "-"} ` +
    `reason="${r.reason ?? "-"}" ${score} decisions=${r.decisions} ` +
    `log=${r.log.length} lines errors=${r.errors.length} ${(r.durationMs / 1000).toFixed(1)}s`
  );
}

async function save(name: string, record: GameRecord): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, name), JSON.stringify(record, null, 1));
}

const command = process.argv[2] ?? "run-game";
const seed = parseInt(arg("seed", "1"), 10);
const corpPrecon = arg("corp", "Gateway Corp");
const runnerPrecon = arg("runner", "Gateway Runner");
const base = { repoRoot, corpPrecon, runnerPrecon };

if (command === "run-game") {
  const record = await runGame({ ...base, seed });
  console.log(summarize(record));
  await save(`game-${seed}.json`, record);
  if (record.errors.length > 0) console.log("errors:", record.errors.slice(0, 5));
  process.exit(record.status === "completed" ? 0 : 1);
} else if (command === "batch") {
  const games = parseInt(arg("games", "5"), 10);
  const browser = await launchBrowser();
  let failed = 0;
  const results: string[] = [];
  for (let i = 0; i < games; i++) {
    const record = await runGame({ ...base, seed: seed + i }, browser);
    console.log(summarize(record));
    results.push(summarize(record));
    await save(`game-${seed + i}.json`, record);
    if (record.status !== "completed") failed++;
  }
  await browser.close();
  await writeFile(join(outDir, "batch-summary.txt"), results.join("\n") + "\n");
  console.log(`\n${games - failed}/${games} games completed`);
  process.exit(failed === 0 ? 0 : 1);
} else if (command === "determinism") {
  const browser = await launchBrowser();
  const first = await runGame({ ...base, seed }, browser);
  const second = await runGame({ ...base, seed }, browser);
  await browser.close();
  console.log("run 1:", summarize(first));
  console.log("run 2:", summarize(second));
  await save(`determinism-${seed}-a.json`, first);
  await save(`determinism-${seed}-b.json`, second);
  // Comparison happens on normalized lines (see src/log.ts); raw logs are
  // preserved in out/.
  const firstLog = normalizeLog(first.log);
  const secondLog = normalizeLog(second.log);
  const identical =
    first.status === "completed" &&
    second.status === "completed" &&
    JSON.stringify(firstLog) === JSON.stringify(secondLog);
  if (identical) {
    console.log(`DETERMINISTIC: identical ${first.log.length}-line logs for seed ${seed}`);
    process.exit(0);
  }
  if (first.status === "completed" && second.status === "completed") {
    const i = firstDivergence(firstLog, secondLog);
    if (i !== -1) {
      console.log(`NON-DETERMINISTIC: logs diverge at line ${i}:`);
      console.log(`  run 1: ${firstLog[i] ?? "<end>"}`);
      console.log(`  run 2: ${secondLog[i] ?? "<end>"}`);
    }
  }
  process.exit(1);
} else if (command === "golden") {
  const mode = process.argv[3] === "record" ? "record" as const : "check" as const;
  process.exit(await golden(repoRoot, mode));
} else {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}
