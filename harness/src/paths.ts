/** Game artifacts: one folder per run —
 *    out/<game_id>/record.json, decisions.jsonl, frames.jsonl, debrief.json,
 *    system-prompt.txt (two-model games: system-prompt.<seat>.txt), full.md
 *  Every tool resolves through here: pass the run folder or any file in it. */
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface GameArtifacts {
  gameId: string;
  dir: string;
  record: string;
  jsonl: string;
  debrief: string;
  /** Every system prompt present: system-prompt.txt, or one per seat. */
  systemPrompts: string[];
  frames: string;
  fullMd: string;
}

export function resolveGameArtifacts(path: string): GameArtifacts {
  const dir = existsSync(path) && statSync(path).isDirectory() ? path : dirname(path);
  let systemPrompts: string[] = [];
  try {
    systemPrompts = readdirSync(dir)
      .filter((f) => /^system-prompt(\.(corp|runner))?\.txt$/.test(f))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    /* folder not created yet */
  }
  return {
    gameId: basename(dir),
    dir,
    record: join(dir, "record.json"),
    jsonl: join(dir, "decisions.jsonl"),
    debrief: join(dir, "debrief.json"),
    systemPrompts,
    frames: join(dir, "frames.jsonl"),
    fullMd: join(dir, "full.md"),
  };
}
