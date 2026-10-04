import assert from "node:assert/strict";
import { test } from "node:test";
import { repoRoot } from "../../src/commands/args.js";
import { assertQualified, checkPool, hardErrors, requiredSets, setsParam } from "../../src/cardpool.js";
import { loadPrecon } from "../../src/precons.js";

test("base-pool decks need no extra set files", async () => {
  const decks = await Promise.all([loadPrecon(repoRoot, "Gateway Corp"), loadPrecon(repoRoot, "Gateway Runner")]);
  assert.deepEqual(await checkPool(repoRoot, decks), { sets: [], missing: [] });
  assert.equal(setsParam([]), "");
});

test("an Elevation deck needs the elevation set file", async () => {
  const sets = await requiredSets(repoRoot, [await loadPrecon(repoRoot, "1000 Cuts")]);
  assert.deepEqual(sets, ["elevation"]);
  assert.equal(setsParam(sets), "&sets=elevation");
});

test("a card no set file defines makes the deck unplayable", async () => {
  const deck = { name: "broken", identity: 30001, cards: [99999999] };
  assert.deepEqual((await checkPool(repoRoot, [deck])).missing, [99999999]);
  await assert.rejects(requiredSets(repoRoot, [deck]), /not implemented in any set file/);
});

test("the engine's card-definition lint is not a hard error", () => {
  const lint = "LogError: .Enforcer on Hostile Takeover will be ignored because it is set to automatic";
  const crash = "LogError: TypeError: Cannot read properties of null (reading 'unique')";
  assert.deepEqual(hardErrors([lint, crash]), [crash]);
});

test("decks that failed qualification are refused unless allowed", async () => {
  await assertQualified(repoRoot, ["Gateway Corp", "Gateway Runner"], false);
  await assert.rejects(assertQualified(repoRoot, ["Agency"], false), /failed pool qualification/);
  await assertQualified(repoRoot, ["Agency"], true);
});
