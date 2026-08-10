# D06 — Match runner, results table, and the inspect tool

**Status: DECOUPLED per review** · §3 polish: scoreboard turn headers
— **IMPLEMENTED**: numbered from boundary ordinals (exact by
construction) with AP from the first record inside the new turn
(boundary-adjacent records predate the SPOILER line and carry the
outgoing turn — found and handled); legacy games degrade to numbered
headers without AP. Run labels — **REMOVED in review**: a
config-derived name ignores deck/seat/ablation arms, and a
run-identity-derived name adds little over the gameId while the config
space is still growing; revisit with §1, where a MATCH-level label may
be the natural unit. §1 (run-match) and §2 (inspect) remain **awaiting
review**, deliberately sequenced AFTER a single-game shakedown run
validates the full stack — batching machinery should aggregate a
pipeline already known to be sound. M5 acceptance: 10 complete games,
zero crashes, results table, at least one moment inspected visually.

## 1. `run-match` + results table

`tsx src/cli.ts run-match --games N --seed S [every llm-game knob]`
runs N sequential `runLLMGame`s on seeds S..S+N-1 into
`out/match-<label>/`, continuing on individual failures (a crashed game
is a ROW, not an abort — the table is where "zero crashes" is checked).
Per-game artifacts unchanged. Adds `match.json` + `match-summary.md`:

| game | seed | status | winner | reason | turns | API dec. | forced | retries/fb | tokens in/out/cached | est. $ | compactions | max ctx | prev. div. | min |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

plus aggregate rows: win rate, means, totals. Everything already exists
in `LLMGameRecord` except the dollar column.

**Pricing table** (new, `src/prices.ts`): $/MTok by model prefix —
haiku 4.5: 1.00 in / 5.00 out / 0.10 cache-read / 1.25 cache-write;
sonnet 4.5: 3 / 15 / 0.30 / 3.75 — with an as-of date in the file.
Unknown model → tokens shown, $ column dashed (never guessed).

## 2. `inspect` — a logged moment on the real board

Engine facts (verified): `ReproductionCode()` emits an EXECUTABLE JS
string (`RunnerTestField(...)` / `CorpTestField(...)` instantiations +
`ReplicationCode` property assignments), and the engine's own rewind
feature already `eval`s exactly these strings (init.js) — loading via
eval is the engine's own mechanism, not our invention. The TestField
calls take renderer texture arguments, i.e. RC assumes the graphical
environment.

Proposed shape:

- `tsx src/cli.ts inspect --file out/<game>.jsonl --seq N`
  `[--view runner|corp] [--screenshot out.png] [--port P]`
- A new thin `inspect.html` (engine loadout like harness.html but WITH
  the canvas renderer — no `accessibilityMode="text"`) plus
  `harness/page/inspect.js`. The page takes `?src=<jsonl path>&seq=N`,
  fetches the JSONL from the static server itself, finds the record,
  and evals its `reproduction_code` after engine init. No game loop, no
  AIs — a still life.
- **Side panel from the record**: seq, turn, phase, the option menu
  (with previews), the model's reasoning, and run context
  (state.run.server / approach position / accessingCard) rendered as
  text next to the board. This matters because of the honest
  limitation below.
- Without `--screenshot`: start the server, print the URL, stay up
  until Ctrl-C (Dante opens it in his browser). With `--screenshot`:
  headless Playwright loads the page, waits for render, writes a PNG
  and exits — the cloud-verifiable path, and cheap visual artifacts
  for reviews.

**Honest limitation** (engine's own comment: "not comprehensive yet"):
RC reconstructs the BOARD — zones, cards, hosted cards, counters,
credits, clicks — but not the phase machine, run position, or turn
ownership. Inspect is board inspection (exactly M5's "eyeballed on the
real board"), not a resumable game; the side panel carries the dynamic
context from the record's own state instead. Fields RC covers vs the
record will be listed in the doc after implementation.

Quarantine: everything in `inspect.html` + `harness/page/inspect.js`;
engine untouched.

## 3. Polish items folded in

- **Memorable run labels** — removed in review (see status note):
  config-derived names collide across decks/seats/ablations; deferred
  to §1 as a possible match-level label.
- **Formatter turn headers with scoreboard**: `## 🏢 Corp turn 4 ·
  AP 2–0` — turn number from the boundary-adjacent record's `turn`
  field, AP from that record's state (`agendaPoints`); falls back to
  today's plain header when no record is nearby. Completes the game-1
  review asks (context stats already shipped in the header).

## Acceptance

- Mock match (`run-match --games 3 --model mock`): 3/3 completed,
  table produced, dollar column dashed for mock, aggregates correct.
- Inspect: `--screenshot` of a known mid-game record (one with rezzed
  ice, counters, a mid-run state) renders a board whose visible
  contents match the record's state — verified by eye against the
  record, PNG attached to the review.
- Full suite untouched and green.

## Non-goals

Resumable play from RC (rewind-style), corp-seat inspection controls,
and any RC format extension (engine quarantine) — if RC misses
something we want visible, it goes in the side panel from the record,
never into engine code.
