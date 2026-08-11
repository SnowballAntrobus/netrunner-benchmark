# D08 — Replay viewer: the game on the real board, reasoning alongside

**Status: awaiting review** · Supersedes D06 §2 (single-moment inspect):
review pain during game 2 showed the needed unit is the WHOLE game, and
a replay is the designed inspector plus a stepper — the mechanism is
identical, already verified (RC strings are executable JS; the engine's
own rewind evals them). Pulled ahead of D06 §1 (run-match): the earlier
"batch machinery after shakedown" logic now favors the tool that serves
the current task (reviewing game 2) over the one serving the next.

## What it is

`tsx src/cli.ts replay --file out/<game>.json [--seq N] [--port P]`
serves the repo (existing static server) and prints a URL; the page
replays the game as a sequence of still lifes — one per decision record
— on the real graphical board, with a side panel showing the model's
mind at that moment. `--screenshot out.png --seq N` renders one moment
headlessly to a PNG (cloud-verifiable acceptance path, and cheap visual
artifacts for reviews).

## Architecture (engine quarantine intact)

- **`harness/inspect.html`** — engine loadout like harness.html but
  GRAPHICAL (no `accessibilityMode="text"`; canvas renderer on) and no
  faceoff auto-start. Pristine-JSON capture included as in harness.html.
- **`harness/page/inspect.js`** — all behavior: fetches the game's
  `.jsonl` + `.json` from the static server (`?src=...&game=...&seq=N`),
  holds the parsed records, and per step evals that record's
  `reproduction_code` into the engine (the rewind mechanism), then
  triggers a render. No game loop, no AIs, no engine edits.
- **`src/cli.ts replay`** — resolves files, starts the server, prints
  the URL, stays up until Ctrl-C; or drives headless Playwright for
  `--screenshot`.

## The stepper

- Prev/next buttons + ← → keys + a seq slider + jump-to-turn dropdown
  (turn list from the records' `turn` fields).
- Steps over ALL decision records, both seats, forced included. Corp
  records render the board too (they carry RC) with the panel showing
  the rules-AI's menu and choice — reviewer-only information, same
  stance as DECISION_LOG.md's corp-records note.
- **Compaction records become interstitial cards**: board unchanged,
  panel shows the summary the model wrote — you watch its memory get
  rewritten mid-replay, with transcript_tokens_before / dropped / kept.

## The side panel (all from the record — no reconstruction)

- Header: seq · turn · phase · seat · decision type, with badges:
  `forced`, `N retries`, `FALLBACK`, `⚠️ preview divergence` (with the
  previewed-vs-actual menus), transcript_tokens.
- The option menu as the model saw it — labels, previews (`choices`)
  expanded, chosen option highlighted.
- The reasoning verbatim (or "auto-resolved — no API call" / "rules AI"
  markers).
- Run context from the record's state where the board can't show it:
  attacked server, approach position, encountered ice, accessingCard.
- Final record steps to a result card; if a debrief artifact exists,
  it renders as the last "slide".

## View perspective

RC is omniscient (it rebuilds every zone with real identities), so
what's VISIBLE is a render choice: default `viewingPlayer = runner`
(facedown corp cards show as backs — the model's-eye board), with a
"reveal all" toggle in the panel (engine's `viewAllFronts`) for
reviewer omniscience. `--view corp` starts from the corp side.

## Known risks / fallback

The one real unknown is engine init choreography: getting the graphical
page to a neutral, renderable state without starting a game (Init flow,
texture loading, then TestField calls from RC). The engine's own rewind
does exactly this eval against a live board, which is strong evidence
it works; if the still-life fight turns ugly anyway, the fallback is a
text-mode board pane (serializer-style rendering) behind the SAME
stepper/panel — less pretty, same review value, and the panel is where
most of the value lives. Card images: the repo ships them (the engine
plays locally); missing images degrade to the renderer's placeholder,
not an error.

RC limitation (from D06, unchanged): board zones only — phase machine,
run position, turn ownership are NOT in RC; the panel carries them from
the record's own state. Fields RC covers vs the record will be listed
in the doc after implementation.

## Acceptance

- `replay --screenshot` of two game-2 moments: the 4–0 board (post
  second steal) and the flatline turn — PNGs attached to the review;
  visible contents verified by eye against those records' states.
- Stepper walked across the full game-2 file in a headless check:
  every record evals without error (count evaled == record count).
- Compaction interstitial exercised against a mock game file (game 2
  had none).
- Full suite untouched and green (nothing engine-side changes).

## Non-goals

Resumable play from a step; run animation on the board; any RC format
extension (if RC misses something we want visible, it goes in the
panel, never into engine code); polish like diffs-between-steps or
timeline scrubbing previews (later, if reviews want them).

## Open questions for review

1. Command name: `replay` (proposed; supersedes the planned `inspect`)?
2. Default perspective: runner's-eye board with reveal-all toggle
   (proposed), or omniscient by default since it's a reviewer tool?
3. Corp decision steps: include in the walk by default (proposed — the
   corp's thinking is half the story) or behind a toggle?
