# Prompting methodology

Every authored word shown to the model is an experimental variable. This
document records what those variables are, how they are controlled, and
what the literature says about them. The full rendered system prompt is
saved per game (`out/<game_id>-system-prompt.txt`), and the game record
carries `rulesSource`, `promptProfile`, and `reasoningStyle` — a result is
never separable from the prompt that produced it.

## Prompt profiles (`--profile`)

| profile | framing | harness-authored strategy hints |
|---|---|---|
| `neutral` (default) | seat and objective only — says NOTHING about the opponent's nature | none |
| `expert` | "expert player ... play to win" persona | digest's "Strategic basics" + the corp-decklist probability hint |

Notes:
- Persona framing alone shows little measurable effect on strategic play
  (persona-infused agents needed a structured mediator before behavior
  diverged — arXiv:2512.06867), so `neutral` vs `expert` is expected to be
  a small effect; it is kept as a controlled variable rather than assumed
  away. Narrative framing more broadly can shape agent behavior
  (arXiv:2607.18566).
- The `neutral` default says nothing about the opponent's nature —
  opponent framing is a test-time variable (see "Opponent framing"), and
  silence is the baseline arm. `expert` still names the opponent as a
  rules-based AI, so the two profiles differ on this axis too; a dedicated
  opponent-framing flag will separate the axes when we test them.
- With `--rules official`, the rules text is NSG's own learn-to-play
  guides, which contain NSG's strategy advice; that is part of the
  official-text neutrality choice and is NOT stripped by `neutral` (the
  profile governs harness-authored words only).

## Conversational context (`--context`, `--history`) — D01

The default is one running conversation per game: every decision message
and every accepted response stays in the model's context, and the model
compacts its own history. `--context stateless` (game 1's mode: fresh
context per decision) is retained as the ablation arm. The literature
basis, failure modes, and the variant analysis live in
`docs/design/D01-conversation-context.md`.

| knob | values | default | meaning |
|---|---|---|---|
| `--context` | conversational / stateless | conversational | one running conversation vs fresh context per decision |
| `--history` | full / lean | full | what a PAST decision's user turn keeps: the complete message (variant A) or header+options only (variant B — past board positions then live only in the model's own words) |
| `--compact-threshold` | tokens | 150000 (300000 for opus models) | compact when the observed request size crosses this — a PER-MODEL knob (see "Choosing the threshold" below) |
| `--compact-keep` | exchanges | 20 | exchanges kept verbatim through a compaction reset |
| `--actions` | compound / split | compound | D09: fuse verb+subject into single menu entries ("run Archives"), page auto-fulfills the follow-up select — vs the raw two-question protocol as the ablation arm. The interface guide swaps a mode-matched paragraph so each arm gets an honest description of its own protocol |

### Choosing the threshold (per-model knob)

The threshold must be tuned to the context window of the model under
test; 150K is the default for 200K-window models (haiku included). The
literature triangulates it from three directions:

- **Platform defaults for the identical mechanism.** Anthropic's API
  compaction feature (model-written summary, conversation continues from
  it) triggers at 150K input tokens by default, minimum 50K, with no
  model-specific differentiation across Opus/Sonnet/Haiku — our default
  IS the platform default. Claude Code auto-compacts at ~83% of the
  window (~166K on 200K), and its practitioner guidance favors compacting
  earlier (60–80%) because smaller, more frequent summaries preserve more
  detail than one giant one. MemGPT's queue manager signals "memory
  pressure" at 70% of the window. The quality band is therefore roughly
  70–83% of the window; 150K/200K = 75% sits in the middle of it.
- **Long-context degradation says don't go higher.** RULER
  (arXiv:2404.06654): only about half of tested models keep satisfactory
  performance even at 32K — effective context < claimed context is the
  norm. NoLiMa (arXiv:2502.05167): under retrieval WITHOUT literal
  matching, 11/13 models halve their short-context performance by 32K
  (Claude 3.5 Sonnet's 85%-retention effective length: 4K). Those probes
  are worst-case-adversarial for buried facts, which is why the harness
  re-sends the FRESH state every decision — board facts never rely on
  deep-context retrieval — but they firmly argue against pushing the
  threshold toward the window limit.
- **A floor from our own message sizes — now measured, and guarded.**
  Post-compaction baseline under `--history full` ≈ system (~33K) +
  summary + 20 full exchanges ≈ 95–115K, so thresholds below ~130K
  thrash. CONFIRMED empirically: a sonnet-5 run at `--compact-threshold
  100000` over a ~95K floor produced 13 compactions in 12 turns,
  degenerating to one every 2–9 decisions with `dropped_turns` collapsing
  13→2 (15% of all API calls were summaries). Two defenses now exist:
  the Transcript floor guard refuses over-threshold compactions that
  can't drop ≥3 exchanges or haven't grown ≥ max(8K, threshold/10) past
  the post-compaction floor — vetoes are counted on the game record
  (`compactionsSuppressed`, warned in the CLI summary); and compaction
  summaries are never clipped (the same incident cut EVERY summary
  mid-sentence at the old 2048-token response cap — now 8192 with a
  `summary_truncated` flag on compaction records). The guard makes a
  misconfigured threshold safe, not correct: if the warning fires, raise
  the threshold. Under `--history lean` the baseline collapses and much
  lower thresholds become experimentally available.
- **Caution on what compaction can fix.** Vending-Bench
  (arXiv:2502.15840) found long-horizon agent breakdowns do NOT correlate
  with context-window fill — coherence failures are behavioral, not
  purely memory-limit. Threshold tuning shapes cost and memory quality;
  it should not be expected to remove long-horizon degradation, which is
  part of what this benchmark measures.

Rule of thumb for a new model: start at ~75% of its context window,
verify the post-compaction baseline leaves a sane epoch length, and log
everything — the threshold is itself an experimental variable.

**Fusion inflates the floor (measured, opus D09-2 game).** Compound
menus (D09/D09-2) fatten each decision message — cross-product entries,
`then` fields, previews — so the kept-20-exchange floor rises and
epochs shrink over a long game: at 150K the opus D09-2 win compacted 7
times with `dropped_turns` decaying 27→7 (epochs down to ~7–10 API
decisions) and cost ~$19.80 vs ~$12.20 for the pre-fusion opus win at
the same threshold. Consequence: opus models now DEFAULT to a 300K
threshold (explicit flag overrides), and the "hold the threshold fixed
across models for comparability" argument is retired — compaction
cadence is model-dependent at any fixed value, because message weight
and verbosity are. The threshold's job is clearing the floor with real
headroom on the model's window; cross-model comparability lives in the
records, not in a shared constant.

Mechanics worth knowing when reading results:

- The transcript is append-only and immutable (prompt caching requires
  prefix immutability); a moving cache breakpoint sits on the last
  history turn, so each call re-reads the prior conversation at cache
  price. Assistant turns store the raw JSON of the accepted tool call as
  plain text; retries never enter the transcript.
- At compaction the model writes a summary FOR ITS FUTURE SELF (the
  harness supplies only the trigger and the empty page — see
  `buildCompactionNotice`); the conversation restarts as [notice] + [its
  summary] + [last K exchanges verbatim]. Every compaction is a
  first-class JSONL record carrying the full summary text
  (DECISION_LOG.md) and is rendered in both formatter views.
- In conversational mode the system prompt carries one added
  interface-guide paragraph (`CONVERSATIONAL_NOTE`) disclosing these
  mechanics — memory disclosure, not strategy advice; it is part of the
  saved system prompt like every other authored word.
- Per-decision `transcript_tokens` and `compaction_id` in the records
  make context size a first-class analysis variable.

## Reasoning elicitation (`--reasoning`)

The `choose_option` tool schema lists `reasoning` BEFORE `option`, and the
interface guide instructs the model to write reasoning first — the choice
should be conditioned on the reasoning, not rationalize it afterwards
(the "ex-post contamination" concern; Game Reasoning Arena,
arXiv:2508.03368, elicits reasoning before actions for the same reason).

| mode | directive | est. output tokens/decision | per-game cost shape |
|---|---|---|---|
| `brief` (default) | 1–3 sentences | ~40–90 | ~25–50K output tokens |
| `extended` | full positional analysis before choosing | ~200–600 | 3–8x brief |
| `scot` | predict the opponent's likely holdings/responses FIRST, then choose (social chain of thought; substantially improved coordination and opponent play in repeated-game studies — arXiv:2305.16867 / Nature Human Behaviour 2025) | ~150–400 | 2–5x brief |
| `none` | reasoning may be empty | ~10–20 | cheapest; also an ablation: does articulating reasoning improve play? |

Output tokens are the expensive side; input is dominated by the cached
system prefix (cache reads bill at a fraction of full input). `extended`
raises `max_tokens` to 2048.

**Hidden chain of thought:** Anthropic's extended thinking returns visible
thinking blocks, but forced tool choice is incompatible with thinking
mode — supporting it means un-forcing the tool and parsing more
defensively. Deferred; when added, thinking blocks will be logged as an
additional record field, and models that hide raw CoT (e.g. some
reasoning-mode APIs) will simply have sparser trace data — a documented
inter-model asymmetry, not a harness bug.

## Opponent framing

Telling the model who it is playing measurably changes strategy: in
repeated-game studies, noting that the opponent "can make mistakes" made
GPT-4 play more forgivingly, and predicting the opponent's action before
choosing (SCoT) substantially improved play (arXiv:2305.16867). The
`neutral` default therefore says NOTHING about the opponent — silence is
the baseline. The knob design, when we build it: opponent framing ∈
{none (current default), rules-AI, human, another LLM}, crossed with
truthfulness (framing ≠ actual opponent is itself an interesting
deception-adjacent arm to handle thoughtfully).

**Cross-match memory** ("RL for context compaction"): letting the model
carry compacted lessons between games is verbal/in-context learning —
Reflexion's episodic self-reflection buffer (arXiv:2303.11366) and its
successors (Meta-Policy Reflexion, arXiv:2509.03990; test-time learning
over memory, arXiv:2606.08656). Design sketch for a future phase: after
each game the model writes bounded "match notes"; subsequent games in the
series receive them in the system prefix; notes are logged artifacts like
everything else. This also connects to the models-author-their-harness
idea from the original project sketch.

## Structured output: what forcing the tool buys and costs

Forcing `choose_option` gives us: schema-valid responses at the API layer
(no parse failures), a single-channel closed world (see below), and a
uniform interface across all ~500 decisions. The literature says the cost
is real: format restrictions can degrade reasoning, with degradation
varying dramatically BY MODEL (arXiv:2408.02442 — one model near-robust,
another catastrophic on math under strict JSON). That inter-model variance
is a genuine confound for model comparisons, so format mode must
eventually be an ablation arm, not a constant. Mitigations already in
place, all literature-aligned: reasoning field ordered BEFORE the answer
(answer-first ordering caused the dramatic failures in that study), a
loose schema (two fields, no deep nesting), and corrective retry prompts
(shown to recover parse errors). Future modes when the ablation matters:
two-stage NL→format (free reasoning, then a cheap formatting call —
recovered near-free-text performance in the study) and free-text with
defensive parsing (also unlocks extended thinking). For Phase 1, forced
tool + reasoning-first is the best correctness/cost point; the knob is
documented so the choice is visible.

## Closed world: what the model can and cannot do

The bridge offers exactly ONE tool (`choose_option`) and forces its use.
There is no web search, no retrieval, no code execution, no channel of any
kind besides choosing a legal option index — so "did it look something
up?" has a structural answer: it cannot. Everything the model emits is
captured in `raw_response`. If future harness rungs grant tools (rulebook
lookup, run-calculator queries, scratchpads), each tool invocation MUST be
logged as its own decision-record extension — the audit trail requirement
is part of the tool's design, not an afterthought.

## Terminology policy

Everything shown to the model uses official (NSG rulebook) vocabulary
wherever the engine's vernacular differs. The serializer already speaks
rulebook terms (grip, stack, heap, HQ, R&D, Archives, rig, core damage).
Engine command names are repo vernacular ("n", "jack", "gain"); options
carry the engine's own tooltip where one exists, with a fallback glossary
in llmplayer.js translating every common command into rulebook phrasing
("n" → "Continue / decline (take no action in this window)"). The engine
itself is never modified (quarantine policy).

Describing the action space in natural language is standard harness
design, not assistance: agentic game benchmarks present legal actions as
natural-language descriptions uniformly across models (BALROG,
arXiv:2411.13543; Game Reasoning Arena, arXiv:2508.03368). Two further
points specific to us: the engine tooltips we surface are the SAME text a
human player sees on the engine's own buttons — parity, not help — and
describing actions in a different vocabulary than the rules text we
provide would turn every decision into a vocabulary-mapping test, a
confound rather than a control.

Once the official rules snapshots are committed (`npm run fetch-rules`), a
terminology audit pass should diff the vocabulary in decision messages
against the snapshot text — open item, tracked for the pre-first-paid-game
checklist alongside the conservation auditor.

## Open knobs (documented, not yet built)

- Opponent-model knowledge: none / "it is a rules-based AI" (current) /
  the fork's own `documentation/ai.md` describing exactly how the corp AI
  thinks. The last is a strong information grant with a clean story.
- Closed decklists (`carddata` grants only the model's own list).
- Pilot-notes ablation (NetrunnerDB-style deck guides), per PHASE1 parking
  lot.
- Extended-thinking mode, as above.
