/** Viewer bundles and the project site's data.
 *
 *  A bundle is the board viewer's whole input for one game: metadata, the
 *  card dictionary, public narration, deduplicated board frames, and one
 *  step per decision/compaction record. It is built by site/viewer/
 *  model.mjs — the SAME module the viewer runs in the browser for the live
 *  stream — so recorded and live games are modeled identically.
 *
 *  `cli.ts site` writes bundles for every corpus game to
 *  site/data/games/<id>.json plus site/data/index.json (gallery + results
 *  tables); `cli.ts replay` writes one into a run folder and serves it.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveGameArtifacts } from "./paths.js";
import { loadPrecon } from "./precons.js";
import { loadPoolManifest } from "./cardpool.js";
import { ABLATION_LABEL, isStandard, seatEntries, type GameRecordLite } from "./corpus.js";

interface ViewerModel {
  buildGame(input: {
    record: Record<string, unknown>;
    rows: Record<string, unknown>[];
    frames: Record<string, unknown>[];
    debrief: unknown;
    carddata: unknown[];
  }): { steps: { k: string; model?: string }[]; frames: unknown[]; meta: Record<string, unknown> };
}

async function viewerModel(repoRoot: string): Promise<ViewerModel> {
  const href = pathToFileURL(join(repoRoot, "site", "viewer", "model.mjs")).href;
  return (await import(href)) as ViewerModel;
}

let carddataCache: unknown[] | null = null;
async function carddata(repoRoot: string): Promise<unknown[]> {
  if (!carddataCache) {
    carddataCache = (
      JSON.parse(await readFile(join(repoRoot, "carddata", "carddata.json"), "utf-8")) as {
        data: unknown[];
      }
    ).data;
  }
  return carddataCache;
}

async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  if (!existsSync(path)) return [];
  return (await readFile(path, "utf-8"))
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Build one game's viewer bundle and write it to `outFile`. */
export async function writeBundle(repoRoot: string, runPath: string, outFile: string): Promise<{
  steps: number;
  frames: number;
  bytes: number;
}> {
  const art = resolveGameArtifacts(runPath);
  const record = JSON.parse(await readFile(art.record, "utf-8")) as Record<string, unknown> & {
    corpPrecon: string;
    runnerPrecon: string;
  };
  record["gameId"] = art.gameId;
  // Whole decklists in the dictionary: menus can name cards no frame shows
  // (a stack search lists cards still in the stack).
  try {
    const [c, r] = await Promise.all([
      loadPrecon(repoRoot, record.corpPrecon),
      loadPrecon(repoRoot, record.runnerPrecon),
    ]);
    record["corpDeckIds"] = [c.identity, ...c.cards];
    record["runnerDeckIds"] = [r.identity, ...r.cards];
  } catch {
    /* precon renamed since — frames still cover what was on the board */
  }
  const rows = await readJsonl(art.jsonl);
  const frames = await readJsonl(art.frames);
  const debrief = existsSync(art.debrief) ? JSON.parse(await readFile(art.debrief, "utf-8")) : null;
  const model = await viewerModel(repoRoot);
  const game = model.buildGame({ record, rows, frames, debrief, carddata: await carddata(repoRoot) });
  const json = JSON.stringify(game);
  await mkdir(join(outFile, ".."), { recursive: true });
  await writeFile(outFile, json);
  return { steps: game.steps.length, frames: game.frames.length, bytes: json.length };
}

export interface SiteGameEntry {
  id: string;
  /** False for the `--ai-branches rules` ablation (see corpus.ts). */
  standard: boolean;
  seed: number | null;
  corpPrecon: string;
  runnerPrecon: string;
  seats: { seat: string; model: string; driver: string; llmDecisions: number; costUsd: number | null }[];
  status: string;
  winner: string | null;
  reason: string | null;
  corpAP: number | null;
  runnerAP: number | null;
  corpTurns: number | null;
  decisions: number | null;
  compactions: number;
  retries: number;
  fallbacks: number;
  hasFrames: boolean;
  bundle: string | null; // path relative to site/
}

/** The demo shown while the corpus has no games with frames: a committed
 *  keyless game (the mock model plays random legal moves as the Runner). */
export const DEMO_GAME = join("harness", "fixtures", "mock-game");

/** Bundles for every corpus game + the site's index.json. */
export async function buildSiteData(
  repoRoot: string
): Promise<{ games: number; bytes: number; demo: boolean }> {
  const gamesDir = join(repoRoot, "harness", "data", "games");
  const outDir = join(repoRoot, "site", "data");
  await rm(join(outDir, "games"), { recursive: true, force: true }); // no stale bundles
  const entries: SiteGameEntry[] = [];
  let bytes = 0;
  const ids = existsSync(gamesDir) ? (await readdir(gamesDir)).sort() : [];
  for (const id of ids) {
    const dir = join(gamesDir, id);
    if (!existsSync(join(dir, "record.json"))) continue;
    const record = JSON.parse(await readFile(join(dir, "record.json"), "utf-8")) as GameRecordLite & {
      decisions?: number;
    };
    const hasFrames = existsSync(join(dir, "frames.jsonl"));
    let bundle: string | null = null;
    if (hasFrames) {
      const rel = `data/games/${id}.json`;
      const out = await writeBundle(repoRoot, dir, join(repoRoot, "site", rel));
      bytes += out.bytes;
      bundle = rel;
    }
    entries.push({
      id,
      standard: isStandard(record),
      seed: record.seed ?? null,
      corpPrecon: record.corpPrecon ?? "?",
      runnerPrecon: record.runnerPrecon ?? "?",
      seats: seatEntries(record).map((s) => ({
        seat: s.seat,
        model: s.model,
        driver: s.driver,
        llmDecisions: s.llmDecisions,
        costUsd: s.costUsd,
      })),
      status: record.status ?? "?",
      winner: record.winner ?? null,
      reason: record.reason ?? null,
      corpAP: record.corpAgendaPoints ?? null,
      runnerAP: record.runnerAgendaPoints ?? null,
      corpTurns: record.turns?.corp ?? null,
      decisions: record.decisions ?? null,
      compactions: record.compactions ?? 0,
      retries: record.retriesTotal ?? 0,
      fallbacks: record.fallbacks ?? 0,
      hasFrames,
      bundle,
    });
  }
  let demo: { bundle: string; seed: number | null; corpPrecon: string; runnerPrecon: string } | null = null;
  if (!entries.some((e) => e.bundle)) {
    const dir = join(repoRoot, DEMO_GAME);
    const record = JSON.parse(await readFile(join(dir, "record.json"), "utf-8")) as GameRecordLite;
    const rel = "data/games/demo.json";
    const out = await writeBundle(repoRoot, dir, join(repoRoot, "site", rel));
    bytes += out.bytes;
    demo = {
      bundle: rel,
      seed: record.seed ?? null,
      corpPrecon: record.corpPrecon ?? "?",
      runnerPrecon: record.runnerPrecon ?? "?",
    };
  }
  // Card-pool qualification summary, when the manifest exists.
  const manifest = await loadPoolManifest(repoRoot);
  const pool = manifest
    ? {
        generated: manifest.generated,
        total: Object.keys(manifest.decks).length,
        qualified: {
          corp: Object.values(manifest.decks).filter((d) => d.qualified && d.side === "corp").length,
          runner: Object.values(manifest.decks).filter((d) => d.qualified && d.side === "runner").length,
        },
        refused: Object.entries(manifest.decks)
          .filter(([, d]) => !d.qualified)
          .map(([name, d]) => ({
            name,
            side: d.side,
            sets: d.sets,
            problem: d.games.find((g) => g.firstProblem)?.firstProblem ?? null,
          })),
      }
    : null;
  const index = {
    generated: new Date().toISOString().slice(0, 10),
    ablation: ABLATION_LABEL,
    pool,
    demo,
    games: entries,
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "index.json"), JSON.stringify(index, null, 1) + "\n");
  return { games: entries.length, bytes, demo: demo !== null };
}
