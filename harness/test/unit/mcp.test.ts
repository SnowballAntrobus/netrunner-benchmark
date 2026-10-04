/** The MCP host and tools without a browser: seat answers, join codes,
 *  tokens, resignation before the game starts, and tool errors. The
 *  end-to-end test plays whole games (test/e2e/mcp.test.ts). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { outDir, repoRoot } from "../../src/commands/args.js";
import type { ChoiceAttempt, SummaryResult } from "../../src/llm.js";
import { PlayerResigned } from "../../src/llmgame.js";
import { GameHost, HostedGame, McpSeat, type NewGame } from "../../src/mcp/host.js";
import { createMcpServer } from "../../src/mcp/server.js";

const config: NewGame = {
  seat: "runner",
  opponent: "mcp",
  player: "tester",
  client: null,
  corpDeck: "Gateway Corp",
  runnerDeck: "Gateway Runner",
  seed: 1,
  view: "full",
  rules: "digest",
};

function seat(): McpSeat {
  return new McpSeat(new HostedGame(config), "runner", "tester", { name: "test-app", version: "1" });
}

const ask = (s: McpSeat, optionCount: number): Promise<ChoiceAttempt> =>
  s.chooseOption("SYSTEM", [{ role: "user", content: "DECISION" }], { callIndex: 1, attempt: 1, optionCount, seq: 7 });

test("a seat parks each decision until the player answers it", async () => {
  const s = seat();
  assert.throws(() => s.choose(0, "early"), /No decision is waiting/);
  const answer = ask(s, 3);
  assert.equal(s.system, "SYSTEM");
  assert.equal(s.pending?.kind, "decision");
  assert.throws(() => s.choose(3, "out of range"), /integer from 0 to 2/);
  assert.throws(() => s.choose(1.5, "not an integer"), /integer from 0 to 2/);
  s.choose(2, "because");
  const a = await answer;
  assert.deepEqual(a.parsed, { option: 2, reasoning: "because" });
  assert.deepEqual(JSON.parse(a.raw), { reasoning: "because", option: 2 });
  assert.equal(a.usage.tokensIn, 0);
  assert.equal(s.pending, null);
});

test("the debrief is answered once, with the player's text", async () => {
  const s = seat();
  assert.throws(() => s.answerDebrief("nothing asked"), /no debrief/);
  const reply: Promise<SummaryResult> = s.summarize("SYSTEM", [{ role: "user", content: "QUESTIONS" }]);
  assert.throws(() => s.choose(0, "x"), /answer the debrief/);
  s.answerDebrief("answers");
  assert.equal((await reply).text, "answers");
});

test("resigning rejects the waiting decision and every later one", async () => {
  const s = seat();
  const answer = ask(s, 2);
  s.resign();
  await assert.rejects(answer, PlayerResigned);
  await assert.rejects(ask(s, 2), PlayerResigned);
});

test("waiting returns on a change or after the limit", async () => {
  const s = seat();
  const t0 = Date.now();
  await s.changed(50);
  assert.ok(Date.now() - t0 >= 40);
  const woken = s.changed(10_000);
  s.wake();
  await woken;
});

const host = (): GameHost => new GameHost({ repoRoot, outDir, waitMs: 100, log: () => {} });

test("a two-player game waits for its join code, which works once", async () => {
  const h = host();
  const own = await h.newGame(config);
  assert.equal(own.game.status, "waiting");
  assert.equal(h.seat(own.token), own);
  const other = own.game.seats.corp!;
  assert.match(other.joinCode!, /^NR-[A-Z0-9]{8}$/);
  const turn = await h.nextTurn(own);
  assert.equal(turn.status, "waiting");
  assert.ok(turn.text.includes(other.joinCode!));
  assert.throws(() => h.join("NR-WRONG", "x", null), /Unknown or already used join code/);
  assert.throws(() => h.seat("not-a-token"), /Unknown seat token/);
  // Abandon before the second player joins: no game is ever started.
  h.resign(own);
  assert.equal(own.game.status, "finished");
  assert.throws(() => h.join(other.joinCode ?? "NR-USED", "late", null), /Unknown or already used/);
  const end = await h.nextTurn(own);
  assert.equal(end.status, "finished");
  assert.match(end.text, /abandoned before the game started/);
});

test("decks that failed qualification cannot be played", async () => {
  const h = host();
  const decks = await h.decks();
  assert.ok(decks.corp.includes("Gateway Corp") && decks.runner.includes("Gateway Runner"));
  assert.ok(!decks.corp.includes("Agency"));
  await assert.rejects(h.newGame({ ...config, corpDeck: "Agency" }), /failed pool qualification/);
});

async function connect(): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(host(), "test").connect(a);
  const client = new Client({ name: "unit-test-app", version: "2.0" });
  await client.connect(b);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
  return { text: r.content.map((c) => c.text ?? "").join("\n"), isError: r.isError === true };
}

test("the tools: list, create, wait, resign, and errors as tool results", async () => {
  const client = await connect();
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    "answer_debrief",
    "choose_option",
    "get_rules",
    "get_state",
    "join_game",
    "list_decks",
    "new_game",
    "resign",
    "wait_for_turn",
  ]);
  assert.match((await call(client, "list_decks", {})).text, /Corp decks:\n(- .+\n)+\nRunner decks:/);

  const start = await call(client, "new_game", { seat: "corp", opponent: "mcp", player: "tester", seed: 3 });
  assert.equal(start.isError, false);
  assert.match(start.text, /you play the Corp\. Gateway Corp \(Corp\) vs Gateway Runner \(Runner\), seed 3\./);
  assert.match(start.text, /The game starts when the other player joins \(join code NR-/);
  const token = start.text.match(/Your seat token is (\S+?)\./)![1]!;

  assert.match((await call(client, "get_state", { token })).text, /No decision has reached you yet/);
  assert.match((await call(client, "get_rules", { token })).text, /has not started yet/);
  const early = await call(client, "choose_option", { token, reasoning: "x", option: 0 });
  assert.equal(early.isError, true);
  assert.match(early.text, /No decision is waiting/);
  assert.equal((await call(client, "join_game", { join_code: "NR-NOPE", player: "x" })).isError, true);

  assert.match((await call(client, "resign", { token })).text, /You resigned/);
  assert.match((await call(client, "wait_for_turn", { token })).text, /abandoned before the game started/);
  await client.close();
});
