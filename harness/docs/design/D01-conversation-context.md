# D01 — Conversational context as the default

**Status: approved (rev 2) — IMPLEMENTED; rev 3 adds the
threshold-selection literature** (variant A default, 150K threshold as a
per-model knob, keep-20; `--context stateless` and `--history lean` as
arms; compaction exercised keylessly in CI via the mock's synthetic
usage) ·
The big reframe: game 1 ran stateless per-decision; the desired default is
a full running conversation where the model keeps its own history and
compacts it itself. Rev 2 added the literature review and revised the
recommendation accordingly. One implementation note: assistant history
turns store the raw JSON of the accepted tool call as plain text (the
retry loop's existing convention) rather than echoing tool_use/tool_result
block pairs — same words, simpler protocol.

## How the API actually works (the mechanics question)

The Messages API is stateless: every call is independent, and a
"conversation" exists only because the CLIENT re-sends the accumulated
message history with each new call. There is no server-side session, no
automatic memory, and no automatic compaction — if the history exceeds the
model's context window (200K tokens), the call errors. Two consequences:

- **We build the conversation**: transcript = alternating user turns
  (decision messages) and assistant turns (the tool_use containing
  reasoning + choice), plus the protocol-required tool_result
  acknowledgments. The model "remembers" exactly what we re-send, nothing
  more.
- **Prompt caching makes this affordable**: with a cache breakpoint at the
  end of the (immutable) history, each call re-reads the prior transcript
  at ~10% of input price and pays full price only for newly appended
  tokens. CRITICAL CONSTRAINT: caching requires prefix IMMUTABILITY — we
  cannot retroactively shrink or edit old turns without invalidating the
  cache and re-paying for the whole prefix. Whatever enters the transcript
  is permanent until a compaction event replaces it.

## What the literature does (new in rev 2)

The closest prior art is the pair of Pokémon harnesses — the same problem
shape: a long-horizon game, thousands of decisions, context far exceeding
the window, an agent that must remember its own plans.

**Claude Plays Pokémon** (Anthropic's harness; see michaelyliu6's
technical writeup): one rolling conversation of tool-use turns. When the
turn count crosses a threshold, the model is asked to WRITE ITS OWN
SUMMARY, and a fresh conversation is started with that summary as the
opening context plus the most recent turns verbatim. Alongside the
transcript it gets a `knowledge_base` tool — a persistent, sectioned
notepad the model itself reads and edits. Some outputs were checked by a
secondary model. Documented failure modes, all relevant to us: marking
goals complete prematurely, forgetting information it had recorded, and
treating its own summary as ground truth so that summarization errors
compound (the summary is the model's only past).

**Gemini Plays Pokémon** (independent harness; developer retrospective):
converged on the same skeleton — periodic self-summarization, a goals
list, a free-form `notepad_edit` tool, an occasional self-critique pass.
The instructive negative result: a structured, harness-imposed "World
Knowledge Graph" HURT play and was removed, while the model-authored
free-form notepad worked. The developer's summary line — "the scaffolding
around an AI is as important as the model itself" — is this project's
thesis stated from the other direction.

**MemGPT** (arXiv:2310.08560) generalizes the pattern: treat context as
an OS treats RAM, with the MODEL paging information between in-context
and out-of-context storage via tools — memory management as itself an
agent behavior, not a harness service. The agent-memory surveys
(2603.07670, 2604.01707) classify the whole space; our design lands on
"episodic memory via self-summarization, no external store" as the
minimal-intervention point. **Reflexion** (2303.11366) is the
cross-EPISODE analogue — verbal self-feedback carried between games —
which is exactly Dante's "RL but for context-length compaction" idea;
out of scope for D01 (within-game), noted as the Phase-2 hook, and the
postgame debrief instrument already gives us the artifact it would feed
on. **BALROG** (2411.13543) documents the standard evaluation posture
(history-carrying agents on long-horizon games) that game 1's stateless
mode deviated from — useful for framing the paper later: stateless is the
ablation, not the default, which matches Dante's redirect.

Three design lessons taken:

1. **Rolling window + threshold-triggered, model-authored summary** is
   the convergent architecture of every working system. Our Axis-2
   compaction below is precisely this; the harness supplies the trigger
   and the empty page, the model supplies every remembered word.
2. **Model-authored beats harness-imposed structure** (knowledge graph
   vs notepad) — direct external evidence for the emergence principle
   already governing this harness: no injected state-diffs, no strategy
   templates, summary content entirely the model's own.
3. **A persistent notepad tool is the literature's one extra ingredient**
   we do NOT adopt by default. It is an intervention (we would be handing
   the model a memory aid it didn't ask for), and compaction summaries
   already provide a self-authored memory channel whose use we can
   observe. If compaction summaries show the model trying to keep notes
   (numbered lists it re-derives each cycle, "remember:" lines), that is
   the emergent signal to revisit a `notepad` tool as a flagged knob.

## Design axes

**Axis 1 — what each historical turn contains** (decided at send time,
immutable after):

| variant | user turn carries | growth/decision | 200K hit at | compactions/game (~750 dec.) |
|---|---|---|---|---|
| A: full | complete decision message (state + options), as game 1 sent them | ~2.5–4K | ~decision 60–80 | ~8–12 |
| B: lean | options only; the CURRENT state appears once, freshly, in the newest turn | ~250–400 | ~decision 400+ | 0–2 |

Both keep every assistant turn (the model's reasoning) verbatim — that is
the continuity that matters most. Under B, past board positions live only
in the model's own words plus the log tail; under A the model can re-read
old states directly. The Pokémon harnesses both kept full per-turn
observations in the window (A-shaped); neither ablated a lean variant —
B is our addition, worth keeping as an arm precisely because it is
untested there.

**Axis 2 — compaction** ("the model compacts as it sees fit"): when the
transcript nears a threshold (e.g. 150K), we make one extra call asking
the model to write a game summary FOR ITS FUTURE SELF (content entirely
its own — no harness-authored template beyond "summarize for yourself");
the transcript restarts as [system] + [its summary] + [last N turns
verbatim] + [fresh state] — the Claude-Plays-Pokémon reset shape.
Compaction events are logged as first-class records (summary text
preserved) — cognitively interesting artifacts in their own right, the
natural home of the emergent strategy-keeping Dante wants to observe, and
per the failure-mode literature the FIRST place to look when the model
confabulates its past (summary errors compound; we can trace any false
memory to the exact compaction that introduced it).

## Cost estimates (haiku; sonnet ≈ 3–5x)

Rough, per ~750-decision game, cached: variant A ≈ $12–18 (many
compaction cycles, heavy cache writes), variant B ≈ $7–10, stateless
(game 1) was ≈ $4.25. Latency rises modestly (larger prefills).

## Interactions to be aware of

- **Forced-decision spam now costs more AND pollutes the transcript**: 78%
  of turns would be "only one option → proceed" exchanges permanently in
  history — and under variant A each drags a full state snapshot into the
  transcript. The deferred auto-resolve item is therefore COUPLED to this
  design and more pressing under A — flagged, not decided here.
- Retries stay inside a single decision's resolution; only the final
  accepted assistant turn enters the transcript.
- The state-diff and continuity knobs from the game-1 review become moot
  (A/B subsume them; the model diffs by itself — the emergent behavior
  preserved as desired).
- Determinism of experiments: transcript content depends on model outputs,
  so unlike the stateless mode, decision inputs are no longer
  reconstructable from state alone — the JSONL must (and will) log the
  exact transcript token counts and compaction events per decision.

## Threshold selection (rev 3 — per-model knob)

`--compact-threshold` is a per-model tuning knob: it must track the
context window of the model under test, and it is an experimental
variable in its own right. For haiku (200K window) the literature
triangulates the default to 150K: Anthropic's own API compaction feature
— the platform version of exactly this mechanism — triggers at 150K
input tokens by default (min 50K, uniform across Opus/Sonnet/Haiku);
Claude Code auto-compacts at ~83% of the window with practitioner
guidance favoring 60–80% ("smaller, more frequent summaries preserve
more detail"); MemGPT signals memory pressure at 70%. That puts the
quality band at ~70–83% of window, and 150K = 75% sits mid-band. The
long-context literature (RULER 2404.06654; NoLiMa 2502.05167 — 11/13
models halve short-context performance by 32K on
retrieval-without-literal-matching) argues against going higher, while
our own post-compaction baseline under variant A (~100–115K) floors the
useful range at ~130K. Vending-Bench (2502.15840) is the caveat on
expectations: long-horizon breakdowns did not correlate with context
fill, so the threshold governs cost and memory quality — it is not a
cure for long-horizon incoherence, which remains a measured phenomenon.
Full derivation: PROMPTING.md "Choosing the threshold".

## Recommendation (revised)

Default: **conversational, variant A, threshold-triggered model-authored
compaction** (trigger at 150K for 200K-window models — see "Threshold
selection" above; keep the last 20 turns verbatim through the reset). Rev 1 leaned toward B on cost; rev 2 reverses that on
two grounds: Dante's direction ("full conversational context ... letting
the model compact as it sees fit") describes A, and A is the
literature-validated architecture — every working long-horizon harness
kept full observations and compacted by self-summary. B is retained as
`--history lean` (the untested-in-literature cost arm), stateless as
`--context stateless` (the ablation arm and game-1 comparator). No
notepad tool by default (lesson 3 above). DECISION NEEDED: confirm A as
default and the 150K / last-20 compaction parameters.

## Implementation sketch (after approval)

`llm.ts` gains a `Transcript` object (append-only, token-counted via API
usage data, cache breakpoint management); `llmgame.ts` threads it through
`decideWithRetries`; compaction call + logging; new record fields
(`transcript_tokens`, `compaction_id`); `--context conversational|stateless`
and `--history full|lean` flags; PROMPTING.md and DECISION_LOG.md updates;
mock-game CI extended to cross a forced low threshold so compaction is
exercised keylessly.
