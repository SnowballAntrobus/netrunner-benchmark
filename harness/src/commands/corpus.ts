/** The tracked corpus and the project page: `corpus` promotes finished runs
 *  into harness/data/games and regenerates CORPUS.md; `site` builds the
 *  page's data from the corpus (and previews it with --serve). */
import { promote, writeReport } from "../corpus.js";
import { startServer } from "../server.js";
import { buildSiteData } from "../site.js";
import { untilInterrupted, type Command } from "./args.js";

export const corpusCommand: Command = async ({ repoRoot, args }) => {
  for (const run of args.all("promote")) {
    console.log(`promoted → ${await promote(repoRoot, run, args.has("partial"))}`);
  }
  console.log(await writeReport(repoRoot));
  return 0;
};

export const siteCommand: Command = async ({ repoRoot, args }) => {
  const out = await buildSiteData(repoRoot);
  console.log(
    `site data: ${out.games} game${out.games === 1 ? "" : "s"}` +
      (out.demo ? " (corpus empty: demo game only)" : "") +
      `, ${(out.bytes / 1e6).toFixed(1)} MB of bundles → site/data/`
  );
  if (args.flag("serve")) {
    const server = await startServer(repoRoot, undefined, args.int("port", 8788));
    console.log(`site preview: http://127.0.0.1:${server.port}/site/  (Ctrl-C to stop)`);
    await untilInterrupted();
    await server.close();
  }
  return 0;
};
