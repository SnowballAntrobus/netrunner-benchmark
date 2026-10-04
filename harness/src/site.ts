/** Viewer bundles and the project site's data (D15/D17).
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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveGameArtifacts } from "./paths.js";
import { loadPrecon } from "./precons.js";
import { eraOf, ERA_LABEL, CURRENT_ERA, seatEntries, type GameRecordLite } from "./corpus.js";

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
  era: number;
  eraLabel: string;
  seed: number | null;
  corpPrecon: string;
  runnerPrecon: string;
  seats: { seat: string; model: string; llmDecisions: number; costUsd: number | null }[];
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

/** Bundles for every corpus game + the site's index.json. */
export async function buildSiteData(repoRoot: string): Promise<{ games: number; bytes: number }> {
  const { readdir } = await import("node:fs/promises");
  const gamesDir = join(repoRoot, "harness", "data", "games");
  const outDir = join(repoRoot, "site", "data");
  const entries: SiteGameEntry[] = [];
  let bytes = 0;
  for (const id of (await readdir(gamesDir)).sort()) {
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
      era: eraOf(record),
      eraLabel: ERA_LABEL[eraOf(record)] ?? "",
      seed: record.seed ?? null,
      corpPrecon: record.corpPrecon ?? "?",
      runnerPrecon: record.runnerPrecon ?? "?",
      seats: seatEntries(record).map((s) => ({
        seat: s.seat,
        model: s.model,
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
  // Card-pool qualification summary (D16), when the manifest exists.
  const { loadPoolManifest } = await import("./cardpool.js");
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
    currentEra: CURRENT_ERA,
    eras: ERA_LABEL,
    pool,
    games: entries,
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "index.json"), JSON.stringify(index, null, 1) + "\n");
  return { games: entries.length, bytes };
}
