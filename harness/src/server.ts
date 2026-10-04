/** Tiny static file server over the repo root — replaces the PHP entry points
 *  for harness purposes. No dependencies, ephemeral port. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export interface StaticServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

// The repo ships no image assets (the engine's image pack, if extracted
// into <repoRoot>/images, is served as is). Missing engine textures get
// solid-color placeholders so PIXI's loaders complete and the page never
// waits on them.
const PLACEHOLDER_PNG: Record<string, string> = {
  corp: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAmklEQVR4nO3QQRHAIADAMEAIQjCDfxVDRh5rFPQ697nf+LGlA7QG6ACtATpAa4AO0BqgA7QG6ACtATpAa4AO0BqgA7QG6ACtATpAa4AO0BqgA7QG6ACtATpAa4AO0BqgA7QG6ACtATpAa4AO0BqgA7QG6ACtATpAa4AO0BqgA7QG6ACtATpAa4AO0BqgA7QG6ACtATpAa4AO0B4/dwI2vPS60gAAAABJRU5ErkJggg==",
  runner: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAl0lEQVR4nO3QURUAEADAQPSQVXRi3Iddgr3Ns/cdH1s6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugA7QHAlgI4wirRAgAAAABJRU5ErkJggg==",
  neutral: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAmklEQVR4nO3QMRHAIADAQEAmIwLwvxUZPzSvIJe5z/3Gjy0doDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA9gAdMQKp61SiRgAAAABJRU5ErkJggg==",
};

function placeholderImage(path: string): Buffer {
  const name = path.toLowerCase();
  const key = name.includes("corp") ? "corp" : name.includes("runner") ? "runner" : "neutral";
  return Buffer.from(PLACEHOLDER_PNG[key]!, "base64");
}

/** Optional dynamic route: return true when the request was handled. */
export type ExtraRoute = (req: IncomingMessage, res: ServerResponse) => boolean;

export async function startServer(
  repoRoot: string,
  extra?: ExtraRoute,
  port = 0
): Promise<StaticServer> {
  const server = createServer(async (req, res) => {
    try {
      if (extra && extra(req, res)) return;
      const url = new URL(req.url ?? "/", "http://localhost");
      let path = decodeURIComponent(url.pathname);
      if (path.endsWith("/")) path += "index.html";
      if (path === "/index.html") path = "/harness.html";
      // Confine to repo root.
      const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
      const file = join(repoRoot, safe);
      if (!file.startsWith(repoRoot)) {
        res.writeHead(403).end();
        return;
      }
      let body: Buffer;
      try {
        body = await readFile(file);
      } catch (e) {
        if (path.startsWith("/images/")) {
          res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
          res.end(placeholderImage(path));
          return;
        }
        throw e;
      }
      res.writeHead(200, {
        "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end(); // missing files etc. are expected; stay quiet
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    server,
    port: address.port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
