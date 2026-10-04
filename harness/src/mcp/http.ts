/** Streamable HTTP transport for the MCP server: one MCP session per client
 *  connection, all sessions sharing one GameHost. */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { GameHost } from "./host.js";
import { createMcpServer } from "./server.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface HttpOptions {
  bind?: string; // default 127.0.0.1
  port?: number; // default 8765; 0 picks a free port
  /** Serve /mcp/<secret> instead of /mcp (for a public tunnel). */
  secret?: string;
  version: string;
}

export interface McpHttpServer {
  url: string;
  close: () => Promise<void>;
}

export async function serveHttp(host: GameHost, options: HttpOptions): Promise<McpHttpServer> {
  const bind = options.bind ?? "127.0.0.1";
  const path = options.secret ? `/mcp/${options.secret}` : "/mcp";
  // On a loopback address, refuse other Host headers (DNS rebinding: a web
  // page must not reach the server through the browser). Behind a public
  // tunnel the secret path is the protection instead.
  const hostAllowed = (req: IncomingMessage): boolean => {
    if (options.secret || !LOOPBACK.has(bind)) return true;
    return LOOPBACK.has((req.headers.host ?? "").replace(/:\d+$/, ""));
  };
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const http = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== path) {
        res.writeHead(404).end();
        return;
      }
      if (!hostAllowed(req)) {
        res.writeHead(403).end("forbidden host");
        return;
      }
      const sid = req.headers["mcp-session-id"];
      let transport = typeof sid === "string" ? transports.get(sid) : undefined;
      if (!transport) {
        if (typeof sid === "string") {
          res
            .writeHead(404, { "content-type": "application/json" })
            .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(400).end("initialize first");
          return;
        }
        const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, t);
          },
        });
        t.onclose = () => {
          if (t.sessionId) transports.delete(t.sessionId);
        };
        await createMcpServer(host, options.version).connect(t);
        transport = t;
      }
      await transport.handleRequest(req, res);
    })().catch((e: unknown) => {
      console.error("mcp request failed:", e);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? 8765, bind, resolve);
  });
  const port = (http.address() as AddressInfo).port;
  return {
    url: `http://${bind === "0.0.0.0" ? "127.0.0.1" : bind}:${port}${path}`,
    close: async () => {
      for (const t of transports.values()) await t.close().catch(() => undefined);
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
