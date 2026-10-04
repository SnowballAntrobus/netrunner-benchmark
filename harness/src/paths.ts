/** Game-artifact path resolution (D06-1 rev 2).
 *
 *  Nested layout (current): one folder per run —
 *    out/<game_id>/record.json, decisions.jsonl, debrief.json,
 *    system-prompt.txt (two-model games: system-prompt.<seat>.txt),
 *    frames.jsonl (viewer board snapshots, D15), full.md
 *  Flat layout (legacy, tolerated): stem siblings —
 *    out/<game_id>.json, <game_id>.jsonl, <game_id>-debrief.json, ...
 *
 *  Every tool resolves through here: pass a run folder, any file inside
 *  it, or any legacy stem file, and get the full artifact set back.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface GameArtifacts {
  gameId: string;
  nested: boolean;
  dir: string; // run folder (nested) or containing dir (flat)
  record: string;
  jsonl: string;
  debrief: string;
  systemPrompt: string;
  /** Every system prompt present: system-prompt.txt, or one per seat. */
  systemPrompts: string[];
  frames: string;
  fullMd: string;
}

const NESTED_NAMES = new Set([
  "record.json",
  "decisions.jsonl",
  "debrief.json",
  "system-prompt.txt",
  "system-prompt.corp.txt",
  "system-prompt.runner.txt",
  "frames.jsonl",
  "full.md",
]);

export function resolveGameArtifacts(path: string): GameArtifacts {
  // A run folder itself.
  if (existsSync(path) && statSync(path).isDirectory()) {
    return nested(path);
  }
  const base = basename(path);
  // Any canonical file inside a run folder.
  if (NESTED_NAMES.has(base)) {
    return nested(dirname(path));
  }
  // Legacy flat stem: strip whichever artifact suffix was passed.
  const stem = path
    .replace(/-debrief\.json$/, "")
    .replace(/-system-prompt\.txt$/, "")
    .replace(/\.full\.md$/, "")
    .replace(/\.report\.md$/, "")
    .replace(/\.jsonl$/, "")
    .replace(/\.json$/, "");
  return {
    gameId: basename(stem),
    nested: false,
    dir: dirname(stem),
    record: `${stem}.json`,
    jsonl: `${stem}.jsonl`,
    debrief: `${stem}-debrief.json`,
    systemPrompt: `${stem}-system-prompt.txt`,
    systemPrompts: existsSync(`${stem}-system-prompt.txt`) ? [`${stem}-system-prompt.txt`] : [],
    frames: `${stem}.frames.jsonl`,
    fullMd: `${stem}.full.md`,
  };
}

function nested(dir: string): GameArtifacts {
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
    nested: true,
    dir,
    record: join(dir, "record.json"),
    jsonl: join(dir, "decisions.jsonl"),
    debrief: join(dir, "debrief.json"),
    systemPrompt: join(dir, "system-prompt.txt"),
    systemPrompts,
    frames: join(dir, "frames.jsonl"),
    fullMd: join(dir, "full.md"),
  };
}
