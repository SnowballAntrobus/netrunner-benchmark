/** LLM-seat game runner (PHASE1 M4): Claude (or the mock) as Runner vs the
 *  rules Corp AI. Reuses the M1 infrastructure; adds the decision bridge
 *  (page.exposeFunction) and the per-decision JSONL log — every record
 *  carries the engine's ReproductionCode, so every decision is a resumable
 *  position. */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
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
  buildDebriefPrompt,
  DEBRIEF_INSTRUMENT_VERSION,
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
  /** D03: auto-resolve single-option decisions at the page layer (logged
   *  as forced, no API call, no transcript entry). Default true; false is
   *  the game-1-interface comparison arm. */
  autoResolve?: boolean;
  /** D07: postgame debrief — one extra call on the final transcript,
   *  answers written to <gameId>-debrief.json. Default true; no-op in
   *  stateless mode (no transcript) and on non-completed games. */
  debrief?: boolean;
  /** D09: "compound" (default) fuses subject-carrying commands into
   *  complete actions, page-fulfilling the follow-up select; "split" is
   *  the games-1/2 two-step comparison arm. */
  actions?: "compound" | "split";
  /** Live progress line on stdout while the game runs: current turn,
   *  agenda points, decision count. In-place (\r) on a TTY; one line per
   *  turn change otherwise. Default false — keeps CI logs and scripted
   *  runs clean. */
  progress?: boolean;
  /** Open a second terminal window streaming the model's reasoning live
   *  (tail -f on the decision JSONL piped through jq — the same view
   *  used to watch games 1/2 by hand). macOS opens Terminal.app;
   *  Linux tries common emulators; either way the exact pipeline is
   *  printed so it can be pasted manually. Default false. */
  watch?: boolean;
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
  /** D05: set on a select decision whose menu differed from the preview
   *  attached to the chosen command — the "preview, not promise" cases,
   *  surfaced for analysis. Null otherwise. */
  preview_divergence: {
    command: string;
    previewed_at_seq: number;
    preview: unknown[];
  } | null;
  /** D03: true = single-option decision auto-resolved at the page layer
   *  (no API call, no transcript entry; model fields null). */
  forced: boolean;
  /** D10: FAILED attempts in order, when retries occurred (null
   *  otherwise, and on corp/forced records). The accepted attempt stays
   *  in raw_response. Closes the game-2 retry mystery with data. */
  failed_attempts: { raw: string; problem: string }[] | null;
  /** D09: true on a command record whose options were the FUSED menu. */
  compound: boolean;
  /** D09: true on a select auto-answered from a prior compound choice
   *  (no API call, no transcript entry; model fields null). */
  compound_fulfilled: boolean;
  /** D09-2: true on an access-order select folded by the structural
   *  guard (order provably irrelevant; option 0 taken, no API call).
   *  Absent on pre-D09-2 records. */
  order_folded?: boolean;
  /** D09-2: set (to the fused menu length) on API decisions whose fused
   *  menu reached the alert threshold (>= 40 entries) — unbounded by
   *  review decision, but flagged for inspection. */
  large_menu?: number;
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
  /** True when the summary hit the response cap — clipped memory. */
  summary_truncated?: boolean;
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
  autoResolve: boolean;
  debrief: boolean; // D07 flag as configured (artifact presence: debriefPath)
  actions: "compound" | "split"; // D09
  llmDecisions: number; // API-answered decisions
  compoundFulfilled: number; // D09 page-fulfilled selects (no API call)
  orderFolded: number; // D09-2 access-order folds (no API call)
  largeFusedMenus: number; // D09-2 fused menus at/over the alert threshold
  forcedDecisions: number; // D03 auto-resolved (no API call)
  rulesDecisions: number;
  retriesTotal: number;
  fallbacks: number;
  compactions: number;
  /** Decisions where the floor guard vetoed an over-threshold compaction —
   *  >0 means compact-threshold is configured below its viable floor
   *  (system + summary + kept exchanges) for this model/config. */
  compactionsSuppressed: number;
  transcriptTokensMax: number;
  /** D05: previews followed into their select (comparisons made) and how
   *  many diverged. Divergent selects carry `preview_divergence`. */
  previewChecks: number;
  previewDivergences: number;
  /** D07: path of the debrief artifact, or null (flag off, stateless,
   *  non-completed game, or the debrief call failed). */
  debriefPath: string | null;
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
  // Forced (D03) and compound-fulfilled (D09) records never touched the
  // model — model fields are null.
  if (r.seat === "runner" && r.model === null && !r.forced && !r.compound_fulfilled && !r.order_folded)
    problems.push("runner record missing model");
  if (r.forced && r.options.length !== 1)
    problems.push("forced record with more than one option");
  return problems;
}

/** --watch: open a second terminal streaming the model's reasoning as it
 *  lands in the decision JSONL — the tail|jq view used to follow games
 *  1/2 by hand, now spawned automatically. Decision records print as
 *  "#seq seat · phase" + reasoning; compaction records print their
 *  summary (the model's memory of the dropped past). Forced/fulfilled/
 *  corp records carry no reasoning and are skipped by the filter.
 *  Best-effort: the pipeline is always printed for manual pasting, and a
 *  failed spawn (headless box, no known emulator) is silently ignored. */
function openReasoningWatch(decisionLogPath: string): void {
  const jqProg =
    'fromjson? | if .record_type == "compaction" then ' +
    '"\\n═══ compaction #\\(.compaction_id): \\(.dropped_turns) exchanges → summary ═══\\n\\(.summary)\\n" ' +
    'elif .reasoning != null then ' +
    '"── #\\(.seq) \\(.seat) · \\(.phase.title // "?") ──\\n\\(.reasoning)\\n" ' +
    "else empty end";
  const shellCmd = `tail -n +1 -f "${decisionLogPath}" | jq -Rr '${jqProg}'`;
  console.log(`watch: ${shellCmd}`);
  const ignore = { stdio: "ignore" as const, detached: true };
  try {
    if (process.platform === "darwin") {
      // AppleScript string: escape backslashes and double quotes.
      const script =
        'tell application "Terminal" to do script "' +
        shellCmd.replace(/([\\"])/g, "\\$1") +
        '"';
      spawn("osascript", ["-e", script], ignore).unref();
    } else {
      // Linux best-effort: first emulator that spawns wins; args passed
      // without a shell so no nested quoting.
      const candidates: [string, string[]][] = [
        ["gnome-terminal", ["--", "bash", "-c", shellCmd]],
        ["konsole", ["-e", "bash", "-c", shellCmd]],
        ["xterm", ["-e", "bash", "-c", shellCmd]],
      ];
      const tryNext = (i: number): void => {
        const candidate = candidates[i];
        if (!candidate) return;
        const child = spawn(candidate[0], candidate[1], ignore);
        child.on("error", () => tryNext(i + 1));
        child.unref();
      };
      tryNext(0);
    }
  } catch {
    /* watch is a convenience — the printed pipeline is the fallback */
  }
}

export async function runLLMGame(options: LLMGameOptions): Promise<LLMGameRecord> {
  const { repoRoot, seed, corpPrecon, runnerPrecon, model, outDir } = options;
  const timeoutMs = options.timeoutMs ?? 7_200_000;
  const stallMs = options.stallMs ?? 300_000;
  const contextMode = options.contextMode ?? "conversational";
  const historyVariant = options.historyVariant ?? "full";
  const compactionThreshold = options.compactionThreshold ?? 150_000;
  const compactionKeepTurns = options.compactionKeepTurns ?? 20;
  const autoResolve = options.autoResolve ?? true;
  const debrief = options.debrief ?? true;
  const actions = options.actions ?? "compound";
  const progress = options.progress ?? false;
  const watch = options.watch ?? false;
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
    contextMode,
    actions
  );
  const client = makeClient(model, seed, options.reasoningStyle === "extended" ? 2048 : 1024);
  const transcript =
    contextMode === "conversational"
      ? new Transcript(compactionThreshold, compactionKeepTurns)
      : null;

  // D06-1 rev 2: one folder per run — every artifact for this game lives
  // in out/<gameId>/ under canonical names (src/paths.ts resolves both
  // this and the legacy flat layout).
  const runDir = join(outDir, gameId);
  await mkdir(runDir, { recursive: true });
  const decisionLogPath = join(runDir, "decisions.jsonl");
  await writeFile(decisionLogPath, "");
  await writeFile(join(runDir, "system-prompt.txt"), system);
  if (watch) openReasoningWatch(decisionLogPath);

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
    autoResolve,
    debrief,
    actions,
    llmDecisions: 0,
    compoundFulfilled: 0,
    orderFolded: 0,
    largeFusedMenus: 0,
    forcedDecisions: 0,
    rulesDecisions: 0,
    retriesTotal: 0,
    fallbacks: 0,
    compactions: 0,
    compactionsSuppressed: 0,
    transcriptTokensMax: 0,
    previewChecks: 0,
    previewDivergences: 0,
    debriefPath: null,
    usage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 },
    decisionLogPath,
    invalidRecords: 0,
  };

  // Appends are serialized through a promise chain: concurrent bridge
  // calls (e.g. back-to-back corp decisions) otherwise race appendFile and
  // adjacent records land in nondeterministic file order — surfaced by
  // D04's double-run comparison. Record ORDER in the file now matches
  // write order deterministically.
  // D07 rev 2: capturedLog index of the last API-delivered decision — the
  // debrief catch-up covers everything after it.
  let lastApiLogIndex = 0;
  let writeQueue: Promise<void> = Promise.resolve();
  const appendRecord = (json: string): Promise<void> => {
    writeQueue = writeQueue.then(() => appendFile(decisionLogPath, json + "\n"));
    return writeQueue;
  };
  const writeDecision = async (r: DecisionRecord): Promise<void> => {
    const problems = validateDecisionRecord(r);
    if (problems.length > 0) {
      record.invalidRecords++;
      record.errors.push(`invalid decision record seq=${r.seq}: ${problems.join("; ")}`);
    }
    await appendRecord(JSON.stringify(r));
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

      // D09 fulfillment path: the model already chose this subject at the
      // fused command; record and answer the matched index. No API call,
      // no transcript entry.
      if (request.compoundFulfilled) {
        record.compoundFulfilled++;
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
          choice: request.compoundChoice ?? 0,
          reasoning: null,
          raw_response: null,
          retries: null,
          fallback: null,
          model: null,
          tokens_in: null,
          tokens_out: null,
          cache_read: null,
          latency_ms: null,
          reproduction_code: request.reproductionCode,
          transcript_tokens: null,
          compaction_id: transcript ? transcript.compactions : null,
          preview_divergence: request.previewDivergence ?? null,
          forced: false,
          failed_attempts: null,
          compound: false,
          compound_fulfilled: true,
        });
        return JSON.stringify({ option: request.compoundChoice ?? 0 });
      }

      // D09-2 class (c): access-order fold — the page proved (structural
      // guard, pool-audited) that order cannot matter; option 0 taken,
      // full record, no API call.
      if (request.orderFolded) {
        record.orderFolded++;
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
          choice: 0,
          reasoning: null,
          raw_response: null,
          retries: null,
          fallback: null,
          model: null,
          tokens_in: null,
          tokens_out: null,
          cache_read: null,
          latency_ms: null,
          reproduction_code: request.reproductionCode,
          transcript_tokens: null,
          compaction_id: transcript ? transcript.compactions : null,
          preview_divergence: request.previewDivergence ?? null,
          forced: false,
          failed_attempts: null,
          compound: false,
          compound_fulfilled: false,
          order_folded: true,
        });
        return JSON.stringify({ option: 0 });
      }

      // D03 forced path: single-option decision auto-resolved — full
      // record (state, options, divergence marker), no API call, no
      // transcript entry. Index 0 is the only possible outcome.
      if (request.forced) {
        record.forcedDecisions++;
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
          choice: 0,
          reasoning: null,
          raw_response: null,
          retries: null,
          fallback: null,
          model: null,
          tokens_in: null,
          tokens_out: null,
          cache_read: null,
          latency_ms: null,
          reproduction_code: request.reproductionCode,
          transcript_tokens: null,
          compaction_id: transcript ? transcript.compactions : null,
          preview_divergence: request.previewDivergence ?? null,
          forced: true,
          failed_attempts: null,
          compound: false,
          compound_fulfilled: false,
        });
        return JSON.stringify({ option: 0 });
      }

      record.llmDecisions++;
      if (typeof request.largeMenu === "number") {
        record.largeFusedMenus++;
        console.log(
          `⚠ fused menu of ${request.largeMenu} entries at seq ${request.seq} — unbounded by design, inspect if frequent`
        );
      }
      // D07 rev 2: remember how far the model's view of the log reached.
      // Everything past this index at game end was never delivered (no
      // later API decision arrived to carry it) — the debrief's terminal
      // catch-up starts here.
      lastApiLogIndex =
        (request as { logIndex?: number | null }).logIndex ?? lastApiLogIndex;

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
            summary_truncated: summary.truncated,
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
          await appendRecord(JSON.stringify(compactionRecord));
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
        preview_divergence: request.previewDivergence ?? null,
        forced: false,
        failed_attempts: result.attempts.length > 0 ? result.attempts : null,
        compound: request.compound === true,
        compound_fulfilled: false,
        ...(typeof request.largeMenu === "number" ? { large_menu: request.largeMenu } : {}),
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
        preview_divergence: r.previewDivergence ?? null,
        forced: false,
        failed_attempts: null,
        compound: false,
        compound_fulfilled: false,
      });
    });

    const url =
      `http://127.0.0.1:${staticServer.port}/harness.html` +
      `?faceoff=1&p=r&llm=runner&seed=${seed}` +
      `&autoresolve=${autoResolve ? 1 : 0}&actions=${actions}` +
      `&c=${encodeDeckParam(corpDeck)}&r=${encodeDeckParam(runnerDeck)}`;
    await page.goto(url, { waitUntil: "load" });

    let lastDecisions = -1;
    let lastProgressAt = Date.now();
    let lastProgressLine = "";
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
        // Live progress extras: current turn (bootstrap keeps
        // __harness.turn updated) and agenda points straight from the
        // engine's own AgendaPoints helper. Read-only; guarded so a
        // mid-boot poll (globals not yet defined) degrades to null.
        let live: {
          turn: { side: string; number: number } | null;
          corpAP: number;
          runnerAP: number;
        } | null = null;
        try {
          const w = window as unknown as {
            AgendaPoints: (p: unknown) => number;
            corp: unknown;
            runner: unknown;
            __harness: { turn?: { side: string; number: number } | null };
          };
          live = {
            turn: w.__harness.turn ?? null,
            corpAP: w.AgendaPoints(w.corp),
            runnerAP: w.AgendaPoints(w.runner),
          };
        } catch {
          live = null;
        }
        return {
          done: h.done,
          decisions: h.decisions,
          turnCounts: h.turnCounts,
          errors: h.errors,
          result: h.result,
          live,
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
        live: {
          turn: { side: string; number: number } | null;
          corpAP: number;
          runnerAP: number;
        } | null;
      };
      if (surface.decisions !== lastDecisions) {
        lastDecisions = surface.decisions;
        lastProgressAt = Date.now();
      }
      if (progress) {
        const t = surface.live?.turn;
        const turnStr = t ? `${t.side} turn ${t.number}` : "mulligan";
        const line = surface.live
          ? `▸ ${turnStr} · AP ${surface.live.corpAP}:${surface.live.runnerAP} ` +
            `(corp:runner) · decisions ${surface.decisions} (api ${record.llmDecisions})`
          : "▸ booting…";
        if (process.stdout.isTTY) {
          // In place on a TTY; padded so a shrinking line leaves no tail.
          process.stdout.write("\r" + line.padEnd(64));
        } else if (line !== lastProgressLine) {
          // Non-TTY (piped/CI): one line per change, no \r spam.
          process.stdout.write(line + "\n");
        }
        lastProgressLine = line;
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
    if (progress && process.stdout.isTTY && lastProgressLine) {
      // Finalize (don't clear): the last progress line stays in scrollback
      // as evidence of the run's shape — with --watch stealing window
      // focus, a cleared line looked like the feature never ran.
      process.stdout.write("\r" + lastProgressLine.padEnd(64) + "\n");
    }

    const finals = (await page.evaluate(() => {
      const h = (
        window as unknown as {
          __harness: {
            log: () => string[];
            logAtWin?: string[];
            previewChecks?: number;
            previewDivergences?: number;
          };
        }
      ).__harness;
      return {
        log: h.logAtWin ?? h.log(),
        previewChecks: h.previewChecks ?? 0,
        previewDivergences: h.previewDivergences ?? 0,
      };
    })) as { log: string[]; previewChecks: number; previewDivergences: number };
    record.log = finals.log;
    record.previewChecks = finals.previewChecks;
    record.previewDivergences = finals.previewDivergences;

    // D07 postgame debrief: one extra call on the final (as-compacted)
    // transcript. Rev 2: opens with the terminal catch-up (public log
    // since the last API decision) and states the result plainly —
    // verdict-blind debriefing is parked as a Phase-2 experiment. The
    // reply enters no transcript and no future call: zero-contamination
    // by construction. No-op for stateless games and non-completed games.
    if (debrief && transcript && record.status === "completed" && !apiAborted) {
      try {
        // D07 rev 2: terminal catch-up — the runner-visible log since the
        // last API-delivered decision, from the page's own public filter
        // (exactly what a next decision message would have carried).
        let finalEvents: string[] = [];
        try {
          finalEvents = (await page.evaluate(
            (i) =>
              (
                window as unknown as {
                  __harness: { publicLogSince?: (i: number) => string[] };
                }
              ).__harness.publicLogSince?.(i) ?? [],
            lastApiLogIndex
          )) as string[];
        } catch {
          /* page unavailable — debrief proceeds without catch-up */
        }
        const debriefPrompt = buildDebriefPrompt(
          finalEvents,
          record.winner
            ? { won: record.winner === "runner", reason: record.reason ?? "" }
            : undefined
        );
        const result = await client.summarize(system, [
          ...transcript.messages(),
          { role: "user", content: debriefPrompt },
        ]);
        record.usage.tokensIn += result.usage.tokensIn;
        record.usage.tokensOut += result.usage.tokensOut;
        record.usage.cacheRead += result.usage.cacheRead;
        record.usage.cacheWrite += result.usage.cacheWrite;
        const debriefPath = join(runDir, "debrief.json");
        await writeFile(
          debriefPath,
          JSON.stringify(
            {
              game_id: gameId,
              instrument_version: DEBRIEF_INSTRUMENT_VERSION,
              final_events: finalEvents, // D07 rev 2: the terminal catch-up shown
              prompt: debriefPrompt,
              text: result.text,
              model,
              tokens_in: result.usage.tokensIn,
              tokens_out: result.usage.tokensOut,
              cache_read: result.usage.cacheRead,
              latency_ms: result.latencyMs,
            },
            null,
            1
          )
        );
        record.debriefPath = debriefPath;
      } catch (e) {
        record.errors.push(`debrief failed (game result unaffected): ${String(e)}`);
      }
    }
  } catch (e) {
    record.errors.push(`host: ${String(e)}`);
  } finally {
    if (transcript) record.compactionsSuppressed = transcript.floorSuppressed;
    record.durationMs = Date.now() - startedAt;
    const totalTurns = record.turns ? record.turns.corp + record.turns.runner : 0;
    record.msPerTurn = totalTurns > 0 ? Math.round(record.durationMs / totalTurns) : null;
    await context.close();
    await browser.close();
    await staticServer.close();
    await writeFile(join(runDir, "record.json"), JSON.stringify(record, null, 1));
  }
  return record;
}
