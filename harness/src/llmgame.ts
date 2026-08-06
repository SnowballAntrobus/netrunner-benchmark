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
  PROFILES,
  type PageDecisionRequest,
  type PromptProfile,
} from "./prompts.js";
import { makeClient, decideWithRetries, type Usage } from "./llm.js";
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
}

export interface DecisionRecord {
  game_id: string;
  seq: number;
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
}

export interface LLMGameRecord extends GameRecord {
  model: string;
  rulesSource: string;
  promptProfile: string;
  reasoningStyle: string;
  llmDecisions: number;
  rulesDecisions: number;
  retriesTotal: number;
  fallbacks: number;
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
    profile
  );
  const client = makeClient(model, seed, options.reasoningStyle === "extended" ? 2048 : 1024);

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
    llmDecisions: 0,
    rulesDecisions: 0,
    retriesTotal: 0,
    fallbacks: 0,
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

  try {
    // LLM decision bridge — called by page/llmplayer.js for every Runner decision.
    await page.exposeFunction("__harnessDecide", async (requestJson: string) => {
      const request = JSON.parse(requestJson) as PageDecisionRequest;
      record.llmDecisions++;
      const result = await decideWithRetries(
        client,
        system,
        buildDecisionMessage(request),
        record.llmDecisions,
        request.options.length
      );
      record.retriesTotal += result.retries;
      if (result.fallback) record.fallbacks++;
      record.usage.tokensIn += result.usage.tokensIn;
      record.usage.tokensOut += result.usage.tokensOut;
      record.usage.cacheRead += result.usage.cacheRead;
      record.usage.cacheWrite += result.usage.cacheWrite;
      await writeDecision({
        game_id: gameId,
        seq: request.seq,
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
      });
      return JSON.stringify({ option: result.option });
    });

    // Rules-AI (Corp) decisions land in the same stream, minus model fields.
    await page.exposeFunction("__harnessLogDecision", async (recordJson: string) => {
      const r = JSON.parse(recordJson) as PageDecisionRequest & { choice: number };
      record.rulesDecisions++;
      await writeDecision({
        game_id: gameId,
        seq: r.seq,
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
