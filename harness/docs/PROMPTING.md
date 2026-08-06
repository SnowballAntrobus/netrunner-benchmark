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
