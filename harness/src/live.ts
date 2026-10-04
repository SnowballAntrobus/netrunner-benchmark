/** Live viewer: watch a game in the board viewer while it is played.
 *
 *  `llm-game --live` starts this server next to the game: it serves the
 *  repo statically (the viewer lives at /site/viewer/) plus one
 *  Server-Sent Events stream, /live/events, carrying every LiveEvent the
 *  game emits (meta, decision, compaction, frame, end). A browser that
 *  connects late first receives the whole backlog, then follows the
 *  stream — so the URL can be opened at any point of the game. Under
 *  run-match the stream carries game after game; each new game's meta
 *  event resets the backlog and the viewer.
 *
 *  The stream is a reviewer view: frames are omniscient board snapshots
 *  and decisions carry the full records. Nothing here ever reaches a
 *  model — the page-side seat and the host bridge are untouched.
 */
import { spawn } from "node:child_process";
import type { ServerResponse } from "node:http";
import { startServer, type StaticServer } from "./server.js";
import type { LiveEvent } from "./llmgame.js";

export interface LiveViewer {
  url: string;
  push: (event: LiveEvent) => void;
  /** Called once the game ends: keeps serving until Ctrl-C on a TTY so
   *  the finished game stays browsable; closes immediately otherwise. */
  finish: () => Promise<void>;
}

/** Best-effort browser launch (same spirit as --watch); the URL is always
 *  printed for manual opening. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* no desktop — the printed URL is the fallback */
    });
    child.unref();
  } catch {
    /* ignore */
  }
}

export async function startLiveViewer(
  repoRoot: string,
  options: { port?: number; open?: boolean } = {}
): Promise<LiveViewer> {
  const backlog: string[] = [];
  const clients = new Set<ServerResponse>();
  const send = (res: ServerResponse, chunk: string): void => {
    try {
      res.write(chunk);
    } catch {
      clients.delete(res);
    }
  };
  const route = (req: { url?: string }, res: ServerResponse): boolean => {
    if (!req.url || !req.url.startsWith("/live/events")) return false;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(": netrunner-benchmark live stream\n\n");
    for (const chunk of backlog) send(res, chunk);
    clients.add(res);
    res.on("close", () => clients.delete(res));
    return true;
  };

  let server: StaticServer;
  const preferred = options.port ?? 8787;
  try {
    server = await startServer(repoRoot, route, preferred);
  } catch {
    server = await startServer(repoRoot, route, 0); // preferred port busy
  }
  const url = `http://127.0.0.1:${server.port}/site/viewer/?live=1`;
  console.log(`live viewer: ${url}`);
  if (options.open !== false) openBrowser(url);

  // Keep-alive comments stop idle proxies/browsers from dropping the
  // stream during long model calls.
  const heartbeat = setInterval(() => {
    for (const res of clients) send(res, ": keep-alive\n\n");
  }, 15_000);

  return {
    url,
    push: (event: LiveEvent): void => {
      const chunk = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      // A new game (next game of a run-match) starts a new backlog: a
      // late-joining tab replays only the game in progress.
      if (event.type === "meta") backlog.length = 0;
      backlog.push(chunk);
      for (const res of clients) send(res, chunk);
    },
    finish: async (): Promise<void> => {
      if (process.stdout.isTTY) {
        console.log(`game over — live viewer still serving at ${url} (Ctrl-C to exit)`);
        await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
      }
      clearInterval(heartbeat);
      for (const res of clients) {
        try {
          res.end();
        } catch {
          /* already closed */
        }
      }
      await server.close();
    },
  };
}
