# Playing from a chat app

The harness can serve games over [MCP](https://modelcontextprotocol.io), so that a chat app plays a seat on its subscription instead of the harness calling a model API. Claude (desktop, web, phone or Claude Code) and ChatGPT both work. The chat answers each decision with a tool call. Everything else is the code path API games use: the menus, auto-resolution, records, frames and debrief. A game can put a chat against the rules AI, against another chat in the same app, or against a chat in another app.

## Start the server

From `harness/`:

```sh
npx tsx src/cli.ts mcp           # Streamable HTTP at http://127.0.0.1:8765/mcp
npx tsx src/cli.ts mcp --live    # also serve the board viewer, following the latest game
npx tsx src/cli.ts mcp --stdio   # for an app that starts the server itself
```

The players of one game must reach the same server process. An HTTP server can serve several apps at once. A stdio server serves only the app that started it, though two chats in that app can still play each other. `--invariant` runs the no-cheating checker in every game, and `--port` and `--host` move the server.

## Connect an app

**Claude Code** connects to the local server directly:

```sh
claude mcp add --transport http netrunner http://127.0.0.1:8765/mcp
```

**Claude Desktop** reads local servers from its config file (Settings → Developer → Edit Config), and needs a restart after a change. To share the running HTTP server with other apps, bridge to it with [mcp-remote](https://github.com/punkpeye/mcp-remote):

```json
{ "mcpServers": { "netrunner": { "command": "npx", "args": ["-y", "mcp-remote", "http://127.0.0.1:8765/mcp"] } } }
```

Or let Desktop start its own server over stdio, using absolute paths:

```json
{
  "mcpServers": {
    "netrunner": {
      "command": "/path/to/netrunner-benchmark/harness/node_modules/.bin/tsx",
      "args": ["/path/to/netrunner-benchmark/harness/src/cli.ts", "mcp", "--stdio"]
    }
  }
}
```

**Claude on the web or phone, and ChatGPT,** connect from their providers' servers, so they need a public HTTPS address. Serve a secret path and put a tunnel in front of the server:

```sh
npx tsx src/cli.ts mcp --secret "$(openssl rand -hex 16)"   # serves /mcp/<secret>
cloudflared tunnel --url http://127.0.0.1:8765               # or: ngrok http 8765
```

The app's URL is the tunnel's HTTPS address followed by `/mcp/<secret>`. Anyone who has that URL can use the server, so keep it private. Apps on your machine can keep using `http://127.0.0.1:8765/mcp/<secret>`.

- **Claude:** add the URL under Customize → Connectors → Add custom connector, with no sign-in. On Team and Enterprise plans an owner adds it for the organization. Connectors added this way also work in Claude Desktop and on the phone.
- **ChatGPT:** turn on developer mode and create an app (custom MCP server) with the URL and no authentication. OpenAI moves these settings from release to release; its help article on developer mode has the current steps.

## Play

With the tools enabled in a chat, ask for a game:

- **Against the rules AI:** "Start a Netrunner game as the Runner against the rules AI and play it to the end. Record the player as Claude Opus 5 (Claude app)."
- **Two chats:** in the first, "Start a Netrunner game as the Corp against another player." The reply includes a join code (`NR-...`). In the second chat, which can be in another app connected to the same server, say "Join the Netrunner game with code NR-...". Each chat then plays its seat and waits while the other decides.

The player name becomes the seat's `model` in the record. The harness cannot check it, so ask for the exact model name and app.

| tool | what it does |
|---|---|
| `list_decks` | the qualified precons, by side |
| `new_game` | start a game: `seat` (`runner`, `corp`), `opponent` (`rules-ai`, `mcp` for another chat, `mock` for random moves), `player`, `corp_deck`, `runner_deck`, `seed`, `view` (`full`, `compact`), `rules` (`digest`, `official`) |
| `join_game` | take the other seat of a game, with its join code |
| `choose_option` | answer the decision in front of you with your reasoning and an option index; returns the next decision |
| `wait_for_turn` | wait for your next decision or the end of the game |
| `get_state` | your full view of the game state as JSON |
| `get_rules` | the rules and interface for your seat again |
| `answer_debrief` | answer the postgame questions |
| `resign` | concede the game |

The first reply of `new_game` and `join_game` carries the seat's rules and interface, which is the system prompt an API model would get and is saved with the game, followed by the first decision. A call waiting on the other player returns after 45 seconds at most, saying so, and the chat calls `wait_for_turn` to keep waiting.

## What is recorded

Chat games are written to `harness/out/<game_id>/` in the same format as API games ([reading game records](records.md)). A chat's seat has `driver: "mcp"`, the app's MCP name and version in `client`, and no token usage. `replay`, `format`, `frames` and `corpus --promote` all work, and the corpus report and the project page mark these seats "(MCP)", with "subscription" as the cost.

## Limits

- **Context.** A full game asks a seat for a couple of hundred decisions. In the full view each decision carries the state JSON, about 4,400 characters, so a long game can outgrow a chat. The compact view sends a status line, the seat's hand, the recent log and the options, about 1,700 characters, and the chat calls `get_state` when it wants the rest. If an app compacts or trims a long chat, `get_rules` shows the rules again.
- **Tool results.** Games default to the rules digest. The official rules text is about 30K tokens, more than Claude Code shows from one tool result by default (25K; `MAX_MCP_OUTPUT_TOKENS` raises it).
- **Approvals.** Apps ask before calling a tool that changes something, and `choose_option` does. Allow the netrunner tools for the conversation ("Always allow" in Claude; ChatGPT can remember an approval per tool for the conversation), or every decision waits for a click.
- **Comparability.** A chat app adds its own system prompt, tools and memory handling, and the player reports which model it is. Compare chat games with each other rather than with API games.
- **Server lifetime.** Games in progress live in the server's memory and end if it stops. Finished games are on disk.
