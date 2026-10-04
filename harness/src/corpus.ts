/** The corpus: finished games kept in harness/data/games/ (one folder per
 *  run, tracked in git) and the report harness/data/CORPUS.md.
 *
 *  Promotion is explicit: `corpus --promote <run>` copies a run's
 *  artifacts in and regenerates the report. Nothing enters the corpus as a
 *  side effect of playing. Every row and aggregate is per seat a model
 *  played, and keyed by how it played: through the API (the harness called
 *  the model) or over MCP (a chat app played on a subscription).
 */
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveGameArtifacts } from "./paths.js";
import { estimateCostUsd } from "./prices.js";
import { writeFormatted } from "./format.js";

type SeatName = "runner" | "corp";
type Driver = "api" | "mcp";

interface UsageLite {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
}

interface SeatStatsLite {
  seat: SeatName;
  model: string;
  driver?: Driver;
  llmDecisions?: number;
  forcedDecisions?: number;
  compoundFulfilled?: number;
  orderFolded?: number;
  retriesTotal?: number;
  fallbacks?: number;
  compactions?: number;
  compactionsSuppressed?: number;
  usage?: UsageLite;
  reportedCostUsd?: number | null;
}

/** The record fields the corpus reads (see llmgame.ts LLMGameRecord). */
export interface GameRecordLite {
  status?: string;
  winner?: string | null;
  reason?: string | null;
  corpAgendaPoints?: number | null;
  runnerAgendaPoints?: number | null;
  decisions?: number;
  turns?: { corp: number; runner: number } | null;
  model?: string;
  llmSeat?: "runner" | "corp" | "both";
  seats?: Partial<Record<SeatName, SeatStatsLite>>;
  aiBranches?: "neutral" | "rules";
  cardSets?: string[];
  rulesSource?: string;
  promptProfile?: string;
  reasoningStyle?: string;
  contextMode?: string;
  decisionView?: string;
  historyVariant?: string | null;
  autoResolve?: boolean;
  debrief?: boolean;
  actions?: string;
  seed?: number;
  corpPrecon?: string;
  runnerPrecon?: string;
  retriesTotal?: number;
  httpRetries?: number;
  fallbacks?: number;
  invalidRecords?: number;
  compactions?: number;
  compactionsSuppressed?: number;
  largeFusedMenus?: number;
  previewDivergences?: number;
}

/** Games are comparable only under the same interface. The standard one
 *  has card scripts treat model seats as human players, so the rules AI's
 *  shortcuts never prune a model's menu. The `--ai-branches rules`
 *  ablation lets them (records without the field ran that way too). */
export function isStandard(r: GameRecordLite): boolean {
  return r.aiBranches === "neutral";
}

export const ABLATION_LABEL = "rules-AI branches active in card scripts (--ai-branches rules)";

/** One seat a model played in one game. */
export interface SeatEntry {
  seat: SeatName;
  model: string;
  /** "api": the harness called the model; "mcp": a chat app played over
   *  MCP (subscription: no token usage, no per-game cost). */
  driver: Driver;
  llmDecisions: number;
  forcedDecisions: number;
  compoundFulfilled: number;
  orderFolded: number;
  retriesTotal: number;
  fallbacks: number;
  compactions: number;
  compactionsSuppressed: number;
  costUsd: number | null;
}

/** Provider-reported cost when present, else the price-table estimate. */
function costOf(model: string, usage: UsageLite | undefined, reported: number | null | undefined): number | null {
  if (typeof reported === "number") return reported;
  return usage ? estimateCostUsd(model, usage) : null;
}

export function seatEntries(r: GameRecordLite): SeatEntry[] {
  return (["corp", "runner"] as SeatName[])
    .filter((s) => r.seats?.[s])
    .map((s) => {
      const st = r.seats![s]!;
      const driver = st.driver ?? "api";
      return {
        seat: s,
        model: st.model,
        driver,
        llmDecisions: st.llmDecisions ?? 0,
        forcedDecisions: st.forcedDecisions ?? 0,
        compoundFulfilled: st.compoundFulfilled ?? 0,
        orderFolded: st.orderFolded ?? 0,
        retriesTotal: st.retriesTotal ?? 0,
        fallbacks: st.fallbacks ?? 0,
        compactions: st.compactions ?? 0,
        compactionsSuppressed: st.compactionsSuppressed ?? 0,
        costUsd: driver === "mcp" ? null : costOf(st.model, st.usage, st.reportedCostUsd),
      };
    });
}

/** "model" for API seats, "model (MCP)" for chat-app seats. */
export function playerLabel(s: { model: string; driver: string }): string {
  return s.driver === "mcp" ? `${s.model} (MCP)` : s.model;
}

export async function promote(repoRoot: string, runPath: string, partial: boolean): Promise<string> {
  const art = resolveGameArtifacts(runPath);
  const dest = join(repoRoot, "harness", "data", "games", art.gameId);
  const required: [string, string][] = [
    [art.record, "record.json"],
    [art.jsonl, "decisions.jsonl"],
  ];
  const optional: [string, string][] = [
    [art.debrief, "debrief.json"],
    [art.frames, "frames.jsonl"],
    ...art.systemPrompts.map((p): [string, string] => [p, p.split(/[\\/]/).pop()!]),
  ];
  const missing = required.filter(([src]) => !existsSync(src));
  if (missing.length > 0 && !partial) {
    throw new Error(
      `incomplete artifact set for ${art.gameId} (missing ${missing.map(([, n]) => n).join(", ")}): ` +
        "pass --partial to promote anyway"
    );
  }
  await mkdir(dest, { recursive: true });
  for (const [src, name] of [...required, ...optional]) {
    if (existsSync(src)) await copyFile(src, join(dest, name));
  }
  // The game's markdown narrative travels with it, regenerated from the
  // promoted data so the two always match.
  const destRecord = join(dest, "record.json");
  if (existsSync(destRecord)) {
    const destJsonl = join(dest, "decisions.jsonl");
    await writeFormatted(destRecord, existsSync(destJsonl) ? destJsonl : null);
  }
  return dest;
}

export interface CorpusGame {
  id: string;
  record: GameRecordLite | null; // null: promoted with --partial, no record
  standard: boolean;
  seats: SeatEntry[];
}

export async function loadCorpus(repoRoot: string): Promise<CorpusGame[]> {
  const gamesDir = join(repoRoot, "harness", "data", "games");
  if (!existsSync(gamesDir)) return [];
  const out: CorpusGame[] = [];
  for (const id of (await readdir(gamesDir)).sort()) {
    const recPath = join(gamesDir, id, "record.json");
    if (!existsSync(recPath)) {
      out.push({ id, record: null, standard: false, seats: [] });
      continue;
    }
    const r = JSON.parse(await readFile(recPath, "utf-8")) as GameRecordLite;
    out.push({ id, record: r, standard: isStandard(r), seats: seatEntries(r) });
  }
  return out;
}

const usd = (v: number | null): string => (v === null ? "—" : `$${v.toFixed(2)}`);

/** A game's cost: API seats in dollars, chat-app seats as "subscription". */
export function costLabel(seats: SeatEntry[]): string {
  const api = seats.filter((s) => s.driver === "api").map((s) => s.costUsd);
  const mcp = seats.some((s) => s.driver === "mcp");
  const known = api.filter((c): c is number => c !== null);
  const dollars = known.length ? usd(known.reduce((a, b) => a + b, 0)) : api.length ? "—" : "";
  return [dollars, mcp ? "subscription" : ""].filter(Boolean).join(" + ");
}

function gameRow(g: CorpusGame): string {
  const r = g.record!;
  const outcome =
    r.status === "completed"
      ? `${r.winner}: ${r.reason} (${r.corpAgendaPoints}:${r.runnerAgendaPoints} AP, ` +
        `${r.turns?.corp ?? "?"} turn${r.turns?.corp === 1 ? "" : "s"})`
      : r.status ?? "?";
  const incidents: string[] = [];
  if (r.retriesTotal) incidents.push(`${r.retriesTotal} retries`);
  if (r.httpRetries) incidents.push(`${r.httpRetries} http-retries`);
  if (r.fallbacks) incidents.push(`${r.fallbacks} FALLBACKS`);
  if (r.invalidRecords) incidents.push(`${r.invalidRecords} INVALID`);
  if (r.previewDivergences) incidents.push(`${r.previewDivergences} preview-div`);
  if (r.compactionsSuppressed) incidents.push(`${r.compactionsSuppressed} compact-suppressed`);
  if (r.largeFusedMenus) incidents.push(`${r.largeFusedMenus} large-menus`);
  const config =
    `${r.actions ?? "—"}/${r.contextMode ?? "—"}` + (r.decisionView === "compact" ? "/compact" : "");
  return [
    `\`${g.id}\``,
    g.seats.map((s) => `${s.seat}: ${playerLabel(s)}`).join(" · "),
    r.seed ?? "—",
    `${r.corpPrecon ?? "?"} vs ${r.runnerPrecon ?? "?"}`,
    config,
    outcome,
    g.seats.map((s) => `${s.llmDecisions}/${s.forcedDecisions}/${s.compoundFulfilled}/${s.orderFolded}`).join(" · "),
    g.seats.map((s) => String(s.compactions)).join(" · "),
    incidents.length ? incidents.join(", ") : "clean",
    costLabel(g.seats),
  ].join(" | ");
}

const TABLE_HEADER =
  "| game | seats (model) | seed | matchup (corp vs runner) | config | outcome | model/forced/fulfilled/folded decisions | compactions | incidents | cost |\n" +
  "|---|---|---|---|---|---|---|---|---|---|";

export interface Aggregate {
  seat: SeatName;
  model: string;
  driver: Driver;
  n: number;
  completed: number;
  wins: number;
  flatlines: number; // games ending in a Runner flatline
  meanTurns: number;
  meanDecisions: number;
  meanCost: number | null;
}

/** Per (seat, model, driver) aggregates over a set of games. */
export function aggregates(games: CorpusGame[]): Aggregate[] {
  const by = new Map<string, { seat: SeatName; model: string; driver: Driver; rows: { g: CorpusGame; s: SeatEntry }[] }>();
  for (const g of games) {
    for (const s of g.seats) {
      const k = `${s.seat}\u0000${s.model}\u0000${s.driver}`;
      const e = by.get(k) ?? { seat: s.seat, model: s.model, driver: s.driver, rows: [] };
      e.rows.push({ g, s });
      by.set(k, e);
    }
  }
  return [...by.values()]
    .sort((a, b) => a.seat.localeCompare(b.seat) || a.model.localeCompare(b.model) || a.driver.localeCompare(b.driver))
    .map(({ seat, model, driver, rows }) => {
      const done = rows.filter(({ g }) => g.record!.status === "completed");
      const mean = (f: (x: { g: CorpusGame; s: SeatEntry }) => number): number =>
        done.reduce((t, x) => t + f(x), 0) / Math.max(1, done.length);
      const costs = rows.map(({ s }) => s.costUsd).filter((c): c is number => c !== null);
      return {
        seat,
        model,
        driver,
        n: rows.length,
        completed: done.length,
        wins: done.filter(({ g }) => g.record!.winner === seat).length,
        flatlines: done.filter(({ g }) => /flatlin/i.test(g.record!.reason ?? "")).length,
        meanTurns: mean(({ g }) => g.record!.turns?.corp ?? 0),
        meanDecisions: mean(({ s }) => s.llmDecisions),
        meanCost: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null,
      };
    });
}

function aggregateTable(games: CorpusGame[]): string[] {
  return [
    "| seat | model | n | wins | runner flatlines | mean corp turns | mean model decisions | mean cost |",
    "|---|---|---|---|---|---|---|---|",
    ...aggregates(games).map(
      (a) =>
        `| ${a.seat} | ${playerLabel(a)} | ${a.n} | ${a.wins}/${a.completed} | ${a.flatlines}/${a.completed} | ` +
        `${a.meanTurns.toFixed(1)} | ${a.meanDecisions.toFixed(0)} | ${a.driver === "mcp" ? "subscription" : usd(a.meanCost)} |`
    ),
  ];
}

/** What the corpus cannot yet say, computed rather than curated. */
function coverageHoles(cur: CorpusGame[]): string[] {
  if (cur.length === 0) return ["- **no games yet**"];
  const holes: string[] = [];
  const seeds = new Set(cur.map((g) => g.record!.seed));
  if (seeds.size === 1) holes.push(`- **single seed**: every game is seed ${[...seeds][0]}, so no across-seed evidence`);
  const n = new Map<string, number>();
  for (const g of cur) for (const s of g.seats) n.set(`${s.seat}: ${playerLabel(s)}`, (n.get(`${s.seat}: ${playerLabel(s)}`) ?? 0) + 1);
  const lowN = [...n.entries()].filter(([, c]) => c < 3);
  if (lowN.length) holes.push(`- **n < 3** for ${lowN.map(([k, c]) => `${k} (n=${c})`).join(", ")}: no variance estimate`);
  if (!cur.some((g) => g.seats.some((s) => s.seat === "corp"))) holes.push("- **no model has played the Corp**");
  if (!cur.some((g) => g.seats.length === 2)) holes.push("- **no model-vs-model game**");
  if (!cur.some((g) => g.record!.actions === "split")) holes.push("- **no `--actions split` arm**");
  if (!cur.some((g) => g.record!.contextMode === "stateless")) holes.push("- **no stateless-context arm**");
  if (!cur.some((g) => g.record!.historyVariant === "lean")) holes.push("- **no lean-history arm**");
  const apiModels = [...new Set(cur.flatMap((g) => g.seats.filter((s) => s.driver === "api").map((s) => s.model)))];
  const neverCompacted = apiModels.filter(
    (m) => !cur.some((g) => g.seats.some((s) => s.model === m && s.driver === "api" && s.compactions > 0))
  );
  if (neverCompacted.length) holes.push(`- **compaction never exercised** for: ${neverCompacted.join(", ")}`);
  const matchups = new Set(cur.map((g) => `${g.record!.corpPrecon} vs ${g.record!.runnerPrecon}`));
  if (matchups.size === 1) holes.push(`- **single matchup**: ${[...matchups][0]}`);
  if (!cur.some((g) => (g.record!.cardSets ?? []).length > 0)) holes.push("- **base card pool only**: no Elevation or Core-set deck");
  const noDebrief = cur.filter((g) => g.record!.debrief === false);
  if (noDebrief.length) holes.push(`- debrief disabled on: ${noDebrief.map((g) => g.id).join(", ")}`);
  return holes;
}

export async function writeReport(repoRoot: string): Promise<string> {
  const games = await loadCorpus(repoRoot);
  const lines: string[] = [
    "# CORPUS: cumulative results",
    "",
    "_Generated by `npx tsx src/cli.ts corpus` from `data/games/`. Every row and aggregate is per seat a " +
      "model played. Costs " +
      "are provider-reported when present, else estimated from `src/prices.ts` (— = no basis); seats played " +
      "from a chat app over MCP are marked (MCP) and cost a subscription, not tokens._",
  ];

  const cur = games.filter((g) => g.standard && g.record);
  lines.push("", "## Games", "");
  if (cur.length) {
    lines.push(TABLE_HEADER, ...cur.map((g) => `| ${gameRow(g)} |`));
    lines.push("", "### Per-seat aggregates (read n, not trends)", "", ...aggregateTable(cur));
  } else {
    lines.push("_(no games yet)_");
  }

  const ablation = games.filter((g) => !g.standard && g.record);
  if (ablation.length) {
    lines.push("", `## Ablation: ${ABLATION_LABEL}`, "", "_Not comparable with the games above._", "");
    lines.push(TABLE_HEADER, ...ablation.map((g) => `| ${gameRow(g)} |`), "", ...aggregateTable(ablation));
  }
  const partials = games.filter((g) => !g.record);
  if (partials.length) {
    lines.push("", "## Partial promotions (no game record)", "", ...partials.map((g) => `- \`${g.id}\``));
  }

  lines.push("", "## Machinery health", "");
  const dirty = games.filter(
    (g) =>
      g.record &&
      ((g.record.fallbacks ?? 0) > 0 ||
        (g.record.invalidRecords ?? 0) > 0 ||
        (g.record.previewDivergences ?? 0) > 0 ||
        (g.record.compactionsSuppressed ?? 0) > 0)
  );
  if (dirty.length) {
    for (const g of dirty) {
      const r = g.record!;
      const parts = [
        r.fallbacks ? `${r.fallbacks} fallbacks` : null,
        r.invalidRecords ? `${r.invalidRecords} invalid records` : null,
        r.previewDivergences ? `${r.previewDivergences} preview divergences` : null,
        r.compactionsSuppressed ? `${r.compactionsSuppressed} suppressed compactions (threshold below the floor)` : null,
      ];
      lines.push(`- \`${g.id}\`: ${parts.filter(Boolean).join(", ")}`);
    }
  } else {
    lines.push("_(no fallbacks, invalid records, preview divergences or suppressed compactions)_");
  }

  lines.push("", "## Coverage holes: where the next run should go", "", ...coverageHoles(cur));

  lines.push("", "## Compaction summaries (the models' own strategy memos)", "");
  const memosStart = lines.length;
  for (const g of games) {
    if (!g.record || (g.record.compactions ?? 0) === 0) continue;
    const jsonlPath = join(repoRoot, "harness", "data", "games", g.id, "decisions.jsonl");
    if (!existsSync(jsonlPath)) continue;
    const rows = (await readFile(jsonlPath, "utf-8"))
      .split("\n")
      .filter((l) => l.includes('"record_type":"compaction"'));
    if (!rows.length) continue;
    lines.push(`### \`${g.id}\``, "");
    for (const row of rows) {
      const c = JSON.parse(row) as { compaction_id: number; summary: string; seat?: string };
      const who = g.seats.length > 1 ? ` (${c.seat ?? "runner"})` : "";
      lines.push(`**Compaction #${c.compaction_id}${who}**`, "", "> " + c.summary.replace(/\n/g, "\n> "), "");
    }
  }
  if (lines.length === memosStart) lines.push("_(none yet)_");

  const reportPath = join(repoRoot, "harness", "data", "CORPUS.md");
  await mkdir(join(repoRoot, "harness", "data"), { recursive: true });
  await writeFile(reportPath, lines.join("\n") + "\n");
  return reportPath;
}
