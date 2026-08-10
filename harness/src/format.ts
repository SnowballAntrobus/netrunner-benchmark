/** Game-log formatter (review artifact).
 *
 *  Merges a game record's log (public narration + SPOILER ground truth +
 *  the corp rules-AI's "AI:" reasoning lines) with the JSONL decision
 *  stream (the LLM's choices and reasoning) into a readable markdown
 *  narrative, one section per turn.
 *
 *  Two artifacts per game:
 *    <id>.report.md — abbreviated: forced single-option decisions
 *                     collapsed into counters; the review copy.
 *    <id>.full.md   — every decision with its full option menu.
 *
 *  Runner decisions are anchored into the narration via each record's
 *  state.log tail (its last public line located in the full log); corp
 *  reasoning needs no anchoring — the AI: lines already sit at the right
 *  positions in the log stream.
 */
import { readFile, writeFile } from "node:fs/promises";

interface DecisionRow {
  record_type?: string; // absent (game 1) or "decision" | "compaction"
  seq: number;
  log_index?: number | null; // exact anchor (recorded from game 2 onward)
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
  forced?: boolean; // D03: auto-resolved single-option decision (no API call)
  state: { log?: string[]; runner?: { credits?: number; grip?: unknown[]; clicks?: number } } | null;
}

interface CompactionRow {
  record_type: "compaction";
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
  if (d["server"] && !d["label"]) bits.push(`→ ${d["server"]}`);
  if (d["description"] && primary !== d["description"]) bits.push(`— ${d["description"]}`);
  // D05: command options carry a preview of the follow-up menu — render
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

// Forced (single-option) decisions still carry model reasoning. Most is
// boilerplate ("only one legal option, proceeding"), but run-phase thinking
// is often the most valuable content in the game. Collapse only reasoning
// that is recognizably boilerplate.
const BOILERPLATE =
  /only (one )?(legal )?option|single (legal )?option|must (select|choose|proceed)|proceed (with|to) the (turn|next|game)|no (other )?choice|I'?ll select it/i;

function isBoilerplate(reasoning: string | null): boolean {
  if (!reasoning || reasoning.trim() === "") return true;
  return BOILERPLATE.test(reasoning) && reasoning.length < 260;
}

export async function formatGame(
  gamePath: string,
  jsonlPath: string | null
): Promise<{ report: string; full: string }> {
  const game = JSON.parse(await readFile(gamePath, "utf-8")) as Record<string, unknown> & {
    log: string[];
  };
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

  // ---- anchor runner decisions into the log ------------------------------
  // Each runner record's state.log tail is the last ~30 PUBLIC lines at
  // decision time. Match its suffix against the public-filtered projection
  // of the full log (matching in the raw log fails: SPOILER/AI blocks sit
  // between consecutive public lines — v1 fell back on 95% of decisions).
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

  // Compactions carry the exact log_index of the decision that triggered
  // them; render them just before that decision.
  const compactionAt = new Map<number, CompactionRow[]>();
  for (const c of compactionRows) {
    const at = Math.min(typeof c.log_index === "number" ? c.log_index : 0, log.length);
    const bucket = compactionAt.get(at) ?? [];
    bucket.push(c);
    compactionAt.set(at, bucket);
  }

  const runnerDecisions = decisions.filter((d) => d.seat === "runner");
  const anchors = new Map<number, DecisionRow[]>(); // raw log index → decisions
  let pubPtr = 0; // monotonic pointer into pub[]
  let lastAnchor = 0;
  const WINDOW = 400; // public lines of forward search
  for (const d of runnerDecisions) {
    // Exact anchor recorded at capture time (games after #1): no guessing.
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
  const header = [
    `# ${game["model"] ?? "faceoff"} — seed ${game["seed"]}: ${game["corpPrecon"]} (Corp) vs ${game["runnerPrecon"]} (Runner)`,
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
        ` · **LLM decisions:** ${game["llmDecisions"]} (${game["retriesTotal"]} retries, ${game["fallbacks"]} fallbacks)` +
        (usage
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
    "Legend: 🏢 Corp turn · 🏃 Runner turn · 🤖 Corp rules-AI thinking · 💭 LLM reasoning · " +
      "🗜️ context compaction · ⚡ run · ✅ run successful · 🛑 run ends · 🏆 agenda · 💥 damage · ☠️ flatline · 🔌 rez",
    "",
    "---",
  ].join("\n");

  const renderDecision = (d: DecisionRow, full: boolean): string[] => {
    const forced = d.options.length === 1;
    const chosen = optionLabel(d.options[d.choice]);
    const meta: string[] = [];
    if (d.retries) meta.push(`${d.retries} retries`);
    if (d.fallback) meta.push("FALLBACK");
    if (full && d.forced) meta.push("auto-resolved");
    if (full && d.latency_ms) meta.push(`${(d.latency_ms / 1000).toFixed(1)}s`);
    const metaStr = meta.length ? ` _( ${meta.join(", ")} )_` : "";
    const lines: string[] = [];
    // D05 "preview, not promise" cases — surfaced loudly in BOTH views so
    // divergences can be pulled and analyzed.
    if (d.preview_divergence) {
      lines.push(
        `> ⚠️ **Preview divergence** — this menu differs from the \`${d.preview_divergence.command}\` ` +
          `preview shown at decision #${d.preview_divergence.previewed_at_seq} ` +
          `(previewed: [${d.preview_divergence.preview.map(optionLabel).join(" | ")}])`
      );
    }
    if (forced && !full) {
      // Abbreviated view: substantive reasoning on a forced step surfaces
      // as a compact thought line; boilerplate was collapsed by the caller.
      lines.push(`> 💭 **#${d.seq}** _${phaseName(d.phase)}:_ ${(d.reasoning ?? "").replace(/\n+/g, " ")}`, "");
      return lines;
    }
    // Reasoning FIRST, then the choice — mirroring both the temporal
    // truth (the model writes reasoning before choosing) and the corp's
    // thought→action presentation.
    if (d.reasoning && (!forced || full)) {
      lines.push(`> 💭 **#${d.seq}** _${phaseName(d.phase)}:_ ${d.reasoning.replace(/\n+/g, " ")}`);
    }
    lines.push(
      `> ↳ chose **${chosen}**` +
        (forced ? " _(only option)_" : ` of [${d.options.map(optionLabel).join(" | ")}]`) +
        metaStr
    );
    lines.push("");
    return lines;
  };

  const render = (full: boolean): string => {
    const out: string[] = [header, ""];
    let forcedRun = 0;
    const flushForced = (): void => {
      if (forcedRun > 0 && !full) {
        out.push(`> _· ${forcedRun} forced (single-option) decision${forcedRun > 1 ? "s" : ""} ·_`, "");
        forcedRun = 0;
      }
    };
    for (let i = 0; i <= log.length; i++) {
      // Compactions render before the decision that triggered them — in
      // BOTH views: the summary is the model's entire memory of the
      // compacted past, central to any review.
      const compactionsHere = compactionAt.get(i);
      if (compactionsHere) {
        for (const c of compactionsHere) {
          flushForced();
          out.push(
            `> 🗜️ **Compaction #${c.compaction_id}** _(before decision #${c.seq_before}: ` +
              `~${c.transcript_tokens_before ?? "?"} tokens → summary + last ${c.kept_turns} ` +
              `exchanges verbatim; ${c.dropped_turns} exchanges compacted)_`,
            `> 📝 ${c.summary.replace(/\n+/g, " ")}`,
            ""
          );
        }
      }
      const here = anchors.get(i);
      if (here) {
        for (const d of here) {
          // Never collapse a divergent select — those are exactly the
          // records the review wants to see.
          if (
            d.options.length === 1 && !full && isBoilerplate(d.reasoning) &&
            !d.preview_divergence
          ) {
            forcedRun++;
            continue;
          }
          flushForced();
          out.push(...renderDecision(d, full));
        }
      }
      if (i === log.length) break;
      const line = log[i]!;
      if (line === "") continue;
      let m: RegExpMatchArray | null;
      if ((m = line.match(/^SPOILER: At start of (Corp|Runner) turn:/))) {
        flushForced();
        const who = m[1]!;
        out.push("", `## ${who === "Corp" ? "🏢" : "🏃"} ${who} turn`, "");
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
      flushForced();
      out.push(decorate(line));
    }
    flushForced();
    return out.join("\n") + "\n";
  };

  return { report: render(false), full: render(true) };
}

// D07: debrief artifact rendered at the end of both views. Read from the
// sibling <stem>-debrief.json when present.
async function debriefSection(gamePath: string): Promise<string> {
  try {
    const stem = gamePath.replace(/\.json$/, "");
    const d = JSON.parse(await readFile(`${stem}-debrief.json`, "utf-8")) as {
      instrument_version: number;
      text: string;
    };
    return [
      "",
      "---",
      "",
      `## 🎤 Debrief _(instrument v${d.instrument_version}; the model's own words, from its final transcript — a self-report, not ground truth)_`,
      "",
      d.text,
      "",
    ].join("\n");
  } catch {
    return ""; // no debrief artifact — nothing to append
  }
}

export async function writeFormatted(gamePath: string, jsonlPath: string | null): Promise<string[]> {
  const { report, full } = await formatGame(gamePath, jsonlPath);
  const stem = gamePath.replace(/\.json$/, "");
  const debrief = await debriefSection(gamePath);
  await writeFile(`${stem}.report.md`, report + debrief);
  await writeFile(`${stem}.full.md`, full + debrief);
  return [`${stem}.report.md`, `${stem}.full.md`];
}
