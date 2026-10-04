/** `mcp`: serve games to chat apps over MCP, so a subscription app (Claude,
 *  ChatGPT) plays a seat instead of the harness calling a model API.
 *
 *    npx tsx src/cli.ts mcp                 Streamable HTTP on 127.0.0.1:8765/mcp
 *    npx tsx src/cli.ts mcp --stdio         for apps that launch the server
 *    npx tsx src/cli.ts mcp --secret S      serve /mcp/S (for a public tunnel)
 *
 *  Flags: --port, --host, --live (board viewer on :8787), --invariant (run
 *  the no-cheating checker in every game), --allow-unqualified. Games are
 *  recorded in harness/out/ like any other run. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startLiveViewer } from "../live.js";
import { GameHost } from "../mcp/host.js";
import { serveHttp } from "../mcp/http.js";
import { createMcpServer } from "../mcp/server.js";
import { untilInterrupted, type Command } from "./args.js";

export const mcpCommand: Command = async ({ repoRoot, outDir, args }) => {
  const version = (JSON.parse(readFileSync(join(repoRoot, "harness", "package.json"), "utf-8")) as { version: string })
    .version;
  const stdio = args.flag("stdio");
  // Under stdio, stdout carries the protocol: everything else goes to stderr.
  if (stdio) console.log = console.error;
  const live = args.flag("live") ? await startLiveViewer(repoRoot, { open: false }) : null;
  const host = new GameHost({
    repoRoot,
    outDir,
    extraParams: args.flag("invariant") ? "&invariant=1" : "",
    allowUnqualified: args.flag("allow-unqualified"),
    ...(live ? { onEvent: live.push } : {}),
  });

  if (stdio) {
    await createMcpServer(host, version).connect(new StdioServerTransport());
    console.error("netrunner MCP server on stdio");
    await new Promise<void>((done) => process.stdin.once("close", done));
    return 0;
  }

  const server = await serveHttp(host, {
    bind: args.str("host", "127.0.0.1"),
    port: args.int("port", 8765),
    secret: args.str("secret", process.env["NETRUNNER_MCP_SECRET"] ?? ""),
    version,
  });
  console.log(`netrunner MCP server: ${server.url}`);
  if (live) console.log(`board viewer for the latest game: ${live.url}`);
  console.log("Ctrl-C to stop (games in progress end with the server).");
  await untilInterrupted();
  await server.close();
  if (live) await live.finish();
  return 0;
};
