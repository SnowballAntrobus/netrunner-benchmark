/** Audit-tooling selftest: do the checkers actually check?
 *
 *  Fault injection. Every checker must catch a planted defect of every
 *  class it claims to detect, LOCALIZED to the plant (the reported line,
 *  field or decision is the planted one — not merely "issues > 0"), and
 *  must stay quiet on the clean original, which is checked first.
 *
 *  Injections corrupt copies of artifacts, never checkers: an in-memory
 *  copy of a golden log, a real decision record from the fixture game,
 *  the page's freshly serialized state (`&plant=`, serializer.js). The
 *  code path each checker runs here is the code path production runs.
 *
 *    audit      conservation auditor (auditGameLog) on golden fixture g01
 *    validator  decision-record validator on a fixture-game record
 *    invariant  no-cheating checker, planted leaks in live games
 *    golden     the golden comparator against doctored fixture copies
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { auditGameLog, buildCardSideMap, type AuditResult, type AuditTraceEvent } from "./audit.js";
import { launchBrowser, runGame } from "./game.js";
import { compareToFixture, toFixture, type Fixture } from "./golden.js";
import { runLLMGame, validateDecisionRecord, type DecisionRecord } from "./llmgame.js";

export type Suite = "audit" | "validator" | "invariant" | "golden";
export const SUITES: Suite[] = ["audit", "validator", "invariant", "golden"];

export interface Outcome {
  suite: Suite;
  cls: string;
  ok: boolean;
  /** Where it was caught (or why the check failed). */
  detail: string;
}

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3 };
const amount = (s: string): number => WORD_NUMBERS[s] ?? parseInt(s, 10);

async function goldenFixture(repoRoot: string, id: string): Promise<Fixture> {
  return JSON.parse(
    await readFile(join(repoRoot, "harness", "fixtures", "golden", `${id}.json`), "utf-8")
  ) as Fixture;
}

// ------------------------------------------------------------- 1. audit

/** Exact findings: every expected (kind, line) reported, nothing else. */
function exactly(
  r: AuditResult,
  issues: { kind: string; line: number }[],
  unknownLines: number[] = []
): { ok: boolean; got: string } {
  const got = [
    ...r.issues.map((i) => `${i.kind}@${i.line}`),
    ...r.unknownCreditLines.map((u) => `unknown-credit-line@${u.line}`),
  ].sort();
  const want = [
    ...issues.map((i) => `${i.kind}@${i.line}`),
    ...unknownLines.map((l) => `unknown-credit-line@${l}`),
  ].sort();
  return { ok: JSON.stringify(got) === JSON.stringify(want), got: got.join(", ") || "nothing" };
}

async function auditSuite(repoRoot: string): Promise<Outcome[]> {
  const out: Outcome[] = [];
  const add = (cls: string, ok: boolean, detail: string): void => {
    out.push({ suite: "audit", cls, ok, detail });
  };
  const cardSide = await buildCardSideMap(repoRoot);
  const fixture = await goldenFixture(repoRoot, "g01");
  const log = fixture.log.map((l) => String(l).replace(/\n+$/, "").trim());
  const events: AuditTraceEvent[] = [];
  const clean = await auditGameLog("g01", log, cardSide, (e) => events.push(e));
  const cleanOk = clean.issues.length === 0 && clean.unknownCreditLines.length === 0;
  add(
    "clean-baseline",
    cleanOk,
    cleanOk
      ? `g01: ${clean.creditChecks} credit checkpoints, ${clean.clickTurns} click turns, no findings`
      : `g01 is not clean (${clean.issues.length} issues) — plants would be meaningless`
  );
  if (!cleanOk) return out;

  const mid = Math.floor(log.length / 2);
  const nextCheckpoint = (who: string, after: number): AuditTraceEvent | undefined =>
    events.find((e) => e.kind === "checkpoint" && e.who === who && e.line > after);
  const run = (mutated: string[]): Promise<AuditResult> => auditGameLog("g01*", mutated, cardSide);

  // credit-drift: one pool gain reported one credit too high.
  {
    const site = events.find(
      (e) =>
        e.kind === "delta" && e.line >= mid && e.ledger !== null &&
        /^(Corp|Runner) gained (one|\d+) credits?$/.test(e.text) && nextCheckpoint(e.who, e.line)
    );
    if (!site) add("credit-drift", false, "no eligible gain line in g01");
    else {
      const m = log.slice();
      m[site.line] = site.text.replace(/gained (one|\d+) credits?$/, (_, a: string) => `gained ${amount(a) + 1} credits`);
      const at = nextCheckpoint(site.who, site.line)!.line;
      const r = exactly(await run(m), [{ kind: "credit-mismatch", line: at }]);
      add("credit-drift", r.ok, `line ${site.line} inflated → caught at checkpoint line ${at}` + (r.ok ? "" : ` (got ${r.got})`));
    }
  }

  // swallowed-spend: one "spent one click" line deleted mid-turn.
  {
    const turnStart = (side: string): RegExp => new RegExp(`^SPOILER: At start of ${side} turn:`);
    let done = false;
    for (let i = mid; i < log.length && !done; i++) {
      const mm = log[i]!.match(/^(Corp|Runner) spent (one|\d+) clicks?$/);
      if (!mm) continue;
      const side = mm[1]!;
      let open = -1;
      for (let j = i - 1; j >= 0; j--) if (turnStart(side).test(log[j]!)) { open = j; break; }
      let close = -1;
      for (let j = i + 1; j < log.length; j++) if (turnStart(side).test(log[j]!)) { close = j; break; }
      if (open === -1 || close === -1) continue;
      done = true;
      const m = log.slice();
      m.splice(i, 1);
      const res = await run(m);
      const r = exactly(res, [{ kind: "click-imbalance", line: close - 1 }]);
      const names = res.issues[0]?.detail.includes(`opened at line ${open}`) ?? false;
      add(
        "swallowed-spend",
        r.ok && names,
        `line ${i} deleted → caught at the ${side} turn boundary (line ${close - 1}), naming the turn opened at line ${open}` +
          (r.ok && names ? "" : ` (got ${r.got}${res.issues[0] ? `: ${res.issues[0].detail}` : ""})`)
      );
    }
    if (!done) add("swallowed-spend", false, "no eligible click line in g01");
  }

  // checkpoint-lie: the engine's own stated value altered. The auditor
  // resyncs to the stated value, so the lie also echoes once at that
  // side's next checkpoint — both locations are the plant's.
  {
    const site = events.find(
      (e) => e.kind === "checkpoint" && e.line >= mid && e.ledger !== null && (e.stated ?? 0) >= 1
    );
    if (!site) add("checkpoint-lie", false, "no eligible checkpoint in g01");
    else {
      const m = log.slice();
      m[site.line] = site.text.replace(/has (\d+) credit\(s\)/, `has ${site.stated! - 1} credit(s)`);
      const echo = nextCheckpoint(site.who, site.line);
      const r = exactly(await run(m), [
        { kind: "credit-mismatch", line: site.line },
        ...(echo ? [{ kind: "credit-mismatch", line: echo.line }] : []),
      ]);
      add(
        "checkpoint-lie",
        r.ok,
        `checkpoint line ${site.line} understated → caught at exactly that line` +
          (echo ? ` (+ resync echo at line ${echo.line})` : "") + (r.ok ? "" : ` (got ${r.got})`)
      );
    }
  }

  // phantom-line: an invented spend the checkpoints contradict.
  {
    const site = events.find((e) => e.kind === "delta" && e.line >= mid && e.ledger !== null && nextCheckpoint(e.who, e.line));
    if (!site) add("phantom-line", false, "no eligible insertion point in g01");
    else {
      const side = site.who === "corp" ? "Corp" : "Runner";
      const m = log.slice();
      m.splice(site.line + 1, 0, `${side} spent 2 credits`);
      const at = nextCheckpoint(site.who, site.line)!.line + 1;
      const r = exactly(await run(m), [{ kind: "credit-mismatch", line: at }]);
      add("phantom-line", r.ok, `inserted after line ${site.line} → caught at the next ${side} checkpoint (line ${at})` + (r.ok ? "" : ` (got ${r.got})`));
    }
  }

  // unparsed-credit-line: credit narration the parser doesn't model must
  // surface (parser-coverage guard), not be silently ignored.
  {
    const m = log.slice();
    m.splice(mid, 0, "Runner skimmed 3 credits off the top");
    const r = exactly(await run(m), [], [mid]);
    add("unparsed-credit-line", r.ok, `inserted at line ${mid} → reported at line ${mid}` + (r.ok ? "" : ` (got ${r.got})`));
  }

  // unattributable-take: credits taken from a card the auditor can't
  // assign to a side.
  {
    const m = log.slice();
    m.splice(mid, 0, "2 credits taken from Nonexistent Card");
    const r = exactly(await run(m), [{ kind: "unattributable-take", line: mid }]);
    add("unattributable-take", r.ok, `inserted at line ${mid} → reported at line ${mid}` + (r.ok ? "" : ` (got ${r.got})`));
  }
  return out;
}

// --------------------------------------------------------- 2. validator

/** Real decision records to mutate: the committed fixture game (the
 *  keyless mock as the Runner against the rules AI). */
async function fixtureRecords(repoRoot: string): Promise<{ id: string; rows: DecisionRecord[] } | null> {
  const path = join(repoRoot, "harness", "fixtures", "mock-game", "decisions.jsonl");
  if (!existsSync(path)) return null;
  const rows = (await readFile(path, "utf-8"))
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as DecisionRecord & { record_type?: string })
    .filter((r) => (r.record_type ?? "decision") === "decision");
  return rows.length ? { id: "fixtures/mock-game", rows } : null;
}

async function validatorSuite(repoRoot: string): Promise<Outcome[]> {
  const out: Outcome[] = [];
  const add = (cls: string, ok: boolean, detail: string): void => {
    out.push({ suite: "validator", cls, ok, detail });
  };
  const source = await fixtureRecords(repoRoot);
  if (!source) {
    add("clean-baseline", false, "no fixture decision records (harness/fixtures/mock-game) to start from");
    return out;
  }
  // The fixture is a Runner-seat game (the seat the model played).
  const seats = new Set(["runner"]);
  const dirty = source.rows.filter((r) => validateDecisionRecord(r, seats).length > 0);
  const base = source.rows.find(
    (r) =>
      r.seat === "runner" && r.model !== null && r.state !== null && r.options.length >= 2 &&
      !r.forced && !r.compound_fulfilled && !r.order_folded
  );
  const cleanOk = dirty.length === 0 && base !== undefined;
  add(
    "clean-baseline",
    cleanOk,
    cleanOk
      ? `${source.id}: all ${source.rows.length} records valid; mutating seq ${base!.seq}`
      : dirty.length
        ? `${dirty.length} fixture records already invalid (first: seq ${dirty[0]!.seq})`
        : "no model-answered Runner record with a 2+ option menu"
  );
  if (!cleanOk) return out;

  const cases: [cls: string, mutate: (r: DecisionRecord) => DecisionRecord, allowed: RegExp, must: RegExp][] = [
    ["bad-choice", (r) => ({ ...r, choice: r.options.length }), /^choice \d+ out of range$/, /^choice/],
    ["empty-menu", (r) => ({ ...r, options: [] }), /^options empty$|^choice \d+ out of range$/, /^options empty$/],
    ["silent-model", (r) => ({ ...r, model: null }), /^runner record missing model$/, /missing model/],
    ["stateless-runner", (r) => ({ ...r, state: null }), /^runner record missing state$/, /missing state/],
    ["fat-forced", (r) => ({ ...r, forced: true }), /^forced record with more than one option$/, /^forced/],
    ["bad-seat", (r) => ({ ...r, seat: "observer" }), /^bad seat observer$/, /^bad seat/],
    ["bad-type", (r) => ({ ...r, decision_type: "hover" }), /^bad decision_type hover$/, /^bad decision_type/],
    ["no-game-id", (r) => ({ ...r, game_id: "" }), /^game_id missing$/, /^game_id/],
    ["fractional-seq", (r) => ({ ...r, seq: r.seq + 0.5 }), /^seq not an integer$/, /^seq/],
  ];
  for (const [cls, mutate, allowed, must] of cases) {
    const problems = validateDecisionRecord(mutate(structuredClone(base!)), seats);
    const ok = problems.length > 0 && problems.every((p) => allowed.test(p)) && problems.some((p) => must.test(p));
    add(cls, ok, problems.length ? `reported: ${problems.join("; ")}` : "NOT reported");
  }
  return out;
}

// --------------------------------------------------------- 3. invariant

interface Violation {
  decision?: number;
  viewer?: string;
  kind?: string;
  detail?: string;
  path?: string;
}

/** The planted violation, and nothing else, was reported. */
function caughtExactly(violations: object[], planted: object | null | undefined): { ok: boolean; got: string } {
  const got = (violations as Violation[]).map((v) => `${v.kind}@${v.decision}/${v.viewer}: ${v.detail}`).join("; ") || "nothing";
  if (!planted) return { ok: false, got: `plant never fired (game too short?) — violations: ${got}` };
  const p = planted as Violation;
  const v = violations as Violation[];
  const ok =
    v.length === 1 &&
    (Object.keys(p) as (keyof Violation)[]).every((k) => v[0]![k] === p[k]);
  return { ok, got };
}

async function invariantSuite(repoRoot: string, outDir: string): Promise<Outcome[]> {
  const out: Outcome[] = [];
  const add = (cls: string, ok: boolean, detail: string): void => {
    out.push({ suite: "invariant", cls, ok, detail });
  };
  const game = { repoRoot, seed: 101, corpPrecon: "Gateway Corp", runnerPrecon: "Gateway Runner" };
  const browser = await launchBrowser();
  try {
    const control = await runGame({ ...game, extraParams: "&invariant=1" }, browser);
    const cv = control.invariantViolations ?? [];
    const cleanOk = control.status === "completed" && cv.length === 0 && (control.invariantChecks ?? 0) > 0;
    add(
      "clean-baseline",
      cleanOk,
      `seed 101 rules-vs-rules, unplanted: ${control.invariantChecks ?? 0} checks, ${cv.length} violations`
    );
    if (!cleanOk) return out;
    for (const cls of ["hidden-title", "private-log"]) {
      const rec = await runGame({ ...game, extraParams: `&invariant=1&plant=${cls}` }, browser);
      const r = caughtExactly(rec.invariantViolations ?? [], rec.planted);
      const p = rec.planted as Violation | null | undefined;
      add(
        cls,
        r.ok,
        p
          ? `planted at decision ${p.decision} (${p.viewer} view${p.path ? `, ${p.path}` : ""}) → ` +
              (r.ok ? `caught at decision ${p.decision}: "${p.detail}"` : `got ${r.got}`)
          : r.got
      );
    }
  } finally {
    await browser.close();
  }
  // Menu half: a planted hidden title in an LLM seat's option menu.
  const rec = await runLLMGame({
    repoRoot,
    seed: 1,
    corpPrecon: game.corpPrecon,
    runnerPrecon: game.runnerPrecon,
    seat: "runner",
    model: "mock",
    rulesSource: "digest",
    profile: "neutral",
    reasoningStyle: "brief",
    debrief: false,
    frames: false,
    extraParams: "&invariant=1&plant=hidden-option",
    outDir: join(outDir, "selftest"),
  });
  const r = caughtExactly(rec.invariantViolations ?? [], rec.planted);
  const p = rec.planted as Violation | null | undefined;
  add(
    "hidden-option",
    r.ok,
    p
      ? `planted in the ${p.viewer} menu at decision ${p.decision} → ` +
          (r.ok ? `caught at decision ${p.decision}: "${p.detail}"` : `got ${r.got}`)
      : r.got
  );
  return out;
}

// ------------------------------------------------------------ 4. golden

async function goldenSuite(repoRoot: string): Promise<Outcome[]> {
  const out: Outcome[] = [];
  const add = (cls: string, ok: boolean, detail: string): void => {
    out.push({ suite: "golden", cls, ok, detail });
  };
  const frozen = await goldenFixture(repoRoot, "g01");
  const record = await runGame({
    repoRoot,
    seed: frozen.seed,
    corpPrecon: frozen.corpPrecon,
    runnerPrecon: frozen.runnerPrecon,
  });
  const fresh = toFixture("g01", record);
  const clean = compareToFixture(frozen, fresh);
  const cleanOk = clean.resultMatch && clean.diverge === -1;
  add(
    "clean-baseline",
    cleanOk,
    cleanOk ? `g01 replays identically (${fresh.log.length} lines)` : `g01 replay differs (line ${clean.diverge})`
  );
  if (!cleanOk) return out;
  const k = Math.floor(frozen.log.length / 2);
  {
    const doctored = { ...frozen, log: frozen.log.slice() };
    doctored.log[k] = `${doctored.log[k]} `;
    const c = compareToFixture(doctored, fresh);
    add("doctored-line", c.diverge === k, `line ${k} altered by one character → diff reported at line ${c.diverge}`);
  }
  {
    const doctored = { ...frozen, log: frozen.log.slice(0, -1) };
    const c = compareToFixture(doctored, fresh);
    add(
      "truncated-log",
      c.diverge === frozen.log.length - 1,
      `last line dropped → diff reported at line ${c.diverge} (of ${frozen.log.length})`
    );
  }
  {
    const doctored = { ...frozen, winner: frozen.winner === "corp" ? "runner" : "corp" };
    const c = compareToFixture(doctored, fresh);
    add("flipped-result", !c.resultMatch && c.diverge === -1, `winner flipped → result mismatch reported (logs still equal)`);
  }
  return out;
}

export async function selftest(repoRoot: string, outDir: string, suites: Suite[]): Promise<Outcome[]> {
  const all: Outcome[] = [];
  for (const suite of suites) {
    const results =
      suite === "audit" ? await auditSuite(repoRoot) :
      suite === "validator" ? await validatorSuite(repoRoot) :
      suite === "invariant" ? await invariantSuite(repoRoot, outDir) :
      await goldenSuite(repoRoot);
    for (const o of results) {
      console.log(
        `[${o.suite}] ${o.cls === "clean-baseline" ? "clean baseline" : `planted ${o.cls}`}` +
          ` → ${o.detail}: ${o.ok ? "OK" : "FAIL"}`
      );
    }
    all.push(...results);
  }
  return all;
}
