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
 *                   [--actions compound|split] [--progress [on|off]]
 *                   [--watch [on|off]] [--seed N] ...  (bare --progress/--watch = on)
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
import { runLLMGame, llmSeatsOf, type SeatMode } from "./llmgame.js";
import type { Seat } from "./prompts.js";
import { startLiveViewer } from "./live.js";
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

/** On/off flag that also accepts the bare form: `--progress` alone means
 *  "on" (the next token being another --flag, or nothing, is not a
 *  value). `--progress on|off` still works. Absent → false. */
function boolArg(name: string): boolean {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return false;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) return true; // bare flag
  return v !== "off";
}

// Default compact-threshold by model, longest-prefix match. Rationale
// lives at the llm-game call site; keep entries ordered here by
// specificity only (the code picks the longest matching prefix).
const THRESHOLD_DEFAULTS: [prefix: string, threshold: string][] = [
  ["openrouter/mistralai/", "200000"], // 262K windows (small-2603, medium-3-5)
  ["openrouter/tencent/hy3", "200000"], // 262K window
  // 131K window — smallest in the bench; 100K ≈ 75% of it, but this sits
  // close to the transcript floor, so expect frequent compaction; if the
  // record shows compactionsSuppressed > 0 the model can't fit our config
  // and that is itself the finding.
  ["openrouter/meta/muse-glimmer-30b", "100000"],
  ["openrouter/", "300000"], // D13 cohort: 400K-1M windows
  ["claude-opus", "300000"], // 1M window; measured on D09-2 opus game
];

function defaultCompactThreshold(model: string): string {
  let best: [string, string] | null = null;
  for (const entry of THRESHOLD_DEFAULTS) {
    if (model.startsWith(entry[0]) && (!best || entry[0].length > best[0].length))
      best = entry;
  }
  return best ? best[1] : "150000";
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
  // D14: --seat runner (default) | corp | both. --model sets the model for
  // a single seat (and both seats unless --corp-model/--runner-model).
  const seatArg = arg("seat", "runner");
  if (!["runner", "corp", "both"].includes(seatArg)) {
    console.error(`--seat must be runner, corp or both (got ${seatArg})`);
    process.exit(2);
  }
  const seatMode = seatArg as SeatMode;
  const model = arg("model", process.env["HARNESS_MODEL"] ?? "claude-haiku-4-5");
  const seatModels: Partial<Record<Seat, string>> = {};
  for (const seat of llmSeatsOf(seatMode)) {
    seatModels[seat] = arg(`${seat}-model`, model);
  }
  for (const m of Object.values(seatModels)) {
    if (m.startsWith("openrouter/") && !process.env["OPENROUTER_API_KEY"]) {
      console.error("OPENROUTER_API_KEY not set (required for openrouter/* models)");
      process.exit(2);
    }
    if (m !== "mock" && !m.startsWith("openrouter/") && !process.env["ANTHROPIC_API_KEY"]) {
      console.error("ANTHROPIC_API_KEY not set (use --model mock for the keyless path)");
      process.exit(2);
    }
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
  // Per-model knob, longest-prefix matched against THRESHOLD_DEFAULTS
  // above, per seat (two-model games get each model's own default).
  // 150K suits 200K-window models (haiku, sonnet). Opus (1M window)
  // defaults to 300K: measured on the opus D09-2 game, 150K produced 7
  // compactions with epochs decaying to ~7-10 API decisions (fused menus
  // fatten each message, raising the kept-window floor) and cost ~$19.80
  // vs ~$12.20 pre-fusion — the threshold must clear the floor with real
  // headroom. The D13 cohort (windows 400K-1M; token counts are each
  // provider's own tokenizer, so the observed-size comparison is
  // like-for-like per provider) also defaults to 300K — 75% of the
  // smallest cohort window, and inside the effective-context comfort band
  // for the 1M ones. Mistral models are the exception: 262K windows, so
  // the same ~75% ratio gives 200K (a 300K threshold would blow the
  // window before compaction fired). An explicit --compact-threshold
  // applies to every seat. See PROMPTING.md "Choosing the threshold".
  const explicitThreshold = arg("compact-threshold", "");
  const compactionThresholds: Partial<Record<Seat, number>> = {};
  for (const [seat, m] of Object.entries(seatModels) as [Seat, string][]) {
    compactionThresholds[seat] = parseInt(explicitThreshold || defaultCompactThreshold(m), 10);
  }
  const live = boolArg("live");
  const liveViewer = live ? await startLiveViewer(repoRoot) : null;
  const record = await runLLMGame({
    repoRoot,
    seed,
    corpPrecon,
    runnerPrecon,
    seat: seatMode,
    model,
    corpModel: seatModels.corp,
    runnerModel: seatModels.runner,
    rulesSource,
    profile: arg("profile", "neutral"),
    reasoningStyle,
    contextMode,
    historyVariant,
    compactionThresholds,
    compactionKeepTurns: parseInt(arg("compact-keep", "20"), 10),
    autoResolve: arg("auto-resolve", "on") !== "off",
    debrief: arg("debrief", "on") !== "off",
    actions: arg("actions", "compound") === "split" ? "split" as const : "compound" as const,
    aiBranches: arg("ai-branches", "neutral") === "rules" ? "rules" as const : "neutral" as const,
    frames: arg("frames", "on") !== "off",
    extraParams: boolArg("invariant") ? "&invariant=1" : "",
    progress: boolArg("progress"),
    watch: boolArg("watch"),
    outDir,
    ...(liveViewer ? { onEvent: liveViewer.push } : {}),
  });
  console.log(summarize(record));
  console.log(
    `seats=${record.llmSeat} model=${record.model} rules=${record.rulesSource} ` +
    `profile=${record.promptProfile}/${record.reasoningStyle} context=${record.contextMode}` +
    (record.historyVariant ? `/${record.historyVariant}` : "") +
    ` autoResolve=${record.autoResolve ? "on" : "off"} actions=${record.actions}` +
    ` aiBranches=${record.aiBranches}` +
    (record.cardSets.length ? ` sets=${record.cardSets.join(",")}` : "")
  );
  for (const stats of Object.values(record.seats)) {
    console.log(
      `[${stats.seat}] model=${stats.model} llmDecisions=${stats.llmDecisions} ` +
      `forced=${stats.forcedDecisions} fulfilled=${stats.compoundFulfilled} ` +
      `folded=${stats.orderFolded} multiSelectSteps=${stats.multiSelectSteps} ` +
      (stats.largeFusedMenus > 0 ? `⚠ largeMenus=${stats.largeFusedMenus} ` : "") +
      `retries=${stats.retriesTotal} fallbacks=${stats.fallbacks} ` +
      `tokens in=${stats.usage.tokensIn} out=${stats.usage.tokensOut} ` +
      `cacheRead=${stats.usage.cacheRead} cacheWrite=${stats.usage.cacheWrite} ` +
      `compactions=${stats.compactions} transcriptMax=${stats.transcriptTokensMax}` +
      (stats.reportedCostUsd !== null ? ` reportedCost=$${stats.reportedCostUsd.toFixed(4)}` : "") +
      (stats.compactionsSuppressed > 0
        ? ` ⚠ compactions-suppressed=${stats.compactionsSuppressed} (compact-threshold below viable floor — raise it; see PROMPTING.md)`
        : "")
    );
  }
  console.log(
    `rulesDecisions=${record.rulesDecisions} invalidRecords=${record.invalidRecords} ` +
    `multiSelects=${record.multiSelects} neutralizedReads=${record.neutralizedReads}`
  );
  console.log(
    `previews followed=${record.previewChecks} diverged=${record.previewDivergences}` +
    (record.previewDivergences > 0 ? "  <-- inspect preview_divergence records" : "")
  );
  const invariantViolations = record.invariantViolations ?? [];
  if (record.invariantChecks !== undefined) {
    console.log(
      `invariant: ${record.invariantChecks} checks, ${invariantViolations.length} violations`
    );
    for (const v of invariantViolations.slice(0, 5)) console.log("  ", JSON.stringify(v));
  }
  console.log(`decision log: ${record.decisionLogPath}`);
  if (record.framesPath) console.log(`frames: ${record.framesPath}`);
  if (record.debriefPath) console.log(`debrief: ${record.debriefPath}`);
  if (liveViewer) await liveViewer.finish();
  const allMock = Object.values(seatModels).every((m) => m === "mock");
  if (allMock) {
    // CI acceptance: the mock injects one transient and one persistent
    // malformed response per seat — both retry and fallback paths must
    // have been exercised — (conversational default) the synthetic mock
    // usage must have driven at least one compaction, (auto-resolve
    // default) at least one forced record must exist, and (debrief
    // default) the debrief artifact must have been written, all keylessly.
    // D10 acceptance: the injected transient-bad decision must carry ONE
    // recorded failed attempt classified out-of-range; the persistent-
    // garbage decision three unparseable/missing-option attempts.
    // D14: every LLM seat that reached the fault-injection calls must show
    // its own retry and fallback.
    const jsonlRows = (await readFile(record.decisionLogPath, "utf-8"))
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as {
        record_type?: string;
        seat?: string;
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
    const seatsOk = Object.values(record.seats).every(
      (st) => st.llmDecisions < 10 || (st.retriesTotal >= 1 && st.fallbacks >= 1)
    );
    const ok =
      record.status === "completed" &&
      record.invalidRecords === 0 &&
      invariantViolations.length === 0 &&
      record.retriesTotal >= 1 &&
      record.fallbacks >= 1 &&
      seatsOk &&
      (record.contextMode !== "conversational" || record.compactions >= 1) &&
      (!record.autoResolve || record.forcedDecisions >= 1) &&
      (!record.debrief || record.contextMode !== "conversational" ||
        record.debriefPath !== null) &&
      (record.actions !== "compound" || record.compoundFulfilled >= 1) &&
      (record.actions !== "compound" || !record.seats.runner || record.orderFolded >= 1) &&
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
    console.error("format requires --file <run folder or game record>");
    process.exit(2);
  }
  // Run folder, any nested artifact, or any legacy stem sibling — all
  // resolve to the same artifact set.
  const { resolveGameArtifacts } = await import("./paths.js");
  const art = resolveGameArtifacts(file);
  const { existsSync } = await import("node:fs");
  const written = await writeFormatted(art.record, existsSync(art.jsonl) ? art.jsonl : null);
  for (const w of written) console.log(w);
  process.exit(0);
} else if (command === "replay") {
  const file = arg("file", "");
  if (!file) {
    console.error("replay requires --file <run folder or game record>");
    process.exit(2);
  }
  const { relative, sep } = await import("node:path");
  const { resolveGameArtifacts } = await import("./paths.js");
  const replayArt = resolveGameArtifacts(resolve(file));
  const abs = replayArt.record;
  const jsonlAbs = replayArt.jsonl;
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
} else if (command === "corpus") {
  // D06-1 rev 2: explicit promotion into harness/data/games/ + the
  // progressive CORPUS.md report. `--promote <run>` accepts a run
  // folder, record.json, or legacy stem; repeatable. `--report` alone
  // regenerates from what's already promoted.
  const { promote, writeReport } = await import("./corpus.js");
  const partial = process.argv.includes("--partial");
  const promotes: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === "--promote" && process.argv[i + 1]) {
      promotes.push(process.argv[i + 1]!);
    }
  }
  for (const p of promotes) {
    const dest = await promote(repoRoot, p, partial);
    console.log(`promoted → ${dest}`);
  }
  const reportPath = await writeReport(repoRoot);
  console.log(reportPath);
  process.exit(0);
} else if (command === "smoke") {
  // D16: fuzz the interface across the card pool — keyless. Pairs every
  // corp precon with a runner precon (cycling the shorter list) and plays
  // each pairing as rules-vs-rules (serializer invariant) and/or with the
  // mock in the requested LLM seats (option-menu invariant, D14 adapter,
  // record validation). Any non-completed game, error, invalid record or
  // invariant violation fails the run.
  const { readdir } = await import("node:fs/promises");
  const { loadPrecon } = await import("./precons.js");
  const { checkPool } = await import("./cardpool.js");
  const { loadCardData } = await import("./carddata.js");
  const cards = await loadCardData(repoRoot);
  const pool = arg("pool", "all"); // all | base | extended
  const modes = arg("seats", "rules,runner,corp,both").split(",");
  const limit = parseInt(arg("limit", "0"), 10);
  const names = (await readdir(join(repoRoot, "precons")))
    .filter((f) => f.endsWith(".js"))
    .map((f) => f.replace(/\.js$/, ""))
    .sort();
  const bySide: Record<string, string[]> = { corp: [], runner: [] };
  for (const name of names) {
    const deck = await loadPrecon(repoRoot, name);
    const check = await checkPool(repoRoot, [deck]);
    if (check.missing.length) continue;
    const extended = check.sets.length > 0;
    if (pool === "base" && extended) continue;
    if (pool === "extended" && !extended) continue;
    const side = cards.get(deck.identity)?.side;
    if (side === "corp" || side === "runner") bySide[side]!.push(name);
  }
  const n = Math.max(bySide["corp"]!.length, bySide["runner"]!.length);
  let pairs: [string, string][] = [];
  for (let i = 0; i < n; i++) {
    pairs.push([
      bySide["corp"]![i % bySide["corp"]!.length]!,
      bySide["runner"]![i % bySide["runner"]!.length]!,
    ]);
  }
  if (limit > 0) pairs = pairs.slice(0, limit);
  let failures = 0;
  let games = 0;
  // Engine self-lint about card definitions (the partial Core set's
  // Datasucker) — logged identically in rules-vs-rules games; reported,
  // not failed.
  const ENGINE_LINT = /^LogError: .* will be ignored because it is set to automatic/;
  const hardErrors = (errors: string[]): string[] => errors.filter((e) => !ENGINE_LINT.test(e));
  const lintCount = (errors: string[]): number => errors.length - hardErrors(errors).length;
  const browser = modes.includes("rules") ? await launchBrowser() : null;
  for (let i = 0; i < pairs.length; i++) {
    const [c, r] = pairs[i]!;
    const s = seed + i;
    for (const mode of modes) {
      games++;
      let line: string;
      let ok: boolean;
      if (mode === "rules") {
        const rec = await runGame(
          { repoRoot, seed: s, corpPrecon: c, runnerPrecon: r, extraParams: "&invariant=1" },
          browser!
        );
        const v = rec.invariantViolations ?? [];
        const hard = hardErrors(rec.errors);
        ok = rec.status === "completed" && hard.length === 0 && v.length === 0;
        line = `${rec.status} ${rec.winner ?? "-"} errors=${hard.length} lint=${lintCount(rec.errors)} ` +
          `invariant=${rec.invariantChecks ?? 0}/${v.length}`;
        if (!ok) console.log("   ", JSON.stringify([...hard.slice(0, 3), ...v.slice(0, 3)]).slice(0, 400));
      } else {
        const rec = await runLLMGame({
          repoRoot, seed: s, corpPrecon: c, runnerPrecon: r,
          seat: mode as SeatMode, model: "mock",
          rulesSource: "digest", profile: "neutral", reasoningStyle: "brief",
          debrief: false, frames: false, extraParams: "&invariant=1",
          outDir: join(outDir, "smoke"),
        });
        const v = rec.invariantViolations ?? [];
        const hard = hardErrors(rec.errors);
        ok = rec.status === "completed" && hard.length === 0 &&
          rec.invalidRecords === 0 && v.length === 0;
        line = `${rec.status} ${rec.winner ?? "-"} errors=${hard.length} lint=${lintCount(rec.errors)} ` +
          `invalid=${rec.invalidRecords} invariant=${rec.invariantChecks ?? 0}/${v.length} ` +
          `multiSelects=${rec.multiSelects} neutralized=${rec.neutralizedReads}`;
        if (!ok) console.log("   ", JSON.stringify([...hard.slice(0, 3), ...v.slice(0, 3)]).slice(0, 400));
      }
      if (!ok) failures++;
      console.log(`${ok ? "ok  " : "FAIL"} s${s} ${mode.padEnd(6)} ${c} vs ${r}: ${line}`);
    }
  }
  if (browser) await browser.close();
  console.log(failures === 0 ? `SMOKE: all ${games} games clean` : `SMOKE: ${failures}/${games} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
} else if (command === "pool") {
  // D16: which precons are playable, and which set files each needs.
  const { readdir } = await import("node:fs/promises");
  const { loadPrecon } = await import("./precons.js");
  const { checkPool } = await import("./cardpool.js");
  const { loadCardData } = await import("./carddata.js");
  const cards = await loadCardData(repoRoot);
  const names = (await readdir(join(repoRoot, "precons")))
    .filter((f) => f.endsWith(".js"))
    .map((f) => f.replace(/\.js$/, ""))
    .sort();
  for (const side of ["corp", "runner"]) {
    console.log(`\n${side.toUpperCase()} precons (✓ playable, ✗ has unimplemented cards):`);
    for (const name of names) {
      const deck = await loadPrecon(repoRoot, name);
      if ((cards.get(deck.identity)?.side ?? "") !== side) continue;
      const check = await checkPool(repoRoot, [deck]);
      console.log(
        `  ${check.missing.length ? "✗" : "✓"} ${name.padEnd(40)} ` +
          `${check.sets.length ? check.sets.join("+") : "base pool"}` +
          (check.missing.length ? ` — ${check.missing.length} unimplemented card(s)` : "")
      );
    }
  }
  process.exit(0);
} else if (command === "audit") {
  const file = arg("file", "");
  const results = file
    ? [
        await auditFile(
          repoRoot,
          (await import("./paths.js")).resolveGameArtifacts(file).record
        ),
      ]
    : await auditGolden(repoRoot);
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
