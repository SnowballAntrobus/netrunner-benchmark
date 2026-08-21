/** The corpus (D06-1 rev 2): durable game data in harness/data/games/
 *  (one nested folder per run, tracked in git) plus the progressive
 *  report data/CORPUS.md.
 *
 *  Promotion is explicit — `corpus --promote <run>` copies a game's
 *  artifact set into the corpus (normalizing legacy flat layouts into
 *  the nested shape) and regenerates the report. Nothing enters the
 *  corpus as a side effect of running a game.
 */
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveGameArtifacts } from "./paths.js";
import { estimateCostUsd } from "./prices.js";
import { writeFormatted } from "./format.js";

interface GameRecordLite {
  status?: string;
  winner?: string | null;
  reason?: string | null;
  corpAgendaPoints?: number | null;
  runnerAgendaPoints?: number | null;
  decisions?: number;
  turns?: { corp: number; runner: number } | null;
  durationMs?: number;
  model?: string;
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
  fallbacks?: number;
  invalidRecords?: number;
  compactions?: number;
  compactionsSuppressed?: number;
  transcriptTokensMax?: number;
  previewChecks?: number;
  previewDivergences?: number;
  usage?: { tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number };
  reportedCostUsd?: number | null; // D13: provider-billed (OpenRouter)
}

/** Interface era, derived from record fields — never hand-tagged.
 *  0 = pre-D01 (stateless, degraded schema)  1 = D01–D07 split
 *  2 = D09-1 compound                         3 = D09-2 (current) */
export function eraOf(r: GameRecordLite): number {
  if (r.orderFolded !== undefined) return 3;
  if (r.actions !== undefined) return 2;
  if (r.contextMode !== undefined) return 1;
  return 0;
}

const ERA_LABEL: Record<number, string> = {
  0: "era 0 — pre-D01 stateless (schema-degraded; archived)",
  1: "era 1 — conversational, split actions (D01–D07)",
  2: "era 2 — compound (D09-1)",
  3: "era 3 — deeper fusion (D09-2, CURRENT)",
};

const CURRENT_ERA = 3;

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
    [art.systemPrompt, "system-prompt.txt"],
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

interface CorpusGame {
  id: string;
  record: GameRecordLite | null; // null = partial promotion (jsonl only)
  era: number;
  costUsd: number | null;
}

async function loadCorpus(repoRoot: string): Promise<CorpusGame[]> {
  const gamesDir = join(repoRoot, "harness", "data", "games");
  if (!existsSync(gamesDir)) return [];
  const out: CorpusGame[] = [];
  for (const id of (await readdir(gamesDir)).sort()) {
    const recPath = join(gamesDir, id, "record.json");
    if (!existsSync(recPath)) {
      out.push({ id, record: null, era: -1, costUsd: null });
      continue;
    }
    const r = JSON.parse(await readFile(recPath, "utf-8")) as GameRecordLite;
    const cost =
      r.reportedCostUsd ??
      (r.model && r.usage ? estimateCostUsd(r.model, r.usage) : null);
    out.push({ id, record: r, era: eraOf(r), costUsd: cost });
  }
  return out;
}

const fmt = {
  usd: (v: number | null): string => (v === null ? "—" : `$${v.toFixed(2)}`),
  n: (v: number | null | undefined): string => (v === null || v === undefined ? "—" : String(v)),
};

function gameRow(g: CorpusGame): string {
  const r = g.record!;
  const outcome =
    r.status === "completed"
      ? `${r.winner} — ${r.reason} (${r.corpAgendaPoints}:${r.runnerAgendaPoints} AP, ${r.turns?.corp ?? "?"}t)`
      : r.status ?? "?";
  const incidents: string[] = [];
  if (r.retriesTotal) incidents.push(`${r.retriesTotal} retries`);
  if (r.fallbacks) incidents.push(`${r.fallbacks} FALLBACKS`);
  if (r.invalidRecords) incidents.push(`${r.invalidRecords} INVALID`);
  if (r.previewDivergences) incidents.push(`${r.previewDivergences} preview-div`);
  if (r.compactionsSuppressed) incidents.push(`${r.compactionsSuppressed} compact-suppressed`);
  if (r.largeFusedMenus) incidents.push(`${r.largeFusedMenus} large-menus`);
  return [
    `\`${g.id}\``,
    r.model ?? "?",
    fmt.n(r.seed),
    `${r.actions ?? "—"}/${r.contextMode ?? "—"}`,
    outcome,
    `${fmt.n(r.llmDecisions)}/${fmt.n(r.forcedDecisions)}/${fmt.n(r.compoundFulfilled)}/${fmt.n(r.orderFolded)}`,
    fmt.n(r.compactions),
    incidents.length ? incidents.join(", ") : "clean",
    fmt.usd(g.costUsd),
  ].join(" | ");
}

const TABLE_HEADER =
  "| game | model | seed | config | outcome | api/forced/fulfilled/folded | compactions | incidents | est. $ |\n" +
  "|---|---|---|---|---|---|---|---|---|";

function coverageHoles(games: CorpusGame[]): string[] {
  const era3 = games.filter((g) => g.era === CURRENT_ERA && g.record);
  const holes: string[] = [];
  if (era3.length === 0) return ["- the current era has no games at all"];
  const seeds = new Set(era3.map((g) => g.record!.seed));
  if (seeds.size === 1)
    holes.push(`- **single seed**: every current-era game is seed ${[...seeds][0]} — no across-seed evidence yet`);
  const models = new Map<string, number>();
  era3.forEach((g) => models.set(g.record!.model ?? "?", (models.get(g.record!.model ?? "?") ?? 0) + 1));
  const lowN = [...models.entries()].filter(([, n]) => n < 3);
  if (lowN.length)
    holes.push(
      `- **within-seed variance unmeasurable**: n < 3 for ${lowN.map(([m, n]) => `${m} (n=${n})`).join(", ")}`
    );
  for (const arm of ["split"]) {
    if (!era3.some((g) => g.record!.actions === arm))
      holes.push(`- **no \`--actions ${arm}\` arm** in the current era`);
  }
  if (!era3.some((g) => g.record!.contextMode === "stateless"))
    holes.push("- **no stateless-context arm** in the current era");
  if (!era3.some((g) => g.record!.historyVariant === "lean"))
    holes.push("- **no lean-history arm** in the current era");
  const neverCompacted = [...models.keys()].filter(
    (m) => !era3.some((g) => g.record!.model === m && (g.record!.compactions ?? 0) > 0)
  );
  if (neverCompacted.length)
    holes.push(
      `- **live compaction never exercised** for: ${neverCompacted.join(", ")} (no long-horizon game)`
    );
  const decks = new Set(era3.map((g) => `${g.record!.corpPrecon} vs ${g.record!.runnerPrecon}`));
  if (decks.size === 1) holes.push(`- **single matchup**: ${[...decks][0]}`);
  const noDebrief = era3.filter((g) => g.record!.debrief === false);
  if (noDebrief.length) holes.push(`- debrief disabled on: ${noDebrief.map((g) => g.id).join(", ")}`);
  if (!era3.some((g) => (g.record!.model ?? "").startsWith("openrouter/")))
    holes.push("- **no non-Anthropic model has played** (D13)");
  return holes;
}

export async function writeReport(repoRoot: string): Promise<string> {
  const games = await loadCorpus(repoRoot);
  const lines: string[] = [];
  lines.push("# CORPUS — cumulative results");
  lines.push("");
  lines.push(
    "_Generated by `corpus --report` from `data/games/`. Games are comparable " +
      "only within an interface era; the era is derived from record fields, " +
      "never hand-tagged. Costs: provider-reported when present, else " +
      "estimated from `src/prices.ts` (— = no basis to estimate)._"
  );

  // §1 current era
  const era3 = games.filter((g) => g.era === CURRENT_ERA && g.record);
  lines.push("", `## Current era — ${ERA_LABEL[CURRENT_ERA]}`, "");
  if (era3.length) {
    lines.push(TABLE_HEADER);
    era3.forEach((g) => lines.push("| " + gameRow(g) + " |"));
  } else {
    lines.push("_(no games yet)_");
  }

  // §2 per-model aggregates (current era)
  lines.push("", "## Per-model aggregates (current era; n is small — read n, not trends)", "");
  const byModel = new Map<string, CorpusGame[]>();
  era3.forEach((g) => {
    const m = g.record!.model ?? "?";
    byModel.set(m, [...(byModel.get(m) ?? []), g]);
  });
  lines.push("| model | n | runner wins | flatlines | mean turns | mean API dec. | mean $ |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const [m, gs] of [...byModel.entries()].sort()) {
    const done = gs.filter((g) => g.record!.status === "completed");
    const wins = done.filter((g) => g.record!.winner === "runner").length;
    const flat = done.filter((g) => /flatlin/i.test(g.record!.reason ?? "")).length;
    const meanTurns =
      done.reduce((s, g) => s + (g.record!.turns?.corp ?? 0), 0) / Math.max(1, done.length);
    const meanApi =
      done.reduce((s, g) => s + (g.record!.llmDecisions ?? 0), 0) / Math.max(1, done.length);
    const costs = gs.map((g) => g.costUsd).filter((c): c is number => c !== null);
    const meanCost = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null;
    lines.push(
      `| ${m} | ${gs.length} | ${wins}/${done.length} | ${flat}/${done.length} | ` +
        `${meanTurns.toFixed(1)} | ${meanApi.toFixed(0)} | ${fmt.usd(meanCost)} |`
    );
  }

  // §3 prior eras
  for (const era of [2, 1, 0]) {
    const gs = games.filter((g) => g.era === era && g.record);
    if (!gs.length) continue;
    lines.push("", `## ${ERA_LABEL[era]} — NOT comparable to the current era`, "");
    lines.push(TABLE_HEADER);
    gs.forEach((g) => lines.push("| " + gameRow(g) + " |"));
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
      const c = JSON.parse(row) as { compaction_id: number; summary: string };
      lines.push(`**Compaction #${c.compaction_id}**`, "", "> " + c.summary.replace(/\n/g, "\n> "), "");
    }
  }

  const reportPath = join(repoRoot, "harness", "data", "CORPUS.md");
  await mkdir(join(repoRoot, "harness", "data"), { recursive: true });
  await writeFile(reportPath, lines.join("\n") + "\n");
  return reportPath;
}
