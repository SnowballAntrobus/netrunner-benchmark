/** Reviewing recorded games: `replay` (board viewer), `frames`
 *  (re-simulate and verify), `format` (markdown narrative) and `audit`
 *  (credit and click conservation). */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { auditFile, auditGolden, reportAudit, reviewSample } from "../audit.js";
import { writeFormatted } from "../format.js";
import { launchBrowser } from "../game.js";
import { resolveGameArtifacts } from "../paths.js";
import { resimulate } from "../resim.js";
import { startServer } from "../server.js";
import { writeBundle } from "../site.js";
import { untilInterrupted, type Command } from "./args.js";

/** Serve a game in the board viewer; `--screenshot out.png` renders one
 *  moment (`--step N` or `--seq N`) and exits. Games recorded without
 *  frames are re-simulated first. */
export const replayCommand: Command = async ({ repoRoot, outDir, args }) => {
  const file = args.str("file", "");
  if (!file) {
    console.error("replay requires --file <run folder>");
    return 2;
  }
  const art = resolveGameArtifacts(resolve(file));
  if (!existsSync(art.frames)) {
    console.log("no frames.jsonl for this game: re-simulating it to capture them…");
    const r = await resimulate(repoRoot, art.dir, outDir);
    console.log(`${r.ok ? "ok" : "FAILED"}: ${r.message}`);
    if (!r.ok) return 1;
  }
  const bundlePath = join(outDir, "viewer", `${art.gameId}.json`);
  const info = await writeBundle(repoRoot, art.dir, bundlePath);
  console.log(
    `bundle: ${bundlePath} (${info.steps} steps, ${info.frames} boards, ${(info.bytes / 1e6).toFixed(1)} MB)`
  );
  const server = await startServer(repoRoot);
  const rel = "/" + relative(repoRoot, bundlePath).split(sep).join("/");
  const anchor = args.str("step", "") ? `#step=${args.str("step", "")}` : args.str("seq", "") ? `#seq=${args.str("seq", "")}` : "";
  const url = `http://127.0.0.1:${server.port}/site/viewer/?game=${encodeURIComponent(rel)}${anchor}`;
  const shot = args.str("screenshot", "");
  if (shot) {
    const browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(
      () => (window as unknown as { __viewer?: { ready: () => boolean } }).__viewer?.ready() === true,
      undefined,
      { timeout: 60_000 }
    );
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot });
    await browser.close();
    await server.close();
    console.log(`screenshot: ${shot}`);
    return 0;
  }
  console.log(`Board viewer: ${url}`);
  console.log("← → step · Shift+← → model decisions · Space play · Ctrl-C to stop");
  await untilInterrupted();
  await server.close();
  return 0;
};

/** Re-simulate recorded games with their recorded choices (no API calls),
 *  verify every decision, and write frames.jsonl next to each record.
 *  `--file <run>` or `--corpus` (every game in harness/data/games). */
export const framesCommand: Command = async ({ repoRoot, outDir, args }) => {
  const targets: string[] = [];
  if (args.has("corpus")) {
    const dir = join(repoRoot, "harness", "data", "games");
    if (existsSync(dir)) for (const id of (await readdir(dir)).sort()) targets.push(join(dir, id));
  } else {
    const file = args.str("file", "");
    if (!file) {
      console.error("frames requires --file <run folder> or --corpus");
      return 2;
    }
    targets.push(resolve(file));
  }
  let failures = 0;
  for (const t of targets) {
    const result = await resimulate(repoRoot, t, outDir);
    if (!result.ok) failures++;
    console.log(`${result.ok ? "ok  " : "FAIL"} ${t.split(/[\\/]/).pop()}: ${result.message}`);
  }
  return failures === 0 ? 0 : 1;
};

export const formatCommand: Command = async ({ args }) => {
  const file = args.str("file", "");
  if (!file) {
    console.error("format requires --file <run folder>");
    return 2;
  }
  const art = resolveGameArtifacts(file);
  for (const w of await writeFormatted(art.record, existsSync(art.jsonl) ? art.jsonl : null)) console.log(w);
  return 0;
};

/** Conservation audit of the golden fixtures, or of one game with
 *  `--file`; `--review-sample N` writes a hand-check packet instead. */
export const auditCommand: Command = async ({ repoRoot, args }) => {
  const file = args.str("file", "");
  if (args.has("review-sample")) {
    if (!file) {
      console.error("audit --review-sample N needs --file <run folder>");
      return 2;
    }
    const out = await reviewSample(
      repoRoot,
      resolveGameArtifacts(file).record,
      args.int("review-sample", 12),
      args.seed
    );
    console.log(`${out.samples} sampled checkpoints → ${out.outFile}`);
    return 0;
  }
  const results = file
    ? [await auditFile(repoRoot, resolveGameArtifacts(file).record)]
    : await auditGolden(repoRoot);
  return reportAudit(results);
};
