/** The corpus (D06-1 rev 2): durable game data in harness/data/games/
 *  (one nested folder per run, tracked in git) plus the progressive
 *  report data/CORPUS.md.
 *
 *  Promotion is explicit — `corpus --promote <run>` copies a game's
 *  artifact set into the corpus (normalizing legacy flat layouts into
 *  the nested shape) and regenerates the report. Nothing enters the
 *  corpus as a side effect of running a game.
 *
 *  Since D14 a game can seat a model as Runner, as Corp, or in both
 *  seats; every table row and aggregate is per (seat, model), and costs
 *  are summed per seat.
 */
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveGameArtifacts } from "./paths.js";
import { estimateCostUsd } from "./prices.js";
import { writeFormatted } from "./format.js";

type SeatName = "runner" | "corp";

interface UsageLite {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
}

interface SeatStatsLite {
  seat: SeatName;
  model: string;
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

export interface GameRecordLite {
  status?: string;
  winner?: string | null;
  reason?: string | null;
  corpAgendaPoints?: number | null;
  runnerAgendaPoints?: number | null;
  decisions?: number;
  turns?: { corp: number; runner: number } | null;
  durationMs?: number;
  model?: string;
  llmSeat?: "runner" | "corp" | "both"; // D14 (absent = runner)
  seats?: Partial<Record<SeatName, SeatStatsLite>>; // D14
  aiBranches?: "neutral" | "rules"; // D14
  multiSelects?: number; // D14
  cardSets?: string[]; // D16
  rulesSource?: string;
  promptProfile?: string;
  reasoningStyle?: string;
  contextMode?: string;
  historyVariant?: string | null;
  autoResolve?: boolean;
  debrief?: boolean;
  actions?: string;
  seed?: number;
  corpPrecon?: string;
  runnerPrecon?: string;
  llmDecisions?: number;
  forcedDecisions?: number;
  compoundFulfilled?: number;
  orderFolded?: number;
  largeFusedMenus?: number;
  rulesDecisions?: number;
  retriesTotal?: number;
  httpRetries?: number;
  fallbacks?: number;
  invalidRecords?: number;
  compactions?: number;
  compactionsSuppressed?: number;
  transcriptTokensMax?: number;
  previewChecks?: number;
  previewDivergences?: number;
  usage?: UsageLite;
  reportedCostUsd?: number | null; // D13: provider-billed (OpenRouter)
}

/** Interface era, derived from record fields — never hand-tagged.
 *  0 = pre-D01 (stateless, degraded schema)  1 = D01–D07 split
 *  2 = D09-1 compound                         3 = D09-2 deeper fusion
 *  4 = D14 neutralized rules-AI branches (current). A D14-era record run
 *  with `--ai-branches rules` reproduces era-3 menus and stays in era 3. */
export function eraOf(r: GameRecordLite): number {
  if (r.aiBranches === "neutral") return 4;
  if (r.orderFolded !== undefined) return 3;
  if (r.actions !== undefined) return 2;
  if (r.contextMode !== undefined) return 1;
  return 0;
}

export const ERA_LABEL: Record<number, string> = {
  0: "era 0 — pre-D01 stateless (schema-degraded; archived)",
  1: "era 1 — conversational, split actions (D01–D07)",
  2: "era 2 — compound (D09-1)",
  3: "era 3 — deeper fusion (D09-2)",
  4: "era 4 — honest menus: rules-AI branches neutralized, multi-select (D14, CURRENT)",
};

export const CURRENT_ERA = 4;

/** One (seat, model) participation in a game — legacy single-seat records
 *  (no `seats`) are the Runner seat with the record's own counters. */
export interface SeatEntry {
  seat: SeatName;
  model: string;
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

function costOf(model: string, usage: UsageLite | undefined, reported: number | null | undefined): number | null {
  if (typeof reported === "number") return reported;
  return usage ? estimateCostUsd(model, usage) : null;
}

export function seatEntries(r: GameRecordLite): SeatEntry[] {
  if (r.seats && Object.keys(r.seats).length > 0) {
    return (["corp", "runner"] as SeatName[])
      .filter((s) => r.seats![s])
      .map((s) => {
        const st = r.seats![s]!;
        return {
          seat: s,
          model: st.model,
          llmDecisions: st.llmDecisions ?? 0,
          forcedDecisions: st.forcedDecisions ?? 0,
          compoundFulfilled: st.compoundFulfilled ?? 0,
          orderFolded: st.orderFolded ?? 0,
          retriesTotal: st.retriesTotal ?? 0,
          fallbacks: st.fallbacks ?? 0,
          compactions: st.compactions ?? 0,
          compactionsSuppressed: st.compactionsSuppressed ?? 0,
          costUsd: costOf(st.model, st.usage, st.reportedCostUsd),
        };
      });
  }
  const model = r.model ?? "?";
  return [
    {
      seat: "runner",
      model,
      llmDecisions: r.llmDecisions ?? 0,
      forcedDecisions: r.forcedDecisions ?? 0,
      compoundFulfilled: r.compoundFulfilled ?? 0,
      orderFolded: r.orderFolded ?? 0,
      retriesTotal: r.retriesTotal ?? 0,
      fallbacks: r.fallbacks ?? 0,
      compactions: r.compactions ?? 0,
      compactionsSuppressed: r.compactionsSuppressed ?? 0,
      costUsd: costOf(model, r.usage, r.reportedCostUsd),
    },
  ];
}

export async function promote(
  repoRoot: string,
  runPath: string,
  partial: boolean
): Promise<string> {
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
      `incomplete artifact set for ${art.gameId} (missing ${missing
        .map(([, n]) => n)
        .join(", ")}) — pass --partial to promote anyway`
    );
  }
  await mkdir(dest, { recursive: true });
  for (const [src, name] of [...required, ...optional]) {
    if (existsSync(src)) await copyFile(src, join(dest, name));
  }
  // The promoted game's full narrative rides with it in the repo
  // (review amendment 2) — regenerated here so it always matches the
  // promoted data.
  const destRecord = join(dest, "record.json");
  if (existsSync(destRecord)) {
    const destJsonl = join(dest, "decisions.jsonl");
    await writeFormatted(destRecord, existsSync(destJsonl) ? destJsonl : null);
  }
  return dest;
}

export interface CorpusGame {
  id: string;
  record: GameRecordLite | null; // null = partial promotion (jsonl only)
  era: number;
  seats: SeatEntry[];
  costUsd: number | null; // all seats
}

export async function loadCorpus(repoRoot: string): Promise<CorpusGame[]> {
  const gamesDir = join(repoRoot, "harness", "data", "games");
  if (!existsSync(gamesDir)) return [];
  const out: CorpusGame[] = [];
  for (const id of (await readdir(gamesDir)).sort()) {
    const recPath = join(gamesDir, id, "record.json");
    if (!existsSync(recPath)) {
      out.push({ id, record: null, era: -1, seats: [], costUsd: null });
      continue;
    }
    const r = JSON.parse(await readFile(recPath, "utf-8")) as GameRecordLite;
    const seats = seatEntries(r);
    const costs = seats.map((s) => s.costUsd);
    const cost = costs.every((c) => c === null)
      ? null
      : costs.reduce<number>((a, c) => a + (c ?? 0), 0);
    out.push({ id, record: r, era: eraOf(r), seats, costUsd: cost });
  }
  return out;
}

const fmt = {
  usd: (v: number | null): string => (v === null ? "—" : `$${v.toFixed(2)}`),
  n: (v: number | null | undefined): string => (v === null || v === undefined ? "—" : String(v)),
};

/** "runner: haiku" / "corp: x · runner: y" — who the model(s) played. */
export function seatsLabel(g: CorpusGame): string {
  return g.seats.map((s) => `${s.seat}: ${s.model}`).join(" · ");
}

function gameRow(g: CorpusGame): string {
  const r = g.record!;
  const outcome =
    r.status === "completed"
      ? `${r.winner} — ${r.reason} (${r.corpAgendaPoints}:${r.runnerAgendaPoints} AP, ${r.turns?.corp ?? "?"}t)`
      : r.status ?? "?";
  const incidents: string[] = [];
  if (r.retriesTotal) incidents.push(`${r.retriesTotal} retries`);
  if (r.httpRetries) incidents.push(`${r.httpRetries} http-retries`);
  if (r.fallbacks) incidents.push(`${r.fallbacks} FALLBACKS`);
  if (r.invalidRecords) incidents.push(`${r.invalidRecords} INVALID`);
  if (r.previewDivergences) incidents.push(`${r.previewDivergences} preview-div`);
  if (r.compactionsSuppressed) incidents.push(`${r.compactionsSuppressed} compact-suppressed`);
  if (r.largeFusedMenus) incidents.push(`${r.largeFusedMenus} large-menus`);
  const api = g.seats.map((s) => `${s.llmDecisions}/${s.forcedDecisions}/${s.compoundFulfilled}/${s.orderFolded}`).join(" · ");
  const compactions = g.seats.map((s) => String(s.compactions)).join(" · ");
  return [
    `\`${g.id}\``,
    seatsLabel(g),
    fmt.n(r.seed),
    `${r.corpPrecon ?? "?"} vs ${r.runnerPrecon ?? "?"}`,
    `${r.actions ?? "—"}/${r.contextMode ?? "—"}`,
    outcome,
    api,
    compactions,
    incidents.length ? incidents.join(", ") : "clean",
    fmt.usd(g.costUsd),
  ].join(" | ");
}

const TABLE_HEADER =
  "| game | seats (model) | seed | matchup (corp vs runner) | config | outcome | api/forced/fulfilled/folded | compactions | incidents | est. $ |\n" +
  "|---|---|---|---|---|---|---|---|---|---|";

function coverageHoles(games: CorpusGame[]): string[] {
  const cur = games.filter((g) => g.era === CURRENT_ERA && g.record);
  const holes: string[] = [];
  if (cur.length === 0) {
    return [
      "- **the current era has no games yet** — every game below predates D14 " +
        "(rules-AI branch neutralization) and is not comparable; the next run " +
        "starts the era-4 corpus",
    ];
  }
  const seeds = new Set(cur.map((g) => g.record!.seed));
  if (seeds.size === 1)
    holes.push(`- **single seed**: every current-era game is seed ${[...seeds][0]} — no across-seed evidence yet`);
  const bySeatModel = new Map<string, number>();
  cur.forEach((g) =>
    g.seats.forEach((s) => {
      const k = `${s.seat}:${s.model}`;
      bySeatModel.set(k, (bySeatModel.get(k) ?? 0) + 1);
    })
  );
  const lowN = [...bySeatModel.entries()].filter(([, n]) => n < 3);
  if (lowN.length)
    holes.push(
      `- **within-seed variance unmeasurable**: n < 3 for ${lowN.map(([m, n]) => `${m} (n=${n})`).join(", ")}`
    );
  if (!cur.some((g) => g.seats.some((s) => s.seat === "corp")))
    holes.push("- **no model has played the Corp seat** in the current era");
  if (!cur.some((g) => g.seats.length === 2))
    holes.push("- **no model-vs-model game** in the current era");
  for (const arm of ["split"]) {
    if (!cur.some((g) => g.record!.actions === arm))
      holes.push(`- **no \`--actions ${arm}\` arm** in the current era`);
  }
  if (!cur.some((g) => g.record!.contextMode === "stateless"))
    holes.push("- **no stateless-context arm** in the current era");
  if (!cur.some((g) => g.record!.historyVariant === "lean"))
    holes.push("- **no lean-history arm** in the current era");
  const neverCompacted = [...new Set(cur.flatMap((g) => g.seats.map((s) => s.model)))].filter(
    (m) => !cur.some((g) => g.seats.some((s) => s.model === m && s.compactions > 0))
  );
  if (neverCompacted.length)
    holes.push(
      `- **live compaction never exercised** for: ${neverCompacted.join(", ")} (no long-horizon game)`
    );
  const decks = new Set(cur.map((g) => `${g.record!.corpPrecon} vs ${g.record!.runnerPrecon}`));
  if (decks.size === 1) holes.push(`- **single matchup**: ${[...decks][0]}`);
  if (!cur.some((g) => (g.record!.cardSets ?? []).length > 0))
    holes.push("- **base card pool only** (System Gateway + SU21) — no Elevation/Core-set matchup");
  const noDebrief = cur.filter((g) => g.record!.debrief === false);
  if (noDebrief.length) holes.push(`- debrief disabled on: ${noDebrief.map((g) => g.id).join(", ")}`);
  if (!cur.some((g) => g.seats.some((s) => s.model.startsWith("openrouter/"))))
    holes.push("- **no non-Anthropic model has played** (D13)");
  return holes;
}

export interface Aggregate {
  seat: SeatName;
  model: string;
  n: number;
  completed: number;
  wins: number;
  flatlines: number; // games ending in a Runner flatline
  meanTurns: number;
  meanApi: number;
  meanCost: number | null;
}

/** Per (seat, model) aggregates over a set of games. */
export function aggregates(games: CorpusGame[]): Aggregate[] {
  const by = new Map<string, { seat: SeatName; model: string; rows: { g: CorpusGame; s: SeatEntry }[] }>();
  for (const g of games) {
    for (const s of g.seats) {
      const k = `${s.seat}\u0000${s.model}`;
      const e = by.get(k) ?? { seat: s.seat, model: s.model, rows: [] };
      e.rows.push({ g, s });
      by.set(k, e);
    }
  }
  return [...by.values()]
    .sort((a, b) => a.seat.localeCompare(b.seat) || a.model.localeCompare(b.model))
    .map(({ seat, model, rows }) => {
      const done = rows.filter(({ g }) => g.record!.status === "completed");
      const mean = (f: (x: { g: CorpusGame; s: SeatEntry }) => number): number =>
        done.reduce((t, x) => t + f(x), 0) / Math.max(1, done.length);
      const costs = rows.map(({ s }) => s.costUsd).filter((c): c is number => c !== null);
      return {
        seat,
        model,
        n: rows.length,
        completed: done.length,
        wins: done.filter(({ g }) => g.record!.winner === seat).length,
        flatlines: done.filter(({ g }) => /flatlin/i.test(g.record!.reason ?? "")).length,
        meanTurns: mean(({ g }) => g.record!.turns?.corp ?? 0),
        meanApi: mean(({ s }) => s.llmDecisions),
        meanCost: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null,
      };
    });
}

export async function writeReport(repoRoot: string): Promise<string> {
  const games = await loadCorpus(repoRoot);
  const lines: string[] = [];
  lines.push("# CORPUS — cumulative results");
  lines.push("");
  lines.push(
    "_Generated by `corpus --report` from `data/games/`. Games are comparable " +
      "only within an interface era; the era is derived from record fields, " +
      "never hand-tagged. Every row and aggregate is per seat a model played " +
      "(Runner, Corp, or both). Costs: provider-reported when present, else " +
      "estimated from `src/prices.ts` (— = no basis to estimate)._"
  );

  // §1 current era
  const cur = games.filter((g) => g.era === CURRENT_ERA && g.record);
  lines.push("", `## Current era — ${ERA_LABEL[CURRENT_ERA]}`, "");
  if (cur.length) {
    lines.push(TABLE_HEADER);
    cur.forEach((g) => lines.push("| " + gameRow(g) + " |"));
  } else {
    lines.push("_(no games yet)_");
  }

  // §2 per-(seat, model) aggregates (current era)
  lines.push("", "## Per-seat aggregates (current era; n is small — read n, not trends)", "");
  if (cur.length) {
    lines.push("| seat | model | n | wins | runner flatlines | mean corp turns | mean API dec. | mean $ |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const a of aggregates(cur)) {
      lines.push(
        `| ${a.seat} | ${a.model} | ${a.n} | ${a.wins}/${a.completed} | ${a.flatlines}/${a.completed} | ` +
          `${a.meanTurns.toFixed(1)} | ${a.meanApi.toFixed(0)} | ${fmt.usd(a.meanCost)} |`
      );
    }
  } else {
    lines.push("_(no games yet)_");
  }

  // §3 prior eras
  for (const era of [3, 2, 1, 0]) {
    const gs = games.filter((g) => g.era === era && g.record);
    if (!gs.length) continue;
    lines.push("", `## ${ERA_LABEL[era]} — NOT comparable to the current era`, "");
    lines.push(TABLE_HEADER);
    gs.forEach((g) => lines.push("| " + gameRow(g) + " |"));
    if (era === 3) {
      lines.push("", "Per-seat aggregates (era 3):", "");
      lines.push("| seat | model | n | wins | runner flatlines | mean corp turns | mean API dec. | mean $ |");
      lines.push("|---|---|---|---|---|---|---|---|");
      for (const a of aggregates(gs)) {
        lines.push(
          `| ${a.seat} | ${a.model} | ${a.n} | ${a.wins}/${a.completed} | ${a.flatlines}/${a.completed} | ` +
            `${a.meanTurns.toFixed(1)} | ${a.meanApi.toFixed(0)} | ${fmt.usd(a.meanCost)} |`
        );
      }
    }
  }
  const partials = games.filter((g) => !g.record);
  if (partials.length) {
    lines.push("", "## Partial promotions (no game record — interrupted runs kept for evidence)", "");
    partials.forEach((g) => lines.push(`- \`${g.id}\``));
  }

  // §4 machinery rollup
  lines.push("", "## Machinery health rollup", "");
  const dirty = games.filter(
    (g) =>
      g.record &&
      ((g.record.fallbacks ?? 0) > 0 ||
        (g.record.invalidRecords ?? 0) > 0 ||
        (g.record.previewDivergences ?? 0) > 0 ||
        (g.record.compactionsSuppressed ?? 0) > 0)
  );
  if (dirty.length) {
    dirty.forEach((g) =>
      lines.push(
        `- \`${g.id}\`: ` +
          [
            (g.record!.fallbacks ?? 0) > 0 ? `${g.record!.fallbacks} fallbacks` : null,
            (g.record!.invalidRecords ?? 0) > 0 ? `${g.record!.invalidRecords} invalid records` : null,
            (g.record!.previewDivergences ?? 0) > 0
              ? `${g.record!.previewDivergences} preview divergences`
              : null,
            (g.record!.compactionsSuppressed ?? 0) > 0
              ? `${g.record!.compactionsSuppressed} suppressed compactions (threshold below floor)`
              : null,
          ]
            .filter(Boolean)
            .join(", ")
      )
    );
  } else {
    lines.push("_(no hard incidents anywhere in the corpus — retries are per-game in the tables)_");
  }

  // §5 coverage holes
  lines.push("", "## Coverage holes — where the next run should go", "");
  coverageHoles(games).forEach((h) => lines.push(h));

  // §6 compaction summaries
  lines.push("", "## Compaction summaries (the models' own strategy memos)", "");
  for (const g of games) {
    if (!g.record || (g.record.compactions ?? 0) === 0) continue;
    const jsonlPath = join(repoRoot, "harness", "data", "games", g.id, "decisions.jsonl");
    if (!existsSync(jsonlPath)) continue;
    const rows = (await readFile(jsonlPath, "utf-8"))
      .split("\n")
      .filter((l) => l.includes('"record_type":"compaction"') || l.includes('"record_type": "compaction"'));
    if (!rows.length) continue;
    lines.push(`### \`${g.id}\``, "");
    for (const row of rows) {
      const c = JSON.parse(row) as { compaction_id: number; summary: string; seat?: string };
      const who = g.seats.length > 1 ? ` (${c.seat ?? "runner"})` : "";
      lines.push(`**Compaction #${c.compaction_id}${who}**`, "", "> " + c.summary.replace(/\n/g, "\n> "), "");
    }
  }

  const reportPath = join(repoRoot, "harness", "data", "CORPUS.md");
  await mkdir(join(repoRoot, "harness", "data"), { recursive: true });
  await writeFile(reportPath, lines.join("\n") + "\n");
  return reportPath;
}
