/** Harness CLI. Every command and flag is documented in harness/README.md.
 *
 *  Games       run-game, batch (rules vs rules) · llm-game (a model in one
 *              or both seats) · run-match (N seeds × K runs, match summary)
 *  Review      replay (board viewer; --engine for the D08 engine replay) ·
 *              frames (re-simulate + verify) · format · audit
 *  Corpus/site corpus (--promote, CORPUS.md) · site (Pages data, --serve)
 *  Card pool   pool (--qualify) · smoke
 *  Checks      determinism · golden record|check · invariant · selftest
 *  Rules       fetch-rules
 *
 *  Run records go to harness/out/ (gitignored). Exit codes are non-zero on
 *  any failed acceptance condition, so every check doubles as a CI step.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, runGame, type GameRecord } from "./game.js";
import { golden } from "./golden.js";
import { runLLMGame, llmSeatsOf, type SeatMode, type LLMGameOptions } from "./llmgame.js";
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

/** llm-game / run-match configuration: every knob except the seed, the
 *  output folder and the per-game sinks. Exits on invalid flags or a
 *  missing API key. */
async function llmRunConfig(): Promise<{
  seatModels: Partial<Record<Seat, string>>;
  game: Omit<LLMGameOptions, "seed" | "outDir" | "onEvent" | "clientFactory">;
}> {
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
  {
    const { assertQualified } = await import("./cardpool.js");
    await assertQualified(repoRoot, [corpPrecon, runnerPrecon], boolArg("allow-unqualified"));
  }
  return {
    seatModels,
    game: {
      repoRoot,
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
    },
  };
}


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
  const { seatModels, game } = await llmRunConfig();
  const live = boolArg("live");
  const liveViewer = live ? await startLiveViewer(repoRoot) : null;
  const record = await runLLMGame({
    ...game,
    seed,
    outDir,
    progress: boolArg("progress"),
    watch: boolArg("watch"),
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
} else if (command === "run-match") {
  // D06 §1 / D12: N games of one configuration on seeds S..S+N-1 (or
  // --seeds a,b,c), each --repeat K times on the same seed, into
  // out/match-<label>/ with match.json + match-summary.md. Crashes are
  // rows, not aborts. --live follows the whole match in one viewer tab.
  if (boolArg("watch")) {
    console.error("run-match: --watch is per-game; use --live to follow the match in the viewer");
    process.exit(2);
  }
  const { seatModels, game } = await llmRunConfig();
  const { runMatch } = await import("./match.js");
  const seedList = arg("seeds", "")
    ? arg("seeds", "").split(",").map((x) => parseInt(x, 10))
    : Array.from({ length: parseInt(arg("games", "10"), 10) }, (_, i) => seed + i);
  if (seedList.length === 0 || seedList.some((x) => !Number.isInteger(x))) {
    console.error("run-match: --games N (with --seed S) or --seeds a,b,c required");
    process.exit(2);
  }
  const repeat = Math.max(1, parseInt(arg("repeat", "1"), 10));
  const slug = (m: string): string => m.replace(/[^A-Za-z0-9.-]+/g, "_");
  const who =
    game.seat === "both"
      ? `${slug(seatModels.corp!)}-vs-${slug(seatModels.runner!)}`
      : `${game.seat === "corp" ? "corp-" : ""}${slug(game.model)}`;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const label = arg(
    "label",
    `${who}-s${seedList[0]}-n${seedList.length}${repeat > 1 ? `x${repeat}` : ""}-${stamp}`
  );
  const matchDir = join(outDir, `match-${label}`);
  if (existsSync(join(matchDir, "match.json"))) {
    console.error(`run-match: ${matchDir} already holds a match — pick another --label`);
    process.exit(2);
  }
  const promoteAll = boolArg("promote-all");
  const corpusMod = promoteAll ? await import("./corpus.js") : null;
  const liveViewer = boolArg("live") ? await startLiveViewer(repoRoot) : null;
  const total = seedList.length * repeat;
  console.log(
    `match ${label}: ${total} game${total === 1 ? "" : "s"} (seeds ${seedList.join(",")}` +
      `${repeat > 1 ? ` × ${repeat}` : ""}) → ${matchDir}`
  );
  const result = await runMatch({
    repoRoot,
    label,
    matchDir,
    seeds: seedList,
    repeat,
    game: { ...game, progress: boolArg("progress") },
    ...(liveViewer ? { onEvent: liveViewer.push } : {}),
    onGame: async (g) => {
      const seatsTxt = g.seats.map((st) => `${st.llmDecisions} API (${st.seat})`).join(", ");
      const cost = g.seats.every((st) => st.costUsd === null)
        ? ""
        : ` · $${g.seats.reduce((a, st) => a + (st.costUsd ?? 0), 0).toFixed(2)}`;
      console.log(
        `[${g.index}/${total}] seed ${g.seed}${repeat > 1 ? ` run ${g.run}` : ""}: ${g.status}` +
          (g.error ? ` (${g.error})` : "") +
          (g.winner ? ` — ${g.winner} wins (${g.reason}) ${g.corpAP}:${g.runnerAP}` : "") +
          ` · ${seatsTxt}${cost} · ${g.minutes.toFixed(1)} min`
      );
      if (corpusMod && g.status === "completed" && g.runDir) {
        const dest = await corpusMod.promote(repoRoot, join(matchDir, g.runDir), false);
        console.log(`  promoted → ${dest}`);
      }
    },
  });
  if (corpusMod) console.log(await corpusMod.writeReport(repoRoot));
  for (const w of result.winRates) {
    console.log(
      `win rate ${w.seat} · ${w.model}: ` +
        (w.rate === null
          ? "no completed games"
          : `${w.wins}/${w.n} = ${(w.rate * 100).toFixed(0)}% ± ${((w.se ?? 0) * 100).toFixed(0)}% (SE clustered by seed)`)
    );
  }
  for (const d of result.divergences) {
    console.log(
      `seed ${d.seed}: ` +
        (d.kind === "choice"
          ? `first divergence at seq ${d.seq} (${d.turn}) after ${d.shared} identical decisions`
          : d.kind === "none"
            ? `identical decision streams (${d.shared})`
            : `${d.kind} divergence at decision ${d.shared}${d.seq !== undefined ? ` (seq ${d.seq})` : ""}`)
    );
  }
  console.log(`summary: ${join(matchDir, "match-summary.md")}`);
  if (liveViewer) await liveViewer.finish();
  const clean =
    result.games.every((g) => g.status === "completed" && g.invalidRecords === 0) &&
    !result.divergences.some((d) => d.kind === "menu");
  if (Object.values(seatModels).every((m) => m === "mock")) {
    // CI acceptance: every game completes cleanly and, with --repeat,
    // every same-seed pair diverges by a CHOICE (salted mock) — the
    // first-divergence path is exercised and the menus before it agree.
    const ok = clean && (repeat === 1 || result.divergences.every((d) => d.kind === "choice"));
    console.log(ok ? "RUN-MATCH (mock): PASS" : "RUN-MATCH (mock): FAIL");
    process.exit(ok ? 0 : 1);
  }
  process.exit(clean ? 0 : 1);
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
  const written = await writeFormatted(art.record, existsSync(art.jsonl) ? art.jsonl : null);
  for (const w of written) console.log(w);
  process.exit(0);
} else if (command === "replay") {
  // D15: the board viewer (site/viewer/) on a recorded game — writes the
  // game's viewer bundle to out/viewer/<id>.json and serves it. --engine
  // opens the D08 engine-board replay instead (the real engine renderer,
  // eval'ing each record's reproduction_code).
  const file = arg("file", "");
  if (!file) {
    console.error("replay requires --file <run folder or game record>");
    process.exit(2);
  }
  const { relative, sep } = await import("node:path");
  const { resolveGameArtifacts } = await import("./paths.js");
  const replayArt = resolveGameArtifacts(resolve(file));
  const rel = (p: string): string => "/" + relative(repoRoot, p).split(sep).join("/");
  const { startServer } = await import("./server.js");
  const shot = arg("screenshot", "");
  if (!process.argv.includes("--engine")) {
    if (!existsSync(replayArt.frames)) {
      console.log("no frames.jsonl for this game — re-simulating it to capture them…");
      const { resimulate } = await import("./resim.js");
      const r = await resimulate(repoRoot, replayArt.dir, outDir);
      console.log(`${r.ok ? "ok" : "FAILED"}: ${r.message}`);
      if (!r.ok) process.exit(1);
    }
    const { writeBundle } = await import("./site.js");
    const bundlePath = join(outDir, "viewer", `${replayArt.gameId}.json`);
    const info = await writeBundle(repoRoot, replayArt.dir, bundlePath);
    console.log(`bundle: ${bundlePath} (${info.steps} steps, ${info.frames} boards, ${(info.bytes / 1e6).toFixed(1)} MB)`);
    const server = await startServer(repoRoot);
    const step = arg("step", "");
    const url =
      `http://127.0.0.1:${server.port}/site/viewer/?game=${encodeURIComponent(rel(bundlePath))}` +
      (step ? `#step=${step}` : "");
    if (shot) {
      const browser = await launchBrowser();
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.goto(url, { waitUntil: "load" });
      await page.waitForFunction(
        () => (window as unknown as { __viewer?: { ready: () => boolean } }).__viewer?.ready() === true,
        undefined,
        { timeout: 60_000 }
      );
      await page.waitForTimeout(300);
      await page.screenshot({ path: shot });
      await browser.close();
      await server.close();
      console.log(`screenshot: ${shot}`);
      process.exit(0);
    }
    console.log("Board viewer running:");
    console.log(`  ${url}`);
    console.log("← → step · Shift+← → model decisions · Space play. Ctrl-C to stop.");
    await new Promise(() => { /* stay up until interrupted */ });
  }
  // --engine: the D08 engine-board replay.
  const abs = replayArt.record;
  const jsonlAbs = replayArt.jsonl;
  const staticServer = await startServer(repoRoot);
  const seqArg = arg("seq", "");
  // Boot the engine with the game's own precon decks (avoids the slow
  // random deck builder; the boot decks are deleted by the first RC eval).
  const { loadPrecon, encodeDeckParam } = await import("./precons.js");
  const { requiredSets, setsParam } = await import("./cardpool.js");
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
    setsParam(await requiredSets(repoRoot, [replayCorpDeck, replayRunnerDeck])) +
    `&c=${encodeDeckParam(replayCorpDeck)}&r=${encodeDeckParam(replayRunnerDeck)}` +
    (seqArg ? `&seq=${seqArg}` : "");
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
  console.log("Engine replay viewer running:");
  console.log(`  ${url}`);
  console.log("Open in a browser; ← → keys step decisions. Ctrl-C to stop.");
  await new Promise(() => { /* stay up until interrupted */ });
} else if (command === "site") {
  // D17: the project site's data — viewer bundles for every corpus game
  // with frames, plus site/data/index.json (gallery + results tables).
  // --serve previews the built site locally (the Pages artifact is site/).
  const { buildSiteData } = await import("./site.js");
  const out = await buildSiteData(repoRoot);
  console.log(`site data: ${out.games} games, ${(out.bytes / 1e6).toFixed(1)} MB of bundles → site/data/`);
  if (boolArg("serve")) {
    const { startServer } = await import("./server.js");
    const server = await startServer(repoRoot, undefined, parseInt(arg("port", "8788"), 10));
    console.log(`site preview: http://127.0.0.1:${server.port}/site/  (Ctrl-C to stop)`);
    await new Promise<void>((done) => process.once("SIGINT", () => done()));
    await server.close();
  }
  process.exit(0);
} else if (command === "frames") {
  // D15: backfill viewer frames by re-simulating recorded games (no API
  // calls) — verifies the replay decision-by-decision before installing
  // frames.jsonl next to the record. --file <run> or --corpus (all games).
  const { resimulate } = await import("./resim.js");
  const { readdir } = await import("node:fs/promises");
  const targets: string[] = [];
  if (process.argv.includes("--corpus")) {
    const dir = join(repoRoot, "harness", "data", "games");
    for (const id of (await readdir(dir)).sort()) targets.push(join(dir, id));
  } else {
    const file = arg("file", "");
    if (!file) {
      console.error("frames requires --file <run folder> or --corpus");
      process.exit(2);
    }
    targets.push(resolve(file));
  }
  let failures = 0;
  for (const t of targets) {
    const result = await resimulate(repoRoot, t, outDir);
    if (!result.ok) failures++;
    console.log(`${result.ok ? "ok  " : "FAIL"} ${t.split(/[\\/]/).pop()}: ${result.message}`);
  }
  process.exit(failures === 0 ? 0 : 1);
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
  // Decks that failed pool qualification hit ENGINE defects; smoke tests
  // the harness, so it skips them unless --allow-unqualified.
  const manifest = await (await import("./cardpool.js")).loadPoolManifest(repoRoot);
  const allowUnqualified = boolArg("allow-unqualified");
  const skipped: string[] = [];
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
    if (!allowUnqualified && manifest?.decks[name]?.qualified === false) {
      skipped.push(name);
      continue;
    }
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
  if (skipped.length) {
    console.log(`skipping ${skipped.length} deck(s) that failed pool qualification: ${skipped.join(", ")}`);
  }
  let failures = 0;
  let games = 0;
  // Engine self-lint about card definitions — logged identically in
  // rules-vs-rules games; reported, not failed (cardpool.ts ENGINE_LINT).
  const { hardErrors } = await import("./cardpool.js");
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
  // D16: the card pool. Lists every precon with the set files it needs
  // and its qualification status; `--qualify` (re)runs qualification —
  // per deck, 3 rules-vs-rules games against the Gateway reference
  // opponent (invariant on, conservation-audited) plus one mock game with
  // the deck's own side as the LLM seat (exercises its cards' human
  // branches under D14). A deck qualifies only if every game completes
  // with no hard error, leak, audit finding or invalid record.
  const { readdir } = await import("node:fs/promises");
  const { loadPrecon } = await import("./precons.js");
  const pool = await import("./cardpool.js");
  const { loadCardData } = await import("./carddata.js");
  const { auditGameLog, buildCardSideMap } = await import("./audit.js");
  const cards = await loadCardData(repoRoot);
  const only = arg("only", "");
  const names = (await readdir(join(repoRoot, "precons")))
    .filter((f) => f.endsWith(".js"))
    .map((f) => f.replace(/\.js$/, ""))
    .filter((n) => !only || n === only)
    .sort();
  if (process.argv.includes("--qualify")) {
    // Decks run --jobs at a time (default 3: rules games share one
    // browser, each mock game launches its own). The manifest is
    // rewritten after every deck, so an interrupted run keeps its
    // progress; --resume skips decks already qualified on the same seeds.
    const seeds = arg("seeds", "1,2,3").split(",").map((x) => parseInt(x, 10));
    const jobs = Math.max(1, parseInt(arg("jobs", "3"), 10));
    const reference = { corp: "Gateway Corp", runner: "Gateway Runner" };
    const cardSide = await buildCardSideMap(repoRoot);
    const existing = (await pool.loadPoolManifest(repoRoot)) ?? null;
    const resume = process.argv.includes("--resume");
    const keep = existing && (only || resume) ? { ...existing.decks } : {};
    const manifest: import("./cardpool.js").PoolManifest = {
      comment:
        "Card-pool qualification (D16), generated by `cli.ts pool --qualify`. Decks with " +
        "qualified=false hit engine defects (crash, stall, error) or harness checks and are " +
        "refused by llm-game/run-match unless --allow-unqualified.",
      generated: new Date().toISOString().slice(0, 10),
      referenceOpponents: reference,
      seeds,
      decks: keep,
    };
    const sameSeeds = (d: { games: { seed: number; kind: string }[] }): boolean =>
      JSON.stringify(d.games.filter((g) => g.kind === "rules").map((g) => g.seed)) ===
      JSON.stringify(seeds);
    const todo = names.filter((n) => !(resume && keep[n] && sameSeeds(keep[n]!)));
    if (resume) console.log(`resuming: ${names.length - todo.length} decks kept, ${todo.length} to run`);
    const writeManifest = async (): Promise<void> => {
      const decks = Object.fromEntries(
        Object.entries(manifest.decks).sort(([a], [b]) => a.localeCompare(b))
      );
      await writeFile(
        join(repoRoot, pool.POOL_MANIFEST),
        JSON.stringify({ ...manifest, decks }, null, 1) + "\n"
      );
    };
    const browser = await launchBrowser();
    const crashed = (
      kind: "rules" | "llm-mock", sd: number, opponent: string, err: unknown
    ): import("./cardpool.js").QualificationGame => ({
      kind, seed: sd, opponent, status: "crashed", winner: null, hardErrors: 1, lint: 0,
      invariantViolations: 0, auditFindings: null, invalidRecords: null,
      firstProblem: `harness exception: ${String(err instanceof Error ? err.message : err).slice(0, 140)}`,
    });
    const qualifyDeck = async (name: string): Promise<void> => {
      const deck = await loadPrecon(repoRoot, name);
      const side = cards.get(deck.identity)?.side === "corp" ? "corp" as const : "runner" as const;
      const check = await pool.checkPool(repoRoot, [deck]);
      const games: import("./cardpool.js").QualificationGame[] = [];
      const opponent = side === "corp" ? reference.runner : reference.corp;
      const corpPrecon = side === "corp" ? name : opponent;
      const runnerPrecon = side === "corp" ? opponent : name;
      if (check.missing.length === 0) {
        for (const sd of seeds) {
          try {
            const rec = await runGame(
              { repoRoot, seed: sd, corpPrecon, runnerPrecon, extraParams: "&invariant=1" },
              browser
            );
            const hard = pool.hardErrors(rec.errors);
            const audit = await auditGameLog(name, rec.log, cardSide);
            const auditFindings = audit.issues.length + audit.unknownCreditLines.length;
            const v = rec.invariantViolations ?? [];
            games.push({
              kind: "rules", seed: sd, opponent, status: rec.status, winner: rec.winner,
              hardErrors: hard.length, lint: rec.errors.length - hard.length,
              invariantViolations: v.length, auditFindings, invalidRecords: null,
              firstProblem:
                rec.status !== "completed"
                  ? `game ${rec.status}${hard[0] ? `: ${hard[0].slice(0, 140)}` : ""}` :
                hard[0]?.slice(0, 160) ??
                (v[0] ? `leak: ${JSON.stringify(v[0]).slice(0, 140)}` : null) ??
                (auditFindings ? `audit: ${(audit.issues[0]?.detail ?? audit.unknownCreditLines[0]?.text ?? "").slice(0, 140)}` : null),
            });
          } catch (err) {
            games.push(crashed("rules", sd, opponent, err));
          }
        }
        const sd = seeds[0]!;
        try {
          const rec = await runLLMGame({
            repoRoot, seed: sd, corpPrecon, runnerPrecon, seat: side, model: "mock",
            rulesSource: "digest", profile: "neutral", reasoningStyle: "brief",
            debrief: false, frames: false, extraParams: "&invariant=1",
            outDir: join(outDir, "qualify"),
          });
          const hard = pool.hardErrors(rec.errors);
          const v = rec.invariantViolations ?? [];
          games.push({
            kind: "llm-mock", seed: sd, opponent, status: rec.status, winner: rec.winner,
            hardErrors: hard.length, lint: rec.errors.length - hard.length,
            invariantViolations: v.length, auditFindings: null, invalidRecords: rec.invalidRecords,
            firstProblem:
              rec.status !== "completed"
                ? `mock ${side}-seat game ${rec.status}${hard[0] ? `: ${hard[0].slice(0, 140)}` : ""}` :
              hard[0]?.slice(0, 160) ??
              (v[0] ? `leak: ${JSON.stringify(v[0]).slice(0, 140)}` : null) ??
              (rec.invalidRecords ? `${rec.invalidRecords} invalid records` : null),
          });
        } catch (err) {
          games.push(crashed("llm-mock", sd, opponent, err));
        }
      }
      const qualified =
        check.missing.length === 0 &&
        games.every((g) => g.status === "completed" && g.hardErrors === 0 &&
          g.invariantViolations === 0 && !g.auditFindings && !g.invalidRecords);
      manifest.decks[name] = { side, sets: check.sets, qualified, games };
      await writeManifest();
      console.log(
        `${qualified ? "✓" : "✗"} ${side.padEnd(6)} ${name.padEnd(40)} ` +
          (qualified ? "" : games.find((g) => g.firstProblem)?.firstProblem ??
            `${check.missing.length} unimplemented card(s)`)
      );
    };
    const queue = [...todo];
    await Promise.all(
      Array.from({ length: Math.min(jobs, queue.length) }, async () => {
        for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
          await qualifyDeck(name);
        }
      })
    );
    await browser.close();
    await writeManifest();
    const all = Object.values(manifest.decks);
    console.log(
      `\nqualified ${all.filter((d) => d.qualified).length}/${all.length} decks → ${pool.POOL_MANIFEST}`
    );
    process.exit(0);
  }
  const manifest = await pool.loadPoolManifest(repoRoot);
  for (const side of ["corp", "runner"]) {
    console.log(`\n${side.toUpperCase()} precons (✓ qualified, ✗ failed qualification, ? not qualified yet):`);
    for (const name of names) {
      const deck = await loadPrecon(repoRoot, name);
      if ((cards.get(deck.identity)?.side ?? "") !== side) continue;
      const check = await pool.checkPool(repoRoot, [deck]);
      const q = manifest?.decks[name];
      const mark = check.missing.length ? "✗" : q ? (q.qualified ? "✓" : "✗") : "?";
      const why = q && !q.qualified ? ` — ${q.games.find((g) => g.firstProblem)?.firstProblem ?? ""}` : "";
      console.log(
        `  ${mark} ${name.padEnd(40)} ${check.sets.length ? check.sets.join("+") : "base pool"}` +
          (check.missing.length ? ` — ${check.missing.length} unimplemented card(s)` : why)
      );
    }
  }
  process.exit(0);
} else if (command === "selftest") {
  // D11: fault injection — every checker must catch a planted defect of
  // every class it claims, localized, and pass the clean original.
  const { selftest, SUITES } = await import("./selftest.js");
  const wanted = arg("suite", "") ? arg("suite", "").split(",") : SUITES;
  const unknown = wanted.filter((x) => !(SUITES as string[]).includes(x));
  if (unknown.length) {
    console.error(`selftest: unknown suite(s) ${unknown.join(", ")} (have ${SUITES.join(", ")})`);
    process.exit(2);
  }
  const outcomes = await selftest(repoRoot, outDir, wanted as typeof SUITES);
  const failed = outcomes.filter((o) => !o.ok);
  console.log(
    failed.length === 0
      ? `SELFTEST: all ${outcomes.length} checks passed (${wanted.join(", ")})`
      : `SELFTEST: ${failed.length}/${outcomes.length} checks FAILED`
  );
  process.exit(failed.length === 0 ? 0 : 1);
} else if (command === "audit") {
  const file = arg("file", "");
  if (process.argv.includes("--review-sample")) {
    // D11: a hand-verifiable packet of sampled checkpoints (needs --file).
    if (!file) {
      console.error("audit --review-sample N needs --file <game>");
      process.exit(2);
    }
    const { reviewSample } = await import("./audit.js");
    const n = parseInt(arg("review-sample", "12"), 10) || 12;
    const out = await reviewSample(
      repoRoot,
      (await import("./paths.js")).resolveGameArtifacts(file).record,
      n,
      seed
    );
    console.log(`${out.samples} sampled checkpoints → ${out.outFile}`);
    process.exit(0);
  }
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
