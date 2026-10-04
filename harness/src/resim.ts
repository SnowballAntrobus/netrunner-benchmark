/** Re-simulation (D15): replay a recorded LLM game through the live harness.
 *
 *  The engine is deterministic under the game's seed and the page's own
 *  auto-resolution, fusion and folding are deterministic, so answering
 *  every API decision with its recorded choice (ReplayClient) reproduces
 *  the game exactly. Uses:
 *    - backfill viewer frames for games recorded before frames existed;
 *    - an end-to-end proof that a recorded game is replayable: the replay's
 *      decision stream must match the record's (seq, seat, type, choice,
 *      menu size) for EVERY decision, both seats, and end the same way.
 *  Interface flags come from the record (era-3 records predate D14 and
 *  replay with the era-3 rules-AI branch policy). No API is ever called.
 */
import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveGameArtifacts } from "./paths.js";
import { runLLMGame, llmSeatsOf, type SeatMode, type LLMGameRecord } from "./llmgame.js";
import { ReplayClient, type RecordedChoice } from "./llm.js";
import type { Seat } from "./prompts.js";

interface Row {
  record_type?: string;
  seq: number;
  seat: string;
  decision_type: string;
  options: unknown[];
  choice: number;
  model: string | null;
  reasoning: string | null;
  raw_response: string | null;
}

export interface ResimResult {
  ok: boolean;
  message: string;
  replayDir: string | null;
  framesPath: string | null;
}

async function readRows(path: string): Promise<Row[]> {
  return (await readFile(path, "utf-8"))
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Row)
    .filter((r) => (r.record_type ?? "decision") === "decision");
}

export async function resimulate(
  repoRoot: string,
  runPath: string,
  outDir: string,
  options: { install?: boolean } = {}
): Promise<ResimResult> {
  const art = resolveGameArtifacts(runPath);
  const record = JSON.parse(await readFile(art.record, "utf-8")) as Partial<LLMGameRecord> & {
    seats?: Partial<Record<Seat, { model: string }>>;
  };
  const original = await readRows(art.jsonl);
  const mode: SeatMode = (record.llmSeat as SeatMode | undefined) ?? "runner";
  const seats = llmSeatsOf(mode);
  const models: Partial<Record<Seat, string>> = {};
  const recorded: Partial<Record<Seat, RecordedChoice[]>> = {};
  for (const seat of seats) {
    models[seat] = record.seats?.[seat]?.model ?? record.model ?? "replay";
    recorded[seat] = original
      .filter((r) => r.seat === seat && r.model !== null)
      .map((r) => ({
        seq: r.seq,
        choice: r.choice,
        optionCount: r.options.length,
        reasoning: r.reasoning ?? "",
        raw: r.raw_response ?? "",
      }));
  }
  const replay = await runLLMGame({
    repoRoot,
    seed: record.seed!,
    corpPrecon: record.corpPrecon!,
    runnerPrecon: record.runnerPrecon!,
    seat: mode,
    model: models[seats[0]!]!,
    corpModel: models.corp,
    runnerModel: models.runner,
    rulesSource: record.rulesSource === "digest" ? "digest" : "official",
    profile: record.promptProfile ?? "neutral",
    reasoningStyle: (record.reasoningStyle as "brief") ?? "brief",
    contextMode: record.contextMode ?? "conversational",
    historyVariant: record.historyVariant ?? "full",
    compactionThreshold: Number.MAX_SAFE_INTEGER, // compaction never changes the game
    autoResolve: record.autoResolve ?? true,
    actions: record.actions ?? "compound",
    aiBranches: record.aiBranches ?? "rules", // absent = era 3 and earlier
    debrief: false,
    frames: true,
    clientFactory: (seat, model) => new ReplayClient(model, recorded[seat] ?? []),
    outDir: join(outDir, "replay"),
  });
  const replayDir = replay.framesPath ? join(replay.framesPath, "..") : null;
  const fail = (message: string): ResimResult => ({
    ok: false,
    message,
    replayDir,
    framesPath: replay.framesPath,
  });
  if (replay.status !== "completed") {
    return fail(`replay ${replay.status}: ${replay.errors.slice(0, 2).join(" | ")}`);
  }
  if (
    record.status === "completed" &&
    (replay.winner !== record.winner ||
      replay.reason !== record.reason ||
      replay.corpAgendaPoints !== record.corpAgendaPoints ||
      replay.runnerAgendaPoints !== record.runnerAgendaPoints)
  ) {
    return fail(
      `different ending: recorded ${record.winner} (${record.reason}), replayed ${replay.winner} (${replay.reason})`
    );
  }
  const replayed = await readRows(replay.decisionLogPath);
  const n = Math.max(original.length, replayed.length);
  for (let i = 0; i < n; i++) {
    const a = original[i];
    const b = replayed[i];
    const key = (r: Row | undefined): string =>
      r ? `${r.seq}/${r.seat}/${r.decision_type}/${r.choice}/${r.options.length}` : "<none>";
    if (key(a) !== key(b)) {
      return fail(`decision streams diverge at record ${i}: recorded ${key(a)}, replayed ${key(b)}`);
    }
  }
  if (options.install !== false && replay.framesPath) {
    await copyFile(replay.framesPath, art.frames);
  }
  return {
    ok: true,
    message: `replay matches all ${original.length} decisions; ${replay.corpAgendaPoints}:${replay.runnerAgendaPoints} ${replay.winner}`,
    replayDir,
    framesPath: options.install !== false ? art.frames : replay.framesPath,
  };
}
