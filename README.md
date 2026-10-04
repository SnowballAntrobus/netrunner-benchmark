# netrunner-benchmark

A research harness that seats language models at **Android: Netrunner**
as the Runner, as the Corp, or on both sides, against the engine's
rules-based AI or against each other. The game has hidden information,
traps and long horizons, and its opponent punishes bad risk assessment.
Every decision is logged with exactly what the model saw, can be
replayed on a board viewer, and is checked for honesty.

**Project page:** [snowballantrobus.github.io/netrunner-benchmark](https://snowballantrobus.github.io/netrunner-benchmark/)
has recorded games to watch in the board viewer, the method, and the
results so far.

Built on the [Chiriboga](https://github.com/bobtheuberfish/chiriboga)
engine (via [DrBo6's solo mode](https://github.com/drbo6/chiriboga)).
The engine is treated as **quarantined ground truth**: no engine file is
modified. All benchmark code lives in [`harness/`](harness/) and
attaches at the page level. A model occupies a seat through the same
decision interface the built-in AIs use.

## Why Netrunner

The Runner sees a partial board: a facedown card may be an agenda worth
stealing or an ambush that kills. Games run to hundreds of decisions
over 15 or more turns, which stresses long-context play, memory (the
harness implements model-written compaction), risk arithmetic ("can
this access flatline me?") and learning within a single game. The
rules-based AI gives every model the same deterministic, reproducible
opponent.

Netrunner is also, in practice, novel to these models. Unlike chess or
Go there is no large public corpus of played games to learn from, so
strong play cannot be retrieved from training data. It has to be
produced in context, from the rules and the board at hand.

## What it does

- **Any seat.** `--seat runner`, `--seat corp`, or `--seat both` for
  model-versus-model games, each seat with its own transcript, prompt
  and debrief ([D14](harness/docs/design/D14-corp-seat-and-model-vs-model.md)).
- **Any model.** Anthropic models directly, other providers through
  OpenRouter (`openrouter/<vendor>/<model>`,
  [D13](harness/docs/design/D13-multi-provider.md)), and a keyless mock
  that plays random legal moves for tests.
- **An honest interface.** The model chooses from exactly the engine's
  legal options, neutrally described. Multi-step actions are offered
  whole ("play Jailbreak, then run R&D"), single-option decisions
  resolve without a call, and card code treats a model's seat as a
  human player's, so no menu is quietly pruned by the rules AI's
  shortcuts.
- **Memory.** A game is one running conversation. Near the context
  limit the model writes a summary for its future self and continues
  from it ([D01](harness/docs/design/D01-conversation-context.md)).
  After the game it answers a short debrief
  ([D07](harness/docs/design/D07-debrief-instrument.md)).
- **Complete records.** One JSONL record per decision (state shown,
  menu, choice, reasoning, retries, tokens, cost) carrying the engine's
  executable `ReproductionCode`, plus board snapshots for the viewer.
  A recorded game re-simulates exactly from its decision stream, with
  no API calls; all 11 corpus games have been verified this way.
- **A board viewer, recorded or live.** Step through a game with the
  model's reasoning beside the board, from either player's perspective
  or omnisciently, or watch a game while it is played (`--live`,
  [D15](harness/docs/design/D15-board-viewer-and-live.md)).
- **Matches.** `run-match` plays N seeds of one configuration, reruns
  seeds to measure within-seed variance, reports win rates with
  standard errors clustered by seed, and finds where same-seed runs
  first diverge ([D06 §1](harness/docs/design/D06-match-runner-and-inspect.md),
  [D12](harness/docs/design/D12-ten-game-run.md)).
- **71 preconstructed decks.** The System Gateway and System Update
  2021 pool plus decks built on Elevation and the partial Core set,
  loaded on demand. A qualification run refuses decks that hit engine
  defects ([D16](harness/docs/design/D16-card-pool.md)).
- **Checks that are themselves checked.** Determinism, golden-log
  regression, a no-cheating invariant over every state and menu a model
  sees, a credit and click conservation audit, and a fault-injection
  selftest proving each checker catches what it claims to
  ([D11](harness/docs/design/D11-audit-selftest.md)). All run in CI
  without API keys.
- **A cumulative corpus.** Finished games are promoted into
  [`harness/data/games/`](harness/data/games/); the corpus report
  ([`CORPUS.md`](harness/data/CORPUS.md)) and the project page are
  generated from it.

## Quickstart

```sh
cd harness
npm install                       # Node 22; uses Playwright's Chromium
npm test                          # typecheck + seeded determinism

# keyless: the mock model plays random legal moves
npx tsx src/cli.ts llm-game --model mock --seed 3

# real models
export ANTHROPIC_API_KEY=...      # or OPENROUTER_API_KEY, or put either in harness/.env
npx tsx src/cli.ts llm-game --model claude-haiku-4-5 --seed 7 --live
npx tsx src/cli.ts llm-game --seat corp --model claude-haiku-4-5
npx tsx src/cli.ts llm-game --seat both --corp-model claude-haiku-4-5 \
    --runner-model openrouter/openai/gpt-5.4-mini
npx tsx src/cli.ts run-match --games 10 --seed 1 --model claude-haiku-4-5

# review
npx tsx src/cli.ts replay --file out/<game_id>     # board viewer
npx tsx src/cli.ts corpus --promote out/<game_id>  # add to the tracked corpus
npx tsx src/cli.ts site --serve                    # the project page, locally
```

[`harness/README.md`](harness/README.md) documents every command and
flag.

## How it fits together

```
engine (untouched fork)          harness/ (all benchmark code)
  init.js, phase.js, ...    ◄──   page/     model seats, honest serializer,
  ai_corp.js, ai_runner.js                   no-cheating checks, board snapshots
  sets/, precons/                 src/      Playwright host, model clients,
                                             records, matches, checks, CLI
                                  data/     the tracked corpus + CORPUS.md
                                  fixtures/ golden logs, card-pool qualification
                                  docs/     design docs (D01–D17), reviews, guides
site/                             project page + board viewer (GitHub Pages)
```

Invariants, each enforced mechanically and run in CI:

- **Determinism.** Seeded RNG end to end. Golden fixture games must
  replay byte-identically, and recorded model games must re-simulate
  decision by decision.
- **No cheating.** An independent checker proves that no state or menu
  a seat receives contains information its player could not see
  (`PlayerCanLook` is the single choke point).
- **Conservation.** A log auditor re-derives every credit and click and
  reconciles them with the engine's ground-truth snapshots.
- **Honest interface.** Exactly the engine's legal options, neutrally
  described, for every seat.

## Documentation map

| doc | what |
|---|---|
| [`harness/README.md`](harness/README.md) | every command and flag |
| [`harness/docs/CLOSEOUT.md`](harness/docs/CLOSEOUT.md) | project status, what is left, maintenance |
| [`harness/docs/PROMPTING.md`](harness/docs/PROMPTING.md) | prompt and context design, choosing the compaction threshold |
| [`harness/docs/DECISION_LOG.md`](harness/docs/DECISION_LOG.md) | how to read the per-decision JSONL records |
| [`harness/docs/ENGINE.md`](harness/docs/ENGINE.md) | engine integration notes (quarantine, quirks, determinism ledger) |
| [`harness/docs/design/`](harness/docs/design/) | numbered design docs (D01–D17), each reviewed before or after build |
| `harness/docs/*_REVIEW.md` | per-game qualitative reviews with adjudicated findings |
| [`harness/docs/PHASE1.md`](harness/docs/PHASE1.md) | the original phase plan (historical) |
| [`UPSTREAM_README.md`](UPSTREAM_README.md) | the original fork README: engine features, debug guide, test-field and AI-preference reference |

## Status (October 2026)

**The harness is feature-complete; the analysis is next.** Everything
on the roadmap is built: model seats on either side and
model-versus-model, the extended card pool with qualification, the
board viewer with live mode, the match runner, the checker selftest
and the project page. The corpus so far is eleven shakedown games, all
with a model as the Runner on one seed and one matchup, recorded before
the interface fixes that began the current era (era 4). They show the
pipeline working, not a ranking. The first measured run is the 10-game
match in [D12](harness/docs/design/D12-ten-game-run.md); see
[`CLOSEOUT.md`](harness/docs/CLOSEOUT.md) for what remains and what was
deliberately parked.

A substantial share of the work has been qualitative: reviewing full
game transcripts to adjudicate findings and identify robust comparison
points between models (`harness/docs/*_REVIEW.md`). Reviews fed
finding-response designs back into the harness before any result was
trusted.

A design bias throughout: cheap to run without weakening what is
measured. Single-option decisions resolve without a call and menus fuse
multi-step actions to cut token cost, while the honest-interface
invariant keeps the seat fair.

## Credits and legal

Engine: **Chiriboga** by
[bobtheuberfish](https://github.com/bobtheuberfish); solo-mode
extension by [DrBo6](https://github.com/drbo6). The full original
README, including the debugging and board-state reference, is preserved
verbatim in [`UPSTREAM_README.md`](UPSTREAM_README.md). License: GPL-3.0
(inherited).

*Netrunner* and *Android* are trademarks of Fantasy Flight Publishing,
Inc. and/or Wizards of the Coast LLC. This is a fan-made research
project and is not affiliated with or endorsed by FFG, WotC, or Null
Signal Games. Card art and symbols are property of Null Signal Games
and used under
[CC BY-ND 4.0](https://creativecommons.org/licenses/by-nd/4.0/).
