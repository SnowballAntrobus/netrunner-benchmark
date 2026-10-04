import assert from "node:assert/strict";
import { test } from "node:test";
import { costLabel, isStandard, playerLabel, seatEntries, type GameRecordLite } from "../../src/corpus.js";

const usage = { tokensIn: 1000, tokensOut: 100, cacheRead: 0, cacheWrite: 0 };

test("seat entries: API seats carry a cost, MCP seats a subscription", () => {
  const record: GameRecordLite = {
    seats: {
      corp: { seat: "corp", model: "mock", driver: "mcp", llmDecisions: 40, usage },
      runner: { seat: "runner", model: "some-model", llmDecisions: 50, usage, reportedCostUsd: 0.5 },
    },
  };
  const [corp, runner] = seatEntries(record);
  assert.equal(corp!.seat, "corp");
  assert.equal(corp!.driver, "mcp");
  assert.equal(corp!.costUsd, null);
  assert.equal(runner!.driver, "api");
  assert.equal(runner!.costUsd, 0.5);
  assert.equal(runner!.llmDecisions, 50);
  assert.equal(playerLabel(corp!), "mock (MCP)");
  assert.equal(playerLabel(runner!), "some-model");
  assert.equal(costLabel([corp!, runner!]), "$0.50 + subscription");
  assert.equal(costLabel([corp!]), "subscription");
});

test("cost label: unknown API cost is a dash, never a guess", () => {
  const [runner] = seatEntries({ seats: { runner: { seat: "runner", model: "unpriced-model" } } });
  assert.equal(runner!.costUsd, null);
  assert.equal(costLabel([runner!]), "—");
});

test("only games with neutral card-script branches are standard", () => {
  assert.equal(isStandard({ aiBranches: "neutral" }), true);
  assert.equal(isStandard({ aiBranches: "rules" }), false);
  assert.equal(isStandard({}), false);
});
