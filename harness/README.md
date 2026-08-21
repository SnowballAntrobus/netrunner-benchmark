# Harness

Headless harness for running Netrunner games on the Chiriboga engine —
Phase 1 scope: seeded, reproducible rules-AI vs rules-AI games. See
`docs/PHASE1.md` for the plan and `docs/ENGINE.md` for engine notes and the
determinism ledger.

## Setup

```sh
cd harness
npm install
npx playwright install chromium   # if no local Chromium is found
```

## Commands

```sh
npm run run-game -- --seed 7                  # one game, result + log to out/
npm run batch -- --games 10 --seed 1          # seeds 1..10, summary to out/
npm run determinism -- --seed 7               # same seed twice, logs must match
npm run golden -- check                       # replay golden fixtures, diff logs
npm run golden -- record                      # re-bless fixtures after intended changes
npm run invariant                             # no-cheating serializer check (5 seeds)
npm run invariant -- --seeds 7 --corp "Thorny Grid" --runner "Trash King"
npm run llm-game -- --model mock --seed 7     # keyless end-to-end LLM-seat game
npm run llm-game -- --seed 7                  # Claude as Runner (needs ANTHROPIC_API_KEY;
                                              #   model via --model or HARNESS_MODEL,
                                              #   default claude-haiku-4-5;
                                              #   openrouter/<vendor>/<slug> routes via
                                              #   OpenRouter — needs OPENROUTER_API_KEY)
                                              # prompt knobs: --profile neutral|expert,
                                              #   --reasoning brief|extended|none
                                              # context knobs (D01): --context
                                              #   conversational|stateless (default
                                              #   conversational), --history full|lean,
                                              #   --compact-threshold N (default 150K;
                                              #   300K for opus models), --compact-keep N
                                              # interface knobs: --auto-resolve on|off
                                              #   (D03, default on: 1-option decisions
                                              #   skip the API, logged forced),
                                              #   --actions compound|split (D09, default
                                              #   compound: verb+subject fused into one
                                              #   menu, follow-up select auto-fulfilled)
                                              # console: --progress on|off (default off:
                                              #   live turn + agenda points + decision
                                              #   count while the game runs),
                                              #   --watch on|off (default off: opens a
                                              #   second terminal streaming the model's
                                              #   reasoning live via tail|jq; the exact
                                              #   pipeline is also printed for manual use)
                                              # instruments: --debrief on|off (D07,
                                              #   default on: postgame self-report to
                                              #   <game>-debrief.json, zero-contamination)
                                              #   (see docs/PROMPTING.md)
npm run audit                                 # conservation audit over golden fixtures
npm run audit -- --file out/<game>.json       # audit any game record
npm run format -- --file out/<game>.json      # markdown narrative: .full.md (every
                                              #   decision + options; review pairs this
                                              #   with the replay viewer)
npm test                                      # typecheck + determinism
```

LLM games write one folder per run — `out/<game_id>/` with `record.json`,
`decisions.jsonl` (one record per decision, both seats, each carrying the
engine's ReproductionCode), `system-prompt.txt`, `debrief.json`, and the
generated `full.md`. Every tool accepts the run folder or any file in it
(legacy flat games still resolve). Promote finished runs into the tracked
corpus with `npx tsx src/cli.ts corpus --promote out/<game_id>` — this
copies the run into `data/games/` and regenerates `data/CORPUS.md`, the
progressive cross-run report. **See docs/DECISION_LOG.md for the record
format guide.**

Rules text for the system prompt comes from NSG's official learn-to-play
guides (`npm run fetch-rules` once, review the extracted text, commit the
snapshots in `harness/rules/`), or from the built-in digest with
`--rules digest` (CI's keyless path). The rules source is recorded in the
game record and in the saved system prompt.

The golden suite (`fixtures/golden/`) is the regression net for any
engine-affecting change — CI runs it on every push; see docs/ENGINE.md.

Decks default to the System Gateway precons (`--corp "Gateway Corp"`,
`--runner "Gateway Runner"`); any file name from `precons/` works.

Game records land in `harness/out/*.json`: status, winner, agenda points,
decision count, errors, and the full engine log (snapshotted at the moment
of the win).

## Debug aids

`harness/page/bootstrap.js` accepts extra URL params (pass via
`extraParams` in `src/game.ts`): `&rngtrace=1` records Math.random draw
counts per log line; `&rngstack=N-M` captures stacks for draws N..M — the
tooling that produced the determinism ledger in `docs/ENGINE.md`.
