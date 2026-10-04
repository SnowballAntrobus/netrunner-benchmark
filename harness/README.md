# Harness

All benchmark code: the page layer that seats models in the Chiriboga
engine (`page/`), the Playwright host, model clients, records, matches,
checks and CLI (`src/`), the tracked corpus (`data/`), regression
fixtures (`fixtures/`) and the design docs (`docs/`). The engine itself
is never modified; see [`docs/ENGINE.md`](docs/ENGINE.md).

## Setup

```sh
cd harness
npm install                       # Node 22
npx playwright install chromium   # only if no local Chromium is found
```

API keys come from the environment or from `harness/.env`
(gitignored, `KEY=VALUE` lines): `ANTHROPIC_API_KEY` for Anthropic
models, `OPENROUTER_API_KEY` for `openrouter/<vendor>/<model>`. The
mock model (`--model mock`) needs neither.

Every command is `npx tsx src/cli.ts <command> [flags]`, run from
`harness/`; the common ones also have npm scripts (`npm run llm-game --
--seed 7`). Output goes to `harness/out/` (gitignored).

## Playing games

### `llm-game` — one game with a model in a seat

```sh
npx tsx src/cli.ts llm-game --model claude-haiku-4-5 --seed 7
```

| flag | default | meaning |
|---|---|---|
| `--seat runner\|corp\|both` | `runner` | which seats a model plays ([D14](docs/design/D14-corp-seat-and-model-vs-model.md)) |
| `--model X` | `$HARNESS_MODEL` or `claude-haiku-4-5` | the model for the seat (both seats unless overridden); `mock`, an Anthropic id, or `openrouter/<vendor>/<model>` |
| `--corp-model X`, `--runner-model X` | `--model` | per-seat models for `--seat both` |
| `--seed N` | `1` | engine seed (deals, shuffles, rules-AI jitter) |
| `--corp NAME`, `--runner NAME` | `Gateway Corp`, `Gateway Runner` | precons, any file name in `precons/` (see `pool`) |
| `--rules official\|digest` | `official` | NSG learn-to-play guides (`fetch-rules` snapshot) or the built-in digest |
| `--profile neutral\|expert` | `neutral` | system-prompt framing |
| `--reasoning brief\|extended\|scot\|none` | `brief` | reasoning requested before each choice |
| `--context conversational\|stateless` | `conversational` | one running conversation per seat, or a fresh request per decision ([D01](docs/design/D01-conversation-context.md)) |
| `--history full\|lean` | `full` | what past turns keep in the transcript |
| `--compact-threshold N` | per model (`THRESHOLD_DEFAULTS` in `src/cli.ts`; 150K unless listed) | compaction trigger in tokens; see [PROMPTING.md](docs/PROMPTING.md) |
| `--compact-keep N` | `20` | exchanges kept verbatim through a compaction |
| `--auto-resolve on\|off` | `on` | single-option decisions skip the API, logged as forced ([D03](docs/design/D03-single-option-auto-resolve.md)) |
| `--actions compound\|split` | `compound` | fuse verb + subject into complete actions ([D09](docs/design/D09-compound-actions.md)) |
| `--ai-branches neutral\|rules` | `neutral` | card code treats model seats as human (era 4); `rules` reproduces era 3 |
| `--debrief on\|off` | `on` | postgame self-report per seat ([D07](docs/design/D07-debrief-instrument.md)) |
| `--frames on\|off` | `on` | board snapshots for the viewer ([D15](docs/design/D15-board-viewer-and-live.md)) |
| `--live` | off | serve the board viewer and stream the game into it while it plays |
| `--progress` | off | live turn, score and decision count on stdout |
| `--watch` | off | open a second terminal streaming the model's reasoning |
| `--invariant` | off | run the no-cheating checker at every decision |
| `--allow-unqualified` | off | play a deck that failed pool qualification |

A run writes `out/<game_id>/`: `record.json` (result, counters, usage,
cost, flags), `decisions.jsonl` (one record per decision, both seats,
each with the engine's `ReproductionCode`), `frames.jsonl` (board
snapshots), `system-prompt.txt` (one per seat in two-model games) and
`debrief.json`. Every tool accepts the run folder or any file in it.
[`docs/DECISION_LOG.md`](docs/DECISION_LOG.md) explains the record
format. With `--model mock` the run doubles as a keyless acceptance
test (retry, fallback, compaction, forced and compound paths; exit code
reports PASS/FAIL).

### `run-match` — many games of one configuration

```sh
npx tsx src/cli.ts run-match --games 10 --seed 1 --model claude-haiku-4-5
npx tsx src/cli.ts run-match --seeds 7 --repeat 3 --model claude-haiku-4-5   # within-seed variance
```

Takes every `llm-game` flag, plus:

| flag | meaning |
|---|---|
| `--games N --seed S` | seeds S..S+N-1 (default 10 games) |
| `--seeds a,b,c` | an explicit seed list instead |
| `--repeat K` | play each seed K times |
| `--label L` | match folder `out/match-<L>/` (default: models, seeds and a timestamp) |
| `--promote-all` | promote each completed game into the corpus as it finishes |
| `--live` | one viewer tab follows the whole match |

A crashed game is a row, not an abort. `match-summary.md` has a row per
game (status, winner, reason, agenda points, turns, API decisions,
forced, retries and fallbacks, tokens, estimated cost, compactions,
maximum context, preview divergences, minutes), win rate per (seat,
model) with a standard error clustered by seed, how games ended, means
and totals, and, for repeated seeds, the first decision at which each
pair of runs diverged. `match.json` holds the same data.
([D06 §1](docs/design/D06-match-runner-and-inspect.md),
[D12](docs/design/D12-ten-game-run.md))

### Rules AI against rules AI

```sh
npx tsx src/cli.ts run-game --seed 7 [--corp NAME] [--runner NAME]
npx tsx src/cli.ts batch --games 10 --seed 1     # seeds 1..10, out/batch-summary.txt
```

## Reviewing games

```sh
npx tsx src/cli.ts replay --file out/<game_id>                 # board viewer
npx tsx src/cli.ts replay --file out/<game_id> --step 120 --screenshot board.png
npx tsx src/cli.ts replay --file out/<game_id> --engine [--seq N]   # engine-board replay (D08)
npx tsx src/cli.ts format --file out/<game_id>                 # full.md narrative
npx tsx src/cli.ts audit --file out/<game_id>                  # conservation audit
npx tsx src/cli.ts audit --file out/<game_id> --review-sample 12   # hand-check packet
npx tsx src/cli.ts frames --file out/<game_id>                 # re-simulate: verify + frames
```

`replay` serves the board viewer ([D15](docs/design/D15-board-viewer-and-live.md))
for a recorded game, re-simulating it first if it has no frames.
`--engine` instead loads each record's `ReproductionCode` into the real
engine renderer; card art there is optional (download
[images.zip](https://chiriboga.cronbach.com/images/images.zip) and
extract it into the repo root as `images/`, not included for licensing
reasons). `frames` replays a recorded game with its recorded choices, no
API calls, verifies every decision matches, and writes `frames.jsonl`;
`--corpus` does this for every corpus game.

## The corpus and the project page

```sh
npx tsx src/cli.ts corpus --promote out/<game_id> [--promote ...] [--partial]
npx tsx src/cli.ts corpus                      # regenerate data/CORPUS.md only
npx tsx src/cli.ts site [--serve [--port P]]   # build site/data/ (and preview)
```

Promotion copies a finished run into `data/games/` (tracked) and
regenerates [`data/CORPUS.md`](data/CORPUS.md), the cumulative report:
per-(seat, model) aggregates by interface era, coverage holes, and the
compaction memos. `site` builds the project page's data from the corpus;
the "Publish GitHub Pages" workflow runs it and deploys `site/`
([D17](docs/design/D17-project-site.md)).

## The card pool

```sh
npx tsx src/cli.ts pool                        # every precon: sets needed, qualification
npx tsx src/cli.ts pool --qualify [--jobs N] [--seeds 1,2,3] [--only NAME] [--resume]
npx tsx src/cli.ts smoke [--pool all|base|extended] [--seats rules,runner,corp,both] [--limit N]
```

Decks load the set files they need on demand. `pool --qualify` plays
every precon (three rules-vs-rules games against the Gateway opponent
with the invariant on and the audit run, plus one mock game in the
deck's own seat) and writes [`fixtures/pool.json`](fixtures/pool.json);
`llm-game` and `run-match` refuse decks that failed.
`smoke` fuzzes the interface across the pool with the mock in every
seat mode and skips unqualified decks.
([D16](docs/design/D16-card-pool.md))

## Checks (all keyless, all in CI)

```sh
npm test                                       # typecheck + determinism
npx tsx src/cli.ts determinism --seed 7        # same seed twice, identical logs
npx tsx src/cli.ts golden check                # 10 frozen rules-vs-rules games
npx tsx src/cli.ts golden record               # re-bless after an intended change
npx tsx src/cli.ts invariant [--seeds a,b,c]   # no-cheating checker, rules-vs-rules
npx tsx src/cli.ts audit                       # conservation audit, golden games
npx tsx src/cli.ts selftest [--suite audit,validator,invariant,golden]
```

`selftest` ([D11](docs/design/D11-audit-selftest.md)) plants a defect
of every class each checker claims to catch (a drifted credit line, a
swallowed click, a hidden title in the state or a menu, a broken
record field, a doctored golden line) and requires the checker to
report it at the planted location, after passing the clean original.
The golden suite is the regression net for anything engine-affecting;
see [`docs/ENGINE.md`](docs/ENGINE.md).

## Rules text

```sh
npx tsx src/cli.ts fetch-rules                 # snapshot NSG's learn-to-play guides
```

Review the extracted text and commit the snapshots in `harness/rules/`.
`--rules digest` uses the built-in digest instead (the keyless path).
The rules source is recorded in the game record and the saved prompt.

## Debug aids

`page/bootstrap.js` accepts extra URL parameters (pass them via
`extraParams` in `src/game.ts`): `&rngtrace=1` records `Math.random`
draw counts per log line, `&rngstack=N-M` captures stacks for draws
N..M. This is the tooling behind the determinism ledger in
`docs/ENGINE.md`. `&plant=<class>` is the selftest's fault injection.
