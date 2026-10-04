import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCompactDecisionMessage,
  buildDecisionMessage,
  buildSystemPrompt,
  CLIENT_NOTE,
  COMPACT_VIEW_NOTE,
  CONVERSATIONAL_NOTE,
  type PageDecisionRequest,
} from "../../src/prompts.js";

const refs = { ownReference: "OWN DECK", opponentReference: "OPPONENT DECK" };

test("system prompt: the context note matches who holds the conversation", () => {
  const api = buildSystemPrompt({ ...refs, contextMode: "conversational" });
  assert.ok(api.includes(CONVERSATIONAL_NOTE));
  assert.ok(!api.includes(CLIENT_NOTE));

  const chat = buildSystemPrompt({ ...refs, contextMode: "client" });
  assert.ok(chat.includes(CLIENT_NOTE));
  assert.ok(!chat.includes(CONVERSATIONAL_NOTE));
  assert.ok(!chat.includes(COMPACT_VIEW_NOTE));

  const stateless = buildSystemPrompt({ ...refs, contextMode: "stateless" });
  assert.ok(!stateless.includes(CONVERSATIONAL_NOTE) && !stateless.includes(CLIENT_NOTE));

  assert.ok(buildSystemPrompt({ ...refs, contextMode: "client", decisionView: "compact" }).includes(COMPACT_VIEW_NOTE));
});

test("system prompt: seat, decklists, and no strategy hints under the neutral profile", () => {
  const corp = buildSystemPrompt({ ...refs, seat: "corp" });
  assert.ok(corp.includes("OWN DECK") && corp.includes("OPPONENT DECK"));
  assert.ok(corp.indexOf("OWN DECK") < corp.indexOf("OPPONENT DECK"));
  assert.ok(!corp.includes("ACTIONS_MODE_PARAGRAPH") && !corp.includes("LOG_PERSPECTIVE_NOTE"));
  assert.ok(!corp.includes("## Strategic basics"));
});

const request: PageDecisionRequest = {
  seat: "runner",
  decisionType: "command",
  seq: 42,
  turn: { side: "runner", number: 3 },
  phase: { identifier: "Runner 1.3", title: "Action phase" },
  options: [{ index: 0, command: "draw" }, { index: 1, command: "run", server: "HQ" }],
  state: {
    viewer: "runner",
    agendaPointsToWin: 7,
    runner: { credits: 5, clicks: 3, tags: 0, agendaPoints: 2, grip: [{ title: "Sure Gamble" }, { title: "Docklands Pass" }] },
    corp: { credits: 8, clicks: 0, badPublicity: 0, agendaPoints: 1, hq: { count: 4 } },
    log: Array.from({ length: 20 }, (_, i) => `line ${i}`),
  },
  reproductionCode: null,
};

test("full decision message carries the state JSON and the options", () => {
  const text = buildDecisionMessage(request);
  assert.ok(text.startsWith("Decision #42 — runner turn 3, phase Runner 1.3 (Action phase), type command."));
  assert.ok(text.includes(JSON.stringify(request.state)));
  assert.ok(text.endsWith("Choose one option index (0-1) via the choose_option tool."));
});

test("compact decision message: status, own hand, recent log, options; no state JSON", () => {
  const text = buildCompactDecisionMessage(request);
  const lines = text.split("\n");
  assert.equal(
    lines[1],
    "Runner: 5 credits, 3 clicks, 2 cards in grip, 0 tags, 2/7 agenda points · " +
      "Corp: 8 credits, 0 clicks, 4 cards in HQ, 0 bad publicity, 1/7 agenda points"
  );
  assert.equal(lines[2], "Your grip: Sure Gamble, Docklands Pass");
  assert.ok(text.includes("  line 19") && text.includes("  line 8") && !text.includes("  line 7"));
  assert.ok(text.includes('1: {"index":1,"command":"run","server":"HQ"}'));
  assert.ok(!text.includes('"viewer"'));
  assert.ok(text.endsWith("Choose one option index (0-1) via the choose_option tool."));
});

test("compact decision message from the Corp's seat puts the Corp first", () => {
  const corpView = {
    ...request,
    seat: "corp",
    state: { ...request.state, viewer: "corp", corp: { credits: 8, hq: [{ title: "Hedge Fund" }] } },
  };
  const lines = buildCompactDecisionMessage(corpView).split("\n");
  assert.ok(lines[1]!.startsWith("Corp: 8 credits, ? clicks, 1 cards in HQ"));
  assert.equal(lines[2], "Your HQ: Hedge Fund");
});
