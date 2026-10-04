# D15 — Board viewer, live mode, and replay by re-simulation

**Status: implemented** · The D08 replay viewer proved the mechanism
(every record's `reproduction_code` rebuilds the board in the real
engine) but not the experience: it rebuilt a still life per step in the
engine's own canvas, so stepping was slow, it could not follow a game
while it was being played, and the result looked like a debugging aid.
D15 replaces it as the primary review surface with an engine-free board
viewer fed by recorded board snapshots, adds a live mode, and proves
that every recorded game can be re-simulated exactly. D08's engine
replay stays available (`replay --engine`) as the ground-truth check.

## Frames: what the viewer draws

`harness/page/snapshot.js` adds `window.__harness.snapshot(seq,
logIndex)`: a compact, **omniscient** frame of the whole board at each
decision, plus one final frame.

**When a frame is taken.** A frame must show the board the decision was
asked on. Model-seat decisions pause the page until the host answers, so
the host takes their snapshot during that pause. Rules-AI decisions do
not pause the page (their log record is sent without waiting), so the
page takes their snapshot synchronously at decision time and sends it
with the log record. The first version snapshotted rules-AI decisions
from the host after the fact, and those frames could show a board a few
steps later (a card already rezzed, the turn already passed). Comparing
two re-simulations of the same game exposed it. Frames are now
reproducible byte for byte: CI re-simulates a corpus game and requires
its committed frames to come out identical.

- Every card in every zone (HQ, R&D top three, Archives, remote servers
  with ice outermost-first, the Runner's grip, stack, heap and rig,
  score areas, removed-from-game, set-aside), with counters
  (advancement, credits, virus, power, agenda), current strength,
  broken subroutines, hosted cards, rez and face-up state.
- Per-card **visibility bits** from `PlayerCanLook`, the serializer's
  own choke point: bit 1 = the Runner can see it, bit 2 = the Corp can.
  The viewer renders the omniscient board or either player's view
  honestly from the same frame.
- A stable instance id per physical card (a `WeakMap`), so the viewer
  can tell which card moved, and the run state (server, ice position,
  encounter, accessed card).
- `lg`: the public log lines since the previous frame (the same
  `isPublicLogLine` filter the serializer uses), so narration needs no
  second channel.

Read-only by construction: the same engine reads as serializer.js, no
RNG draws and no state writes, so golden fixtures and seeded games are
unaffected (golden 10/10, determinism and invariant suites unchanged).

**Isolation.** Frames are a reviewer artifact. They go to
`frames.jsonl` next to the record and to the live stream, and never into
a model request: the model's view is still only the serializer's
per-seat state, guarded by the no-cheating invariant.

**Size.** One frame per decision is repetitive JSON: the 11 corpus games
hold 13 MB of frames that gzip to 180 KB, so they are committed with
the games.

## The viewer (`site/viewer/`)

A static page with no build step and no engine. `model.mjs` turns a
record, its decision rows, its frames and the debrief into a game: steps
(one per decision or compaction record), deduplicated board frames, card
dictionary, narration, metadata. The **same module** runs in Node (the
`site` and `replay` commands write bundles with it) and in the browser
(live mode feeds it event by event), so recorded and live games are
modeled identically.

What it shows:

- **The board**: the Corp's servers across the top (ice outermost
  first, R&D's top card in the omniscient view), the Runner's rig below,
  score areas, hand sizes, credits, clicks, tags and bad publicity; a
  run bar during runs (server, position, encountered ice, accessed
  card). Card faces are schematic (title, type, cost, strength,
  counters), with the card's NetrunnerDB text on hover or tap; no card
  art is needed or shipped.
- **The model's mind**, per step: the seat and model, the menu it chose
  from with its choice marked, the reasoning it gave, retries and
  fallbacks, compound and folded steps, multi-select progress, and
  compaction memos where the context was summarized.
- **The public log** with the step's new lines highlighted.
- **Perspective**: Omniscient, Runner or Corp. In a player's view, cards
  that player cannot see are face-down, exactly as the frame's
  visibility bits say.
- **Navigation**: a timeline with turn, score and compaction marks;
  play/pause and speed; "skip auto steps" (forced, fulfilled and folded
  records); keyboard (←/→ step, Shift jumps between model decisions,
  Home/End, Space, 1/2/3 for perspective); deep links `#step=` and
  `#seq=`. A change glow marks what the last step changed.
- **End of game**: result, final scores and each seat's debrief answers.

## Live mode

`llm-game --live` (and `run-match --live`) starts a small server next to
the game and prints `http://127.0.0.1:8787/site/viewer/?live=1`. The
game emits `meta`, `frame`, `decision`, `compaction` and `end` events;
the server forwards them as Server-Sent Events and keeps a backlog, so a
tab opened mid-game first replays everything so far and then follows.
The viewer follows the newest step unless the reviewer scrolls back
("Jump to live" returns). Under `run-match` each game's `meta` resets
the backlog and the viewer, so one tab follows a whole match. The stream
is a reviewer view only; nothing in it reaches a model.

## Re-simulation: every recorded game, replayed exactly

The engine is deterministic under the seed, and so are the page's
auto-resolution, fusion and folding. Answering each API decision with
its recorded choice (`ReplayClient`) therefore reproduces a game exactly,
with no API calls. `src/resim.ts` does this through the live harness,
using the interface flags on the record (era-3 records replay with the
era-3 rules-AI branch policy), and **verifies** the replay: every
decision record must match on `(seq, seat, decision type, choice, menu
size)`, both seats, and the game must end the same way. A replay that
drifts stops with "replay diverged".

Uses:

- `cli.ts frames --file <run>` / `--corpus` backfills frames for games
  recorded before frames existed. All 11 corpus games re-simulated
  exactly; their frames are committed.
- `cli.ts replay --file <run>` re-simulates automatically when a game
  has no frames, then serves the viewer.
- It is the end-to-end proof that the decision stream is a complete
  record of the game.

## Commands

```sh
npx tsx src/cli.ts replay --file out/<game_id>              # serve the board viewer
npx tsx src/cli.ts replay --file out/<game_id> --screenshot board.png --step 120
npx tsx src/cli.ts replay --file out/<game_id> --engine      # D08 engine replay
npx tsx src/cli.ts frames --corpus                           # verify + backfill frames
npx tsx src/cli.ts llm-game --model claude-haiku-4-5 --live  # watch while it plays
```

`--frames off` on `llm-game` skips snapshots (the record is unchanged).

## Acceptance (met)

- Frames on by default with no change to any golden, determinism,
  invariant or audit result.
- All 11 corpus games re-simulate exactly; frames backfilled, and
  regenerated after the capture-timing fix above.
- Re-simulation reproduces committed frames byte for byte (CI).
- Live: a mock-vs-mock game of 1,174 decisions followed end to end in a
  browser via SSE, including a tab opened mid-game.
- Viewer checked at desktop and phone widths, in all three perspectives,
  at compaction steps and at the end screen.

## Non-goals

Editing or branching a replay (counterfactuals are a Phase-2
instrument, see D12), and animation between frames beyond the change
glow.
