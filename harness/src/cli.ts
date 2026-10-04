/** Harness command line: `npx tsx src/cli.ts <command> [flags]`.
 *  `help` lists the commands; docs/how-it-works.md documents the flags. */
import { Args, loadEnvFile, outDir, repoRoot, type Command } from "./commands/args.js";

const COMMANDS: Record<string, { about: string; load: () => Promise<Command> }> = {
  "llm-game": {
    about: "play one game with a model in the Runner, Corp or both seats",
    load: async () => (await import("./commands/games.js")).llmGameCommand,
  },
  "run-match": {
    about: "play many games of one configuration and summarize them",
    load: async () => (await import("./commands/games.js")).runMatchCommand,
  },
  mcp: {
    about: "serve games to chat apps over MCP (play with a subscription instead of the API)",
    load: async () => (await import("./commands/mcp.js")).mcpCommand,
  },
  "run-game": {
    about: "play one game with the rules AI in both seats",
    load: async () => (await import("./commands/games.js")).runGameCommand,
  },
  replay: {
    about: "open a recorded game in the board viewer",
    load: async () => (await import("./commands/review.js")).replayCommand,
  },
  frames: {
    about: "re-simulate recorded games, verify every decision, write viewer frames",
    load: async () => (await import("./commands/review.js")).framesCommand,
  },
  format: {
    about: "write a game's markdown narrative (full.md)",
    load: async () => (await import("./commands/review.js")).formatCommand,
  },
  audit: {
    about: "credit and click conservation audit",
    load: async () => (await import("./commands/review.js")).auditCommand,
  },
  corpus: {
    about: "promote runs into the tracked corpus and regenerate CORPUS.md",
    load: async () => (await import("./commands/corpus.js")).corpusCommand,
  },
  site: {
    about: "build the project page's data (--serve to preview)",
    load: async () => (await import("./commands/corpus.js")).siteCommand,
  },
  pool: {
    about: "list the precons and their qualification (--qualify to rerun it)",
    load: async () => (await import("./commands/pool.js")).poolCommand,
  },
  smoke: {
    about: "fuzz the seat interface across the card pool with the mock model",
    load: async () => (await import("./commands/pool.js")).smokeCommand,
  },
  determinism: {
    about: "play one seed twice and require identical logs",
    load: async () => (await import("./commands/checks.js")).determinismCommand,
  },
  golden: {
    about: "replay the frozen golden games (`golden record` re-blesses them)",
    load: async () => (await import("./commands/checks.js")).goldenCommand,
  },
  invariant: {
    about: "check that no serialized state leaks hidden information",
    load: async () => (await import("./commands/checks.js")).invariantCommand,
  },
  selftest: {
    about: "plant defects and require every checker to catch them",
    load: async () => (await import("./commands/checks.js")).selftestCommand,
  },
  "fetch-rules": {
    about: "snapshot NSG's learn-to-play guides into harness/rules/",
    load: async () => (await import("./commands/checks.js")).fetchRulesCommand,
  },
};

function help(): void {
  console.log("usage: npx tsx src/cli.ts <command> [flags]\n");
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  for (const [name, c] of Object.entries(COMMANDS)) console.log(`  ${name.padEnd(width)}  ${c.about}`);
  console.log("\nFlags are documented in harness/docs/how-it-works.md.");
}

const name = process.argv[2];
if (!name || name === "help" || name === "--help" || name === "-h") {
  help();
  process.exit(name ? 0 : 2);
}
const command = COMMANDS[name];
if (!command) {
  console.error(`unknown command: ${name}\n`);
  help();
  process.exit(2);
}
loadEnvFile();
const run = await command.load();
process.exit(await run({ repoRoot, outDir, args: new Args(process.argv.slice(3)) }));
