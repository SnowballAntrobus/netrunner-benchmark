/** LLM-seat game runner (PHASE1 M4): Claude (or the mock) as Runner vs the
 *  rules Corp AI. Reuses the M1 infrastructure; adds the decision bridge
 *  (page.exposeFunction) and the per-decision JSONL log — every record
 *  carries the engine's ReproductionCode, so every decision is a resumable
 *  position. */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchBrowser, type GameRecord } from "./game.js";
import { startServer } from "./server.js";
import { loadPrecon, encodeDeckParam } from "./precons.js";
import { loadCardData, deckReference } from "./carddata.js";
import {
  buildSystemPrompt,
  buildDecisionMessage,
  buildLeanDecisionMessage,
  buildCompactionNotice,
  PROFILES,
  type PageDecisionRequest,
  type PromptProfile,
} from "./prompts.js";
import { makeClient, decideWithRetries, Transcript, type Usage } from "./llm.js";
import { loadOfficialRules } from "./rules.js";

export interface LLMGameOptions {
  repoRoot: string;
  seed: number;
  corpPrecon: string;
  runnerPrecon: string;
  model: string; // "mock" or an Anthropic model id
  rulesSource: "official" | "digest";
  profile: string; // key into PROFILES
  reasoningStyle: PromptProfile["reasoningStyle"];
  outDir: string;
  timeoutMs?: number;
  stallMs?: number;
  /** D01: "conversational" (default) keeps the whole game in one running
   *  conversation; "stateless" is the game-1 ablation arm. */
  contextMode?: "conversational" | "stateless";
  /** D01 axis 1: what a PAST turn keeps in the transcript. "full" (default,
   *  variant A) = the complete decision message; "lean" (variant B) =
   *  header + options only. */
  historyVariant?: "full" | "lean";
  /** Compact when the observed request size crosses this (tokens). A
   *  PER-MODEL tuning knob: pick ~70–80% of the model's context window,
   *  floored by post-compaction baseline + epoch headroom (see
   *  PROMPTING.md "Choosing the threshold"). Default 150K for
   *  200K-window models (haiku) — matches Anthropic's own API compaction
   *  trigger default and the practitioner quality band. */
  compactionThreshold?: number;
  /** Exchanges kept verbatim through a compaction reset. */
  compactionKeepTurns?: number;
}

export interface DecisionRecord {
  record_type?: "decision"; // absent in game-1 records; readers tolerate both
  game_id: string;
  seq: number;
  log_index: number | null; // capturedLog.length at capture time (exact ordering)
  turn: { side: string; number: number } | null;
  phase: { identifier: string; title: string } | null;
  seat: string;
  decision_type: string;
  state: Record<string, unknown> | null; // null for rules-AI records
  options: Record<string, unknown>[];
  choice: number;
  reasoning: string | null;
  raw_response: string | null;
  retries: number | null;
  fallback: boolean | null;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read: number | null;
  latency_ms: number | null;
  reproduction_code: string | null;
  /** D01: observed request size (system + transcript + decision) for this
   *  decision; null for corp records and stateless mode. */
  transcript_tokens: number | null;
  /** D01: compaction epoch this decision was made in (0 = before the first
   *  compaction); null when stateless. */
  compaction_id: number | null;
}

/** D01: compaction events are first-class records in the same JSONL stream —
 *  the summary text is the model's only memory of everything dropped, and
 *  the first place to look when a later confabulation needs tracing. */
export interface CompactionRecord {
  record_type: "compaction";
  game_id: string;
  compaction_id: number; // 1-based
  seq_before: number; // seq of the decision whose arrival triggered it
  log_index: number | null;
  turn: { side: string; number: number } | null;
  transcript_tokens_before: number | null;
  dropped_turns: number; // exchanges compacted into the summary
  kept_turns: number; // exchanges kept verbatim
  summary: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  latency_ms: number;
}

export interface LLMGameRecord extends GameRecord {
  model: string;
  rulesSource: string;
  promptProfile: string;
  reasoningStyle: string;
  contextMode: "conversational" | "stateless";
  historyVariant: "full" | "lean" | null; // null when stateless
  llmDecisions: number;
  rulesDecisions: number;
  retriesTotal: number;
  fallbacks: number;
  compactions: number;
  transcriptTokensMax: number;
  usage: Usage;
  decisionLogPath: string;
  invalidRecords: number;
}

export function validateDecisionRecord(r: DecisionRecord): string[] {
  const problems: string[] = [];
  if (!r.game_id) problems.push("game_id missing");
  if (!Number.isInteger(r.seq)) problems.push("seq not an integer");
  if (r.seat !== "runner" && r.seat !== "corp") problems.push(`bad seat ${r.seat}`);
  if (r.decision_type !== "command" && r.decision_type !== "select")
    problems.push(`bad decision_type ${r.decision_type}`);
  if (!Array.isArray(r.options) || r.options.length === 0) problems.push("options empty");
  if (!Number.isInteger(r.choice) || r.choice < 0 || r.choice >= r.options.length)
    problems.push(`choice ${r.choice} out of range`);
  if (r.seat === "runner" && r.state === null) problems.push("runner record missing state");
  if (r.seat === "runner" && r.model === null) problems.push("runner record missing model");
  return problems;
}

export async function runLLMGame(options: LLMGameOptions): Promise<LLMGameRecord> {
  const { repoRoot, seed, corpPrecon, runnerPrecon, model, outDir } = options;
  const timeoutMs = options.timeoutMs ?? 7_200_000;
  const stallMs = options.stallMs ?? 300_000;
  const contextMode = options.contextMode ?? "conversational";
  const historyVariant = options.historyVariant ?? "full";
  const compactionThreshold = options.compactionThreshold ?? 150_000;
  const compactionKeepTurns = options.compactionKeepTurns ?? 20;
  const startedAt = Date.now();
  const gameId = `llm-${model.replace(/[^a-z0-9.-]/gi, "_")}-s${seed}-${startedAt}`;

  const [corpDeck, runnerDeck, cardData] = await Promise.all([
    loadPrecon(repoRoot, corpPrecon),
    loadPrecon(repoRoot, runnerPrecon),
    loadCardData(repoRoot),
  ]);
  const rulesText =
    options.rulesSource === "official" ? await loadOfficialRules(repoRoot) : undefined;
  const profileBase = PROFILES[options.profile];
  if (!profileBase) throw new Error(`unknown prompt profile: ${options.profile}`);
  const profile: PromptProfile = { ...profileBase, reasoningStyle: options.reasoningStyle };
  const system = buildSystemPrompt(
    deckReference("Your deck (Runner)", runnerDeck, cardData),
    deckReference("Corp deck (opponent)", corpDeck, cardData),
    rulesText,
    profile,
    contextMode
  );
  const client = makeClient(model, seed, options.reasoningStyle === "extended" ? 2048 : 1024);
  const transcript =
    contextMode === "conversational"
      ? new Transcript(compactionThreshold, compactionKeepTurns)
      : null;

  await mkdir(outDir, { recursive: true });
  const decisionLogPath = join(outDir, `${gameId}.jsonl`);
  await writeFile(decisionLogPath, "");
  await writeFile(join(outDir, `${gameId}-system-prompt.txt`), system);

  const record: LLMGameRecord = {
    seed,
    corpPrecon,
    runnerPrecon,
    status: "crashed",
    winner: null,
    reason: null,
    corpAgendaPoints: null,
    runnerAgendaPoints: null,
    decisions: 0,
    durationMs: 0,
    turns: null,
    msPerTurn: null,
    errors: [],
    log: [],
    model,
    rulesSource: options.rulesSource,
    promptProfile: options.profile,
    reasoningStyle: options.reasoningStyle,
    contextMode,
    historyVariant: contextMode === "conversational" ? historyVariant : null,
    llmDecisions: 0,
    rulesDecisions: 0,
    retriesTotal: 0,
    fallbacks: 0,
    compactions: 0,
    transcriptTokensMax: 0,
    usage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 },
    decisionLogPath,
    invalidRecords: 0,
  };

  const writeDecision = async (r: DecisionRecord): Promise<void> => {
    const problems = validateDecisionRecord(r);
    if (problems.length > 0) {
      record.invalidRecords++;
      record.errors.push(`invalid decision record seq=${r.seq}: ${problems.join("; ")}`);
    }
    await appendFile(decisionLogPath, JSON.stringify(r) + "\n");
  };

  const staticServer = await startServer(repoRoot);
  const browser = await launchBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  // Set when the API is unusable (bad key, quota, network): the game must
  // ABORT, not degrade into option-0 fallback play — a game played by
  // fallbacks is worthless data. (Found via fake-key probe: 460 silent
  // bridge failures produced a "completed" game.)
  let apiAborted = false;

  try {
    // LLM decision bridge — called by page/llmplayer.js for every Runner decision.
    await page.exposeFunction("__harnessDecide", async (requestJson: string) => {
      const request = JSON.parse(requestJson) as PageDecisionRequest;
      if (apiAborted) return JSON.stringify({ option: 0, abort: true });
      record.llmDecisions++;

      // D01 compaction: checked BEFORE the decision, on the request size
      // observed at the PREVIOUS decision (threshold < window leaves
      // headroom). The model writes its own summary; the transcript
      // restarts as [notice] + [summary] + [last K exchanges verbatim].
      if (transcript && transcript.shouldCompact()) {
        try {
          const summary = await client.summarize(system, [
            ...transcript.messages(),
            { role: "user", content: buildCompactionNotice(transcript.keepPairs) },
          ]);
          const tokensBefore = transcript.promptTokens;
          const { droppedPairs, keptPairs } = transcript.compact(summary.text);
          record.compactions++;
          const compactionRecord: CompactionRecord = {
            record_type: "compaction",
            game_id: gameId,
            compaction_id: transcript.compactions,
            seq_before: request.seq,
            log_index: (request as { logIndex?: number | null }).logIndex ?? null,
            turn: request.turn,
            transcript_tokens_before: tokensBefore,
            dropped_turns: droppedPairs,
            kept_turns: keptPairs,
            summary: summary.text,
            model,
            tokens_in: summary.usage.tokensIn,
            tokens_out: summary.usage.tokensOut,
            cache_read: summary.usage.cacheRead,
            latency_ms: summary.latencyMs,
          };
          record.usage.tokensIn += summary.usage.tokensIn;
          record.usage.tokensOut += summary.usage.tokensOut;
          record.usage.cacheRead += summary.usage.cacheRead;
          record.usage.cacheWrite += summary.usage.cacheWrite;
          await appendFile(decisionLogPath, JSON.stringify(compactionRecord) + "\n");
        } catch (e) {
          apiAborted = true;
          record.errors.push(`API failure at compaction (seq ${request.seq}): ${String(e)}`);
          return JSON.stringify({ option: 0, abort: true });
        }
      }

      const decisionMessage = buildDecisionMessage(request);
      let result;
      try {
        result = await decideWithRetries(
          client,
          system,
          transcript ? transcript.messages() : [],
          decisionMessage,
          record.llmDecisions,
          request.options.length
        );
      } catch (e) {
        apiAborted = true;
        record.errors.push(`API failure at decision ${request.seq}: ${String(e)}`);
        return JSON.stringify({ option: 0, abort: true });
      }
      if (transcript) {
        // Only the final accepted exchange enters the transcript; retries
        // stay inside the decision. Under "lean", the persisted user turn
        // drops state+log (the fresh state was still SENT this decision).
        transcript.append(
          historyVariant === "lean" ? buildLeanDecisionMessage(request) : decisionMessage,
          result.raw || "(empty)"
        );
        transcript.notePromptTokens(result.promptTokens);
        if (result.promptTokens > record.transcriptTokensMax) {
          record.transcriptTokensMax = result.promptTokens;
        }
      }
      record.retriesTotal += result.retries;
      if (result.fallback) record.fallbacks++;
      record.usage.tokensIn += result.usage.tokensIn;
      record.usage.tokensOut += result.usage.tokensOut;
      record.usage.cacheRead += result.usage.cacheRead;
      record.usage.cacheWrite += result.usage.cacheWrite;
      await writeDecision({
        record_type: "decision",
        game_id: gameId,
        seq: request.seq,
        log_index: (request as { logIndex?: number | null }).logIndex ?? null,
        turn: request.turn,
        phase: request.phase,
        seat: "runner",
        decision_type: request.decisionType,
        state: request.state,
        options: request.options,
        choice: result.option,
        reasoning: result.reasoning,
        raw_response: result.raw,
        retries: result.retries,
        fallback: result.fallback,
        model,
        tokens_in: result.usage.tokensIn,
        tokens_out: result.usage.tokensOut,
        cache_read: result.usage.cacheRead,
        latency_ms: result.latencyMs,
        reproduction_code: request.reproductionCode,
        transcript_tokens: transcript ? result.promptTokens : null,
        compaction_id: transcript ? transcript.compactions : null,
      });
      return JSON.stringify({ option: result.option });
    });

    // Rules-AI (Corp) decisions land in the same stream, minus model fields.
    await page.exposeFunction("__harnessLogDecision", async (recordJson: string) => {
      const r = JSON.parse(recordJson) as PageDecisionRequest & { choice: number };
      record.rulesDecisions++;
      await writeDecision({
        record_type: "decision",
        game_id: gameId,
        seq: r.seq,
        log_index: (r as { logIndex?: number | null }).logIndex ?? null,
        turn: r.turn,
        phase: r.phase,
        seat: "corp",
        decision_type: r.decisionType,
        state: null,
        options: r.options,
        choice: r.choice,
        reasoning: null,
        raw_response: null,
        retries: null,
        fallback: null,
        model: null,
        tokens_in: null,
        tokens_out: null,
        cache_read: null,
        latency_ms: null,
        reproduction_code: r.reproductionCode,
        transcript_tokens: null,
        compaction_id: null,
      });
    });

    const url =
      `http://127.0.0.1:${staticServer.port}/harness.html` +
      `?faceoff=1&p=r&llm=runner&seed=${seed}` +
      `&c=${encodeDeckParam(corpDeck)}&r=${encodeDeckParam(runnerDeck)}`;
    await page.goto(url, { waitUntil: "load" });

    let lastDecisions = -1;
    let lastProgressAt = Date.now();
    for (;;) {
      const surface = (await page.evaluate(() => {
        const h = (
          window as unknown as {
            __harness: {
              done: boolean;
              decisions: number;
              turnCounts: { corp: number; runner: number };
              errors: string[];
              result: {
                winner: "corp" | "runner";
                reason: string;
                corpAgendaPoints: number;
                runnerAgendaPoints: number;
              } | null;
            };
          }
        ).__harness;
        return {
          done: h.done,
          decisions: h.decisions,
          turnCounts: h.turnCounts,
          errors: h.errors,
          result: h.result,
        };
      })) as {
        done: boolean;
        decisions: number;
        turnCounts: { corp: number; runner: number };
        errors: string[];
        result: {
          winner: "corp" | "runner";
          reason: string;
          corpAgendaPoints: number;
          runnerAgendaPoints: number;
        } | null;
      };
      if (surface.decisions !== lastDecisions) {
        lastDecisions = surface.decisions;
        lastProgressAt = Date.now();
      }
      if (apiAborted) {
        record.status = "crashed";
        record.turns = surface.turnCounts;
        record.decisions = surface.decisions;
        record.errors.push(...surface.errors);
        break;
      }
      if (surface.done && surface.result) {
        record.status = "completed";
        record.turns = surface.turnCounts;
        record.winner = surface.result.winner;
        record.reason = surface.result.reason;
        record.corpAgendaPoints = surface.result.corpAgendaPoints;
        record.runnerAgendaPoints = surface.result.runnerAgendaPoints;
        record.decisions = surface.decisions;
        record.errors.push(...surface.errors);
        break;
      }
      if (Date.now() - startedAt > timeoutMs) {
        record.status = "timeout";
        record.turns = surface.turnCounts;
        record.decisions = surface.decisions;
        record.errors.push(...surface.errors);
        break;
      }
      if (Date.now() - lastProgressAt > stallMs) {
        record.status = "stalled";
        record.turns = surface.turnCounts;
        record.decisions = surface.decisions;
        record.errors.push(...surface.errors);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    record.log = (await page.evaluate(() => {
      const h = (
        window as unknown as { __harness: { log: () => string[]; logAtWin?: string[] } }
      ).__harness;
      return h.logAtWin ?? h.log();
    })) as string[];
  } catch (e) {
    record.errors.push(`host: ${String(e)}`);
  } finally {
    record.durationMs = Date.now() - startedAt;
    const totalTurns = record.turns ? record.turns.corp + record.turns.runner : 0;
    record.msPerTurn = totalTurns > 0 ? Math.round(record.durationMs / totalTurns) : null;
    await context.close();
    await browser.close();
    await staticServer.close();
    await writeFile(join(outDir, `${gameId}.json`), JSON.stringify(record, null, 1));
  }
  return record;
}
