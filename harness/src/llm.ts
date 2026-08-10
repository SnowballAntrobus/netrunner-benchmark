/** LLM clients + transcript + retry bridge (PHASE1 M4; D01 conversational).
 *
 *  AnthropicClient: forced tool call ("choose_option") so the response is
 *  schema-validated JSON at the API layer; system prompt carries a
 *  prompt-cache breakpoint (static per game); in conversational mode a
 *  second, moving breakpoint sits on the last transcript turn so the whole
 *  immutable history prefix is a cache hit.
 *
 *  Transcript (D01): the append-only conversation history. The Messages API
 *  is stateless — the "conversation" exists only because we re-send it.
 *  Assistant turns store the raw JSON of the model's accepted tool call as
 *  plain text (the same convention the retry loop has always used), which
 *  sidesteps tool_use/tool_result echo requirements while preserving every
 *  word of the model's reasoning verbatim. Compaction: when the observed
 *  request size crosses the threshold, the model writes a summary FOR ITS
 *  FUTURE SELF and the transcript restarts as [notice] + [its summary] +
 *  [last K exchanges verbatim] — the Claude-Plays-Pokémon reset shape.
 *
 *  MockClient: deterministic, keyless — CI's end-to-end path. Injects one
 *  transient malformed response (exercises retry) and one persistently
 *  malformed decision (exercises fallback), then picks seeded-random legal
 *  options. Reports SYNTHETIC usage (≈ chars/4) so the compaction path is
 *  exercised keylessly with the production threshold.
 */
import Anthropic from "@anthropic-ai/sdk";

export interface Usage {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One conversation message. `cache: true` marks a prompt-cache breakpoint
 *  (rendered as a content-block cache_control by AnthropicClient). */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  cache?: boolean;
}

export interface ChoiceAttempt {
  parsed: { option: number; reasoning: string } | null;
  raw: string;
  usage: Usage;
}

export interface ChoiceContext {
  callIndex: number; // nth LLM decision this game (1-based)
  attempt: number; // 1-based attempt number for this decision
  optionCount: number;
}

export interface SummaryResult {
  text: string;
  usage: Usage;
  latencyMs: number;
}

export interface ChoiceClient {
  readonly model: string;
  chooseOption(
    system: string,
    messages: ChatMessage[],
    context: ChoiceContext
  ): Promise<ChoiceAttempt>;
  /** Free-text call (no forced tool) — used for compaction summaries. */
  summarize(system: string, messages: ChatMessage[]): Promise<SummaryResult>;
}

const ZERO_USAGE: Usage = { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 };

function renderMessages(
  messages: ChatMessage[]
): { role: "user" | "assistant"; content: string | { type: "text"; text: string; cache_control: { type: "ephemeral" } }[] }[] {
  return messages.map((m) =>
    m.cache
      ? {
          role: m.role,
          content: [
            { type: "text" as const, text: m.content, cache_control: { type: "ephemeral" as const } },
          ],
        }
      : { role: m.role, content: m.content }
  );
}

function usageOf(response: { usage: Anthropic.Usage }): Usage {
  return {
    tokensIn: response.usage.input_tokens,
    tokensOut: response.usage.output_tokens,
    cacheRead: response.usage.cache_read_input_tokens ?? 0,
    cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
  };
}

export class AnthropicClient implements ChoiceClient {
  readonly model: string;
  private client: Anthropic;
  private maxTokens: number;

  constructor(model: string, maxTokens = 1024) {
    this.model = model;
    this.maxTokens = maxTokens;
    this.client = new Anthropic(); // ANTHROPIC_API_KEY from env
  }

  async chooseOption(
    system: string,
    messages: ChatMessage[],
    _context: ChoiceContext
  ): Promise<ChoiceAttempt> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: [
        {
          type: "text",
          text: system,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [
        {
          name: "choose_option",
          description: "Choose one legal option by index.",
          input_schema: {
            // reasoning FIRST: generated before the option so the choice is
            // conditioned on it (ex-post contamination; arXiv:2508.03368).
            type: "object",
            properties: {
              reasoning: {
                type: "string",
                description: "Your strategic reasoning, written before choosing",
              },
              option: { type: "integer", description: "Index of the chosen option" },
            },
            required: ["reasoning", "option"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "choose_option" },
      messages: renderMessages(messages),
    });
    const usage = usageOf(response);
    const block = response.content.find((b) => b.type === "tool_use");
    if (block && block.type === "tool_use") {
      const input = block.input as { option?: unknown; reasoning?: unknown };
      // Type-level coercion ONLY: models sometimes emit the index as a
      // numeric string ("2"); that is the same choice in the wrong type,
      // so accept it. Out-of-range or non-numeric values still go through
      // the corrective retry loop — never guess a different choice.
      const option =
        typeof input.option === "number"
          ? Math.trunc(input.option)
          : typeof input.option === "string" && /^\s*\d+\s*$/.test(input.option)
            ? parseInt(input.option, 10)
            : null;
      if (option !== null) {
        return {
          parsed: {
            option,
            reasoning: String(input.reasoning ?? ""),
          },
          raw: JSON.stringify(block.input),
          usage,
        };
      }
      return { parsed: null, raw: JSON.stringify(block.input), usage };
    }
    return { parsed: null, raw: JSON.stringify(response.content), usage };
  }

  async summarize(system: string, messages: ChatMessage[]): Promise<SummaryResult> {
    const startedAt = Date.now();
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: [
        { type: "text", text: system, cache_control: { type: "ephemeral" } },
      ],
      messages: renderMessages(messages),
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return { text, usage: usageOf(response), latencyMs: Date.now() - startedAt };
  }
}

/** Seeded LCG (same shape the engine uses) for deterministic mock play. */
function lcg(seed: number): () => number {
  let s = (seed * 48271) % 2147483647 || 1;
  return () => {
    s = (s * 48271) % 2147483647;
    return s / 2147483648;
  };
}

export class MockClient implements ChoiceClient {
  readonly model = "mock";
  private rng: () => number;
  /** callIndex 5: malformed on first attempt only (retry path).
   *  callIndex 9: malformed on every attempt (fallback path). */
  private transientBadAt = 5;
  private persistentBadAt = 9;

  constructor(seed: number) {
    this.rng = lcg(seed + 7919);
  }

  /** Synthetic request size (≈ chars/4) so conversational-mode compaction
   *  triggers keylessly at the production threshold. Decisions themselves
   *  never depend on messages — choices stay LCG-deterministic. */
  private estimateUsage(system: string, messages: ChatMessage[]): Usage {
    let chars = system.length;
    for (const m of messages) chars += m.content.length;
    return { tokensIn: Math.ceil(chars / 4), tokensOut: 32, cacheRead: 0, cacheWrite: 0 };
  }

  async chooseOption(
    system: string,
    messages: ChatMessage[],
    context: ChoiceContext
  ): Promise<ChoiceAttempt> {
    const usage = this.estimateUsage(system, messages);
    if (context.callIndex === this.persistentBadAt) {
      return { parsed: null, raw: "\"I choose to run HQ!\" (mock: persistent-garbage)", usage };
    }
    if (context.callIndex === this.transientBadAt && context.attempt === 1) {
      return {
        parsed: { option: 9999, reasoning: "mock: transient bad index" },
        raw: "{\"option\":9999}",
        usage,
      };
    }
    const option = Math.floor(this.rng() * context.optionCount);
    return {
      parsed: { option, reasoning: "mock: seeded random legal choice" },
      raw: JSON.stringify({ option, reasoning: "mock: seeded random legal choice" }),
      usage,
    };
  }

  async summarize(system: string, messages: ChatMessage[]): Promise<SummaryResult> {
    // Serves both free-text paths (D01 compaction, D07 debrief) — the
    // canned text is deliberately purpose-neutral.
    return {
      text: "mock: free-text response (summarize path exercised keylessly).",
      usage: this.estimateUsage(system, messages),
      latencyMs: 0,
    };
  }
}

export function makeClient(model: string, seed: number, maxTokens = 1024): ChoiceClient {
  if (model === "mock") return new MockClient(seed);
  return new AnthropicClient(model, maxTokens);
}

// ---- transcript (D01) ------------------------------------------------------

export class Transcript {
  /** Append-only user/assistant exchange pairs (post-compaction: notice +
   *  summary + kept pairs). Content is immutable once appended — the
   *  prompt-cache prefix depends on it. */
  private turns: ChatMessage[] = [];
  /** Last observed request size (system + history + decision message),
   *  from API usage data; null until the first decision (and reset by
   *  compaction, whose reshuffle invalidates the estimate). */
  promptTokens: number | null = null;
  compactions = 0;

  constructor(
    readonly threshold: number,
    readonly keepPairs: number
  ) {}

  /** History to send: cache breakpoint on the final (most recent) turn so
   *  the whole immutable prefix is one cache hit. */
  messages(): ChatMessage[] {
    return this.turns.map((t, i) =>
      i === this.turns.length - 1 ? { ...t, cache: true } : t
    );
  }

  append(userContent: string, assistantContent: string): void {
    this.turns.push(
      { role: "user", content: userContent },
      { role: "assistant", content: assistantContent }
    );
  }

  notePromptTokens(n: number): void {
    this.promptTokens = n;
  }

  shouldCompact(): boolean {
    return (
      this.promptTokens !== null &&
      this.promptTokens > this.threshold &&
      this.turns.length > this.keepPairs * 2
    );
  }

  /** Replace the transcript with [notice] + [model's own summary] + the
   *  last keepPairs exchanges verbatim. Returns how many exchanges were
   *  dropped (compacted into the summary). */
  compact(summary: string): { droppedPairs: number; keptPairs: number } {
    const kept = this.turns.slice(-this.keepPairs * 2);
    const droppedPairs = Math.floor((this.turns.length - kept.length) / 2);
    this.turns = [
      {
        role: "user",
        content:
          "[Transcript compacted to fit the context window. The summary you " +
          "wrote for your future self follows; after it, your most recent " +
          "exchanges continue verbatim.]",
      },
      { role: "assistant", content: summary },
      ...kept,
    ];
    this.promptTokens = null;
    this.compactions++;
    return { droppedPairs, keptPairs: Math.floor(kept.length / 2) };
  }
}

// ---- retry bridge ----------------------------------------------------------

/** D10: a FAILED attempt, kept for forensics (game 2's 28 retries were
 *  unexplainable because only accepted attempts were recorded). */
export interface FailedAttempt {
  raw: string;
  problem: "unparseable" | "missing-option" | "out-of-range";
}

export interface BridgeResult {
  option: number;
  reasoning: string;
  raw: string;
  retries: number;
  fallback: boolean;
  usage: Usage;
  latencyMs: number;
  /** Request size (input + cache read + cache write) of the LAST attempt —
   *  the observed transcript-plus-decision footprint driving compaction. */
  promptTokens: number;
  /** D10: failed attempts in order (empty when first attempt succeeded —
   *  the overwhelming majority). The accepted attempt stays in `raw`. */
  attempts: FailedAttempt[];
}

const MAX_ATTEMPTS = 3;

/** D10 classification of a failed attempt. `parsed` null with raw that is
 *  a JSON OBJECT means the tool input existed but carried no usable
 *  option; non-object raw is unparseable output; a parsed-but-invalid
 *  index is out-of-range. */
function classifyFailure(parsed: { option: number } | null, raw: string): FailedAttempt["problem"] {
  if (parsed !== null) return "out-of-range";
  try {
    const v: unknown = JSON.parse(raw);
    if (v !== null && typeof v === "object" && !Array.isArray(v)) return "missing-option";
  } catch {
    /* not JSON at all */
  }
  return "unparseable";
}

/** Retry loop: malformed or out-of-range responses get one corrective
 *  follow-up message per retry; after MAX_ATTEMPTS, fall back to option 0
 *  with the incident flagged. Retries stay INSIDE the decision — the
 *  corrective exchanges never enter the transcript (history is passed in,
 *  never mutated here). */
export async function decideWithRetries(
  client: ChoiceClient,
  system: string,
  history: ChatMessage[],
  decisionMessage: string,
  callIndex: number,
  optionCount: number
): Promise<BridgeResult> {
  const startedAt = Date.now();
  const usage: Usage = { ...ZERO_USAGE };
  const messages: ChatMessage[] = [
    ...history,
    { role: "user", content: decisionMessage },
  ];
  let lastRaw = "";
  let promptTokens = 0;
  const attempts: FailedAttempt[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await client.chooseOption(system, messages, {
      callIndex,
      attempt,
      optionCount,
    });
    usage.tokensIn += result.usage.tokensIn;
    usage.tokensOut += result.usage.tokensOut;
    usage.cacheRead += result.usage.cacheRead;
    usage.cacheWrite += result.usage.cacheWrite;
    promptTokens =
      result.usage.tokensIn + result.usage.cacheRead + result.usage.cacheWrite;
    lastRaw = result.raw;
    if (
      result.parsed !== null &&
      result.parsed.option >= 0 &&
      result.parsed.option < optionCount
    ) {
      return {
        option: result.parsed.option,
        reasoning: result.parsed.reasoning,
        raw: result.raw,
        retries: attempt - 1,
        fallback: false,
        usage,
        latencyMs: Date.now() - startedAt,
        promptTokens,
        attempts,
      };
    }
    attempts.push({ raw: result.raw, problem: classifyFailure(result.parsed, result.raw) });
    messages.push(
      { role: "assistant", content: result.raw || "(empty)" },
      {
        role: "user",
        content:
          `Invalid response. You must call the choose_option tool with an ` +
          `integer "option" between 0 and ${optionCount - 1} inclusive. ` +
          `Choose again.`,
      }
    );
  }
  return {
    option: 0,
    reasoning: "",
    raw: lastRaw,
    retries: MAX_ATTEMPTS - 1,
    fallback: true,
    usage,
    latencyMs: Date.now() - startedAt,
    promptTokens,
    attempts,
  };
}
