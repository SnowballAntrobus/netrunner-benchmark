/** MCP server end to end: scripted MCP clients play whole games with random
 *  legal moves through the real server, transport and game loop. Needs
 *  Chromium (Playwright); no API keys. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { outDir, repoRoot } from "../../src/commands/args.js";
import { GameHost } from "../../src/mcp/host.js";
import { serveHttp, type McpHttpServer } from "../../src/mcp/http.js";

let server: McpHttpServer;

before(async () => {
  // Short waits so the "keep waiting" path is exercised too.
  const host = new GameHost({ repoRoot, outDir, waitMs: 3000, extraParams: "&invariant=1", log: () => {} });
  server = await serveHttp(host, { port: 0, version: "test" });
});

after(async () => {
  await server.close();
});

async function connect(name: string): Promise<Client> {
  const client = new Client({ name, version: "1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  return client;
}

async function call(client: Client, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const r = (await client.callTool({ name: tool, arguments: args })) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  return { text: r.content.map((c) => c.text ?? "").join("\n"), isError: r.isError === true };
}

function lcg(seed: number): () => number {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 48271) % 2147483647) / 2147483647;
}

/** Answer every decision with a random legal option until the game ends. */
async function playOut(client: Client, token: string, first: string, seed: number): Promise<{ final: string; decisions: number }> {
  const rand = lcg(seed);
  let text = first;
  let decisions = 0;
  for (let step = 0; step < 20_000; step++) {
    const options = text.match(/Choose one option index \(0-(\d+)\)/);
    if (options) {
      decisions++;
      const option = Math.floor(rand() * (parseInt(options[1]!, 10) + 1));
      text = (await call(client, "choose_option", { token, reasoning: "random legal move (test)", option })).text;
    } else if (text.includes("answer_debrief")) {
      text = (await call(client, "answer_debrief", { token, answers: "test debrief answers" })).text;
    } else if (text.includes("The game is over")) {
      return { final: text, decisions };
    } else {
      assert.match(text, /wait_for_turn/, `unexpected tool result: ${text.slice(0, 300)}`);
      text = (await call(client, "wait_for_turn", { token })).text;
    }
  }
  throw new Error("game did not end");
}

const tokenOf = (text: string): string => text.match(/Your seat token is (\S+?)\./)![1]!;

function checkRecord(final: string, seat: "runner" | "corp", clientName: string): Record<string, unknown> {
  const dir = final.match(/The record is saved in (.+?)\.$/m)![1]!;
  const record = JSON.parse(readFileSync(join(dir, "record.json"), "utf-8")) as {
    status: string;
    contextMode: string;
    invalidRecords: number;
    invariantViolations?: unknown[];
    seats: Record<string, { driver: string; client: { name: string } | null; llmDecisions: number }>;
  };
  assert.equal(record.status, "completed");
  assert.equal(record.contextMode, "client");
  assert.equal(record.invalidRecords, 0);
  assert.deepEqual(record.invariantViolations ?? [], []);
  assert.equal(record.seats[seat]!.driver, "mcp");
  assert.equal(record.seats[seat]!.client?.name, clientName);
  assert.ok(existsSync(join(dir, "frames.jsonl")));
  const rows = readFileSync(join(dir, "decisions.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { seat: string; model: string | null; reasoning: string | null });
  const answered = rows.filter((r) => r.seat === seat && r.model !== null);
  assert.equal(answered.length, record.seats[seat]!.llmDecisions);
  assert.ok(answered.every((r) => r.reasoning === "random legal move (test)"));
  return record;
}

test("a chat app plays the Runner against the rules AI", async () => {
  const client = await connect("netrunner-test");
  const decks = await call(client, "list_decks", {});
  assert.match(decks.text, /Gateway Runner/);
  const start = await call(client, "new_game", {
    seat: "runner",
    opponent: "rules-ai",
    player: "random test player",
    seed: 5,
  });
  assert.equal(start.isError, false, start.text);
  assert.match(start.text, /=== Game rules and interface for your seat ===/);
  assert.match(start.text, /answer it by calling choose_option/);
  const token = tokenOf(start.text);
  const state = await call(client, "get_state", { token });
  assert.match(state.text, /"viewer":"runner"/);
  const rules = await call(client, "get_rules", { token });
  assert.ok(start.text.includes(rules.text), "get_rules repeats the rules shown at the start");
  assert.match(rules.text, /# How you play/);
  // Misuse is reported, not fatal.
  assert.equal((await call(client, "choose_option", { token, reasoning: "x", option: 999 })).isError, true);
  assert.equal((await call(client, "wait_for_turn", { token: "not-a-token" })).isError, true);
  const { final, decisions } = await playOut(client, token, start.text, 11);
  assert.ok(decisions > 0);
  const dir = final.match(/The record is saved in (.+?)\.$/m)![1]!;
  checkRecord(final, "runner", "netrunner-test");
  const debrief = JSON.parse(readFileSync(join(dir, "debrief.json"), "utf-8")) as { text: string; seat: string };
  assert.equal(debrief.text, "test debrief answers");
  await client.close();
});

test("two chat apps play each other, compact view", async () => {
  const corp = await connect("corp-app");
  const runner = await connect("runner-app");
  const start = await call(corp, "new_game", {
    seat: "corp",
    opponent: "mcp",
    player: "corp test player",
    seed: 9,
    rules: "digest",
    view: "compact",
  });
  const code = start.text.match(/Join code for the other player: (\S+?)\./)![1]!;
  assert.match(start.text, /starts when the other player joins/);
  const joined = await call(runner, "join_game", { join_code: code, player: "runner test player" });
  assert.equal(joined.isError, false, joined.text);
  assert.equal((await call(runner, "join_game", { join_code: code, player: "again" })).isError, true);
  const corpToken = tokenOf(start.text);
  const runnerToken = tokenOf(joined.text);
  const [c, r] = await Promise.all([
    playOut(corp, corpToken, start.text, 3),
    playOut(runner, runnerToken, joined.text, 4),
  ]);
  assert.equal(c.final, r.final);
  const record = checkRecord(c.final, "corp", "corp-app") as { decisionView: string; seats: Record<string, { driver: string }> };
  assert.equal(record.decisionView, "compact");
  assert.equal(record.seats["runner"]!.driver, "mcp");
  await corp.close();
  await runner.close();
});
