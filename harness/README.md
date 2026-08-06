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
npm test                                      # typecheck + determinism
```

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
