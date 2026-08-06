/** Orchestrates one headless rules-AI vs rules-AI game (M1).
 *  Launches Chromium via Playwright, navigates to harness.html in faceoff
 *  mode, and waits for the page's __harness surface to report a result.
 *  All page interaction goes through window.__harness — nothing else. */
import { chromium, type Browser } from "playwright";
import { existsSync } from "node:fs";
import { startServer } from "./server.js";
import { loadPrecon, encodeDeckParam } from "./precons.js";

export interface GameOptions {
  repoRoot: string;
  seed: number;
  corpPrecon: string;
  runnerPrecon: string;
  timeoutMs?: number; // whole-game watchdog
  stallMs?: number; // no-new-decisions watchdog
  extraParams?: string; // appended verbatim to the harness URL (debug aids)
}

export interface GameRecord {
  seed: number;
  corpPrecon: string;
  runnerPrecon: string;
  status: "completed" | "timeout" | "stalled" | "crashed";
  winner: "corp" | "runner" | null;
  reason: string | null;
  corpAgendaPoints: number | null;
  runnerAgendaPoints: number | null;
  decisions: number;
  durationMs: number;
  errors: string[];
  log: string[];
  rngTrace?: number[]; // per-log-line Math.random draw counts (&rngtrace=1)
  rngStacks?: string[]; // stacks for draws in &rngstack=N-M
}

interface HarnessSurface {
  started: boolean;
  done: boolean;
  decisions: number;
  errors: string[];
  result: {
    winner: "corp" | "runner";
    reason: string;
    corpAgendaPoints: number;
    runnerAgendaPoints: number;
  } | null;
}

/** The sandbox pre-installs Chromium outside npm's registry path; prefer it. */
function chromiumExecutable(): string | undefined {
  for (const p of [process.env["HARNESS_CHROMIUM"], "/opt/pw-browsers/chromium"]) {
    if (p && existsSync(p)) return p;
  }
  return undefined; // fall back to Playwright's own resolution
}

export async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch (e) {
    const executablePath = chromiumExecutable();
    if (!executablePath) throw e;
    return await chromium.launch({ executablePath });
  }
}

export async function runGame(options: GameOptions, browser?: Browser): Promise<GameRecord> {
  const { repoRoot, seed, corpPrecon, runnerPrecon } = options;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const stallMs = options.stallMs ?? 60_000;
  const startedAt = Date.now();

  const [corpDeck, runnerDeck] = await Promise.all([
    loadPrecon(repoRoot, corpPrecon),
    loadPrecon(repoRoot, runnerPrecon),
  ]);

  const staticServer = await startServer(repoRoot);
  const ownBrowser = browser === undefined;
  const activeBrowser = browser ?? (await launchBrowser());
  const context = await activeBrowser.newContext();
  const page = await context.newPage();

  const record: GameRecord = {
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
    errors: [],
    log: [],
  };

  try {
    const url =
      `http://127.0.0.1:${staticServer.port}/harness.html` +
      `?faceoff=1&p=r&seed=${seed}` +
      `&c=${encodeDeckParam(corpDeck)}&r=${encodeDeckParam(runnerDeck)}` +
      (options.extraParams ?? "");
    await page.goto(url, { waitUntil: "load" });

    // Poll the page's harness surface until done / timeout / stall.
    let lastDecisions = -1;
    let lastProgressAt = Date.now();
    for (;;) {
      const surface = (await page.evaluate(() => {
        const h = (window as unknown as { __harness: HarnessSurface }).__harness;
        return {
          started: h.started,
          done: h.done,
          decisions: h.decisions,
          errors: h.errors,
          result: h.result,
        };
      })) as HarnessSurface;

      if (surface.decisions !== lastDecisions) {
        lastDecisions = surface.decisions;
        lastProgressAt = Date.now();
      }
      if (surface.done && surface.result) {
        record.status = "completed";
        record.winner = surface.result.winner;
        record.reason = surface.result.reason;
        record.corpAgendaPoints = surface.result.corpAgendaPoints;
        record.runnerAgendaPoints = surface.result.runnerAgendaPoints;
        record.decisions = surface.decisions;
        record.errors = surface.errors;
        break;
      }
      if (Date.now() - startedAt > timeoutMs) {
        record.status = "timeout";
        record.decisions = surface.decisions;
        record.errors = surface.errors;
        break;
      }
      if (Date.now() - lastProgressAt > stallMs) {
        record.status = "stalled";
        record.decisions = surface.decisions;
        record.errors = surface.errors;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    record.log = (await page.evaluate(() => {
      const h = (window as unknown as {
        __harness: { log: () => string[]; logAtWin?: string[] };
      }).__harness;
      return h.logAtWin ?? h.log();
    })) as string[];

    if (options.extraParams?.includes("rngtrace")) {
      const debug = (await page.evaluate(() => {
        const w = window as unknown as { __rngTrace?: number[]; __rngStacks?: string[] };
        return { trace: w.__rngTrace ?? [], stacks: w.__rngStacks ?? [] };
      })) as { trace: number[]; stacks: string[] };
      record.rngTrace = debug.trace;
      record.rngStacks = debug.stacks;
    }
  } catch (e) {
    record.errors.push(`host: ${String(e)}`);
  } finally {
    record.durationMs = Date.now() - startedAt;
    await context.close();
    if (ownBrowser) await activeBrowser.close();
    await staticServer.close();
  }
  return record;
}
