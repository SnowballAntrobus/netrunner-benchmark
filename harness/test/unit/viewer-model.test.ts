/** The board viewer's game model (site/viewer/model.mjs), on the committed
 *  fixture game. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../../src/commands/args.js";

interface Step {
  k: string;
  seq?: number;
  model?: string;
  forced?: number;
  fulfilled?: number;
  fr: number;
  opts?: { l: string }[];
}
interface Model {
  optionLabel(o: unknown): string;
  stepFromRow(row: Record<string, unknown>): Step;
  isModelStep(step: Step): boolean;
  isAutoStep(step: Step): boolean;
  buildGame(input: Record<string, unknown>): {
    meta: Record<string, unknown> & { seats: Record<string, { model: string; driver: string }> };
    steps: Step[];
    frames: unknown[];
    log: [number, string, string][];
    debrief: { seat: string; text: string }[];
    cards: Record<string, { t: string }>;
  };
}

const model = (await import(pathToFileURL(join(repoRoot, "site", "viewer", "model.mjs")).href)) as Model;
const fixture = join(repoRoot, "harness", "fixtures", "mock-game");
const jsonl = (name: string): Record<string, unknown>[] =>
  readFileSync(join(fixture, name), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

test("option labels read like the menu the model saw", () => {
  assert.equal(model.optionLabel({ index: 0 }), "continue");
  assert.equal(model.optionLabel({ command: "install", card: { title: "Sure Gamble" } }), "install Sure Gamble");
  assert.equal(model.optionLabel({ command: "run", server: "HQ" }), "run → HQ");
  assert.equal(
    model.optionLabel({ command: "play", card: { title: "Jailbreak" }, then: { server: "R&D" } }),
    "play Jailbreak → then: R&D"
  );
  assert.equal(model.optionLabel({ command: "install", card: { hidden: true } }), "install (hidden card)");
});

test("compaction rows become summary steps", () => {
  const step = model.stepFromRow({
    record_type: "compaction",
    seat: "corp",
    compaction_id: 1,
    seq_before: 10,
    dropped_turns: 4,
    kept_turns: 2,
    summary: "so far",
  });
  assert.equal(step.k, "c");
  assert.equal(model.isModelStep(step), false);
  assert.equal(model.isAutoStep(step), false);
});

test("the fixture game builds into one step per decision plus the result", () => {
  const record = JSON.parse(readFileSync(join(fixture, "record.json"), "utf-8")) as {
    seats: { runner: { llmDecisions: number; forcedDecisions: number } };
  };
  const rows = jsonl("decisions.jsonl");
  const frames = jsonl("frames.jsonl");
  const debrief = JSON.parse(readFileSync(join(fixture, "debrief.json"), "utf-8")) as unknown;
  const carddata = (JSON.parse(readFileSync(join(repoRoot, "carddata", "carddata.json"), "utf-8")) as { data: unknown[] })
    .data;
  const game = model.buildGame({ record, rows, frames, debrief, carddata });

  assert.equal(game.steps.length, rows.length + 1);
  assert.equal(game.steps.at(-1)!.k, "end");
  assert.equal(game.steps.filter(model.isModelStep).length, record.seats.runner.llmDecisions);
  assert.equal(game.steps.filter((s) => s.forced).length, record.seats.runner.forcedDecisions);
  // Frames are deduplicated, and every step points at one.
  assert.ok(game.frames.length > 0 && game.frames.length <= frames.length);
  assert.ok(game.steps.every((s) => s.fr >= 0 && s.fr < game.frames.length));
  assert.deepEqual(Object.keys(game.meta.seats), ["runner"]);
  assert.equal(game.meta.seats["runner"]!.driver, "api");
  assert.equal(game.debrief.length, 1);
  assert.ok(game.log.some(([, kind]) => kind === "t"));
  assert.ok(Object.values(game.cards).some((c) => c.t === "Hedge Fund"));
});
