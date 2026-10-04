/** Playing games: `run-game` (rules AI on both seats), `llm-game` (a model
 *  in one or both seats) and `run-match` (many games of one configuration). */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runGame, type GameRecord } from "../game.js";
import { runLLMGame, type LLMGameRecord } from "../llmgame.js";
import { startLiveViewer } from "../live.js";
import type { Command } from "./args.js";
import { gameConfig, UsageError } from "./llm-options.js";

export function summarize(r: GameRecord): string {
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

export async function saveRecord(outDir: string, name: string, record: GameRecord): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, name), JSON.stringify(record, null, 1));
}

export const runGameCommand: Command = async ({ repoRoot, outDir, args }) => {
  const record = await runGame({
    repoRoot,
    seed: args.seed,
    corpPrecon: args.corp,
    runnerPrecon: args.runner,
  });
  console.log(summarize(record));
  await saveRecord(outDir, `game-${args.seed}.json`, record);
  if (record.errors.length > 0) console.log("errors:", record.errors.slice(0, 5));
  return record.status === "completed" ? 0 : 1;
};

/** Per-seat counters and checks after a model game. */
export function printGameReport(record: LLMGameRecord): void {
  console.log(summarize(record));
  console.log(
    `seats=${record.llmSeat} model=${record.model} rules=${record.rulesSource} ` +
      `profile=${record.promptProfile}/${record.reasoningStyle} context=${record.contextMode}` +
      (record.historyVariant ? `/${record.historyVariant}` : "") +
      ` autoResolve=${record.autoResolve ? "on" : "off"} actions=${record.actions}` +
      ` aiBranches=${record.aiBranches}` +
      (record.cardSets.length ? ` sets=${record.cardSets.join(",")}` : "")
  );
  for (const s of Object.values(record.seats)) {
    console.log(
      `[${s.seat}] model=${s.model} llmDecisions=${s.llmDecisions} ` +
        `forced=${s.forcedDecisions} fulfilled=${s.compoundFulfilled} ` +
        `folded=${s.orderFolded} multiSelectSteps=${s.multiSelectSteps} ` +
        (s.largeFusedMenus > 0 ? `⚠ largeMenus=${s.largeFusedMenus} ` : "") +
        `retries=${s.retriesTotal} fallbacks=${s.fallbacks} ` +
        `tokens in=${s.usage.tokensIn} out=${s.usage.tokensOut} ` +
        `cacheRead=${s.usage.cacheRead} cacheWrite=${s.usage.cacheWrite} ` +
        `compactions=${s.compactions} transcriptMax=${s.transcriptTokensMax}` +
        (s.reportedCostUsd !== null ? ` reportedCost=$${s.reportedCostUsd.toFixed(4)}` : "") +
        (s.compactionsSuppressed > 0
          ? ` ⚠ compactions-suppressed=${s.compactionsSuppressed} (threshold below the viable floor — raise it)`
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
  if (record.invariantChecks !== undefined) {
    const v = record.invariantViolations ?? [];
    console.log(`invariant: ${record.invariantChecks} checks, ${v.length} violations`);
    for (const x of v.slice(0, 5)) console.log("  ", JSON.stringify(x));
  }
  console.log(`decision log: ${record.decisionLogPath}`);
  if (record.framesPath) console.log(`frames: ${record.framesPath}`);
  if (record.debriefPath) console.log(`debrief: ${record.debriefPath}`);
}

/** Keyless acceptance for an all-mock game. The mock injects one transient
 *  and one persistent malformed answer per seat, so every model seat that
 *  reached those calls must show a retry and a fallback, recorded with the
 *  right failure classes. Compaction (conversational), forced records
 *  (auto-resolve), the debrief and compound fulfillment must all occur. */
async function mockAcceptance(record: LLMGameRecord): Promise<boolean> {
  const rows = (await readFile(record.decisionLogPath, "utf-8"))
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map(
      (l) =>
        JSON.parse(l) as {
          record_type?: string;
          failed_attempts?: { problem: string }[] | null;
          fallback?: boolean | null;
        }
    );
  const withFailures = rows.filter(
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
    (s) => s.llmDecisions < 10 || (s.retriesTotal >= 1 && s.fallbacks >= 1)
  );
  const conversational = record.contextMode === "conversational";
  const clauses: [clause: string, met: boolean][] = [
    ["the game completed", record.status === "completed"],
    ["no invalid records", record.invalidRecords === 0],
    ["no invariant violations", (record.invariantViolations ?? []).length === 0],
    ["a retry and a fallback on every model seat", record.retriesTotal >= 1 && record.fallbacks >= 1 && seatsOk],
    ["a transient failure recorded", transientOk],
    ["a persistent failure recorded", persistentOk],
    [
      "a compaction (a short game needs a low threshold, e.g. --compact-threshold 40000)",
      !conversational || record.compactions >= 1,
    ],
    ["a forced decision", !record.autoResolve || record.forcedDecisions >= 1],
    ["a debrief", !record.debrief || !conversational || record.debriefPath !== null],
    ["a compound fulfillment", record.actions !== "compound" || record.compoundFulfilled >= 1],
    ["an order fold", record.actions !== "compound" || !record.seats.runner || record.orderFolded >= 1],
  ];
  console.log(
    `failed-attempt records: ${withFailures.length} ` +
      `(transient=${transientOk ? "ok" : "MISSING"} persistent=${persistentOk ? "ok" : "MISSING"})`
  );
  const missed = clauses.filter(([, met]) => !met).map(([clause]) => clause);
  if (missed.length) console.log(`acceptance not met: ${missed.join("; ")}`);
  return missed.length === 0;
}

export const llmGameCommand: Command = async ({ repoRoot, outDir, args }) => {
  let config;
  try {
    config = await gameConfig(repoRoot, args);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
  const liveViewer = args.flag("live") ? await startLiveViewer(repoRoot) : null;
  const record = await runLLMGame({
    ...config.game,
    seed: args.seed,
    outDir,
    ...(liveViewer ? { onEvent: liveViewer.push } : {}),
  });
  printGameReport(record);
  if (liveViewer) await liveViewer.finish();
  if (Object.values(config.seatModels).every((m) => m === "mock")) {
    const ok = await mockAcceptance(record);
    console.log(ok ? "LLM-GAME (mock): PASS" : "LLM-GAME (mock): FAIL");
    return ok ? 0 : 1;
  }
  return record.status === "completed" && record.invalidRecords === 0 ? 0 : 1;
};

export const runMatchCommand: Command = async ({ repoRoot, outDir, args }) => {
  let config;
  try {
    config = await gameConfig(repoRoot, args);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
  const { seatModels, game } = config;
  const { runMatch } = await import("../match.js");
  const seeds = args.str("seeds", "")
    ? args.str("seeds", "").split(",").map((x) => parseInt(x, 10))
    : Array.from({ length: args.int("games", 10) }, (_, i) => args.seed + i);
  if (seeds.length === 0 || seeds.some((x) => !Number.isInteger(x))) {
    console.error("run-match: --games N (with --seed S) or --seeds a,b,c required");
    return 2;
  }
  const repeat = Math.max(1, args.int("repeat", 1));
  const slug = (m: string): string => m.replace(/[^A-Za-z0-9.-]+/g, "_");
  const who =
    game.seat === "both"
      ? `${slug(seatModels.corp!)}-vs-${slug(seatModels.runner!)}`
      : `${game.seat === "corp" ? "corp-" : ""}${slug(game.model)}`;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const label = args.str(
    "label",
    `${who}-s${seeds[0]}-n${seeds.length}${repeat > 1 ? `x${repeat}` : ""}-${stamp}`
  );
  const matchDir = join(outDir, `match-${label}`);
  if (existsSync(join(matchDir, "match.json"))) {
    console.error(`run-match: ${matchDir} already holds a match — pick another --label`);
    return 2;
  }
  const corpus = args.flag("promote-all") ? await import("../corpus.js") : null;
  const liveViewer = args.flag("live") ? await startLiveViewer(repoRoot) : null;
  const total = seeds.length * repeat;
  console.log(
    `match ${label}: ${total} game${total === 1 ? "" : "s"} (seeds ${seeds.join(",")}` +
      `${repeat > 1 ? ` × ${repeat}` : ""}) → ${matchDir}`
  );
  const result = await runMatch({
    repoRoot,
    label,
    matchDir,
    seeds,
    repeat,
    game,
    ...(liveViewer ? { onEvent: liveViewer.push } : {}),
    onGame: async (g) => {
      const seatsTxt = g.seats.map((s) => `${s.llmDecisions} API (${s.seat})`).join(", ");
      const cost = g.seats.every((s) => s.costUsd === null)
        ? ""
        : ` · $${g.seats.reduce((a, s) => a + (s.costUsd ?? 0), 0).toFixed(2)}`;
      console.log(
        `[${g.index}/${total}] seed ${g.seed}${repeat > 1 ? ` run ${g.run}` : ""}: ${g.status}` +
          (g.error ? ` (${g.error})` : "") +
          (g.winner ? ` — ${g.winner} wins (${g.reason}) ${g.corpAP}:${g.runnerAP}` : "") +
          ` · ${seatsTxt}${cost} · ${g.minutes.toFixed(1)} min`
      );
      if (corpus && g.status === "completed" && g.runDir) {
        console.log(`  promoted → ${await corpus.promote(repoRoot, join(matchDir, g.runDir), false)}`);
      }
    },
  });
  if (corpus) console.log(await corpus.writeReport(repoRoot));
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
    // With --repeat, salted mock reruns must diverge by a choice, and the
    // menus before that point must agree.
    const ok = clean && (repeat === 1 || result.divergences.every((d) => d.kind === "choice"));
    console.log(ok ? "RUN-MATCH (mock): PASS" : "RUN-MATCH (mock): FAIL");
    return ok ? 0 : 1;
  }
  return clean ? 0 : 1;
};
