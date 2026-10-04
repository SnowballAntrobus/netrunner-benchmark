/** Games played by chat apps over MCP.
 *
 *  A seat played over MCP is a ChoiceClient like any API model: the game
 *  loop (runLLMGame) asks it to choose, and it parks the decision until
 *  the chat app answers through a tool call. Everything else — auto-
 *  resolution, compound menus, records, frames, the debrief — is the same
 *  code path API games use, so MCP games land in the same corpus format.
 *
 *  A player holds a seat token (returned by new_game / join_game) and
 *  passes it to every call; tokens, not MCP sessions, decide which seat a
 *  call acts for, so two chats in one app can play each other. Calls that
 *  wait for the next decision return after `waitMs` at most (chat clients
 *  time out long calls) and say so; the player then calls wait_for_turn.
 */
import { randomBytes } from "node:crypto";
import { assertQualified, loadPoolManifest } from "../cardpool.js";
import type { ChatMessage, ChoiceAttempt, ChoiceClient, ChoiceContext, SummaryResult } from "../llm.js";
import {
  PlayerResigned,
  runLLMGame,
  type DecisionView,
  type LiveEvent,
  type LLMGameRecord,
  type SeatDriver,
  type SeatMode,
} from "../llmgame.js";
import type { Seat } from "../prompts.js";

const ZERO_USAGE = { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 };
const SEAT_NAME: Record<Seat, string> = { corp: "Corp", runner: "Runner" };

export type Opponent = "rules-ai" | "mcp" | "mock";
export interface ClientInfo {
  name: string;
  version: string;
}

type Pending =
  | {
      kind: "decision";
      seq: number;
      text: string;
      optionCount: number;
      resolve: (a: ChoiceAttempt) => void;
      reject: (e: Error) => void;
    }
  | { kind: "debrief"; text: string; resolve: (r: SummaryResult) => void; reject: (e: Error) => void };

/** What a waiting call returns to the player. */
export interface Turn {
  status: "decision" | "debrief" | "waiting" | "finished";
  text: string;
  seq?: number;
  optionCount?: number;
}

const token = (bytes: number): string => randomBytes(bytes).toString("base64url");

export class McpSeat implements ChoiceClient {
  readonly token = token(18);
  model: string;
  client: ClientInfo | null;
  joined: boolean;
  /** Join code for the second player (opponent "mcp"), until used. */
  joinCode: string | null = null;
  system: string | null = null;
  state: Record<string, unknown> | null = null;
  pending: Pending | null = null;
  resigned = false;
  /** The rules and interface text has been shown to the player. */
  introduced = false;
  private waiters: (() => void)[] = [];

  constructor(
    readonly game: HostedGame,
    readonly seat: Seat,
    player: string | null,
    client: ClientInfo | null
  ) {
    this.model = player ?? "";
    this.client = client;
    this.joined = player !== null;
  }

  async chooseOption(system: string, messages: ChatMessage[], context: ChoiceContext): Promise<ChoiceAttempt> {
    this.system = system;
    if (this.resigned) throw new PlayerResigned("player resigned");
    const text = messages[messages.length - 1]?.content ?? "";
    return new Promise((resolve, reject) => {
      this.pending = {
        kind: "decision",
        seq: context.seq ?? 0,
        text,
        optionCount: context.optionCount,
        resolve,
        reject,
      };
      this.wake();
    });
  }

  /** Only the postgame debrief reaches here: the harness never compacts a
   *  client-held conversation. */
  async summarize(system: string, messages: ChatMessage[]): Promise<SummaryResult> {
    this.system = system;
    if (this.resigned) throw new PlayerResigned("player resigned");
    const text = messages[messages.length - 1]?.content ?? "";
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      this.pending = {
        kind: "debrief",
        text,
        resolve: (r) => resolve({ ...r, latencyMs: Date.now() - startedAt }),
        reject,
      };
      this.wake();
    });
  }

  /** Answer the pending decision. Throws a player-facing message on misuse. */
  choose(option: number, reasoning: string): void {
    const p = this.pending;
    if (!p || p.kind !== "decision") {
      throw new Error(
        p ? "The game is over: answer the debrief with answer_debrief." : "No decision is waiting for you. Call wait_for_turn."
      );
    }
    if (!Number.isInteger(option) || option < 0 || option >= p.optionCount) {
      throw new Error(`option must be an integer from 0 to ${p.optionCount - 1}.`);
    }
    this.pending = null;
    const raw = JSON.stringify({ reasoning, option });
    p.resolve({ parsed: { option, reasoning }, raw, usage: { ...ZERO_USAGE } });
  }

  answerDebrief(text: string): void {
    const p = this.pending;
    if (!p || p.kind !== "debrief") throw new Error("There is no debrief to answer.");
    this.pending = null;
    p.resolve({ text, usage: { ...ZERO_USAGE }, latencyMs: 0, truncated: false });
  }

  resign(): void {
    this.resigned = true;
    const p = this.pending;
    this.pending = null;
    p?.reject(new PlayerResigned("player resigned"));
    this.wake();
  }

  wake(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  /** Resolve on the next change (a prompt, the game ending) or after `ms`. */
  changed(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export interface NewGame {
  seat: Seat;
  opponent: Opponent;
  player: string;
  client: ClientInfo | null;
  corpDeck: string;
  runnerDeck: string;
  seed: number;
  view: DecisionView;
  rules: "official" | "digest";
}

export class HostedGame {
  readonly id = `g${token(4).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
  readonly seats: Partial<Record<Seat, McpSeat>> = {};
  status: "waiting" | "running" | "finished" = "waiting";
  record: LLMGameRecord | null = null;
  error: string | null = null;
  constructor(readonly config: NewGame) {}

  get mcpSeats(): McpSeat[] {
    return Object.values(this.seats);
  }

  describe(): string {
    const c = this.config;
    return `${c.corpDeck} (Corp) vs ${c.runnerDeck} (Runner), seed ${c.seed}`;
  }

  finish(): void {
    this.status = "finished";
    for (const s of this.mcpSeats) s.wake();
  }
}

export interface HostOptions {
  repoRoot: string;
  outDir: string;
  /** Longest a waiting tool call blocks before answering "still waiting". */
  waitMs?: number;
  onEvent?: (event: LiveEvent) => void;
  /** Appended to the harness URL (e.g. "&invariant=1"). */
  extraParams?: string;
  allowUnqualified?: boolean;
  log?: (line: string) => void;
}

export class GameHost {
  private games = new Map<string, HostedGame>();
  private seatsByToken = new Map<string, McpSeat>();
  private seatsByJoinCode = new Map<string, McpSeat>();
  readonly waitMs: number;

  constructor(private readonly options: HostOptions) {
    this.waitMs = options.waitMs ?? 45_000;
  }

  private log(line: string): void {
    (this.options.log ?? console.error)(line);
  }

  /** Qualified precons by side (decks that failed qualification are left out). */
  async decks(): Promise<{ corp: string[]; runner: string[] }> {
    const manifest = await loadPoolManifest(this.options.repoRoot);
    const out = { corp: [] as string[], runner: [] as string[] };
    for (const [name, d] of Object.entries(manifest?.decks ?? {})) {
      if (d.qualified) out[d.side].push(name);
    }
    out.corp.sort();
    out.runner.sort();
    return out;
  }

  async newGame(config: NewGame): Promise<McpSeat> {
    await assertQualified(this.options.repoRoot, [config.corpDeck, config.runnerDeck], !!this.options.allowUnqualified);
    const game = new HostedGame(config);
    const own = new McpSeat(game, config.seat, config.player, config.client);
    game.seats[config.seat] = own;
    this.seatsByToken.set(own.token, own);
    if (config.opponent === "mcp") {
      const other: Seat = config.seat === "runner" ? "corp" : "runner";
      const seat = new McpSeat(game, other, null, null);
      seat.joinCode = `NR-${token(6).toUpperCase().replace(/[^A-Z0-9]/g, "X")}`;
      game.seats[other] = seat;
      this.seatsByToken.set(seat.token, seat);
      this.seatsByJoinCode.set(seat.joinCode, seat);
    }
    this.games.set(game.id, game);
    this.log(`game ${game.id}: created by ${config.player} (${SEAT_NAME[config.seat]}) — ${game.describe()}, opponent ${config.opponent}`);
    if (game.mcpSeats.every((s) => s.joined)) this.start(game);
    return own;
  }

  join(code: string, player: string, client: ClientInfo | null): McpSeat {
    const seat = this.seatsByJoinCode.get(code.trim());
    if (!seat) throw new Error("Unknown or already used join code.");
    this.seatsByJoinCode.delete(seat.joinCode!);
    seat.joinCode = null;
    seat.joined = true;
    seat.model = player;
    seat.client = client;
    this.log(`game ${seat.game.id}: ${player} joined as the ${SEAT_NAME[seat.seat]}`);
    if (seat.game.mcpSeats.every((s) => s.joined)) this.start(seat.game);
    return seat;
  }

  /** Concede: the game ends as "resigned" (or is dropped if it never started). */
  resign(seat: McpSeat): void {
    seat.resign();
    if (seat.game.status === "waiting") {
      seat.game.error = "abandoned before the game started";
      for (const s of seat.game.mcpSeats) if (s.joinCode) this.seatsByJoinCode.delete(s.joinCode);
      seat.game.finish();
    }
    this.log(`game ${seat.game.id}: the ${SEAT_NAME[seat.seat]} resigned`);
  }

  seat(tokenValue: string): McpSeat {
    const seat = this.seatsByToken.get(tokenValue.trim());
    if (!seat) throw new Error("Unknown seat token. Use the token new_game or join_game returned.");
    return seat;
  }

  private start(game: HostedGame): void {
    const c = game.config;
    game.status = "running";
    const mcp = game.mcpSeats;
    const mode: SeatMode = c.opponent === "rules-ai" ? c.seat : "both";
    const label = (seat: Seat): string => game.seats[seat]?.model ?? "mock";
    const drivers: Partial<Record<Seat, SeatDriver>> = {};
    for (const s of mcp) drivers[s.seat] = { driver: "mcp", client: s.client };
    runLLMGame({
      repoRoot: this.options.repoRoot,
      seed: c.seed,
      corpPrecon: c.corpDeck,
      runnerPrecon: c.runnerDeck,
      seat: mode,
      model: label(c.seat),
      ...(mode === "both" ? { corpModel: label("corp"), runnerModel: label("runner") } : {}),
      rulesSource: c.rules,
      profile: "neutral",
      reasoningStyle: "brief",
      contextMode: "client",
      decisionView: c.view,
      autoResolve: true,
      actions: "compound",
      aiBranches: "neutral",
      debrief: true,
      frames: true,
      // People take their time: the whole-game limit is generous, and the
      // stall check pauses while a decision waits on a player.
      timeoutMs: 7 * 24 * 3600 * 1000,
      outDir: this.options.outDir,
      extraParams: this.options.extraParams ?? "",
      seatDrivers: drivers,
      clientFactory: (seat) => game.seats[seat],
      awaitingClient: () => mcp.some((s) => s.pending !== null),
      onSystemPrompt: (seat, text) => {
        const s = game.seats[seat];
        if (s) {
          s.system = text;
          s.wake();
        }
      },
      onModelDecision: (seat, request) => {
        const s = game.seats[seat];
        if (s) s.state = request.state;
      },
      ...(this.options.onEvent ? { onEvent: this.options.onEvent } : {}),
    }).then(
      (record) => {
        game.record = record;
        this.log(
          `game ${game.id}: ${record.status}` +
            (record.winner ? ` — ${record.winner} wins (${record.reason})` : "") +
            ` → ${record.decisionLogPath.replace(/[\\/]decisions\.jsonl$/, "")}`
        );
        game.finish();
      },
      (err: unknown) => {
        game.error = String(err instanceof Error ? err.message : err);
        this.log(`game ${game.id}: failed — ${game.error}`);
        game.finish();
      }
    );
    this.log(`game ${game.id}: started`);
  }

  /** The seat's current prompt, waiting up to waitMs for one to appear. */
  async nextTurn(seat: McpSeat, waitMs = this.waitMs): Promise<Turn> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const p = seat.pending;
      if (p?.kind === "decision") return { status: "decision", text: p.text, seq: p.seq, optionCount: p.optionCount };
      if (p?.kind === "debrief") {
        return { status: "debrief", text: `${p.text}\n\nReply by calling answer_debrief with your answers.` };
      }
      if (seat.game.status === "finished") return { status: "finished", text: this.finalText(seat) };
      const left = deadline - Date.now();
      if (left <= 0) return { status: "waiting", text: this.waitingText(seat) };
      await seat.changed(left);
    }
  }

  /** The seat's system prompt, once the game has built it (shortly after start). */
  async systemPrompt(seat: McpSeat, waitMs = this.waitMs): Promise<string | null> {
    const deadline = Date.now() + waitMs;
    while (seat.system === null && seat.game.status !== "finished" && Date.now() < deadline) {
      if (seat.game.status === "waiting") return null;
      await seat.changed(Math.min(1000, deadline - Date.now()));
    }
    return seat.system;
  }

  private waitingText(seat: McpSeat): string {
    const game = seat.game;
    if (game.status === "waiting") {
      const other = game.mcpSeats.find((s) => !s.joined);
      return (
        "The game starts when the other player joins" +
        (other?.joinCode ? ` (join code ${other.joinCode})` : "") +
        ". Call wait_for_turn to keep waiting."
      );
    }
    if (seat.system === null) return "The game is starting. Call wait_for_turn to continue.";
    return "It is not your decision yet: the other player is deciding. Call wait_for_turn to keep waiting.";
  }

  private finalText(seat: McpSeat): string {
    const r = seat.game.record;
    if (!r) return `The game ended with an error: ${seat.game.error ?? "unknown"}.`;
    const runDir = r.decisionLogPath.replace(/[\\/]decisions\.jsonl$/, "");
    const result =
      r.status === "completed"
        ? `${r.winner === "corp" ? "The Corp" : "The Runner"} won (${r.reason}), agenda points ${r.corpAgendaPoints}–${r.runnerAgendaPoints} (Corp–Runner).`
        : `The game ended without a result (${r.status}).`;
    return `The game is over. ${result} The record is saved in ${runDir}.`;
  }
}
