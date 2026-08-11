# netrunner-benchmark

A research benchmark measuring how frontier LLMs play **Android:
Netrunner** against a rules-based AI — hidden information, traps, long
horizons, and an opponent that punishes bad risk assessment.

Built on the [Chiriboga](https://github.com/bobtheuberfish/chiriboga)
engine (via [DrBo6's solo mode](https://github.com/drbo6/chiriboga)).
The engine is treated as **quarantined ground truth**: no engine file is
modified. All instrumentation lives in [`harness/`](harness/) and
attaches at the page level — the LLM occupies a player seat through the
same decision interface the built-in AIs use.

## Why Netrunner

The runner sees a partial board: facedown cards may be agendas worth
stealing or ambushes that kill. Games run hundreds of decisions across
15+ turns, which stresses long-context play, memory (the harness
implements model-written compaction), risk arithmetic ("can this access
flatline me?"), and in-context learning within a single game. The
rules-based corp AI provides a deterministic, reproducible opponent.

## Architecture

```
engine (untouched fork)          harness/ (all benchmark code)
  init.js, phase.js, ...    ◄──   page/     page-level seat, serializer,
  ai_corp.js  (opponent)                     enrichment, no-cheating checks
  cardrenderer/                   src/      Playwright host, Anthropic client,
                                             decision records, CLI, replay
                                  docs/     designs (D01..), reviews, guides
                                  fixtures/ golden logs (determinism)
```

Every decision the model faces is written to a JSONL record: the exact
state it saw, the menu it chose from, its stated reasoning, tokens,
retries, and the engine's executable `ReproductionCode` — every
position is replayable, in a graphical viewer, years later.

Key invariants, each mechanically enforced:

- **Determinism** — seeded RNG end to end; golden fixture games must
  replay byte-identically (CI).
- **No cheating** — an independent checker proves serialized state
  never contains information the seat's player couldn't see (`PlayerCanLook`
  is the single choke point).
- **Conservation** — a log auditor re-derives credit/click arithmetic
  for every game.
- **Honest interface** — the model gets exactly the engine's legal
  options, described neutrally; single-option decisions auto-resolve;
  menus fuse multi-step actions without hiding information.

## Quickstart

```sh
cd harness
npm install
npm test                                  # typecheck + seeded determinism
npx tsx src/cli.ts llm-game --model mock --seed 3 --compact-threshold 40000
                                          # full pipeline, keyless
export ANTHROPIC_API_KEY=...              # for real models
npx tsx src/cli.ts llm-game --model claude-haiku-4-5 --seed 7 \
    --progress on --watch on              # live game with reasoning stream
npm run format -- --file out/<game>.json  # human-readable reports
npx tsx src/cli.ts replay --file out/<game>.json   # graphical replay viewer
```

See [`harness/README.md`](harness/README.md) for every command and knob.

**Card art (optional, for the replay viewer):** download
[chiriboga.cronbach.com/images/images.zip](https://chiriboga.cronbach.com/images/images.zip)
and extract into the repo root (creates `images/`). Not included here
for licensing reasons; the viewer renders schematic card faces without
it.

## Documentation map

| doc | what |
|---|---|
| [`harness/docs/PHASE1.md`](harness/docs/PHASE1.md) | phase plan and milestones |
| [`harness/docs/PROMPTING.md`](harness/docs/PROMPTING.md) | prompt/context design, compaction threshold guidance |
| [`harness/docs/DECISION_LOG.md`](harness/docs/DECISION_LOG.md) | how to read the per-decision JSONL records |
| [`harness/docs/ENGINE.md`](harness/docs/ENGINE.md) | engine integration notes (quarantine, quirks) |
| [`harness/docs/design/`](harness/docs/design/) | numbered design docs (D01…), each reviewed before build |
| `harness/docs/*_REVIEW.md` | per-game qualitative reviews with adjudicated findings |
| [`UPSTREAM_README.md`](UPSTREAM_README.md) | the original fork README — engine features, debug guide, test-field/AI-preference reference |

## Status

Phase 1 (single-game pipeline) is nearly complete: conversational
context with model-written compaction, compound action menus, retry
forensics, postgame debrief instrument, replay viewer, and audit
tooling. Next: batch runner and the 10-game acceptance experiment.

## Credits and legal

Engine: **Chiriboga** by
[bobtheuberfish](https://github.com/bobtheuberfish); solo-mode
extension by [DrBo6](https://github.com/drbo6) — the full original
README, including the invaluable debugging and board-state reference,
is preserved verbatim in [`UPSTREAM_README.md`](UPSTREAM_README.md).
License: GPL-3.0 (inherited).

*Netrunner* and *Android* are trademarks of Fantasy Flight Publishing,
Inc. and/or Wizards of the Coast LLC. This is a fan-made research
project and is not affiliated with or endorsed by FFG, WotC, or Null
Signal Games. Card art and symbols are property of Null Signal Games
and used under
[CC BY-ND 4.0](https://creativecommons.org/licenses/by-nd/4.0/).
