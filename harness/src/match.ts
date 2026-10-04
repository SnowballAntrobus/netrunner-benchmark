/** Match runner (D06 §1, D12): one configuration, many games.
 *
 *  `run-match` plays N sequential `runLLMGame`s on seeds S..S+N-1 (or an
 *  explicit seed list), each optionally repeated K times on the SAME seed,
 *  into out/match-<label>/. A game that crashes is a row, not an abort —
 *  the results table is where "zero crashes" is checked. Per-game
 *  artifacts are the ordinary run folders; the match adds match.json and
 *  match-summary.md.
 *
 *  Two variance questions (D12): across seeds (the game dealt) and within
 *  a seed (nothing changed but sampling — the engine is deterministic
 *  under the seed, the model is not). The headline win rate therefore
 *  carries a standard error CLUSTERED BY SEED (Miller, "Adding Error Bars
 *  to Evals", arXiv 2411.00640): reruns of one seed are not independent
 *  samples. For seeds played more than once, the first-divergence
 *  decision — the first record where two runs' choices differ, found by
 *  diffing their decision streams — says WHERE stochasticity enters.
 *
 *  Mock games are deterministic per seed, so a mock rerun salts the
 *  mock's own choice stream (never the engine seed) to stand in for
 *  sampling — that keeps the within-seed path exercised keylessly.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { MockClient } from "./llm.js";
import { runLLMGame, type LLMGameOptions, type LLMGameRecord, type LiveEvent } from "./llmgame.js";
import { estimateCostUsd } from "./prices.js";
import type { Seat } from "./prompts.js";

const SEAT_NAME: Record<Seat, string> = { corp: "Corp", runner: "Runner" };

export interface MatchSeat {
  seat: Seat;
  model: string;
  llmDecisions: number;
  forcedDecisions: number;
  retriesTotal: number;
  fallbacks: number;
  compactions: number;
  transcriptTokensMax: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  /** Provider-reported (OpenRouter) or price-table estimate; null when
   *  unknown (mock, unpriced model) — never guessed. */
  costUsd: number | null;
}

export interface MatchGame {
  index: number; // 1-based, play order
  seed: number;
  run: number; // 1-based run of this seed
  gameId: string | null;
  runDir: string | null; // relative to the match folder
  /** Record status, or "crashed" when the harness itself threw. */
  status: string;
  error: string | null;
  winner: string | null;
  reason: string | null;
  corpAP: number | null;
  runnerAP: number | null;
  turns: { corp: number; runner: number } | null;
  minutes: number;
  invalidRecords: number | null;
  previewDivergences: number | null;
  seats: MatchSeat[];
  /** Mock reruns only: the salt added to the mock's choice stream. */
  mockSalt?: number;
}

export interface WinRate {
  seat: Seat;
  model: string;
  wins: number;
  n: number; // completed games
  seeds: number; // clusters
  rate: number | null;
  se: number | null; // clustered by seed
}

export interface Divergence {
  seed: number;
  a: string; // game ids
  b: string;
  /** "choice": same menu, different pick (sampling). "menu": the menus
   *  themselves differ with every earlier choice equal — harness or
   *  engine nondeterminism, a bug. "none": identical decision streams. */
  kind: "choice" | "menu" | "length" | "none";
  shared: number; // identical decisions before the divergence
  seq?: number;
  turn?: string;
  seat?: string;
  /** The diverging decision was answered by a model (not forced/folded). */
  byModel?: boolean;
  choiceA?: string;
  choiceB?: string;
}

export interface MatchResult {
  label: string;
  /** The match folder, relative to harness/ (where the CLI runs). */
  dir: string;
  startedAt: string;
  finishedAt: string;
  config: Record<string, unknown>;
  seeds: number[];
  repeat: number;
  games: MatchGame[];
  winRates: WinRate[];
  divergences: Divergence[];
}

export interface MatchOptions {
  repoRoot: string;
  label: string;
  matchDir: string;
  seeds: number[];
  repeat: number;
  /** Every runLLMGame knob except the per-game ones. */
  game: Omit<LLMGameOptions, "seed" | "outDir" | "onEvent" | "clientFactory">;
  /** Live viewer sink: the meta event carries `match`, the end event
   *  `more` (another game follows), so one viewer tab follows the match. */
  onEvent?: (event: LiveEvent) => void;
  /** After each game (promotion hook, progress line). */
  onGame?: (game: MatchGame) => Promise<void> | void;
}

// ---------------------------------------------------------------- stats

/** Mean and cluster-robust standard error of a per-game score, clusters
 *  = seeds: SE = sqrt(Σ_c (Σ_{i∈c} (x_i − x̄))²) / n. With one game per
 *  seed this is the ordinary (1/n-variance) standard error. */
export function clusteredMean(xs: { cluster: number; x: number }[]): { mean: number; se: number } | null {
  const n = xs.length;
  if (n === 0) return null;
  const mean = xs.reduce((a, b) => a + b.x, 0) / n;
  const byCluster = new Map<number, number>();
  for (const { cluster, x } of xs) byCluster.set(cluster, (byCluster.get(cluster) ?? 0) + (x - mean));
  let ss = 0;
  for (const s of byCluster.values()) ss += s * s;
  return { mean, se: Math.sqrt(ss) / n };
}

export function winRates(games: MatchGame[]): WinRate[] {
  const keys = new Map<string, { seat: Seat; model: string }>();
  for (const g of games) for (const s of g.seats) keys.set(`${s.seat}\0${s.model}`, { seat: s.seat, model: s.model });
  return [...keys.values()].map(({ seat, model }) => {
    const played = games.filter(
      (g) => g.status === "completed" && g.seats.some((s) => s.seat === seat && s.model === model)
    );
    const xs = played.map((g) => ({ cluster: g.seed, x: g.winner === seat ? 1 : 0 }));
    const m = clusteredMean(xs);
    return {
      seat,
      model,
      wins: xs.filter((p) => p.x === 1).length,
      n: xs.length,
      seeds: new Set(played.map((g) => g.seed)).size,
      rate: m?.mean ?? null,
      se: m?.se ?? null,
    };
  });
}

// ------------------------------------------------------- first divergence

interface Row {
  record_type?: string;
  seq: number;
  turn: { side: string; number: number } | null;
  seat: string;
  decision_type: string;
  options: unknown[];
  choice: number;
  model: string | null;
  forced?: boolean;
  compound_fulfilled?: boolean;
  order_folded?: boolean;
}

type Labeler = (o: unknown) => string;

async function readDecisions(path: string): Promise<Row[]> {
  if (!existsSync(path)) return [];
  return (await readFile(path, "utf-8"))
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Row)
    .filter((r) => (r.record_type ?? "decision") === "decision");
}

/** First decision where two same-seed runs part ways. Compaction records
 *  are skipped (their timing follows token counts, not the game). */
export function firstDivergence(
  a: Row[],
  b: Row[],
  label: Labeler
): Omit<Divergence, "seed" | "a" | "b"> {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    const where = {
      shared: i,
      seq: x.seq,
      turn: x.turn ? `${SEAT_NAME[x.turn.side as Seat] ?? x.turn.side} turn ${x.turn.number}` : "setup",
      seat: x.seat,
    };
    if (
      x.seat !== y.seat ||
      x.decision_type !== y.decision_type ||
      JSON.stringify(x.options) !== JSON.stringify(y.options)
    ) {
      return { kind: "menu", ...where };
    }
    if (x.choice !== y.choice) {
      return {
        kind: "choice",
        ...where,
        byModel: !!x.model && !x.forced && !x.compound_fulfilled && !x.order_folded,
        choiceA: label(x.options[x.choice]),
        choiceB: label(y.options[y.choice]),
      };
    }
  }
  if (a.length !== b.length) return { kind: "length", shared: n };
  return { kind: "none", shared: n };
}

// ------------------------------------------------------------- the match

function seatRows(record: LLMGameRecord): MatchSeat[] {
  return (["corp", "runner"] as Seat[])
    .filter((s) => record.seats[s])
    .map((s) => {
      const st = record.seats[s]!;
      return {
        seat: s,
        model: st.model,
        llmDecisions: st.llmDecisions,
        forcedDecisions: st.forcedDecisions,
        retriesTotal: st.retriesTotal,
        fallbacks: st.fallbacks,
        compactions: st.compactions,
        transcriptTokensMax: st.transcriptTokensMax,
        tokensIn: st.usage.tokensIn,
        tokensOut: st.usage.tokensOut,
        cacheRead: st.usage.cacheRead,
        cacheWrite: st.usage.cacheWrite,
        costUsd: st.reportedCostUsd ?? estimateCostUsd(st.model, st.usage),
      };
    });
}

function plannedSeats(game: MatchOptions["game"]): MatchSeat[] {
  const mode = game.seat ?? "runner";
  const seats: Seat[] = mode === "both" ? ["corp", "runner"] : [mode];
  return seats.map((seat) => ({
    seat,
    model: (seat === "corp" ? game.corpModel : game.runnerModel) ?? game.model,
    llmDecisions: 0,
    forcedDecisions: 0,
    retriesTotal: 0,
    fallbacks: 0,
    compactions: 0,
    transcriptTokensMax: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: null,
  }));
}

export async function runMatch(options: MatchOptions): Promise<MatchResult> {
  const { repoRoot, matchDir, seeds, repeat, game } = options;
  await mkdir(matchDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const plan = seeds.flatMap((seed) => Array.from({ length: repeat }, (_, r) => ({ seed, run: r + 1 })));
  const games: MatchGame[] = [];
  const config = {
    seat: game.seat ?? "runner",
    model: game.model,
    corpModel: game.corpModel ?? null,
    runnerModel: game.runnerModel ?? null,
    corpPrecon: game.corpPrecon,
    runnerPrecon: game.runnerPrecon,
    rulesSource: game.rulesSource,
    profile: game.profile,
    reasoningStyle: game.reasoningStyle,
    contextMode: game.contextMode ?? "conversational",
    historyVariant: game.historyVariant ?? "full",
    compactionThresholds: game.compactionThresholds ?? null,
    compactionKeepTurns: game.compactionKeepTurns ?? null,
    autoResolve: game.autoResolve ?? true,
    debrief: game.debrief ?? true,
    actions: game.actions ?? "compound",
    aiBranches: game.aiBranches ?? "neutral",
  };

  for (const [i, { seed, run }] of plan.entries()) {
    const index = i + 1;
    const t0 = Date.now();
    // Mock reruns: salt the mock's choice stream so same-seed runs differ
    // the way sampled models do. Real models need nothing — they vary.
    const mockSalt = run > 1 ? (run - 1) * 1_000_003 : 0;
    const salted =
      mockSalt > 0
        ? (seat: Seat, model: string) =>
            model === "mock"
              ? new MockClient(seed + mockSalt + (game.seat === "both" && seat === "corp" ? 1000 : 0))
              : undefined
        : undefined;
    const row: MatchGame = {
      index,
      seed,
      run,
      gameId: null,
      runDir: null,
      status: "crashed",
      error: null,
      winner: null,
      reason: null,
      corpAP: null,
      runnerAP: null,
      turns: null,
      minutes: 0,
      invalidRecords: null,
      previewDivergences: null,
      seats: plannedSeats(game),
      ...(mockSalt > 0 && plannedSeats(game).some((s) => s.model === "mock") ? { mockSalt } : {}),
    };
    try {
      const record = await runLLMGame({
        ...game,
        repoRoot,
        seed,
        outDir: matchDir,
        // Non-mock seats get undefined → runLLMGame's default client.
        ...(salted ? { clientFactory: salted } : {}),
        ...(options.onEvent
          ? {
              onEvent: (event: LiveEvent) => {
                if (event.type === "meta") {
                  options.onEvent!({
                    type: "meta",
                    meta: { ...event.meta, match: { label: options.label, index, of: plan.length } },
                  });
                } else if (event.type === "end") {
                  options.onEvent!({ ...event, more: index < plan.length });
                } else {
                  options.onEvent!(event);
                }
              },
            }
          : {}),
      });
      const runDir = dirname(record.decisionLogPath);
      Object.assign(row, {
        gameId: basename(runDir),
        runDir: relative(matchDir, runDir),
        status: record.status,
        winner: record.winner,
        reason: record.reason,
        corpAP: record.corpAgendaPoints,
        runnerAP: record.runnerAgendaPoints,
        turns: record.turns,
        invalidRecords: record.invalidRecords,
        previewDivergences: record.previewDivergences,
        seats: seatRows(record),
      });
    } catch (err) {
      row.error = String(err instanceof Error ? err.message : err).slice(0, 300);
    }
    row.minutes = (Date.now() - t0) / 60_000;
    games.push(row);
    await options.onGame?.(row);
    // Rewritten after every game: an interrupted match keeps its rows.
    await writeFile(join(matchDir, "match.json"), JSON.stringify({ label: options.label, startedAt, config, games }, null, 1));
  }

  // Within-seed: every pair of completed-or-not runs that left a decision
  // stream, per seed played more than once.
  const { optionLabel } = (await import(
    pathToFileURL(join(repoRoot, "site", "viewer", "model.mjs")).href
  )) as { optionLabel: Labeler };
  const label: Labeler = (o) => {
    const d = o && typeof o === "object" ? (o as { description?: unknown }).description : undefined;
    const base = optionLabel(o);
    return typeof d === "string" && d !== base ? `${base} (${d.length > 60 ? d.slice(0, 57) + "…" : d})` : base;
  };
  const divergences: Divergence[] = [];
  for (const seed of seeds) {
    const runs = games.filter((g) => g.seed === seed && g.runDir);
    for (let x = 0; x < runs.length; x++) {
      for (let y = x + 1; y < runs.length; y++) {
        const a = runs[x]!;
        const b = runs[y]!;
        const [ra, rb] = await Promise.all([
          readDecisions(join(matchDir, a.runDir!, "decisions.jsonl")),
          readDecisions(join(matchDir, b.runDir!, "decisions.jsonl")),
        ]);
        divergences.push({ seed, a: a.gameId!, b: b.gameId!, ...firstDivergence(ra, rb, label) });
      }
    }
  }

  const result: MatchResult = {
    label: options.label,
    dir: relative(join(repoRoot, "harness"), matchDir),
    startedAt,
    finishedAt: new Date().toISOString(),
    config,
    seeds,
    repeat,
    games,
    winRates: winRates(games),
    divergences,
  };
  await writeFile(join(matchDir, "match.json"), JSON.stringify(result, null, 1));
  await writeFile(join(matchDir, "match-summary.md"), summaryMarkdown(result));
  return result;
}

// --------------------------------------------------------------- report

const fmtInt = (n: number): string => n.toLocaleString("en-US");
const kTok = (n: number): string => (n >= 10_000 ? `${Math.round(n / 1000)}K` : fmtInt(n));
const usd = (v: number | null): string => (v === null ? "—" : `$${v.toFixed(2)}`);
const pct = (v: number): string => `${Math.round(v * 100)}%`;

function seatCell(g: MatchGame, f: (s: MatchSeat) => string): string {
  return g.seats.map(f).join(" / ");
}

function costOf(g: MatchGame): number | null {
  const known = g.seats.map((s) => s.costUsd);
  return known.every((c) => c === null) ? null : known.reduce<number>((a, c) => a + (c ?? 0), 0);
}

export function summaryMarkdown(m: MatchResult): string {
  const c = m.config;
  const both = c["seat"] === "both";
  const out: string[] = [];
  const seatsLine = (m.games[0]?.seats ?? [])
    .map((s) => `${SEAT_NAME[s.seat]}: ${s.model}`)
    .join(" · ");
  out.push(`# Match ${m.label}`, "");
  out.push(
    `${m.startedAt.slice(0, 16).replace("T", " ")} UTC · ${seatsLine} · ` +
      `${c["corpPrecon"]} vs ${c["runnerPrecon"]} · seeds ${m.seeds.join(", ")}` +
      (m.repeat > 1 ? ` × ${m.repeat} runs each` : "")
  );
  out.push("");
  out.push(
    `Config: rules=${c["rulesSource"]} profile=${c["profile"]}/${c["reasoningStyle"]} ` +
      `context=${c["contextMode"]}/${c["historyVariant"]} actions=${c["actions"]} ` +
      `autoResolve=${c["autoResolve"] ? "on" : "off"} debrief=${c["debrief"] ? "on" : "off"} ` +
      `aiBranches=${c["aiBranches"]}`
  );
  out.push("");

  out.push("## Games", "");
  if (both) out.push("Per-seat columns read Corp / Runner.", "");
  out.push(
    "| # | seed | run | status | winner | reason | AP c:r | turns c/r | API dec. | forced | retries/fb | tokens in/out/cache-read | est. $ | compactions | max ctx | prev. div. | min |"
  );
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const g of m.games) {
    const winner = g.winner
      ? `${SEAT_NAME[g.winner as Seat] ?? g.winner}${!both && g.seats[0]?.seat === g.winner ? " (model)" : ""}`
      : "—";
    out.push(
      `| ${g.index} | ${g.seed} | ${g.run} | ${g.status}${g.error ? ` — ${g.error.replace(/\|/g, "\\|").slice(0, 80)}` : ""} | ${winner} | ` +
        `${g.reason ?? "—"} | ${g.corpAP ?? "—"}:${g.runnerAP ?? "—"} | ` +
        `${g.turns ? `${g.turns.corp}/${g.turns.runner}` : "—"} | ` +
        `${seatCell(g, (s) => String(s.llmDecisions))} | ${seatCell(g, (s) => String(s.forcedDecisions))} | ` +
        `${seatCell(g, (s) => `${s.retriesTotal}/${s.fallbacks}`)} | ` +
        `${seatCell(g, (s) => `${kTok(s.tokensIn)}/${kTok(s.tokensOut)}/${kTok(s.cacheRead)}`)} | ` +
        `${usd(costOf(g))} | ${seatCell(g, (s) => String(s.compactions))} | ` +
        `${seatCell(g, (s) => kTok(s.transcriptTokensMax))} | ${g.previewDivergences ?? "—"} | ${g.minutes.toFixed(1)} |`
    );
  }
  out.push("");

  out.push("## Aggregates", "");
  const completed = m.games.filter((g) => g.status === "completed");
  const statusCounts = new Map<string, number>();
  for (const g of m.games) statusCounts.set(g.status, (statusCounts.get(g.status) ?? 0) + 1);
  out.push(
    `- **Completed**: ${completed.length}/${m.games.length}` +
      (completed.length < m.games.length
        ? ` (${[...statusCounts].filter(([s]) => s !== "completed").map(([s, n]) => `${s} ×${n}`).join(", ")})`
        : " — zero crashes")
  );
  for (const w of m.winRates) {
    out.push(
      `- **Win rate, ${SEAT_NAME[w.seat]} · ${w.model}**: ` +
        (w.rate === null
          ? "no completed games"
          : `${w.wins}/${w.n} = ${pct(w.rate)} ± ${pct(w.se ?? 0)} (standard error clustered by seed; ` +
            `${w.n} completed game${w.n === 1 ? "" : "s"} over ${w.seeds} seed${w.seeds === 1 ? "" : "s"})`)
    );
  }
  const reasons = new Map<string, number>();
  for (const g of completed) {
    const k = `${SEAT_NAME[g.winner as Seat] ?? g.winner}: ${g.reason ?? "?"}`;
    reasons.set(k, (reasons.get(k) ?? 0) + 1);
  }
  if (reasons.size) {
    out.push(`- **How games ended**: ${[...reasons].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join("; ")}`);
  }
  if (completed.length) {
    const mean = (f: (g: MatchGame) => number): string =>
      (completed.reduce((a, g) => a + f(g), 0) / completed.length).toFixed(1);
    out.push(
      `- **Per completed game (mean)**: ${mean((g) => (g.turns?.corp ?? 0))} Corp turns · ` +
        (m.games[0]?.seats ?? [])
          .map((s0) => `${mean((g) => g.seats.find((s) => s.seat === s0.seat)?.llmDecisions ?? 0)} API decisions (${SEAT_NAME[s0.seat]})`)
          .join(" · ") +
        ` · ${mean((g) => g.minutes)} min`
    );
  }
  const costs = m.games.map(costOf).filter((v): v is number => v !== null);
  const sum = (f: (s: MatchSeat) => number): number =>
    m.games.reduce((a, g) => a + g.seats.reduce((b, s) => b + f(s), 0), 0);
  out.push(
    `- **Totals**: ${costs.length ? `${usd(costs.reduce((a, b) => a + b, 0))} (${usd(costs.reduce((a, b) => a + b, 0) / costs.length)}/game)` : "cost unknown (unpriced model)"} · ` +
      `tokens in ${fmtInt(sum((s) => s.tokensIn))} / out ${fmtInt(sum((s) => s.tokensOut))} / cache-read ${fmtInt(sum((s) => s.cacheRead))} · ` +
      `retries ${sum((s) => s.retriesTotal)} · fallbacks ${sum((s) => s.fallbacks)} · compactions ${sum((s) => s.compactions)} · ` +
      `preview divergences ${m.games.reduce((a, g) => a + (g.previewDivergences ?? 0), 0)} · ` +
      `invalid records ${m.games.reduce((a, g) => a + (g.invalidRecords ?? 0), 0)} · ` +
      `${m.games.reduce((a, g) => a + g.minutes, 0).toFixed(1)} min`
  );
  out.push("");

  if (m.divergences.length) {
    out.push("## Within-seed reruns", "");
    out.push(
      "Same seed, same configuration: the engine deals identically, so the decision streams match " +
        "until a choice differs. The first divergence marks where sampling first changed the game."
    );
    if (m.games.some((g) => g.mockSalt)) {
      out.push("", "_Mock reruns salt the mock's choice stream to stand in for sampling._");
    }
    out.push("");
    for (const seed of m.seeds) {
      const runs = m.games.filter((g) => g.seed === seed);
      if (runs.length < 2) continue;
      out.push(
        `**Seed ${seed}** — ${runs.length} runs: ` +
          runs
            .map((g) => (g.status !== "completed" ? g.status : g.winner ? `${SEAT_NAME[g.winner as Seat]} won (${g.reason})` : "no winner"))
            .join("; ")
      );
      out.push("");
      for (const d of m.divergences.filter((x) => x.seed === seed)) {
        const ra = runs.find((g) => g.gameId === d.a)!.run;
        const rb = runs.find((g) => g.gameId === d.b)!.run;
        const head = `- run ${ra} vs run ${rb}: `;
        if (d.kind === "none") out.push(`${head}identical decision streams (${d.shared} decisions).`);
        else if (d.kind === "length")
          out.push(`${head}identical for ${d.shared} decisions, then one stream ends — no differing choice.`);
        else if (d.kind === "menu")
          out.push(
            `${head}**menus differ at seq ${d.seq}** (${d.turn}, ${d.seat}) with every earlier choice equal — ` +
              "harness or engine nondeterminism; investigate."
          );
        else
          out.push(
            `${head}first divergence at seq ${d.seq} (${d.turn}, ${SEAT_NAME[d.seat as Seat] ?? d.seat}` +
              `${d.byModel ? ", model decision" : ""}) after ${d.shared} identical decisions: ` +
              `"${d.choiceA}" vs "${d.choiceB}".`
          );
      }
      out.push("");
    }
  }

  const promotable = m.games.filter((g) => g.status === "completed" && g.runDir);
  if (promotable.length) {
    out.push("## Promote to the corpus", "");
    out.push("Completed games are offered, not auto-promoted (`run-match --promote-all` promotes as they finish):", "");
    out.push("```sh");
    out.push(
      `npx tsx src/cli.ts corpus ${promotable.map((g) => `--promote ${m.dir}/${g.runDir}`).join(" \\\n    ")}`
    );
    out.push("```", "");
  }
  return out.join("\n");
}
