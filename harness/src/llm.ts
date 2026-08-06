/** LLM clients + retry bridge (PHASE1 M4).
 *
 *  AnthropicClient: forced tool call ("choose_option") so the response is
 *  schema-validated JSON at the API layer; system prompt carries a
 *  prompt-cache breakpoint (static per game, reused across ~300+ decisions).
 *
 *  MockClient: deterministic, keyless — CI's end-to-end path. Injects one
 *  transient malformed response (exercises retry) and one persistently
 *  malformed decision (exercises fallback), then picks seeded-random legal
 *  options.
 */
import Anthropic from "@anthropic-ai/sdk";

export interface Usage {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
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

export interface ChoiceClient {
  readonly model: string;
  chooseOption(
    system: string,
    messages: { role: "user" | "assistant"; content: string }[],
    context: ChoiceContext
  ): Promise<ChoiceAttempt>;
}

const ZERO_USAGE: Usage = { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 };

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
    messages: { role: "user" | "assistant"; content: string }[],
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
      messages,
    });
    const usage: Usage = {
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
      cacheRead: response.usage.cache_read_input_tokens ?? 0,
      cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
    };
    const block = response.content.find((b) => b.type === "tool_use");
    if (block && block.type === "tool_use") {
      const input = block.input as { option?: unknown; reasoning?: unknown };
      if (typeof input.option === "number") {
        return {
          parsed: {
            option: Math.trunc(input.option),
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

  async chooseOption(
    _system: string,
    _messages: { role: "user" | "assistant"; content: string }[],
    context: ChoiceContext
  ): Promise<ChoiceAttempt> {
    if (context.callIndex === this.persistentBadAt) {
      return { parsed: null, raw: "\"I choose to run HQ!\" (mock: persistent-garbage)", usage: ZERO_USAGE };
    }
    if (context.callIndex === this.transientBadAt && context.attempt === 1) {
      return {
        parsed: { option: 9999, reasoning: "mock: transient bad index" },
        raw: "{\"option\":9999}",
        usage: ZERO_USAGE,
      };
    }
    const option = Math.floor(this.rng() * context.optionCount);
    return {
      parsed: { option, reasoning: "mock: seeded random legal choice" },
      raw: JSON.stringify({ option }),
      usage: ZERO_USAGE,
    };
  }
}

export function makeClient(model: string, seed: number, maxTokens = 1024): ChoiceClient {
  if (model === "mock") return new MockClient(seed);
  return new AnthropicClient(model, maxTokens);
}

export interface BridgeResult {
  option: number;
  reasoning: string;
  raw: string;
  retries: number;
  fallback: boolean;
  usage: Usage;
  latencyMs: number;
}

const MAX_ATTEMPTS = 3;

/** Retry loop: malformed or out-of-range responses get one corrective
 *  follow-up message per retry; after MAX_ATTEMPTS, fall back to option 0
 *  with the incident flagged. */
export async function decideWithRetries(
  client: ChoiceClient,
  system: string,
  decisionMessage: string,
  callIndex: number,
  optionCount: number
): Promise<BridgeResult> {
  const startedAt = Date.now();
  const usage: Usage = { ...ZERO_USAGE };
  const messages: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: decisionMessage },
  ];
  let lastRaw = "";
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
      };
    }
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
  };
}
