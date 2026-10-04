/** Conservation auditor — tier one of the rules-conformance "judge":
 *  deterministic, no LLM, no credits spent.
 *
 *  The engine logs omniscient ground truth at every turn boundary (the
 *  SPOILER lines: both players' credits, hand sizes, tags). This auditor
 *  replays a game's log, maintaining independent credit and click ledgers
 *  from the narrated events, and reconciles them against every snapshot.
 *  A mismatch means either an engine rules bug or a narration gap — both
 *  worth knowing before real games are trusted.
 *
 *  Credit-event semantics (verified against mechanics.js):
 *    "X gained N credit(s)"            → pool +N
 *    "X gained N credit(s) from Y"     → TEMPORARY credits (not pool)
 *    "X spent N credit(s)"             → pool -N
 *    "X spent N temporary credit(s)"   → not pool
 *    "X lost N credit(s)"              → pool -N
 *    "N credit(s) taken from <card>"   → pool +N for the card's SIDE
 *    "N credit(s) placed on/loaded onto <card>" → bank↔card, not pool
 *    "X used N credit(s) from <card>"  → card counters, not pool
 *
 *  Click-event semantics: "X receives N allotted clicks" opens a turn
 *  ledger; spent/gained/lost lines must balance it by the next allotment.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadCardData } from "./carddata.js";

export interface AuditIssue {
  line: number;
  kind: string;
  detail: string;
}

/** One step of the credit ledger, for the review-sample packet.
 *  Emitted by an optional observer — detection never depends on it. */
export interface AuditTraceEvent {
  line: number;
  who: "corp" | "runner";
  /** "set": setup/resync value; "delta": pool change; "checkpoint": the
   *  engine's stated value next to the ledger's own (null = unchecked). */
  kind: "set" | "delta" | "checkpoint";
  delta?: number;
  ledger: number | null;
  stated?: number;
  text: string;
}

export interface AuditResult {
  file: string;
  lines: number;
  creditChecks: number;
  clickTurns: number;
  issues: AuditIssue[];
  unknownCreditLines: { line: number; text: string }[];
}

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3 };

function amount(s: string): number {
  return WORD_NUMBERS[s] ?? parseInt(s, 10);
}

export async function auditGameLog(
  file: string,
  log: string[],
  cardSide: Map<string, "corp" | "runner">,
  trace?: (event: AuditTraceEvent) => void
): Promise<AuditResult> {
  const result: AuditResult = {
    file,
    lines: log.length,
    creditChecks: 0,
    clickTurns: 0,
    issues: [],
    unknownCreditLines: [],
  };

  const pool: Record<"corp" | "runner", number | null> = { corp: null, runner: null };
  // Click ledger: per-side open allotment.
  const clicks: Record<"corp" | "runner", { allotted: number; balance: number; openedAt: number } | null> =
    { corp: null, runner: null };

  const side = (name: string): "corp" | "runner" => (name === "Corp" ? "corp" : "runner");

  // Bonus clicks announced for a side's NEXT turn ("will receive +N ...").
  const pendingBonus: Record<"corp" | "runner", number> = { corp: 0, runner: 0 };

  const closeClickLedger = (who: "corp" | "runner", atLine: number, endOfLog: boolean): void => {
    const ledger = clicks[who];
    if (!ledger) return;
    clicks[who] = null;
    if (endOfLog) return; // game ended mid-turn (win interrupts) — not an imbalance
    result.clickTurns++;
    if (ledger.balance !== 0) {
      result.issues.push({
        line: atLine,
        kind: "click-imbalance",
        detail: `${who} turn opened at line ${ledger.openedAt}: balance ${ledger.balance} (allotted ${ledger.allotted})`,
      });
    }
  };

  for (let i = 0; i < log.length; i++) {
    const raw = String(log[i]).replace(/\n+$/, "");
    const line = raw.trim();
    let m: RegExpMatchArray | null;

    // ---- ground-truth checkpoints ----------------------------------------
    if ((m = line.match(/^SPOILER: (Corp|Runner) has (\d+) credit\(s\)/))) {
      const who = side(m[1]!);
      const stated = parseInt(m[2]!, 10);
      trace?.({ line: i, who, kind: "checkpoint", ledger: pool[who], stated, text: line });
      if (pool[who] !== null) {
        result.creditChecks++;
        if (pool[who] !== stated) {
          result.issues.push({
            line: i,
            kind: "credit-mismatch",
            detail: `${who}: ledger says ${pool[who]}, engine says ${stated}`,
          });
        }
      }
      pool[who] = stated; // resync so one gap doesn't cascade
      continue;
    }

    // ---- setup -----------------------------------------------------------
    if (line.startsWith("Each player has taken five credits")) {
      pool.corp = 5;
      pool.runner = 5;
      trace?.({ line: i, who: "corp", kind: "set", ledger: 5, text: line });
      trace?.({ line: i, who: "runner", kind: "set", ledger: 5, text: line });
      continue;
    }

    // ---- clicks ----------------------------------------------------------
    // Turn anchor: the engine does not narrate click allotments; the
    // SPOILER turn-start line is the reliable boundary. Defaults 3/4 plus
    // any announced next-turn bonuses.
    if ((m = line.match(/^SPOILER: At start of (Corp|Runner) turn:/))) {
      const who = side(m[1]!);
      closeClickLedger(who, i, false);
      const allotted = (who === "corp" ? 3 : 4) + pendingBonus[who];
      pendingBonus[who] = 0;
      clicks[who] = { allotted, balance: allotted, openedAt: i };
      continue;
    }
    if ((m = line.match(/^(Corp|Runner) will receive \+(\d+) allotted click\(s\) next turn/))) {
      pendingBonus[side(m[1]!)] += parseInt(m[2]!, 10);
      continue;
    }
    if ((m = line.match(/^(Corp|Runner) spent (one|\d+) clicks?$/))) {
      const ledger = clicks[side(m[1]!)];
      if (ledger) ledger.balance -= amount(m[2]!);
      continue;
    }
    if ((m = line.match(/^(Corp|Runner) gained (one|\d+) clicks?$/))) {
      const ledger = clicks[side(m[1]!)];
      if (ledger) ledger.balance += amount(m[2]!);
      continue;
    }
    if ((m = line.match(/^(Corp|Runner) lost (one|\d+|no) clicks?$/))) {
      const ledger = clicks[side(m[1]!)];
      if (ledger && m[2] !== "no") ledger.balance -= amount(m[2]!);
      continue;
    }

    // ---- credits ---------------------------------------------------------
    if ((m = line.match(/^(Corp|Runner) gained (one|\d+) credits? from /))) {
      continue; // temporary credits (bad publicity etc.) — not pool
    }
    if ((m = line.match(/^(Corp|Runner) gained (one|\d+) credits?$/))) {
      const who = side(m[1]!);
      if (pool[who] !== null) pool[who]! += amount(m[2]!);
      trace?.({ line: i, who, kind: "delta", delta: amount(m[2]!), ledger: pool[who], text: line });
      continue;
    }
    if ((m = line.match(/^(Corp|Runner) spent (one|\d+) temporary credits?$/))) {
      continue; // not pool
    }
    if (/^(Corp|Runner) spent (one|\d+) credits? from /.test(line)) {
      continue; // card-sourced credits (Overclock, Scrubber, ...) — not pool
    }
    if (/^(Corp|Runner) loses \d+ unspent temporary credits?/.test(line)) {
      continue; // bad-publicity/run credits expiring — not pool
    }
    if ((m = line.match(/^(Corp|Runner) spent (one|\d+) credits?$/))) {
      const who = side(m[1]!);
      if (pool[who] !== null) pool[who]! -= amount(m[2]!);
      trace?.({ line: i, who, kind: "delta", delta: -amount(m[2]!), ledger: pool[who], text: line });
      continue;
    }
    if ((m = line.match(/^(Corp|Runner) lost (one|\d+|0) credits?$/))) {
      const who = side(m[1]!);
      if (pool[who] !== null && m[2] !== "0") pool[who]! -= amount(m[2]!);
      trace?.({ line: i, who, kind: "delta", delta: m[2] === "0" ? 0 : -amount(m[2]!), ledger: pool[who], text: line });
      continue;
    }
    if ((m = line.match(/^(one|\d+) credits? taken from (.+)$/))) {
      const title = m[2]!.trim();
      const who = cardSide.get(title);
      if (who === undefined) {
        result.issues.push({
          line: i,
          kind: "unattributable-take",
          detail: `credits taken from unknown card "${title}"`,
        });
      } else {
        if (pool[who] !== null) pool[who]! += amount(m[1]!);
        trace?.({ line: i, who, kind: "delta", delta: amount(m[1]!), ledger: pool[who], text: line });
      }
      continue;
    }
    if (/^(one|\d+) credits? (placed on|loaded onto) /.test(line)) continue; // bank↔card
    if (/^(Corp|Runner) used (one|\d+) credits? from /.test(line)) continue; // card counters

    // ---- announcements whose credit effects are narrated separately -----
    // (Extended pool; each verified against the card code.) Ability
    // choices are announced as "<ability text> triggered" — the effects
    // log through GainCredits/LoseCredits/TakeCredits like any other.
    if (/ triggered$/.test(line)) continue;
    // Subroutine announcements quote the subroutine text — Elevation ice
    // writes "[credit]" where the base sets write "[c]"; the effects log
    // separately ("Runner lost 2 credits").
    if (/^Firing .+:$/.test(line) || /^Subroutine .+ broken$/.test(line)) continue;
    // Side Hustle (Elevation): announcement, then TakeCredits narrates
    // "N credits taken from Side Hustle".
    if (/^Side Hustle pays out \d+ credits?$/.test(line)) continue;
    // Account Siphon (Core): summary after LoseCredits/GainCredits/AddTags
    // already narrated each effect.
    if (/^Account Siphon: Corp lost \d+ credits?, Runner gained \d+ credits? and took \d+ tags?$/.test(line)) continue;

    // ---- unknown credit-ish lines (parser-coverage guard) ----------------
    // ERROR:/DEBUG: are engine channels, not narration (engine errors are
    // surfaced on the game record).
    if (/credit/i.test(line) && !/^SPOILER:|^AI:|^RC:|^ERROR:|^DEBUG:|^\[/.test(line)) {
      result.unknownCreditLines.push({ line: i, text: line.slice(0, 120) });
    }
  }
  closeClickLedger("corp", log.length, true);
  closeClickLedger("runner", log.length, true);
  return result;
}

export async function buildCardSideMap(repoRoot: string): Promise<Map<string, "corp" | "runner">> {
  const raw = JSON.parse(
    await readFile(join(repoRoot, "carddata", "carddata.json"), "utf-8")
  ) as { data: { title?: unknown; side_code?: unknown; stripped_title?: unknown }[] };
  const map = new Map<string, "corp" | "runner">();
  for (const c of raw.data) {
    const sideCode = c.side_code === "corp" ? "corp" : c.side_code === "runner" ? "runner" : null;
    if (!sideCode) continue;
    if (typeof c.title === "string") map.set(c.title, sideCode);
    if (typeof c.stripped_title === "string") map.set(c.stripped_title, sideCode);
  }
  return map;
}

export async function auditGolden(repoRoot: string): Promise<AuditResult[]> {
  const dir = join(repoRoot, "harness", "fixtures", "golden");
  const cardSide = await buildCardSideMap(repoRoot);
  const results: AuditResult[] = [];
  for (const f of (await readdir(dir)).filter((f) => /^g\d+\.json$/.test(f)).sort()) {
    const fixture = JSON.parse(await readFile(join(dir, f), "utf-8")) as { log: string[] };
    results.push(await auditGameLog(f, fixture.log, cardSide));
  }
  return results;
}

export async function auditFile(repoRoot: string, path: string): Promise<AuditResult> {
  const cardSide = await buildCardSideMap(repoRoot);
  const record = JSON.parse(await readFile(path, "utf-8")) as { log: string[] };
  return auditGameLog(path, record.log, cardSide);
}

export function reportAudit(results: AuditResult[]): number {
  let failures = 0;
  for (const r of results) {
    const bad = r.issues.length + r.unknownCreditLines.length;
    if (bad === 0) {
      console.log(
        `${r.file} PASS (${r.creditChecks} credit checkpoints, ${r.clickTurns} click turns, ${r.lines} lines)`
      );
      continue;
    }
    failures++;
    console.log(`${r.file} FAIL:`);
    for (const issue of r.issues.slice(0, 10)) {
      console.log(`  [${issue.kind}] line ${issue.line}: ${issue.detail}`);
    }
    for (const u of r.unknownCreditLines.slice(0, 10)) {
      console.log(`  [unknown-credit-line] line ${u.line}: ${u.text}`);
    }
  }
  console.log(
    failures === 0
      ? `AUDIT: all ${results.length} games conserve credits and clicks`
      : `AUDIT: ${failures}/${results.length} games have findings`
  );
  return failures === 0 ? 0 : 1;
}

/** Manual-review assist: N seeded-random checked credit checkpoints,
 *  each with the log since that side's previous checkpoint, the
 *  auditor's arithmetic, and the engine's stated value — a packet a human
 *  can verify against the rulebook in minutes. */
export async function reviewSample(
  repoRoot: string,
  path: string,
  n: number,
  seed: number
): Promise<{ outFile: string; samples: number }> {
  const cardSide = await buildCardSideMap(repoRoot);
  const record = JSON.parse(await readFile(path, "utf-8")) as { log: string[] };
  const events: AuditTraceEvent[] = [];
  const result = await auditGameLog(path, record.log, cardSide, (e) => events.push(e));
  // Checked checkpoints and the segment of ledger events leading to each.
  const segments: { who: "corp" | "runner"; from: AuditTraceEvent; steps: AuditTraceEvent[]; at: AuditTraceEvent }[] = [];
  const last: Record<"corp" | "runner", AuditTraceEvent | null> = { corp: null, runner: null };
  const steps: Record<"corp" | "runner", AuditTraceEvent[]> = { corp: [], runner: [] };
  for (const e of events) {
    if (e.kind === "delta") {
      steps[e.who].push(e);
      continue;
    }
    if (e.kind === "checkpoint" && e.ledger !== null && last[e.who]) {
      segments.push({ who: e.who, from: last[e.who]!, steps: steps[e.who], at: e });
    }
    last[e.who] = e;
    steps[e.who] = [];
  }
  // Seeded pick without replacement (same LCG shape as the engine).
  let s = (seed * 48271) % 2147483647 || 1;
  const rand = (): number => (s = (s * 48271) % 2147483647) / 2147483647;
  const pool = segments.map((_, i) => i);
  const picked: number[] = [];
  while (picked.length < Math.min(n, pool.length)) {
    picked.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]!);
  }
  picked.sort((a, b) => a - b);
  const startOf = (e: AuditTraceEvent): number => (e.kind === "set" ? e.ledger! : e.stated!);
  const out: string[] = [
    `# Audit review sample — ${path.split(/[\\/]/).slice(-2).join("/")}`,
    "",
    `${picked.length} of ${segments.length} checked credit checkpoints, seeded (seed ${seed}). ` +
      `Audit result for the whole game: ${result.issues.length} issue(s), ` +
      `${result.unknownCreditLines.length} unparsed credit line(s), ${result.creditChecks} checkpoints.`,
    "",
    "For each sample: confirm every credit-relevant line in the excerpt is in the arithmetic " +
      "(and nothing else is), that each delta matches the rules for that event, and that the " +
      "expected value equals the engine's checkpoint.",
    "",
  ];
  for (const [k, idx] of picked.entries()) {
    const seg = segments[idx]!;
    const who = seg.who === "corp" ? "Corp" : "Runner";
    out.push(`## ${k + 1}. ${who} checkpoint at log line ${seg.at.line}`, "");
    out.push(`Start: **${startOf(seg.from)}** (${seg.from.kind === "set" ? "game setup" : "previous checkpoint"}, line ${seg.from.line})`, "");
    if (seg.steps.length === 0) out.push("- no credit events for this side");
    let running = startOf(seg.from);
    for (const st of seg.steps) {
      running += st.delta ?? 0;
      const d = st.delta ?? 0;
      out.push(`- line ${st.line}: \`${st.text}\` → ${d >= 0 ? "+" : "−"}${Math.abs(d)} = ${running}`);
    }
    const ok = seg.at.ledger === seg.at.stated;
    out.push("", `Expected **${seg.at.ledger}** · engine says **${seg.at.stated}** — ${ok ? "agree" : "**MISMATCH**"}`, "");
    const from = seg.from.line + 1;
    const to = seg.at.line;
    const lines = record.log.slice(from, to + 1).map((l, j) => `${String(from + j).padStart(5)}  ${String(l).replace(/\n+$/, "")}`);
    const shown = lines.length > 80 ? [...lines.slice(0, 40), "  ...  (excerpt trimmed)", ...lines.slice(-40)] : lines;
    out.push("<details><summary>Log excerpt (lines " + from + "–" + to + ")</summary>", "", "```", ...shown, "```", "", "</details>", "");
  }
  const outFile = path.endsWith("record.json")
    ? path.replace(/record\.json$/, "audit-sample.md")
    : path.replace(/\.json$/, "-audit-sample.md");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(outFile, out.join("\n"));
  return { outFile, samples: picked.length };
}
