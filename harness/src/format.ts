/** Game-log formatter (review artifact).
 *
 *  Merges a game record's log (public narration + SPOILER ground truth +
 *  the corp rules-AI's "AI:" reasoning lines) with the JSONL decision
 *  stream (the LLM's choices and reasoning) into a readable markdown
 *  narrative, one section per turn.
 *
 *  One artifact per game: full.md — every decision with its full menu.
 *
 *  Runner decisions are anchored into the narration via each record's
 *  state.log tail (its last public line located in the full log); corp
 *  reasoning needs no anchoring — the AI: lines already sit at the right
 *  positions in the log stream.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolveGameArtifacts } from "./paths.js";

interface DecisionRow {
  record_type?: string; // absent (legacy records) or "decision" | "compaction"
  seq: number;
  log_index?: number | null; // exact anchor (absent in legacy records)
  turn?: { side?: string; number?: number } | null;
  seat: string;
  decision_type: string;
  phase: unknown;
  options: Record<string, unknown>[];
  choice: number;
  reasoning: string | null;
  retries: number | null;
  fallback: boolean | null;
  latency_ms: number | null;
  transcript_tokens?: number | null;
  preview_divergence?: { command: string; previewed_at_seq: number; preview: unknown[] } | null;
  forced?: boolean; // auto-resolved single-option decision (no API call)
  compound?: boolean; // options were the fused menu
  compound_fulfilled?: boolean; // select auto-answered from the fused choice
  order_folded?: boolean; // access-order fold (guarded auto-resolve)
  state: {
    log?: string[];
    runner?: { credits?: number; grip?: unknown[]; clicks?: number; agendaPoints?: number };
    corp?: { agendaPoints?: number };
  } | null;
}

interface CompactionRow {
  record_type: "compaction";
  seat?: string; // absent = runner
  compaction_id: number;
  seq_before: number;
  log_index?: number | null;
  transcript_tokens_before: number | null;
  dropped_turns: number;
  kept_turns: number;
  summary: string;
}

function phaseName(p: unknown): string {
  if (p && typeof p === "object") {
    const obj = p as { identifier?: string; title?: string };
    return obj.identifier ?? obj.title ?? "?";
  }
  return String(p ?? "?");
}

function optionLabel(o: unknown): string {
  if (!o || typeof o !== "object") return String(o);
  const d = o as Record<string, unknown>;
  const card = (d["card"] && typeof d["card"] === "object" ? d["card"] : {}) as Record<string, unknown>;
  const bits: string[] = [];
  const primary =
    (d["command"] as string) ??
    (d["label"] as string) ??
    (d["button"] as string) ??
    (card["title"] as string) ??
    (card["hidden"] ? "(hidden card)" : undefined) ??
    (d["text"] as string);
  bits.push(primary ?? `option ${d["index"]}`);
  // Fused entries pair a verb with its subject (command + label/card) —
  // show the subject so "run Archives" and "run HQ" read distinctly.
  if (d["command"] && d["label"] && primary === d["command"]) {
    bits.push(String(d["label"]));
  } else if (d["command"] && card["title"] && primary === d["command"]) {
    bits.push(String(card["title"]));
  }
  if (d["server"] && !d["label"]) bits.push(`→ ${d["server"]}`);
  if (d["description"] && primary !== d["description"]) bits.push(`— ${d["description"]}`);
  // Command options can carry a preview of the follow-up menu — render
  // it compactly so the review shows what the model saw at the verb step.
  if (Array.isArray(d["choices"])) {
    bits.push(`→ (${(d["choices"] as unknown[]).map(optionLabel).join(", ")})`);
  }
  return bits.join(" ");
}

const LINE_DECOR: [RegExp, string][] = [
  [/^Run initiated/, "⚡ "],
  [/^Run successful/, "✅ "],
  [/^Run ends|^Run unsuccessful/, "🛑 "],
  [/stolen$/, "🏆 "],
  [/scored$/, "🏆 "],
  [/takes \d+ (net|meat|core) damage|damage$/, "💥 "],
  [/flatlined/, "☠️ "],
  [/rezzed/, "🔌 "],
];

function decorate(line: string): string {
  for (const [re, emoji] of LINE_DECOR) {
    if (re.test(line)) return emoji + line;
  }
  return line;
}

const PRIVATE_PREFIX = /^\s*(SPOILER:|AI:|RC:|ERROR:|DEBUG:|AI would have chosen:|\[)/;

export async function formatGame(
  gamePath: string,
  jsonlPath: string | null
): Promise<{ full: string }> {
  const game = JSON.parse(await readFile(gamePath, "utf-8")) as Record<string, unknown> & {
    log: string[];
  };
  if (!Array.isArray(game.log)) {
    throw new Error(
      `${gamePath} is not a game record (no log[]) — pass the out/<game>.json ` +
        `written by llm-game, not a debrief/JSONL/system-prompt sibling`
    );
  }
  let decisions: DecisionRow[] = [];
  let compactionRows: CompactionRow[] = [];
  if (jsonlPath) {
    try {
      const rows = (await readFile(jsonlPath, "utf-8"))
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as DecisionRow | CompactionRow);
      decisions = rows.filter(
        (r): r is DecisionRow => r.record_type === undefined || r.record_type === "decision"
      );
      compactionRows = rows.filter(
        (r): r is CompactionRow => r.record_type === "compaction"
      );
    } catch {
      /* no decision log — narration-only formatting */
    }
  }
  const log = game.log.map((l) => String(l).replace(/\n+$/, "").trim());

  // LLM-seat decisions anchor into the narration (either seat, or both);
  // rules-AI seats speak through their own "AI:" lines instead.
  const llmSeatMode = (game["llmSeat"] as string | undefined) ?? "runner";
  const llmSeats = new Set(llmSeatMode === "both" ? ["corp", "runner"] : [llmSeatMode]);

  // ---- anchor runner decisions into the log ------------------------------
  // Each runner record's state.log tail is the last ~30 PUBLIC lines at
  // decision time. Match its suffix against the public-filtered projection
  // of the full log (matching in the raw log fails: SPOILER/AI blocks sit
  // between consecutive public lines, so nearly every decision would miss).
  const isPublicLine = (l: string): boolean =>
    l !== "" &&
    !/^\s*(SPOILER:|AI:|RC:|ERROR:|DEBUG:|AI would have chosen:|\[)/.test(l) &&
    !/PixiJS/.test(l);
  const pub: { rawIdx: number; text: string }[] = [];
  log.forEach((l, i) => {
    if (isPublicLine(l)) pub.push({ rawIdx: i, text: l });
  });

  // Turn boundaries with ordinals (corp N = 2N, runner N = 2N+1) so the
  // skip below can tell which side of a boundary a decision belongs on:
  // corp-turn-end decisions share their log tail with runner-turn-begin
  // decisions, and only the record's own turn field separates them.
  const boundaryAt = new Map<number, number>();
  {
    const counts: Record<string, number> = { corp: 0, runner: 0 };
    log.forEach((l, i) => {
      const m = l.match(/^SPOILER: At start of (Corp|Runner) turn:/);
      if (m) {
        const bSide = m[1] === "Corp" ? "corp" : "runner";
        counts[bSide] = (counts[bSide] ?? 0) + 1;
        boundaryAt.set(i, counts[bSide]! * 2 + (bSide === "runner" ? 1 : 0));
      }
    });
  }
  const ordinalOf = (t: DecisionRow["turn"]): number => {
    if (!t || typeof t.number !== "number") return -1;
    return t.number * 2 + (t.side === "runner" ? 1 : 0);
  };

  // Scoreboard turn headers: each turn boundary's header shows the turn
  // number and the agenda points from a state-bearing LLM-seat record
  // before the NEXT boundary. Legacy games (no log_index) get no score.
  const headerInfo = new Map<number, { number: number | null; ap: string | null }>();
  {
    const withIdx = decisions
      .filter((d) => llmSeats.has(d.seat) && typeof d.log_index === "number" && d.state)
      .sort((a, b) => (a.log_index as number) - (b.log_index as number));
    const bounds = [...boundaryAt.keys()].sort((a, b) => a - b);
    for (let i = 0; i < bounds.length; i++) {
      const from = bounds[i]!;
      const to = bounds[i + 1] ?? Infinity;
      const ord = boundaryAt.get(from)!;
      // Turn number comes from the boundary ordinal itself (exact by
      // construction). Records supply only the AP scoreboard — prefer one
      // fully inside the new turn (a record captured AT the boundary index
      // predates the SPOILER line and still carries the outgoing turn).
      const inWindow = withIdx.filter(
        (d) => (d.log_index as number) >= from && (d.log_index as number) < to
      );
      const r = inWindow.find((d) => ordinalOf(d.turn) === ord) ?? inWindow[0];
      const corpAP = r?.state?.corp?.agendaPoints;
      const runnerAP = r?.state?.runner?.agendaPoints;
      headerInfo.set(from, {
        number: Math.floor(ord / 2),
        ap:
          typeof corpAP === "number" && typeof runnerAP === "number"
            ? `${corpAP}–${runnerAP}`
            : null,
      });
    }
  }

  // Compactions carry the exact log_index of the decision that triggered
  // them; render them just before that decision.
  const compactionAt = new Map<number, CompactionRow[]>();
  for (const c of compactionRows) {
    const at = Math.min(typeof c.log_index === "number" ? c.log_index : 0, log.length);
    const bucket = compactionAt.get(at) ?? [];
    bucket.push(c);
    compactionAt.set(at, bucket);
  }

  const runnerDecisions = decisions.filter((d) => llmSeats.has(d.seat));
  const anchors = new Map<number, DecisionRow[]>(); // raw log index → decisions
  let pubPtr = 0; // monotonic pointer into pub[]
  let lastAnchor = 0;
  const WINDOW = 400; // public lines of forward search
  for (const d of runnerDecisions) {
    // Exact anchor recorded at capture time: no guessing.
    if (typeof d.log_index === "number") {
      const at = Math.min(Math.max(d.log_index, lastAnchor === 0 ? 0 : 0), log.length);
      lastAnchor = Math.max(lastAnchor, at);
      const bucket = anchors.get(at) ?? [];
      bucket.push(d);
      anchors.set(at, bucket);
      continue;
    }
    const tail = (d.state?.log ?? [])
      .filter((l) => !l.startsWith("===") && l.trim() !== "")
      .map((l) => l.trim());
    const k = Math.min(tail.length, 4);
    let at = lastAnchor;
    if (k > 0) {
      const suffix = tail.slice(tail.length - k);
      const limit = Math.min(pub.length - k, pubPtr + WINDOW);
      for (let p = pubPtr; p <= limit; p++) {
        let ok = true;
        for (let q = 0; q < k; q++) {
          if (pub[p + q]!.text !== suffix[q]) { ok = false; break; }
        }
        if (!ok) continue;
        at = pub[p + k - 1]!.rawIdx + 1;
        // Skip past SPOILER/junk lines logged before this decision — but a
        // turn-boundary line is only "before" the decision if the decision's
        // own recorded turn is at or past that boundary (corp-turn-end
        // decisions must stay in the corp section). And STOP at AI:/RC:
        // lines: the opponent's next deliberation follows this decision.
        const dOrd = ordinalOf(d.turn);
        while (at < log.length) {
          const lineAt = log[at] ?? "";
          const bOrd = boundaryAt.get(at);
          if (bOrd !== undefined) {
            if (dOrd >= bOrd) { at++; continue; }
            break;
          }
          if (/^\s*(SPOILER:|\[)|PixiJS|^\s*$/.test(lineAt)) { at++; continue; }
          break;
        }
        pubPtr = p; // identical tails (chained decisions) re-match here
        break;
      }
    }
    lastAnchor = Math.max(lastAnchor, at);
    const bucket = anchors.get(at) ?? [];
    bucket.push(d);
    anchors.set(at, bucket);
  }

  // ---- render ------------------------------------------------------------
  const turns = game["turns"] as { corp: number; runner: number } | null;
  const usage = game["usage"] as Record<string, number> | undefined;
  const seatModels = (game["seats"] ?? {}) as Record<
    string,
    { model?: string; driver?: string; client?: { name: string; version: string } | null }
  >;
  const who = (seat: string): string => {
    if (!llmSeats.has(seat)) return "rules AI";
    const s = seatModels[seat];
    const model = s?.model ?? (game["model"] as string | undefined) ?? "model";
    return s?.driver === "mcp" ? `${model}, over MCP${s.client ? ` from ${s.client.name}` : ""}` : model;
  };
  const mcpGame = Object.values(seatModels).some((s) => s.driver === "mcp");
  const header = [
    `# ${game["model"] ?? "faceoff"} — seed ${game["seed"]}: ${game["corpPrecon"]} (Corp: ${who("corp")}) vs ${game["runnerPrecon"]} (Runner: ${who("runner")})`,
    "",
    `**Result:** ${game["winner"]} wins — ${game["reason"]} · ` +
      `**Score:** ${game["corpAgendaPoints"]}:${game["runnerAgendaPoints"]} (Corp:Runner AP) · ` +
      `**Turns:** ${turns ? `${turns.corp}c/${turns.runner}r` : "?"} · ` +
      `**Duration:** ${((game["durationMs"] as number) / 60000).toFixed(1)} min`,
    "",
    game["model"]
      ? `**Config:** profile=${game["promptProfile"]}, reasoning=${game["reasoningStyle"]}, rules=${game["rulesSource"]}` +
        (game["contextMode"]
          ? `, context=${game["contextMode"]}` +
            (game["historyVariant"] ? `/${game["historyVariant"]}` : "")
          : "") +
        (game["decisionView"] === "compact" ? ", view=compact" : "") +
        ` · **LLM decisions:** ${game["llmDecisions"]} (${game["retriesTotal"]} retries, ${game["fallbacks"]} fallbacks)` +
        (usage && !mcpGame
          ? ` · **Tokens:** ${usage["tokensIn"]} in / ${usage["tokensOut"]} out / ${usage["cacheRead"]} cached`
          : "") +
        (typeof game["compactions"] === "number"
          ? ` · **Compactions:** ${game["compactions"]} (transcript max ${game["transcriptTokensMax"] ?? "?"} tokens)`
          : "") +
        (typeof game["previewDivergences"] === "number" && (game["previewDivergences"] as number) > 0
          ? ` · ⚠️ **Preview divergences:** ${game["previewDivergences"]}`
          : "")
      : "",
    "",
    "Legend: 🏢 Corp turn · 🏃 Runner turn · 🤖 rules-AI thinking · 💭 model reasoning · " +
      "🗜️ context compaction · ⚡ run · ✅ run successful · 🛑 run ends · 🏆 agenda · 💥 damage · ☠️ flatline · 🔌 rez",
    "",
    "---",
  ].join("\n");

  // Two-model games tag each decision with its seat.
  const seatTag = (d: DecisionRow): string => (llmSeats.size > 1 ? ` _${d.seat}_` : "");
  const renderDecision = (d: DecisionRow): string[] => {
    const forced = d.options.length === 1;
    const chosen = optionLabel(d.options[d.choice]);
    const meta: string[] = [];
    if (d.retries) meta.push(`${d.retries} retries`);
    if (d.fallback) meta.push("FALLBACK");
    if (d.forced) meta.push("auto-resolved");
    if (d.compound_fulfilled) meta.push("compound-fulfilled");
    if (d.order_folded) meta.push("order-folded");
    if (d.latency_ms) meta.push(`${(d.latency_ms / 1000).toFixed(1)}s`);
    const metaStr = meta.length ? ` _( ${meta.join(", ")} )_` : "";
    const lines: string[] = [];
    // A preview is not a promise: divergences are surfaced loudly so they
    // can be pulled and analyzed.
    if (d.preview_divergence) {
      lines.push(
        `> ⚠️ **Preview divergence** — this menu differs from the \`${d.preview_divergence.command}\` ` +
          `preview shown at decision #${d.preview_divergence.previewed_at_seq} ` +
          `(previewed: [${d.preview_divergence.preview.map(optionLabel).join(" | ")}])`
      );
    }
    // Reasoning FIRST, then the choice — mirroring both the temporal
    // truth (the model writes reasoning before choosing) and the corp's
    // thought→action presentation.
    if (d.reasoning) {
      lines.push(`> 💭 **#${d.seq}**${seatTag(d)} _${phaseName(d.phase)}:_ ${d.reasoning.replace(/\n+/g, " ")}`);
    }
    lines.push(
      `> ↳ chose **${chosen}**` +
        (forced ? " _(only option)_" : ` of [${d.options.map(optionLabel).join(" | ")}]`) +
        metaStr
    );
    lines.push("");
    return lines;
  };

  const render = (): string => {
    const out: string[] = [header, ""];
    for (let i = 0; i <= log.length; i++) {
      // Compactions render before the decision that triggered them: the
      // summary is the model's entire memory of the compacted past,
      // central to any review.
      const compactionsHere = compactionAt.get(i);
      if (compactionsHere) {
        for (const c of compactionsHere) {
          out.push(
            `> 🗜️ **Compaction #${c.compaction_id}**${llmSeats.size > 1 ? ` _${c.seat ?? "runner"}_` : ""} _(before decision #${c.seq_before}: ` +
              `~${c.transcript_tokens_before ?? "?"} tokens → summary + last ${c.kept_turns} ` +
              `exchanges verbatim; ${c.dropped_turns} exchanges compacted)_`,
            `> 📝 ${c.summary.replace(/\n+/g, " ")}`,
            ""
          );
        }
      }
      const here = anchors.get(i);
      if (here) for (const d of here) out.push(...renderDecision(d));
      if (i === log.length) break;
      const line = log[i]!;
      if (line === "") continue;
      let m: RegExpMatchArray | null;
      if ((m = line.match(/^SPOILER: At start of (Corp|Runner) turn:/))) {
        const who = m[1]!;
        const info = headerInfo.get(i);
        out.push(
          "",
          `## ${who === "Corp" ? "🏢" : "🏃"} ${who} turn` +
            (info?.number != null ? ` ${info.number}` : "") +
            (info?.ap ? ` · AP ${info.ap}` : ""),
          ""
        );
        continue;
      }
      if ((m = line.match(/^SPOILER: (Corp|Runner) has (.+)$/))) {
        out.push(`_${m[1]}: ${m[2]!.replace(/\[.*\]/, (h) => `hand ${h}`)}_`);
        continue;
      }
      if (line.startsWith("AI:")) {
        out.push(`> 🤖 ${line.slice(3).trim()}`);
        continue;
      }
      if (PRIVATE_PREFIX.test(line)) continue; // decklists, RC, banners
      if (/PixiJS/.test(line)) continue;
      out.push(decorate(line));
    }
    return out.join("\n") + "\n";
  };

  return { full: render() };
}

// Debrief artifact(s) rendered at the end of the narrative, read from the
// run folder's debrief.json. Two-model games carry one debrief per seat
// ({seats: [...]}).
async function debriefSection(gamePath: string): Promise<string> {
  try {
    interface DebriefEntry {
      seat?: string;
      model?: string;
      instrument_version: number;
      text: string;
    }
    const raw = JSON.parse(
      await readFile(resolveGameArtifacts(gamePath).debrief, "utf-8")
    ) as DebriefEntry & { seats?: DebriefEntry[] };
    const entries: DebriefEntry[] = raw.seats ?? [raw];
    const out: string[] = ["", "---", ""];
    for (const d of entries) {
      const whose = entries.length > 1 ? ` — ${d.seat ?? "runner"}${d.model ? ` (${d.model})` : ""}` : "";
      out.push(
        `## 🎤 Debrief${whose} _(instrument v${d.instrument_version}; the model's own words, from its final transcript — a self-report, not ground truth)_`,
        "",
        d.text,
        ""
      );
    }
    return out.join("\n");
  } catch {
    return ""; // no debrief artifact — nothing to append
  }
}

export async function writeFormatted(gamePath: string, jsonlPath: string | null): Promise<string[]> {
  const { full } = await formatGame(gamePath, jsonlPath);
  const out = resolveGameArtifacts(gamePath).fullMd;
  const debrief = await debriefSection(gamePath);
  await writeFile(out, full + debrief);
  return [out];
}
