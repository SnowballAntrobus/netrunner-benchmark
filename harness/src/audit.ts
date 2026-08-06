/** Conservation auditor (PHASE1 M4.5) — tier one of the rules-conformance
 *  "judge": deterministic, no LLM, no credits spent.
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
  cardSide: Map<string, "corp" | "runner">
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
      continue;
    }
    if ((m = line.match(/^(Corp|Runner) lost (one|\d+|0) credits?$/))) {
      const who = side(m[1]!);
      if (pool[who] !== null && m[2] !== "0") pool[who]! -= amount(m[2]!);
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
      } else if (pool[who] !== null) {
        pool[who]! += amount(m[1]!);
      }
      continue;
    }
    if (/^(one|\d+) credits? (placed on|loaded onto) /.test(line)) continue; // bank↔card
    if (/^(Corp|Runner) used (one|\d+) credits? from /.test(line)) continue; // card counters

    // ---- unknown credit-ish lines (parser-coverage guard) ----------------
    if (/credit/i.test(line) && !/^SPOILER:|^AI:|^RC:|^\[/.test(line)) {
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
