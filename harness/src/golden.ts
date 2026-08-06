/** Golden-log regression suite (PHASE1 M2).
 *
 *  `record` plays every game in fixtures/golden/manifest.json and freezes
 *  {result, normalized log} per game. `check` replays them and diffs — any
 *  engine-affecting change shows up as a failed game with the first
 *  divergent log line. Raw (un-normalized) logs stay out of fixtures by
 *  design; determinism of the raw-vs-normalized distinction is covered by
 *  the determinism command.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launchBrowser, runGame, type GameRecord } from "./game.js";
import { normalizeLog, firstDivergence } from "./log.js";

interface ManifestGame {
  id: string;
  seed: number;
  corp: string;
  runner: string;
}

interface Fixture {
  id: string;
  seed: number;
  corpPrecon: string;
  runnerPrecon: string;
  winner: string | null;
  reason: string | null;
  corpAgendaPoints: number | null;
  runnerAgendaPoints: number | null;
  log: string[]; // normalized
}

function toFixture(id: string, r: GameRecord): Fixture {
  return {
    id,
    seed: r.seed,
    corpPrecon: r.corpPrecon,
    runnerPrecon: r.runnerPrecon,
    winner: r.winner,
    reason: r.reason,
    corpAgendaPoints: r.corpAgendaPoints,
    runnerAgendaPoints: r.runnerAgendaPoints,
    log: normalizeLog(r.log),
  };
}

export async function golden(repoRoot: string, mode: "record" | "check"): Promise<number> {
  const dir = join(repoRoot, "harness", "fixtures", "golden");
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf-8")) as {
    games: ManifestGame[];
  };
  const browser = await launchBrowser();
  let failures = 0;

  try {
    for (const g of manifest.games) {
      const record = await runGame(
        { repoRoot, seed: g.seed, corpPrecon: g.corp, runnerPrecon: g.runner },
        browser
      );
      const fresh = toFixture(g.id, record);

      if (record.status !== "completed") {
        console.log(`${g.id} FAIL: game did not complete (${record.status})`,
          record.errors.slice(0, 3));
        failures++;
        continue;
      }

      const fixtureFile = join(dir, `${g.id}.json`);
      if (mode === "record") {
        await mkdir(dir, { recursive: true });
        await writeFile(fixtureFile, JSON.stringify(fresh, null, 1));
        console.log(
          `${g.id} recorded: seed=${g.seed} ${g.corp} vs ${g.runner} → ` +
          `${fresh.winner} (${fresh.corpAgendaPoints}:${fresh.runnerAgendaPoints}), ` +
          `${fresh.log.length} lines, ${(record.durationMs / 1000).toFixed(1)}s`
        );
        continue;
      }

      let frozen: Fixture;
      try {
        frozen = JSON.parse(await readFile(fixtureFile, "utf-8")) as Fixture;
      } catch {
        console.log(`${g.id} FAIL: fixture missing — run \`npm run golden -- record\``);
        failures++;
        continue;
      }

      const resultMatch =
        frozen.winner === fresh.winner &&
        frozen.reason === fresh.reason &&
        frozen.corpAgendaPoints === fresh.corpAgendaPoints &&
        frozen.runnerAgendaPoints === fresh.runnerAgendaPoints;
      const diverge = firstDivergence(frozen.log, fresh.log);

      if (resultMatch && diverge === -1) {
        console.log(`${g.id} PASS (${fresh.log.length} lines, ${(record.durationMs / 1000).toFixed(1)}s)`);
      } else {
        failures++;
        console.log(`${g.id} FAIL:`);
        if (!resultMatch) {
          console.log(
            `  result: frozen ${frozen.winner} ${frozen.corpAgendaPoints}:${frozen.runnerAgendaPoints} ` +
            `("${frozen.reason}") vs fresh ${fresh.winner} ${fresh.corpAgendaPoints}:${fresh.runnerAgendaPoints} ` +
            `("${fresh.reason}")`
          );
        }
        if (diverge !== -1) {
          console.log(`  logs diverge at line ${diverge}:`);
          console.log(`    frozen: ${frozen.log[diverge] ?? "<end>"}`);
          console.log(`    fresh:  ${fresh.log[diverge] ?? "<end>"}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  if (mode === "check") {
    console.log(
      failures === 0
        ? `GOLDEN: all ${manifest.games.length} games match their fixtures`
        : `GOLDEN: ${failures}/${manifest.games.length} games FAILED`
    );
  }
  return failures === 0 ? 0 : 1;
}
