import assert from "node:assert/strict";
import { test } from "node:test";
import { clusteredMean, firstDivergence, winRates, type MatchGame } from "../../src/match.js";

type Row = Parameters<typeof firstDivergence>[0][number];

test("clusteredMean: one game per seed is the ordinary standard error", () => {
  const m = clusteredMean([
    { cluster: 1, x: 1 },
    { cluster: 2, x: 0 },
    { cluster: 3, x: 1 },
    { cluster: 4, x: 0 },
  ])!;
  assert.equal(m.mean, 0.5);
  // sqrt(Σ (x - x̄)²) / n = sqrt(4 · 0.25) / 4
  assert.equal(m.se, 0.25);
  assert.equal(clusteredMean([]), null);
});

test("clusteredMean: reruns of one seed are not independent samples", () => {
  const independent = clusteredMean([
    { cluster: 1, x: 1 },
    { cluster: 2, x: 1 },
    { cluster: 3, x: 0 },
    { cluster: 4, x: 0 },
  ])!;
  const clustered = clusteredMean([
    { cluster: 1, x: 1 },
    { cluster: 1, x: 1 },
    { cluster: 2, x: 0 },
    { cluster: 2, x: 0 },
  ])!;
  assert.equal(independent.mean, clustered.mean);
  assert.ok(clustered.se > independent.se);
});

function game(seed: number, winner: "corp" | "runner" | null, status = "completed"): MatchGame {
  return {
    index: seed,
    seed,
    run: 1,
    gameId: `g${seed}`,
    runDir: null,
    status,
    error: null,
    winner,
    reason: null,
    corpAP: null,
    runnerAP: null,
    turns: null,
    minutes: 0,
    invalidRecords: 0,
    previewDivergences: 0,
    seats: [
      {
        seat: "runner",
        model: "m",
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
      },
    ],
  };
}

test("winRates counts completed games only, clustered by seed", () => {
  const [r] = winRates([game(1, "runner"), game(2, "corp"), game(3, "runner"), game(4, null, "crashed")]);
  assert.equal(r!.seat, "runner");
  assert.equal(r!.wins, 2);
  assert.equal(r!.n, 3);
  assert.equal(r!.seeds, 3);
  assert.equal(r!.rate, 2 / 3);
});

function row(seq: number, choice: number, extra: Partial<Row> = {}): Row {
  return {
    seq,
    turn: { side: "runner", number: 2 },
    seat: "runner",
    decision_type: "command",
    options: [{ command: "draw" }, { command: "run" }],
    choice,
    model: "m",
    ...extra,
  };
}

const label = (o: unknown): string => JSON.stringify(o);

test("firstDivergence finds the first differing choice", () => {
  const d = firstDivergence([row(1, 0), row(2, 0)], [row(1, 0), row(2, 1)], label);
  assert.equal(d.kind, "choice");
  assert.equal(d.shared, 1);
  assert.equal(d.seq, 2);
  assert.equal(d.turn, "Runner turn 2");
  assert.equal(d.byModel, true);
  assert.equal(d.choiceA, '{"command":"draw"}');
  assert.equal(d.choiceB, '{"command":"run"}');
});

test("firstDivergence: different menus under equal choices are a menu divergence", () => {
  const d = firstDivergence([row(1, 0)], [row(1, 0, { options: [{ command: "draw" }] })], label);
  assert.equal(d.kind, "menu");
});

test("firstDivergence: forced decisions are not the model's", () => {
  const d = firstDivergence([row(1, 0, { forced: true })], [row(1, 1, { forced: true })], label);
  assert.equal(d.byModel, false);
});

test("firstDivergence: identical streams and truncated streams", () => {
  assert.equal(firstDivergence([row(1, 0)], [row(1, 0)], label).kind, "none");
  const d = firstDivergence([row(1, 0), row(2, 0)], [row(1, 0)], label);
  assert.equal(d.kind, "length");
  assert.equal(d.shared, 1);
});
