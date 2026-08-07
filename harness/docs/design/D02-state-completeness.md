# D02 — State completeness: active events, counters, missing zones

**Status: approved (rev 2) — IMPLEMENTED, plus one discovery during
implementation (rev 3, below)** · Priority per Dante (game-1 #281/#293:
wasted Overclock credits). Rev 2 added the requested field survey and
answered the counters question.

## Rev 3 addendum — discovered during implementation, needs review

While verifying the new zones in a mock run, the records showed
`"resolving": ["Sure Gamble"]` — title STRINGS, not cardEntry objects.
Root cause: **the engine's utility.js replaces the page-global
`JSON.stringify`** with a log-readability wrapper whose replacer collapses
any object bearing a `.title` to its title string (also null → "null",
undefined → "undefined"). llmplayer's `JSON.stringify(request)` was
therefore flattening EVERY state and option at send time — in game 1 the
model never saw counters, strength, rezzed flags, subroutines, or hosted
cards as structure; grip entries, identities, and phase objects arrived as
bare strings. This simultaneously root-causes the "schema drift" open item
(GAME1_REVIEW.md #2): the committed page code DID build objects — the
override flattened them in transit; no mystery working-tree edits.

Fix (harness-side only, quarantine intact): harness.html captures
`window.__pristineJSON = {stringify, parse}` BEFORE any engine script
loads; llmplayer.js and the invariant checker's structural scan serialize
through the pristine copy. The engine's global override is untouched — its
own log lines depend on it.

Verified in the mock game after the fix: full cardEntry objects
everywhere; mid-run Overclock serializes `counters: {credits: 5}` (seq
529); rezzed ice carries strength + subroutines with broken flags;
`run.accessingCard` shows the accessed card; phase/turn are proper
objects. Invariant suite: 17,032 serializations, zero leaks. Golden,
determinism, audit: unchanged/green.

## Dante's questions, answered first

**"Would the card in resolvingCards have the counters serialized too?"**
Yes. The proposal routes `resolvingCards` through the existing
`pileEntries → cardEntry` path, and `cardEntry` emits every
`VISIBLE_COUNTERS` entry (`advancement, credits, virus, power, agenda`)
that is > 0 on the card object — regardless of zone. Overclock hosts its
credits as `card.credits = 5`, so mid-run it would serialize as
`{title: "Overclock", cardType: "event", counters: {credits: 5}, ...}`.
No counter-specific work is needed; the gap was only ever the missing
zone.

**`runner.temporaryCredits`** — will be serialized, with one refinement
discovered in the survey: the serialized credit TOTAL was never wrong.
`Credits(runner)` (utility.js:2649) returns
`creditPool + temporaryCredits`, and `playerEntry` uses `Credits()`. What
the model cannot see is the decomposition: at run end the engine logs
"Runner loses N unspent temporary credits" and zeroes them
(phase.js:1673–1675), so part of the displayed total silently evaporates.
The field is therefore a use-it-or-lose-it signal, not a correction.
Naming: keep the engine/log name — the public log the model reads says
"temporary credits" verbatim, so `temporaryCredits` is the self-consistent
choice (the earlier `runCredits` suggestion is withdrawn).

## Field survey (init.js player structs + engine globals vs serializer.js)

Method: every field initialized on `corp`/`runner` in init.js and every
game-state global (init.js:15–68), checked against `playerEntry`/`stateFor`
coverage, with pool relevance verified by grepping sets/systemgateway.js
and sets/systemupdate2021.js for producers.

| field | meaning | today | verdict |
|---|---|---|---|
| `player.resolvingCards` (both) | events/operations mid-resolution | absent | **serialize** (the headline fix; Overclock verified at seq 284) |
| `runner.temporaryCredits` | run-scoped credits (bad pub etc.), zeroed at run end | folded into `credits` total, unattributed | **serialize** when > 0 |
| `accessingCard` (global) | the card being accessed during the steal/trash/continue decision | absent — and the decision's options are bare `{}` (phase.js:1547–1582), so the card appears NOWHERE in the request | **serialize** as `run.accessingCard` |
| `removedFromGame` (global) | RFG zone | absent | **serialize** — live TODAY: Spin Doctor (Gateway Corp precon) removes itself (sets/systemgateway.js:4030); also `Forfeit()` |
| `player.identityCard` | serialized as `{id, title}` only | partial | **upgrade** to full cardEntry (counters, hosted cards) |
| `identityCard.setAsideCards` | set-aside zone | absent | **serialize** when non-empty — Ayla "Bios" Rahim (SU21) hosts playable set-asides; `PlayerCanLook` already grants owner visibility (utility.js:1945) |
| `traceStrength` / `linkStrength` | mid-trace state | absent | defer — sole producer in the pool is Punitive Counterstrike (SU21), not in current precons; add a conditional `state.trace` when traces enter the card pool |
| `player.installingCards` | card in limbo during install resolution | absent | no change for the runner seat (no mid-install selects in this pool); flagged for the future corp seat (server-choice selects) |
| `tempBonusClicks` | next-turn bonus clicks | absent | no change — zero producers in implemented sets (dormant engine support) |
| `lingeringEffects` | source-independent effects | absent | no change — `AddLingeringEffect` never called by implemented sets (dormant) |
| `subroutine` index, `accessedCards`, `movement` flag | run micro-state | absent | no change — conveyed by phase identifier, `encounteredIce.subroutines[].broken`, and the log |

Everything else initialized in init.js is either already covered
(`creditPool`→credits, `clickTracker`, zones, `badPublicity`, `tags`,
`coreDamage`, MU/link, `agendaPointsToWin`) or render/control plumbing
(`serverIncrementer`, `_renderOnly*`, `opportunitiesGiven`, ...).

## Proposed change (still serializer.js only)

In `playerEntry`, both sides (seat-agnostic as always):

- `resolving: pileEntries(player.resolvingCards, viewer)` — omitted when
  empty. cardEntry → PlayerCanLook honesty preserved automatically.
- `identity` upgraded to full cardEntry (keeps id/title; gains counters
  and hosted when present).
- `setAside: pileEntries(player.identityCard.setAsideCards, viewer)` when
  non-empty.
- Runner only: `temporaryCredits` when > 0, documented in the interface
  guide's notation note as "included in your credit total; lost when the
  run ends if unspent".

In `stateFor`:

- `run.accessingCard: cardEntry(accessingCard, viewer)` when set. Honesty
  note: `PlayerCanLook` (utility.js:1941) returns true for the accessed
  card for ANY viewer — the engine's own rule — so a corp viewer would
  also see it. We defer to the choke point as ever (and the invariant
  checker shares it, so no violation is possible by construction).
- `removedFromGame: pileEntries(removedFromGame, viewer)` when non-empty
  (top-level: the engine keeps one shared array; name matches the "removed
  from the game" log line).

## Acceptance

- Mock game + invariant suite re-run: the structural no-cheating check
  string-scans the whole state, so the new zones are covered
  automatically; zero leaks required.
- Golden fixtures unchanged (serializer is observation-only).
- A resolving-event-with-counters serialization confirmed against game 2's
  first records (also closes the schema-drift item).

## Non-goals

No prompting changes, no decision-message changes — purely making the
board state complete. Whether the model USES the visible Overclock
credits remains an observation (emergence intact).
