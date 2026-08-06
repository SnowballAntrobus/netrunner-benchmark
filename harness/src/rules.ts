/** Official rules sourcing (PHASE1 M4.1).
 *
 *  `npm run fetch-rules` downloads NSG's learn-to-play guides (full HTML
 *  pages) and extracts their text into harness/rules/*.txt. Snapshots are
 *  meant to be REVIEWED and COMMITTED once fetched — pinned rules text
 *  keeps experiments reproducible (same precedent as carddata.json, which
 *  already vendors NSG card text with attribution). Re-fetching is a
 *  deliberate act that shows up in review.
 *
 *  Rationale (see PHASE1 discussion): official text is the neutral rules
 *  source — no harness author wrote it for either side. The harness still
 *  prepends its own interface guide (unavoidable authored text: it maps
 *  rulebook concepts onto the decision protocol). Including BOTH sides'
 *  guides means the Runner knows how the Corp works; narrowing that is a
 *  future ablation knob.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const RULES_SOURCES: { file: string; url: string; label: string }[] = [
  {
    file: "learn-to-play-runner.txt",
    url: "https://nullsignal.games/players/learn-to-play/learn-to-play-runner/",
    label: "Null Signal Games — Learn to Play: Runner",
  },
  {
    file: "learn-to-play-corp.txt",
    url: "https://nullsignal.games/players/learn-to-play/learn-to-play-corp/",
    label: "Null Signal Games — Learn to Play: Corp",
  },
  {
    file: "run-guide.txt",
    url: "https://nullsignal.games/players/learn-to-play/run-guide/",
    label: "Null Signal Games — Run Guide (run timing structure)",
  },
];

/** Minimal HTML → text: prefer the <article>/<main> content region
 *  (WordPress layout), strip scripts/styles/tags, decode common entities.
 *  Output is meant for human review before being committed. */
export function htmlToText(html: string): string {
  let s = html;
  const article = /<article[\s>][\s\S]*?<\/article>/i.exec(s);
  const main = /<main[\s>][\s\S]*?<\/main>/i.exec(s);
  if (article) s = article[0];
  else if (main) s = main[0];
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<(h[1-6])[^>]*>/gi, "\n\n## ");
  s = s.replace(/<\/(h[1-6])>/gi, "\n");
  s = s.replace(/<(p|div|li|tr|br)[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#8216;|&lsquo;/g, "'")
    .replace(/&#8220;|&ldquo;/g, '"')
    .replace(/&#8221;|&rdquo;/g, '"')
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8212;|&mdash;/g, "—");
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

export async function fetchRules(repoRoot: string): Promise<void> {
  const dir = join(repoRoot, "harness", "rules");
  await mkdir(dir, { recursive: true });
  for (const source of RULES_SOURCES) {
    process.stdout.write(`fetching ${source.url} ... `);
    const response = await fetch(source.url, {
      headers: { "user-agent": "netrunner-benchmark-harness rules fetch (research)" },
    });
    if (!response.ok) throw new Error(`${source.url}: HTTP ${response.status}`);
    const html = await response.text();
    const text =
      `# ${source.label}\n# Source: ${source.url}\n# Retrieved: ${
        new Date().toISOString().slice(0, 10)
      }\n# Copyright Null Signal Games; vendored for research use with attribution.\n\n` +
      htmlToText(html);
    await writeFile(join(dir, source.file), text);
    console.log(`${text.length} chars → rules/${source.file}`);
  }
  console.log(
    "\nReview the extracted text (nav/footer noise, truncation), then commit\n" +
      "harness/rules/ so the rules snapshot is pinned for reproducibility."
  );
}

export async function loadOfficialRules(repoRoot: string): Promise<string> {
  const dir = join(repoRoot, "harness", "rules");
  const parts: string[] = [];
  for (const source of RULES_SOURCES) {
    try {
      parts.push(await readFile(join(dir, source.file), "utf-8"));
    } catch {
      throw new Error(
        `missing harness/rules/${source.file} — run \`npm run fetch-rules\` once ` +
          `(and commit the snapshots), or use --rules digest`
      );
    }
  }
  return parts.join("\n\n---\n\n");
}
