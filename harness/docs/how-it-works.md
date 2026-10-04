# How the harness works

A game is the Chiriboga engine running in headless Chromium, driven by a Node host through Playwright. The engine files are never modified. `harness.html` loads them with a small page layer (`harness/page/`) that seats models in place of the engine's own AI and reports every decision to the host.

## A game

`llm-game` (and each game of a `run-match`) goes through these steps:

1. **Load the page.** `harness.html` loads the engine, the base card sets (System Gateway, System Update 2021 and the tutorial set) and any extra set files the decks need (`&sets=elevation,...`). Decks are the repository's precons, passed the way the engine's own pages pass them. `bootstrap.js` seeds `Math.random` and removes the engine's other sources of nondeterminism ([engine quirks](engine-quirks.md#determinism)), so one seed always deals the same game.
2. **Seat the model.** `llmplayer.js` replaces the seat's AI with a shell that keeps the rules AI's bookkeeping (cards consult it) but sends every decision to the host. Card scripts see a model's seat as a human player's, so the shortcuts card code takes for the rules AI never narrow a model's menu.
3. **Describe the decision.** The state is the seat's own view, built by `serializer.js` from the engine's `PlayerCanLook`. Hidden cards are `{"hidden": true}`, and the log tail drops private channels. The options are exactly the engine's legal options in rulebook vocabulary. By default a command and its follow-up are fused into one complete action ("play Jailbreak, then run R&D"), and the follow-up is answered from the same choice (`compound_fulfilled`). A decision with a single option resolves without asking (`forced`), as does an access-order choice whose order cannot matter (`order_folded`).
4. **Ask the model.** The model answers through one forced tool, `choose_option`, with its reasoning before the option index. A malformed answer gets a corrective message, up to three attempts; after that option 0 is taken and the decision is marked `fallback`. Each seat keeps one running conversation. Near its compaction threshold, the model writes a summary for its future self and continues from the summary plus its last 20 exchanges.
5. **Record.** Every decision of both seats becomes a line of `decisions.jsonl` with the state shown, the menu, the choice, the reasoning and the engine's `ReproductionCode` for the position. A board snapshot goes to `frames.jsonl` before each decision.
6. **Debrief.** After the game each model seat is told the result, along with any events it had not yet seen, and answers five fixed questions (`debrief.json`). The answers enter no transcript.

A rules-AI seat decides in the page, and its decisions are logged in the same stream with options described from its own view.

## Model seats

| model id | client |
|---|---|
| `claude-*` | Anthropic Messages API, with prompt caching on the system prompt and the moving end of the conversation |
| `openrouter/<vendor>/<model>` | OpenRouter, recording the provider-reported cost |
| `mock` | seeded random legal moves with synthetic token counts, plus one malformed answer and one persistent failure to exercise retries and fallback |
| over MCP | a chat app answers each decision with a tool call ([playing from a chat app](mcp.md)) |

Every word a model is shown is in `src/prompts.ts`, and each game saves its full system prompt (`system-prompt.txt`, or one per seat). The prompt holds the seat's framing, the rules text, an interface guide that describes mechanics only, a reasoning directive, and both decklists. Knobs, all recorded on the game record:

| flag | values (default first) | meaning |
|---|---|---|
| `--rules` | `official`, `digest` | Null Signal Games' learn-to-play guides (snapshots in `harness/rules/`), or a short built-in digest |
| `--profile` | `neutral`, `expert` | `neutral` names only the seat and the goal; `expert` adds an expert persona and harness-written strategy hints |
| `--reasoning` | `brief`, `extended`, `scot`, `none` | the reasoning asked for before each choice (`scot` predicts the opponent first) |
| `--context` | `conversational`, `stateless` | one conversation per seat, or a fresh request per decision; MCP games are `client` (the chat app holds the conversation) |
| `--history` | `full`, `lean` | whether past decisions keep their state in the transcript |
| `--compact-threshold` | per model | about 75% of the context window: 150K tokens, 300K for Opus and most OpenRouter models (`src/commands/llm-options.ts`) |
| `--actions` | `compound`, `split` | fused complete actions, or the engine's two-step command-then-select protocol |
| `--auto-resolve` | `on`, `off` | resolve single-option decisions without a call |
| `--ai-branches` | `neutral`, `rules` | `rules` lets card scripts take their rules-AI shortcuts on a model's seat (an ablation; the corpus keeps these games apart) |

A compaction that would drop fewer than three exchanges, or that comes before the transcript has grown well past its size after the last one, is refused and counted (`compactionsSuppressed`). If that happens, the threshold is too low for the model.

## Commands

All commands run from `harness/` as `npx tsx src/cli.ts <command>`; `help` lists them.

| command | what it does |
|---|---|
| `llm-game` | one game: `--seat runner\|corp\|both`, `--model` (or `--corp-model`, `--runner-model`), `--seed`, `--corp`, `--runner`, the knobs above, `--live` (watch in the board viewer), `--progress`, `--invariant`, `--debrief off`, `--frames off`, `--allow-unqualified` |
| `run-match` | the same flags, over `--games N --seed S` or `--seeds a,b,c`, each seed `--repeat K` times, into `out/match-<label>/` with a summary table, win rates with standard errors clustered by seed, and the first decision where reruns of a seed diverge; `--promote-all` adds finished games to the corpus |
| `mcp` | the MCP server for chat apps: `--port` (8765), `--host`, `--stdio`, `--secret`, `--live`, `--invariant` |
| `run-game` | the rules AI in both seats |
| `replay` | the board viewer for a recorded game (`--file`), re-simulating its frames if needed; `--step N` or `--seq N` with `--screenshot out.png` renders one moment |
| `frames` | re-simulate a recorded game from its decisions, check every decision against the record, and write `frames.jsonl`; `--corpus` does every corpus game |
| `format` | write a game's readable narrative, `full.md` |
| `audit` | the conservation audit of the golden games or one game (`--file`); `--review-sample N` writes a packet for checking by hand |
| `corpus` | `--promote <run>` (repeatable) copies a run into `data/games/` and regenerates `data/CORPUS.md` |
| `site` | build the project page's data from the corpus; `--serve` previews it |
| `pool` | list the precons with the sets they need and their qualification; `--qualify` reruns qualification |
| `smoke` | play the mock model in every seat mode across the card pool (`--pool`, `--seats`, `--limit`) |
| `determinism`, `golden`, `invariant`, `selftest` | the checks below |
| `fetch-rules` | snapshot the official rules text into `harness/rules/` |

A run writes `out/<game_id>/`. [Reading game records](records.md) describes the files.

## Checks

All of these are keyless and run in CI.

- **Determinism** plays one seed twice and requires identical logs. **Golden** replays ten frozen rules-AI games, covering every Quick-Game Corp deck, and requires the same logs and results; `golden record` re-blesses them after an intended change. Timings are the only thing normalized away.
- **No cheating.** `&invariant=1` (`--invariant`, and `invariant` for rules-AI games) checks every state and every menu a seat receives for the title of any card that seat cannot see, and the log for private channels. The checker keeps its own patterns, so a bug in the serializer's filter cannot hide itself.
- **Conservation.** `audit` rebuilds every credit and click from the narrated log and reconciles it with the engine's own snapshots at each turn. A credit line the parser does not recognize is a failure.
- **Replay.** `frames` reproduces a game from its decision stream with no model calls. The committed fixture game must reproduce its frames byte for byte.
- **Selftest.** For every class of defect a checker claims to catch, `selftest` plants one (a drifted credit, a swallowed click, a leaked title in a state or a menu, a broken record field, a doctored golden line) and requires the checker to report it at the planted place, after passing the clean original.
- **Acceptance.** Mock games in every seat mode exercise retries, fallback, compaction, forced and compound decisions and record validation, and exit non-zero on any failure.

## Card pool

The repository has 71 precons: the System Gateway and System Update 2021 decks, plus decks built on Elevation and the partial Core set, whose set files load on demand. Set membership is read from the set files themselves. `pool --qualify` plays each deck three times against the Gateway reference deck with the rules AI in both seats, the no-cheating checker on and the audit run, then once with the mock model in the deck's own seat. A deck qualifies only if every game finishes clean; 66 do. The results go to `fixtures/pool.json`. Model games refuse the five that fail ([engine quirks](engine-quirks.md#refused-decks)) unless `--allow-unqualified` is passed.

## Viewer, corpus and site

The board viewer (`site/viewer/`) reads a bundle built by `site/viewer/model.mjs`. The same module runs in Node for recorded games and in the browser for live ones, so both are modeled identically. A bundle holds the card dictionary, the public narration, deduplicated board frames and one step per decision. The viewer shows the board from either player's view or both, with the model's reasoning beside it. `--live` streams a running game (or a whole match, or the latest MCP game) to it over server-sent events.

Nothing enters the corpus by playing. `corpus --promote` copies a finished run into `data/games/` and regenerates `data/CORPUS.md`, which holds per-game rows, per-seat aggregates, the compaction summaries, and the coverage holes the corpus cannot yet speak to. Games played over MCP are marked "(MCP)" and cost "subscription". `site` builds `site/data/` from the corpus; with no corpus games it shows the fixture game as a demonstration. The **Publish GitHub Pages** workflow builds and deploys `site/`, and is run by hand from Actions.

## Configuration

- `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`: from the environment or `harness/.env` (gitignored). `HARNESS_MODEL` sets the default `--model`.
- `NETRUNNER_MCP_SECRET`: the default `--secret` for `mcp`.
- `src/prices.ts`: per-model prices with an as-of date, used when the provider does not report a cost. Unknown costs are shown as "—", never guessed.
- `src/commands/llm-options.ts`: compaction thresholds by model prefix. For a new model, start near 75% of its context window.
- URL parameters for `harness.html`, passed through `extraParams` in `src/game.ts`: `&invariant=1`, `&rngtrace=1` (count `Math.random` draws per log line) and `&rngstack=N-M` (stack traces for draws N to M) when hunting nondeterminism, and `&plant=<class>`, used by the selftest.

## Known limitations

- The engine needs a browser. A game takes minutes, mostly in the model's turns, and a Node-only host would need jQuery, the DOM elements `harness.html` provides, `localStorage` and a constructible Pixi renderer.
- Five precons hit engine defects and are refused. Fixing them means changing the engine, which this repository does not do.
- Hidden reasoning (extended thinking) is not used: it is incompatible with a forced tool choice.
- The debrief is self-report, and the audit checks only credits and clicks. Rulings and timing are checked by reading games in the viewer.
- Chat-app games differ from API games in ways the harness cannot control: the app's own system prompt and tools, its context management, and the identity of the model, which the player reports.
- There is no counterfactual replay (asking model B for its choice at model A's position).
