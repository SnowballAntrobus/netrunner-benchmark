/** The MCP tools. Descriptions state mechanics only: like every word the
 *  harness shows a model, they carry no strategy advice. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ClientInfo, GameHost, McpSeat, Turn } from "./host.js";

export const SERVER_INSTRUCTIONS =
  "Plays games of Android: Netrunner. Start one with new_game (or join one with join_game " +
  "and a join code), then answer each decision with choose_option until the game ends. " +
  "Every call after that takes the seat token new_game or join_game returned; get_rules " +
  "shows the rules and interface for your seat again.";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const reply = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const failure = (e: unknown): ToolResult => ({
  content: [{ type: "text", text: String(e instanceof Error ? e.message : e) }],
  isError: true,
});
const SEAT_NAME = { corp: "Corp", runner: "Runner" } as const;

const tokenField = z.string().describe("Your seat token, from new_game or join_game.");

export function createMcpServer(host: GameHost, version: string): McpServer {
  const server = new McpServer({ name: "netrunner-benchmark", version }, { instructions: SERVER_INSTRUCTIONS });
  const client = (): ClientInfo | null => {
    const v = server.server.getClientVersion();
    return v ? { name: v.name, version: v.version } : null;
  };
  /** A turn's text, preceded the first time by the seat's rules and
   *  interface (the system prompt an API model would get). */
  const deliver = (seat: McpSeat, turn: Turn): string => {
    if (!seat.introduced && seat.system) {
      seat.introduced = true;
      return (
        "=== Game rules and interface for your seat ===\n\n" +
        `${seat.system}\n\n=== End of rules and interface ===\n\n${turn.text}`
      );
    }
    return turn.text;
  };
  const guarded =
    <A>(fn: (args: A) => Promise<string>) =>
    async (args: A): Promise<ToolResult> => {
      try {
        return reply(await fn(args));
      } catch (e) {
        return failure(e);
      }
    };

  server.registerTool(
    "list_decks",
    {
      description: "List the preconstructed decks available to new_game, by side.",
      annotations: { readOnlyHint: true },
    },
    guarded(async () => {
      const d = await host.decks();
      return `Corp decks:\n${d.corp.map((n) => `- ${n}`).join("\n")}\n\nRunner decks:\n${d.runner.map((n) => `- ${n}`).join("\n")}`;
    })
  );

  server.registerTool(
    "new_game",
    {
      description:
        "Start a game of Android: Netrunner in which you play one seat. The opponent is the " +
        'rules-based AI ("rules-ai"), another player who joins with a code ("mcp"), or a player ' +
        'making random legal moves, for testing ("mock"). Returns your seat token, the rules and ' +
        "interface for your seat, and your first decision.",
      inputSchema: {
        seat: z.enum(["runner", "corp"]).default("runner").describe("The seat you play."),
        opponent: z.enum(["rules-ai", "mcp", "mock"]).default("rules-ai"),
        player: z
          .string()
          .min(1)
          .describe("Who plays this seat, for the game record: the model and app, e.g. 'Claude Opus 5 (Claude app)'."),
        corp_deck: z.string().optional().describe("Corp precon (default Gateway Corp); see list_decks."),
        runner_deck: z.string().optional().describe("Runner precon (default Gateway Runner); see list_decks."),
        seed: z.number().int().optional().describe("Game seed (default random)."),
        view: z
          .enum(["full", "compact"])
          .default("full")
          .describe("full: each decision includes the game state JSON. compact: a status line and the recent log; call get_state for the state."),
        rules: z
          .enum(["digest", "official"])
          .default("digest")
          .describe(
            "Rules text: a short digest, or the official learn-to-play guides (about 30K tokens, more than some apps accept in one tool result)."
          ),
      },
    },
    guarded(async (a) => {
      const seat = await host.newGame({
        seat: a.seat,
        opponent: a.opponent,
        player: a.player,
        client: client(),
        corpDeck: a.corp_deck ?? "Gateway Corp",
        runnerDeck: a.runner_deck ?? "Gateway Runner",
        seed: a.seed ?? 1 + Math.floor(Math.random() * 999_999),
        view: a.view,
        rules: a.rules,
      });
      const game = seat.game;
      const other = game.mcpSeats.find((s) => s !== seat);
      const head = [
        `Game ${game.id}: you play the ${SEAT_NAME[seat.seat]}. ${game.describe()}.`,
        `Your seat token is ${seat.token}. Pass it to every call for this game.`,
        ...(other?.joinCode
          ? [`Join code for the other player: ${other.joinCode}. In their conversation, they call join_game with it.`]
          : []),
      ].join("\n");
      await host.systemPrompt(seat);
      return `${head}\n\n${deliver(seat, await host.nextTurn(seat))}`;
    })
  );

  server.registerTool(
    "join_game",
    {
      description:
        "Join a game another player created, with its join code. Returns your seat token, the " +
        "rules and interface for your seat, and your first decision.",
      inputSchema: {
        join_code: z.string().describe("The join code new_game gave the other player."),
        player: z.string().min(1).describe("Who plays this seat, for the game record: the model and app."),
      },
    },
    guarded(async (a) => {
      const seat = host.join(a.join_code, a.player, client());
      const head =
        `Game ${seat.game.id}: you play the ${SEAT_NAME[seat.seat]}. ${seat.game.describe()}.\n` +
        `Your seat token is ${seat.token}. Pass it to every call for this game.`;
      await host.systemPrompt(seat);
      return `${head}\n\n${deliver(seat, await host.nextTurn(seat))}`;
    })
  );

  server.registerTool(
    "wait_for_turn",
    {
      description:
        "Wait for your next decision or the end of the game. If the other player is still " +
        "deciding after a while, says so: call it again.",
      inputSchema: { token: tokenField },
      annotations: { readOnlyHint: true },
    },
    guarded(async (a) => {
      const seat = host.seat(a.token);
      return deliver(seat, await host.nextTurn(seat));
    })
  );

  server.registerTool(
    "choose_option",
    {
      description:
        "Answer the decision in front of you: your reasoning, then the index of one option from " +
        "its list of legal options. Returns your next decision when it is ready.",
      inputSchema: {
        token: tokenField,
        reasoning: z.string().describe("Your reasoning for this choice."),
        option: z.number().int().describe("The index of the chosen option."),
      },
    },
    guarded(async (a) => {
      const seat = host.seat(a.token);
      seat.choose(a.option, a.reasoning);
      return deliver(seat, await host.nextTurn(seat));
    })
  );

  server.registerTool(
    "get_rules",
    {
      description: "The rules and interface for your seat, as shown with your first decision.",
      inputSchema: { token: tokenField },
      annotations: { readOnlyHint: true },
    },
    guarded(async (a) => {
      const seat = host.seat(a.token);
      return seat.system ?? "Your game has not started yet. Call wait_for_turn.";
    })
  );

  server.registerTool(
    "get_state",
    {
      description: "Your current view of the game state as JSON: the state of your latest decision.",
      inputSchema: { token: tokenField },
      annotations: { readOnlyHint: true },
    },
    guarded(async (a) => {
      const seat = host.seat(a.token);
      if (!seat.state) return "No decision has reached you yet, so there is no state to show. Call wait_for_turn.";
      return JSON.stringify(seat.state);
    })
  );

  server.registerTool(
    "answer_debrief",
    {
      description: "After the game, answer the debrief questions.",
      inputSchema: { token: tokenField, answers: z.string().describe("Your answers to the debrief questions.") },
    },
    guarded(async (a) => {
      const seat = host.seat(a.token);
      seat.answerDebrief(a.answers);
      return (await host.nextTurn(seat)).text;
    })
  );

  server.registerTool(
    "resign",
    {
      description: "Concede the game. The game ends and is recorded as resigned.",
      inputSchema: { token: tokenField },
      annotations: { destructiveHint: true },
    },
    guarded(async (a) => {
      const seat = host.seat(a.token);
      host.resign(seat);
      return "You resigned. The game is over.";
    })
  );

  return server;
}
