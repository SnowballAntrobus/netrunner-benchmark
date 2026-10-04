# D14 — Corp seat, model vs model, and honest menus for every seat

**Status: implemented** · The Phase-1 parking lot's next two items, in
order: a model in the Corp seat, then models in both seats. Building
them surfaced three interface defects that also affected the Runner
seat — fixed here, which opens **interface era 4**.

## Seats

`llm-game --seat runner|corp|both` (default `runner`, byte-identical to
era 3 except for the fixes below). `--model` sets the model for a single
seat and for both seats unless `--corp-model` / `--runner-model` say
otherwise (self-play is `--seat both --model X`).

- **Page.** `&llm=runner|corp|both`. Each LLM seat gets its own
  delegation shell over the rules AI Init created (same reasoning as
  M4); whichever seat is left to the rules AI is wrapped for logging.
  Every request names its seat; per-seat state (compound queues,
  pending previews) is keyed by seat.
- **Host.** One `SeatContext` per LLM seat: its own client, system
  prompt, transcript (D01), compaction threshold (each model's own
  default), counters and debrief. The seats never share context. The
  game record keeps every era-3 top-level field (now sums over seats)
  and adds `llmSeat`, `seats.{corp,runner}` (per-seat counters, usage,
  cost, threshold) and `aiBranches`. Compaction records carry `seat`.
  Two-model games write `system-prompt.corp.txt` +
  `system-prompt.runner.txt` and a `debrief.json` of `{seats: [...]}`.
- **Game ids.** Runner seat unchanged (`llm-<model>-s7-…`); Corp seat
  `llm-corp-<model>-s7-…`; two models `llm-<corp>-vs-<runner>-s7-…`.

## Perspective (whose eyes the page renders through)

The engine masks titles in option labels AND in log narration by its
single global `viewingPlayer`. So:

- **Corp seat alone** → `p=c`: labels and narration from the Corp's side.
- **Any game with an LLM Runner** → `p=r`: the shared narration must
  stay Runner-honest. In two-model games the Corp therefore reads a
  Runner-perspective log; its system prompt says so in one sentence
  (`CORP_SHARED_LOG_NOTE`, mechanics disclosure only), its state JSON is
  its own full view, and menu labels the engine masked ("hidden card ->
  new server") are restored for cards the Corp can see.

## Prompts

Every Runner-seat string is unchanged: a Runner-vs-rules prompt is
byte-identical to era 3. The Corp gets parallel texts to the same
standard — `CORP_RULES_DIGEST` (for `--rules digest`; the default
official rules already include NSG's Corp guide), `CORP_INTERFACE_GUIDE`
(Corp commands: install into servers, advance, rez, score, purge, trash
while tagged), `CORP_ACTIONS_PARAGRAPHS`, and the Corp-side reading of
the three Comprehensive Rules terms. Profiles keep their wording with
the roles swapped; `expert` names the opponent truthfully ("a
rules-based Runner AI" / "another AI model"). Decklists stay open, own
deck first.

## Fix 1 — rules-AI branches decided for LLM seats

Card scripts carry `//**AI code` branches that run whenever
`player.AI != null`: they **prune a menu to the rules AI's pick**
(Mutual Favor's stack search returned only the rules AI's preferred
breaker — a forced single option), **suppress an option entirely**
(abilities that return `[]` when the rules AI would not use them), or
**pre-fill a choice** through `preferred`. Since M4 the LLM shell is
`Object.create(rulesAI)`, so every one of these fired for the model.
Counting only branches inside card `Enumerate` functions: 23 in the
SG/SU21 Corp cards, 13 in the Runner cards, 22 more in Elevation and the
small sets — with further ones in `Resolve` code and its callbacks.

The fix keeps the shell (engine dispatch and belief bookkeeping need a
non-null AI) and makes `player.AI` an accessor on LLM seats that reads
as **null exactly when the reading code is a card script** (`sets/*.js`
on the stack's reading frame) **and no rules-AI deliberation**
(`ai_corp.js`, `ai_runner.js`, `runcalculator.js`) is on the stack:

- card Enumerate/Resolve code and its callbacks (closures keep their
  `sets/` source location) take their human-player branches — the full
  legal menu a human would get;
- engine code (Main/MakeChoice dispatch, bookkeeping) still sees the
  shell, so decisions keep routing to the model;
- card AI-helper functions called during rules-AI deliberation (they
  read `player.AI._helper()` unguarded) still see the shell.

Golden fixtures cannot move: the accessor exists only on LLM seats.
`--ai-branches rules` restores the era-3 behavior (records keep
`aiBranches: "rules"` and stay in era 3). `neutralizedReads` on the
record counts how often card code saw a human seat.

**Own-deck searches.** Human branches can offer cards from the deciding
seat's own stack or R&D (Mutual Favor, R&D tutors). Searching means
looking, which `PlayerCanLook` doesn't model — such entries are
revealed to that seat (menus only; the state keeps the deck as a
count). Opponent decks never.

## Fix 2 — multi-select prompts resolved with empty slots

"Trash 2 cards from your grip", "shuffle up to 3 cards from Archives",
sabotage, Longevity Serum: each option carries a `.cards` slot array the
human UI fills click by click; the rules AIs fill it from `preferred`
hints, which the shell ignores. An LLM seat therefore resolved these
with empty slots. The page now answers the human protocol card by card:
each step is an ordinary select (`multi_select: {slot, of, chosen}` on
the record, one line in the decision message), a card fills the next
slot of every same-length selector, filling the last slot resolves with
that card's option, and button options (gated by
`multiSelectDynamicButtonEnabler`) finish early. Multi-select menus are
never fused, fulfilled or folded.

## Fix 3 — breach menus named the cards about to be accessed

Found by the extended invariant below: the engine's `ChoicesAccess`
deliberately unmasks names for a human Runner ("don't hide the name"),
so every access-order menu named each card before its access. Menu
entries whose card is hidden from the deciding seat now have that title
masked in label/button text. **No model ever saw one**: an audit of the
era-3 corpus finds 70 such menus, every one auto-resolved, fulfilled or
folded (0 reached the API) — prior results stand.

## The no-cheating invariant, extended

`&invariant=1` used to check both viewers' serialized state at rules-AI
decisions only — a model-vs-model game got zero checks, and no check
ever looked at the option menus a model sees. Now llmplayer.js also
calls the checker at every LLM-seat decision: both viewers' state plus
**the seat's own menu** (no title of an opponent card the seat cannot
see, unless a visible copy exists). `llm-game --invariant` reports it;
`smoke` runs it across the pool for every seat mode.

## Acceptance

- Mock games for all three seat modes complete with 0 invalid records,
  retry and fallback exercised per seat, compaction and debriefs per
  seat (CI: one run per mode).
- `--invariant`: 0 violations for runner, corp and both (CI).
- `smoke` over every qualified deck (D16), every seat mode: no crash,
  error, invalid record or violation.
- Golden, determinism, the rules-vs-rules invariant and the audit
  unchanged.

## Comparability

New games are **era 4**: the Runner's menus differ from era 3 exactly
where fixes 1–3 apply (in the Gateway matchup: Mutual Favor and a few
ability windows), plus one wording change made at close-out: the
mulligan command `m` now carries a description like every other
command, where era-3 menus showed the bare letter. Era-3 games remain in
the corpus, reported separately as always.
