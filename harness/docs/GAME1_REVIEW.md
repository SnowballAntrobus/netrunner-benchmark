# Game 1 review — adjudications and action plan

Dante's turn-by-turn notes on game 1 (claude-haiku-4-5, seed 7, flatline
loss T22), cross-referenced against the decision records. Each flagged
item is classified: harness-bug / engine-behavior / model-finding /
interface-design. The action list at the bottom is the pre-game-2 batch.

## The central frame: statelessness

Every decision is a FRESH context: system prompt + current state + 30-line
public log tail. The model has no memory of its own prior reasoning,
choices, or observations. This single fact explains a large share of the
notes:

- **#4** praising "my starting hand" one decision after choosing to
  mulligan it (#3): the state correctly showed the pre-mulligan hand (the
  confirm step precedes the reshuffle — NOT a harness bug), and nothing in
  the fresh context says a mulligan was already chosen.
- Never "reacting" to a drawn card, an opponent install, an advancement
  (#43, #50, #66, #148, #170): reacting requires a diff against a previous
  state, and no previous state exists in context. The drawn card IS in the
  grip; its newness is invisible.
- Invented history — wrong click counts (#112, #143), imagined successful
  runs (#165), conflated turns: the model reconstructs "what I've been
  doing" from the log tail and confabulates the gaps.
- Duplicate-card confusion (#171, discard notes): "I installed DZMZ this
  turn so I should keep [the copy in hand]" — partly model weakness,
  aggravated by no memory of which copy did what.

Knobs this motivates (all logged, all cheap to add):
- **Continuity window**: include the model's own last K reasonings in the
  decision message. The within-game version of the cross-match memory idea.
- **State-diff line**: "changes since your last decision: Corp installed a
  card in Remote 1; you drew Cleaver." Directly targets the no-reaction
  pattern.
- **scot reasoning mode** (already built): predict-opponent-first targets
  the absent opponent modeling (#11/#16/#21/#27 cluster).

## Adjudicated harness bugs

1. **[CONFIRMED — the best catch] #163 blind search.** Mutual Favor's
   select showed `{"hidden": true}` for the runner's OWN stack cards.
   `PlayerCanLook` correctly denies stack visibility in normal play but a
   search entitles you to look. Game-1 consequence: every tutor was blind.
   Fix: in OPTION serialization only, reveal cards the viewer owns
   (`card.player === viewer`); corp-owned facedown options stay hidden, so
   no information leak is possible. State serialization unchanged;
   invariant untouched.
2. **Schema drift — CLOSED, root-caused (D02 rev 3).** Game-1 records
   carry compact strings (phase, turn "null", grip/identity titles)
   because the ENGINE's utility.js replaces the global `JSON.stringify`
   with a title-collapsing log wrapper — the committed page code built
   full objects and the override flattened them in transit (the earlier
   "working-tree edits" hypothesis was wrong). Consequence, larger than
   the drift itself: game 1's model never saw counters, strength, rezzed
   flags, subroutines, or hosted cards as structure. Fixed by capturing
   the pristine stringify in harness.html before engine load; records
   from game 2 onward carry the full documented schema.

## Engine behavior, not bugs (the response-window class)

#6, #8, #33, #35, #40, #42, #49, #53/#54/#56 (the "same prompt 3 times"),
and every "option 0 / what is this?" note: these are the engine's
paid-ability/response windows and phase-boundary confirms. Human players
never see most of them because the engine merges or auto-continues them
for human play; the AI code path receives them raw. The discard-phase
triple is window + selection + window. **Action: auto-resolve
single-option decisions at the page layer** (logged with a forced flag, no
API call): removes ~78% of calls (~5x cost/time), and with them most of
the confusion-generating prompts (#39's wrong guess about the discard
phase, #47/#71's "my turn must be over" confabulations were all elicited
by windows that offered nothing to decide).

## Interface-design findings

- **#212 trigger abilities ("always broke").** The model wanted Telework
  Contract credits but never connected `trigger` → select Telework. It may
  never use click abilities. Fix: enrich the `trigger` command option with
  the actual triggerable abilities (names + short text), enumerated from
  the engine at decision time.
- **#281 / #218–#219 / #37–#38 / #44–#45 / #238–#239: verb-then-subject
  decomposition.** The engine's two-layer protocol splits one intention
  into command + select, with no back-out surfaced; #281 shows the trap
  (chose `play` intending Sure Gamble, follow-up only offered affordable
  events, forced into Overclock and an unintended run). Remedy ladder:
  (a) NOW: annotate command options with their follow-up choices (e.g.
  `play — playable: Overclock (1c), Creative Commission (1c)`), so the
  verb choice is informed; (b) surface the engine's cancel where it
  exists; (c) compound actions (verb+subject fused into one decision) —
  interface v2: bigger change, also the second-largest cost saver, and per
  #219 decomposition can CHANGE decisions, so this is a real experimental
  variable, not just ergonomics.
- **#293 Overclock credits invisible at trash-decision time**: the
  card-hosted credits are in state, but nothing tells the model hosted
  credits are spendable on the current cost. Candidate: include "usable
  credit sources: Overclock (5c)" in relevant decision messages — needs
  care to not become strategy advice; parked for discussion.

## Model findings (haiku, game 1) — becoming metrics

- Breaker-type discipline: knew types at #212 and in the killer diagnosis,
  violated them at #219 and fatally at #1463.
- State-echo accuracy: reasoning misstates credits/clicks it was shown
  (#112, #143, #275 3rd-person oddity). AUTOMATABLE metric: parse claimed
  numbers from reasoning, compare to the state in the same record — a
  per-model "state fidelity" score with zero extra API cost.
- Planning: mostly greedy two-step ladders ("need economy → gain");
  #158's explicit subgoal list measurably improved the following
  decisions; #369's deliberate race-the-corp steal was the strategic
  high-water mark.
- Rulebook impressions visible: conservative rig-first doctrine (#37,
  contra the guides' run-early advice), opponent-tuned framing ("against
  The Syndicate").

## Answered questions

- **Console prompt-caching toggle vs our caching**: different things. The
  Console toggle governs the web Workbench playground only. API caching is
  per-request opt-in via `cache_control`, which our client sets; game 1's
  usage (26.6M cache-read tokens) is the receipt that it worked.
- **Context tracking**: stateless per decision → each call ≈ system
  (~33K, cached) + state/options (~2–4K) ≈ 35–40K in, ~18–20% of the 200K
  window. Compaction never occurs by construction. Per-decision
  `tokens_in` is already in the records; surfacing avg/max + % in the
  formatter header is queued.

## Endorsed ideas

- **Pregame deck interview + postgame debrief**: because decisions are
  stateless, both are ZERO-CONTAMINATION instruments by construction —
  their text never enters any gameplay context unless we choose to feed
  it. Log-only artifacts; `--interview` / `--debrief` flags. Emergent
  in-decision strategy talk remains observable separately, unpolluted.
- **Reason-before-options**: a blind "what do you want to do?" call before
  the option menu — real ablation arm, roughly doubles calls; queued as a
  knob, not a default.

## Pre-game-2 batch (ordered)

1. Auto-resolve single-option windows (page layer, logged as forced).
2. #163 fix: own-card reveal in option serialization.
3. Trigger-command enrichment (list triggerable abilities).
4. Command-option follow-up annotations (the #281 guard).
5. Retry numeric-string coercion (the 25-retry cause).
6. Run naming (memorable id), turn-numbered headers with AP scoreboard,
   context stats in formatter header.
7. Optional instruments: --interview / --debrief; state-diff line and
   continuity window as flagged knobs (default off).
8. Close the schema-drift item against game 2's first records.
