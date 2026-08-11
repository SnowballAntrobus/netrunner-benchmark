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

// The repo ships NO image assets (deployments serve them separately).
// For the replay viewer (D08), missing engine textures resolve to embedded
// solid-color placeholders so PIXI's loaders complete and the boot never
// stalls; card FACES are canvas-generated page-side with real titles.
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
      let body: Buffer;
      try {
        body = await readFile(file);
      } catch (e) {
        if (path.includes("/images/")) {
          // The image pack extracts to <repoRoot>/images, but pages under
          // /harness/ request images RELATIVE to themselves
          // (/harness/images/...). Re-anchor any /images/ request at the
          // repo-root pack before falling back to a placeholder.
          const packPath = join(
            repoRoot,
            path.slice(path.indexOf("/images/") + 1)
          );
          try {
            const packBody = await readFile(packPath);
            res.writeHead(200, {
              "content-type":
                MIME[extname(packPath).toLowerCase()] ?? "application/octet-stream",
              "cache-control": "no-store",
            });
            res.end(packBody);
            return;
          } catch {
            /* pack absent or file missing — placeholder below */
          }
          res.writeHead(200, {
            "content-type": "image/png",
            "cache-control": "no-store",
            // The viewer probes this to decide canvas faces vs real art.
            "x-harness-placeholder": "1",
          });
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

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    server,
    port: address.port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
