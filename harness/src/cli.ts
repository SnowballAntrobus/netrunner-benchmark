/** Harness CLI (M1 scope).
 *
 *    tsx src/cli.ts run-game    [--seed N] [--corp "Gateway Corp"] [--runner "Gateway Runner"]
 *    tsx src/cli.ts batch       [--games N] [--seed N] [--corp ...] [--runner ...]
 *    tsx src/cli.ts determinism [--seed N]   # same seed twice, logs must match
 *    tsx src/cli.ts golden record|check      # golden-log regression fixtures
 *    tsx src/cli.ts invariant [--seeds a,b,c] # no-cheating serializer check
 *    tsx src/cli.ts llm-game [--model X|mock] [--rules official|digest]
 *                   [--profile neutral|expert] [--reasoning brief|extended|scot|none]
 *                   [--context conversational|stateless] [--history full|lean]
 *                   [--compact-threshold N] [--compact-keep N]
 *                   [--auto-resolve on|off] [--debrief on|off]
 *                   [--actions compound|split] [--progress on|off]
 *                   [--watch on|off] [--seed N] ...
 *    tsx src/cli.ts fetch-rules              # snapshot NSG learn-to-play guides
 *    tsx src/cli.ts audit [--file <game.json>] # conservation audit (default: golden fixtures)
 *    tsx src/cli.ts format --file <game.json>  # markdown game narratives (.report.md + .full.md)
 *    tsx src/cli.ts replay --file <game.json> [--seq N]        # replay viewer (D08): serves
 *                   [--screenshot out.png]                     # the board+reasoning stepper,
 *                                                              # or renders one moment to PNG
 *
 *  Game records are written to harness/out/ as JSON; batch also writes a
 *  summary. Exit code is non-zero on any failed acceptance condition.
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, runGame, type GameRecord } from "./game.js";
import { golden } from "./golden.js";
import { runLLMGame } from "./llmgame.js";
import { fetchRules } from "./rules.js";
import { auditGolden, auditFile, reportAudit } from "./audit.js";
import { writeFormatted } from "./format.js";
import { normalizeLog, firstDivergence } from "./log.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = join(repoRoot, "harness", "out");

// Minimal .env support (harness/.env, KEY=VALUE lines, # comments).
// Existing environment variables take precedence. The file is gitignored —
// it exists so API keys never touch the shell history or the repo.
try {
  const envFile = await readFile(join(repoRoot, "harness", ".env"), "utf-8");
  for (const rawLine of envFile.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
} catch {
  /* no .env — fine */
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > -1 ? process.argv[i + 1] : undefined;
  return v ?? fallback;
}

function summarize(r: GameRecord): string {
  const score = `${r.corpAgendaPoints ?? "-"}:${r.runnerAgendaPoints ?? "-"} (corp:runner AP)`;
  const turns = r.turns
    ? `turns=${r.turns.corp}c/${r.turns.runner}r` +
      (r.msPerTurn !== null ? ` (~${(r.msPerTurn / 1000).toFixed(1)}s/turn)` : "")
    : "turns=-";
  return (
    `seed=${r.seed} status=${r.status} winner=${r.winner ?? "-"} ` +
    `reason="${r.reason ?? "-"}" ${score} ${turns} decisions=${r.decisions} ` +
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
} else if (command === "llm-game") {
  const model = arg("model", process.env["HARNESS_MODEL"] ?? "claude-haiku-4-5");
  if (model !== "mock" && !process.env["ANTHROPIC_API_KEY"]) {
    console.error("ANTHROPIC_API_KEY not set (use --model mock for the keyless path)");
    process.exit(2);
  }
  const rulesSource = arg("rules", "official") === "digest" ? "digest" as const : "official" as const;
  const reasoningArg = arg("reasoning", "brief");
  const reasoningStyle =
    reasoningArg === "extended" ? "extended" as const :
    reasoningArg === "scot" ? "scot" as const :
    reasoningArg === "none" ? "none" as const : "brief" as const;
  const contextMode =
    arg("context", "conversational") === "stateless"
      ? "stateless" as const
      : "conversational" as const;
  const historyVariant = arg("history", "full") === "lean" ? "lean" as const : "full" as const;
  const record = await runLLMGame({
    repoRoot,
    seed,
    corpPrecon,
    runnerPrecon,
    model,
    rulesSource,
    profile: arg("profile", "neutral"),
    reasoningStyle,
    contextMode,
    historyVariant,
    // Per-model knob: ~70-80% of the model's context window (default is
    // tuned for 200K-window models like haiku; see PROMPTING.md).
    compactionThreshold: parseInt(arg("compact-threshold", "150000"), 10),
    compactionKeepTurns: parseInt(arg("compact-keep", "20"), 10),
    autoResolve: arg("auto-resolve", "on") !== "off",
    debrief: arg("debrief", "on") !== "off",
    actions: arg("actions", "compound") === "split" ? "split" as const : "compound" as const,
    progress: arg("progress", "off") === "on",
    watch: arg("watch", "off") === "on",
    outDir,
  });
  console.log(summarize(record));
  console.log(
    `model=${record.model} rules=${record.rulesSource} profile=${record.promptProfile}/` +
    `${record.reasoningStyle} context=${record.contextMode}` +
    (record.historyVariant ? `/${record.historyVariant}` : "") +
    ` autoResolve=${record.autoResolve ? "on" : "off"} actions=${record.actions}` +
    ` llmDecisions=${record.llmDecisions} forced=${record.forcedDecisions} ` +
    `fulfilled=${record.compoundFulfilled} ` +
    `rulesDecisions=${record.rulesDecisions} retries=${record.retriesTotal} ` +
    `fallbacks=${record.fallbacks} invalidRecords=${record.invalidRecords}`
  );
  console.log(
    `tokens in=${record.usage.tokensIn} out=${record.usage.tokensOut} ` +
    `cacheRead=${record.usage.cacheRead} cacheWrite=${record.usage.cacheWrite} ` +
    `compactions=${record.compactions} transcriptMax=${record.transcriptTokensMax}`
  );
  console.log(
    `previews followed=${record.previewChecks} diverged=${record.previewDivergences}` +
    (record.previewDivergences > 0 ? "  <-- inspect preview_divergence records" : "")
  );
  console.log(`decision log: ${record.decisionLogPath}`);
  if (record.debriefPath) console.log(`debrief: ${record.debriefPath}`);
  if (model === "mock") {
    // CI acceptance: the mock injects one transient and one persistent
    // malformed response — both retry and fallback paths must have been
    // exercised — (conversational default) the synthetic mock usage must
    // have driven at least one compaction, (auto-resolve default) at
    // least one forced record must exist, and (debrief default) the
    // debrief artifact must have been written, all keylessly.
    // D10 acceptance: the injected transient-bad decision must carry ONE
    // recorded failed attempt classified out-of-range; the persistent-
    // garbage decision three unparseable/missing-option attempts.
    const jsonlRows = (await readFile(record.decisionLogPath, "utf-8"))
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as {
        record_type?: string;
        failed_attempts?: { problem: string }[] | null;
        fallback?: boolean | null;
      });
    const withFailures = jsonlRows.filter(
      (r) => (r.record_type ?? "decision") === "decision" && r.failed_attempts?.length
    );
    const transientOk = withFailures.some(
      (r) => r.failed_attempts!.length === 1 && r.failed_attempts![0]!.problem === "out-of-range"
    );
    const persistentOk = withFailures.some(
      (r) =>
        r.fallback === true &&
        r.failed_attempts!.length === 3 &&
        r.failed_attempts!.every((a) => a.problem === "unparseable" || a.problem === "missing-option")
    );
    const ok =
      record.status === "completed" &&
      record.invalidRecords === 0 &&
      record.retriesTotal >= 1 &&
      record.fallbacks >= 1 &&
      (record.contextMode !== "conversational" || record.compactions >= 1) &&
      (!record.autoResolve || record.forcedDecisions >= 1) &&
      (!record.debrief || record.contextMode !== "conversational" ||
        record.debriefPath !== null) &&
      (record.actions !== "compound" || record.compoundFulfilled >= 1) &&
      transientOk &&
      persistentOk;
    console.log(
      `failed-attempt records: ${withFailures.length} ` +
      `(transient=${transientOk ? "ok" : "MISSING"} persistent=${persistentOk ? "ok" : "MISSING"})`
    );
    console.log(ok ? "LLM-GAME (mock): PASS" : "LLM-GAME (mock): FAIL");
    process.exit(ok ? 0 : 1);
  }
  process.exit(record.status === "completed" && record.invalidRecords === 0 ? 0 : 1);
} else if (command === "format") {
  const file = arg("file", "");
  if (!file) {
    console.error("format requires --file <game.json>");
    process.exit(2);
  }
  const jsonl = file.replace(/\.json$/, ".jsonl");
  const { existsSync } = await import("node:fs");
  const written = await writeFormatted(file, existsSync(jsonl) ? jsonl : null);
  for (const w of written) console.log(w);
  process.exit(0);
} else if (command === "replay") {
  const file = arg("file", "");
  if (!file) {
    console.error("replay requires --file <game.json>");
    process.exit(2);
  }
  const { relative, sep } = await import("node:path");
  const abs = resolve(file);
  const jsonlAbs = abs.replace(/\.json$/, ".jsonl");
  const rel = (p: string): string => "/" + relative(repoRoot, p).split(sep).join("/");
  const { startServer } = await import("./server.js");
  const staticServer = await startServer(repoRoot);
  const seqArg = arg("seq", "");
  // Boot the engine with the game's own precon decks (avoids the slow
  // random deck builder; the boot decks are deleted by the first RC eval).
  const { loadPrecon, encodeDeckParam } = await import("./precons.js");
  const gameRec = JSON.parse(await readFile(abs, "utf-8")) as {
    corpPrecon?: string;
    runnerPrecon?: string;
  };
  const [replayCorpDeck, replayRunnerDeck] = await Promise.all([
    loadPrecon(repoRoot, gameRec.corpPrecon ?? "Gateway Corp"),
    loadPrecon(repoRoot, gameRec.runnerPrecon ?? "Gateway Runner"),
  ]);
  const url =
    `http://127.0.0.1:${staticServer.port}/harness/inspect.html` +
    `?src=${encodeURIComponent(rel(jsonlAbs))}&game=${encodeURIComponent(rel(abs))}` +
    `&c=${encodeDeckParam(replayCorpDeck)}&r=${encodeDeckParam(replayRunnerDeck)}` +
    (seqArg ? `&seq=${seqArg}` : "");
  const shot = arg("screenshot", "");
  if (shot) {
    const browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1720, height: 980 });
    await page.goto(url + "&shot=1", { waitUntil: "load" });
    await page.waitForFunction(
      () => (window as unknown as { __inspectReady?: boolean }).__inspectReady === true,
      undefined,
      { timeout: 120_000 }
    );
    await page.waitForTimeout(1500); // settle sprites/text rendering
    await page.screenshot({ path: shot });
    await browser.close();
    await staticServer.close();
    console.log(`screenshot: ${shot}`);
    process.exit(0);
  }
  console.log("Replay viewer running:");
  console.log(`  ${url}`);
  console.log("Open in a browser; ← → keys step decisions. Ctrl-C to stop.");
  await new Promise(() => { /* stay up until interrupted */ });
} else if (command === "audit") {
  const file = arg("file", "");
  const results = file ? [await auditFile(repoRoot, file)] : await auditGolden(repoRoot);
  process.exit(reportAudit(results));
} else if (command === "fetch-rules") {
  await fetchRules(repoRoot);
  process.exit(0);
} else if (command === "invariant") {
  const seeds = arg("seeds", "101,102,103,104,105").split(",").map((x) => parseInt(x, 10));
  const browser = await launchBrowser();
  let totalChecks = 0;
  let failed = 0;
  for (const s of seeds) {
    const record = await runGame({ ...base, seed: s, extraParams: "&invariant=1" }, browser);
    const violations = record.invariantViolations ?? [];
    const checks = record.invariantChecks ?? 0;
    totalChecks += checks;
    const ok = record.status === "completed" && violations.length === 0 && checks > 0;
    if (!ok) failed++;
    console.log(
      `seed=${s} ${ok ? "PASS" : "FAIL"} status=${record.status} ` +
      `checks=${checks} violations=${violations.length}`
    );
    for (const v of violations.slice(0, 5)) console.log("  ", JSON.stringify(v));
    if (record.sampleState) {
      await save(`state-sample-${s}.json`, record.sampleState as never);
    }
    await save(`invariant-${s}.json`, record);
  }
  console.log(
    failed === 0
      ? `INVARIANT: ${totalChecks} state serializations across ${seeds.length} games, zero leaks`
      : `INVARIANT: FAILED for ${failed}/${seeds.length} games`
  );
  process.exit(failed === 0 ? 0 : 1);
} else if (command === "golden") {
  const mode = process.argv[3] === "record" ? "record" as const : "check" as const;
  process.exit(await golden(repoRoot, mode));
} else {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}
