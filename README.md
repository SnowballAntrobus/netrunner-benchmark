# netrunner-benchmark

[Watch recorded games on the project page](https://snowballantrobus.github.io/netrunner-benchmark/)

Can a language model play **Android: Netrunner** well? It is a card game of hidden information, bluffs and long plans. Its games run to hundreds of decisions, and unlike chess or Go there is no large public record of played games to learn from, so strong play has to come from the rules and the board in front of the model. This repository is the harness for that question. It seats a model as the Runner, the Corp or both, against the engine's rules-based AI or against another model. The harness is complete; the analysis is ongoing.

The process is **seat a model → play the game → record every decision → check and review the record**. A model reaches its seat through a model API (Anthropic directly, other vendors through OpenRouter) or from a chat app such as Claude or ChatGPT over [MCP](https://modelcontextprotocol.io), so games can run on a subscription instead of API credit. Every decision is recorded with exactly what the model saw and why it chose. A checker shows that no seat ever sees what its player could not, and every recorded game can be replayed on a board viewer. [How the harness works](harness/docs/how-it-works.md) has the details.

Games run on the [Chiriboga](https://github.com/bobtheuberfish/chiriboga) engine (via [DrBo6's solo mode](https://github.com/drbo6/chiriboga)), unmodified. All harness code attaches at the page level.

## Contents

- `harness/src/`: the host. `cli.ts` dispatches to `commands/`, `llmgame.ts` runs a game with model seats, `llm.ts` holds the model clients, `prompts.ts` holds every word a model is shown, and `mcp/` is the MCP server. The other modules record, check, replay and summarize games.
- `harness/page/`: code that runs inside the engine page (`harness.html`). It seeds the game, serializes each seat's honest view, checks for leaks, seats the models and snapshots the board.
- `harness/test/`: unit tests, and an end-to-end test that plays whole games through the MCP server.
- `harness/fixtures/`: frozen rules-AI games for regression, the card-pool qualification, and one recorded keyless game.
- `harness/data/`: the tracked corpus of recorded games and its report, `CORPUS.md`.
- `site/`: the project page and the board viewer, published with GitHub Pages.
- `harness/docs/`: [how the harness works](harness/docs/how-it-works.md), [reading game records](harness/docs/records.md), [playing from a chat app](harness/docs/mcp.md), and the [engine quirks](harness/docs/engine-quirks.md) found along the way. `skills/` holds two Claude skills for reviewing a recorded game: one for how the model played, one for rules conformance.
- Everything else at the root is the engine. Its own README is [`UPSTREAM_README.md`](UPSTREAM_README.md).

## Setup

Install Node 22, then run from `harness/`:

```sh
npm install
npx playwright install chromium   # unless a Chromium is already installed
```

API keys go in the environment or in `harness/.env`: `ANTHROPIC_API_KEY` for Claude models, `OPENROUTER_API_KEY` for `openrouter/<vendor>/<model>`. The mock model (`--model mock`, which plays random legal moves) and the MCP server need neither.

## Playing

From `harness/`:

```sh
npx tsx src/cli.ts llm-game --model claude-haiku-4-5 --seed 7 --live   # Runner vs the rules AI, watched live
npx tsx src/cli.ts llm-game --seat corp --model claude-haiku-4-5
npx tsx src/cli.ts llm-game --seat both --corp-model claude-haiku-4-5 --runner-model openrouter/openai/gpt-5.4-mini
npx tsx src/cli.ts run-match --games 10 --seed 1 --model claude-haiku-4-5
npx tsx src/cli.ts replay --file out/<game_id>   # step through a recorded game
```

To play on a subscription, start the MCP server and connect a chat app to it:

```sh
npx tsx src/cli.ts mcp   # serves http://127.0.0.1:8765/mcp
```

Then ask the app something like "Start a Netrunner game as the Runner against the rules AI and play it to the end." A chat can play the rules AI, another chat in the same app, or a chat in another app (Claude against ChatGPT). [Playing from a chat app](harness/docs/mcp.md) covers the setup for each app. API and chat games are recorded in `harness/out/` in the same format, and `corpus --promote out/<game_id>` adds a game to the tracked corpus and the project page.

## Tests

```sh
npm test            # typecheck and unit tests, a few seconds
npm run test:e2e    # whole games through the MCP server (needs Chromium)
npm run checks      # determinism, golden games, no-cheating, conservation audit, checker selftest
```

CI runs all of them without API keys, together with mock-model games in every seat mode.

The development notes are gone from the working tree but kept in the git history at commit `b1e80e8`. They include the phase plan, the design documents, the game reviews, and the notes on prompting and the decision log. The games recorded before the last interface change were removed at the same time, because they are not comparable with games played now.

## Credits and legal

The engine is **Chiriboga** by [bobtheuberfish](https://github.com/bobtheuberfish), with the solo-mode extension by [DrBo6](https://github.com/drbo6). The license is GPL-3.0, inherited from the engine.

*Netrunner* and *Android* are trademarks of Fantasy Flight Publishing, Inc. and/or Wizards of the Coast LLC. This is a fan-made research project and is not affiliated with or endorsed by FFG, WotC or Null Signal Games. Card art and symbols are the property of Null Signal Games and are used under [CC BY-ND 4.0](https://creativecommons.org/licenses/by-nd/4.0/).
