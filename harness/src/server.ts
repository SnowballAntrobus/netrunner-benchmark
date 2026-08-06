/** Tiny static file server over the repo root — replaces the PHP entry points
 *  for harness purposes. No dependencies, ephemeral port. */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

export interface StaticServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

export async function startServer(repoRoot: string): Promise<StaticServer> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let path = decodeURIComponent(url.pathname);
      if (path === "/") path = "/harness.html";
      // Confine to repo root.
      const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
      const file = join(repoRoot, safe);
      if (!file.startsWith(repoRoot)) {
        res.writeHead(403).end();
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end(); // missing images etc. are expected; stay quiet
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    server,
    port: address.port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
