# D16 — The card pool: every precon, loaded on demand, qualified

**Status: implemented** · PHASE1's progressive card pool ("start with
System Gateway, expand to SU21, then Elevation"). Every one of the
engine's 71 preconstructed decks is now playable by the harness, and a
qualification run decides which of them are fit for benchmark games:
the extended pool exposes real engine defects, and a crash or stall
mid-game would corrupt the data.

## Loading the sets a deck needs

`harness.html` statically loads the base pool: System Gateway, System
Update 2021 and the tutorial set, which every golden fixture uses.
Decks built on other sets need those set files too. The page loads them
on demand from `&sets=a,b`, `document.write`-ing them right after the
base sets so the engine sees its usual load order. Base-pool games pass
no parameter and load byte-identically to before (golden 10/10).

`src/cardpool.ts` derives membership from the set files themselves
(every `cardSet[N] =` / `coreSet[N] =` definition), never from a
precon's self-declared `sets` field: the definitions are what the
engine runs. `requiredSets` refuses a deck containing a card no set
file defines (the engine would silently drop it). Every game path
(`run-game`, `llm-game`, `run-match`, `replay --engine`, `frames`)
computes and passes the sets, and the game record lists them in
`cardSets`.

The engine ships **71 precons**: 33 Corp and 38 Runner. 47 use only the base pool; 24 need extra sets (18 Elevation, 6 the partial Core set). Every card in every precon is implemented by some set file.

## What the extended pool broke, and what was fixed in the harness

- **Audit coverage.** Elevation narrates some events differently:
  ability announcements ("... triggered"), subroutine text with
  `[credit]` where the base sets write `[c]`, "Side Hustle pays out N
  credits", Account Siphon's summary line. Each new pattern was
  verified against the card code and taught to the auditor; its
  parser-coverage guard (unknown credit lines fail the audit) is what
  surfaced them.
- **Engine self-lint.** Some set files log `LogError: .x on Y should
  not be automatic` (or "will be ignored because it is set to
  automatic") at load, identically in rules-only games. These are
  reported as lint, not counted as errors (`ENGINE_LINT`).
- **A checker false positive.** Detente hosts a Corp card face up on
  Runner hardware outside every zone the engine's `AllCards` walks, so
  the invariant's census missed a visible copy and flagged its public
  title. The census now includes hosted cards recursively (the check
  itself was not loosened).

## Qualification

```sh
npx tsx src/cli.ts pool --qualify [--jobs N] [--seeds 1,2,3] [--only NAME] [--resume]
```

Per deck: three rules-vs-rules games against the Gateway reference
opponent on seeds 1–3, with the no-cheating invariant on and the
conservation audit run on each log, plus one mock game with the deck's
own side as the model seat (exercising its cards' human branches under
D14). A deck **qualifies** only if every game completes with no hard
error, leak, audit finding or invalid record. Results go to
`harness/fixtures/pool.json` (per deck: side, sets, qualified, and
every game's outcome and first problem); the manifest is rewritten
after each deck, so an interrupted run resumes with `--resume`. Decks
run `--jobs` at a time (default 2).

**Timing must not decide a verdict.** A hang is caught by the
no-progress stall check (60 s without a decision). The whole-game limit
is only a safety net, set to 15 minutes for qualification: the first
full run used the ordinary 5-minute limit on a heavily loaded machine
and refused long but healthy games (25 turns each side, still making
progress) as "timeouts". A refusal is therefore only recorded after the
deck is re-run on its own with `--only` on an idle machine.

`llm-game` and `run-match` refuse a deck that failed (`--allow-unqualified`
overrides) and warn about one never qualified; `smoke` skips failed
decks; `pool` lists every deck with its sets and status; the project
page shows the summary.

**Result (2026-10-04, seeds 1, 2, 3): 66 of 71 decks qualify** (31 of 33 Corp, 35 of 38 Runner). 5 are refused: 0 from the base pool and 5 from the extended sets. Every refusal from the parallel run was re-run on its own: three were overturned (No Walls, ProCo Ayla and Quick Returns had long games that timed out under load and qualify when run alone), and the rest reproduced exactly. Every remaining refusal fails in a rules-AI-only game, so the defect is the engine's, not the harness's.

| deck | side | sets | games failing (first) | first problem |
|---|---|---|---|---|
| Agency | Corp | elevation | 1 of 4 (rules game, seed 3) | LogError: TypeError: Cannot read properties of null (reading 'unique') |
| Fashion Lab | Corp | elevation | 1 of 4 (rules game, seed 1) | game stalled: LogError: TypeError: Cannot read properties of null (reading 'unique') |
| Economy, Chaos and FIxed Suit | Runner | coreset | 1 of 4 (rules game, seed 1) | game stalled: unhandledrejection: TypeError: Cannot read properties of undefined (reading 'length') |
| Professional Opportunities | Runner | elevation | 1 of 4 (rules game, seed 3) | LogError: preferred option not matched with the above optionList and preferred: |
| R&Devour | Runner | coreset | 1 of 4 (rules game, seed 3) | game stalled: unhandledrejection: TypeError: Cannot read properties of undefined (reading 'length') |

## Smoke testing the interface across the pool

```sh
npx tsx src/cli.ts smoke [--pool all|base|extended] [--seats rules,runner,corp,both] [--limit N]
```

Pairs every Corp precon with a Runner precon and plays each pairing as
rules-vs-rules (serializer invariant) and with the mock in each
requested seat mode (option-menu invariant, multi-select adapter,
record validation). Any non-completed game, hard error, invalid record
or invariant violation fails the run. Keyless.

## Non-goals

Fixing the engine defects behind refused decks (the engine is
quarantined here; those fixes belong upstream), the set files no
precon uses (Midnight Sun, Downfall, Uprising, Rebellion, Parhelion and
others are loadable by `&sets=` but no deck draws on them), and
deckbuilding.
