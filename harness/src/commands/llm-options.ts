/** Flags shared by `llm-game` and `run-match`: everything about a model
 *  game except its seed, output folder and event sinks. */
import { assertQualified } from "../cardpool.js";
import { llmSeatsOf, type LLMGameOptions, type SeatMode } from "../llmgame.js";
import type { Seat } from "../prompts.js";
import type { Args } from "./args.js";

export type GameConfig = Omit<LLMGameOptions, "seed" | "outDir" | "onEvent" | "clientFactory">;

/** Compaction threshold by model prefix (longest match wins): about 75% of
 *  the model's context window, high enough above the post-compaction
 *  floor (system prompt + summary + kept exchanges) to leave real
 *  headroom. Token counts are each provider's own tokenizer. */
const THRESHOLD_DEFAULTS: [prefix: string, threshold: number][] = [
  ["openrouter/mistralai/", 200_000], // 262K windows
  ["openrouter/tencent/hy3", 200_000], // 262K window
  // 131K window: 100K sits near the transcript floor, so expect frequent
  // compaction; compactionsSuppressed > 0 on the record means the model
  // cannot fit this configuration.
  ["openrouter/meta/muse-glimmer-30b", 100_000],
  ["openrouter/", 300_000], // 400K-1M windows
  ["claude-opus", 300_000], // 1M window
];

export function defaultCompactThreshold(model: string): number {
  let best: [string, number] | null = null;
  for (const entry of THRESHOLD_DEFAULTS) {
    if (model.startsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best ? best[1] : 150_000;
}

export class UsageError extends Error {}

/** Parse and validate; throws UsageError on a bad flag or missing key. */
export async function gameConfig(
  repoRoot: string,
  args: Args
): Promise<{ seatModels: Partial<Record<Seat, string>>; game: GameConfig }> {
  const seat = args.str("seat", "runner");
  if (!["runner", "corp", "both"].includes(seat)) {
    throw new UsageError(`--seat must be runner, corp or both (got ${seat})`);
  }
  const seatMode = seat as SeatMode;
  const model = args.str("model", process.env["HARNESS_MODEL"] ?? "claude-haiku-4-5");
  const seatModels: Partial<Record<Seat, string>> = {};
  for (const s of llmSeatsOf(seatMode)) seatModels[s] = args.str(`${s}-model`, model);
  for (const m of Object.values(seatModels)) {
    if (m.startsWith("openrouter/") && !process.env["OPENROUTER_API_KEY"]) {
      throw new UsageError("OPENROUTER_API_KEY not set (required for openrouter/* models)");
    }
    if (m !== "mock" && !m.startsWith("openrouter/") && !process.env["ANTHROPIC_API_KEY"]) {
      throw new UsageError("ANTHROPIC_API_KEY not set (use --model mock for the keyless path)");
    }
  }
  const reasoning = args.str("reasoning", "brief");
  const explicitThreshold = args.int("compact-threshold", 0);
  const compactionThresholds: Partial<Record<Seat, number>> = {};
  for (const [s, m] of Object.entries(seatModels) as [Seat, string][]) {
    compactionThresholds[s] = explicitThreshold || defaultCompactThreshold(m);
  }
  await assertQualified(repoRoot, [args.corp, args.runner], args.flag("allow-unqualified"));
  return {
    seatModels,
    game: {
      repoRoot,
      corpPrecon: args.corp,
      runnerPrecon: args.runner,
      seat: seatMode,
      model,
      corpModel: seatModels.corp,
      runnerModel: seatModels.runner,
      rulesSource: args.str("rules", "official") === "digest" ? "digest" : "official",
      profile: args.str("profile", "neutral"),
      reasoningStyle:
        reasoning === "extended" || reasoning === "scot" || reasoning === "none" ? reasoning : "brief",
      contextMode: args.str("context", "conversational") === "stateless" ? "stateless" : "conversational",
      historyVariant: args.str("history", "full") === "lean" ? "lean" : "full",
      compactionThresholds,
      compactionKeepTurns: args.int("compact-keep", 20),
      autoResolve: args.str("auto-resolve", "on") !== "off",
      debrief: args.str("debrief", "on") !== "off",
      actions: args.str("actions", "compound") === "split" ? "split" : "compound",
      aiBranches: args.str("ai-branches", "neutral") === "rules" ? "rules" : "neutral",
      frames: args.str("frames", "on") !== "off",
      extraParams: args.flag("invariant") ? "&invariant=1" : "",
      progress: args.flag("progress"),
    },
  };
}
