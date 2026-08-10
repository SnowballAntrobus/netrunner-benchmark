# D07 — Postgame debrief (interview deferred)

**Status: approved — IMPLEMENTED** (all open questions resolved per
review: debrief default on; instrument v1 as written; result NOT
disclosed). Results: instrument v1 in prompts.ts
(`DEBRIEF_INSTRUMENT_VERSION`), debrief call reuses `client.summarize`
after the result is known (completed conversational games only; errors
never affect the game record beyond a note), artifact at
`<gameId>-debrief.json` with prompt/text/usage/latency, `debriefPath` +
`debrief` flag on the game record, `--debrief on|off` in the CLI, "🎤
Debrief" section appended to both formatter views, mock CI acceptance
requires the artifact keylessly. Verified: typecheck, mock PASS
(artifact + formatter section confirmed; `--debrief off` produces
neither), golden/invariant/audit green. One timing property worth
knowing: the transcript ends at the model's LAST DECISION — the
game-ending log lines postdate it — so whether the model realizes how
the game ended is fully observable, as intended.

Original design below.

---

Recommendation up front: build the
DEBRIEF only this phase, defer the pregame interview — agreeing with
Dante's inclination, with a literature-backed reason it costs us
little.

## Why the interview can wait

The interview's unique value was a PREREGISTERED plan to measure
plan-adherence against. Under D01's conversational default we get a
close substitute for free: the model's early-turn reasoning is
preserved verbatim in the transcript (and its records), so "did it
state a plan and follow it?" is measurable from emergent statements
without eliciting anything — and emergent plans are truer to the
emergence philosophy than solicited ones anyway. What we lose is only
the controlled-prompt comparability of elicited plans across models;
that's a real ablation arm someday, not a Phase-1 need. (Stateless-arm
games lose the substitute too — noted, accepted.)

## The debrief

One extra API call when the game ends:

    [system prompt] + [final transcript, as compacted] +
    [user: debrief instrument]

- **Zero-contamination by construction**: the game is over; the
  debrief text enters no transcript, no record that any future call
  reads. (This survives the conversational redesign because instrument
  calls are separate calls — never appended.)
- **It uses the model's own memory**: the debrief sees the game as the
  model remembers it — including through its own compaction summaries.
  A model that compacted badly will debrief from a distorted past;
  that is signal, not noise (see fidelity below).
- Stateless-mode games have no transcript; the flag is a no-op there
  this phase (a debrief-from-records variant is a later arm).

**Instrument text** (fixed, versioned, recorded verbatim like every
authored word; neutral and open-ended, no leading content):

1. Summarize how the game went from your perspective.
2. What was your plan, and how did it change as the game developed?
3. What were the key turning points?
4. What would you do differently?
5. Was there anything about the interface — the way state, options,
   or rules were presented — that hindered you?

Q5 is deliberate: a harness-feedback channel from the player itself,
in the spirit of "models dictate their harness" — answers feed the
design-review queue, not the model.

## What the literature says a debrief is (and is not)

- **Self-reports are not ground truth.** Post-hoc explanations can
  systematically misrepresent the true causes of behavior (Turpin et
  al., "Language Models Don't Always Say What They Think",
  arXiv:2305.04388), and stated beliefs measurably diverge from
  behavior in LLM agents (belief–behavior consistency,
  arXiv:2507.02197). So the debrief is DATA ABOUT THE MODEL'S
  SELF-MODEL, analyzed against the records, never taken at face value.
- **But self-access is not zero either**: models show some privileged
  introspective access to their own dispositions (Binder et al.,
  "Looking Inward", arXiv:2410.13787) — how much a debrief adds over
  the records is itself a measurable question, not an assumption in
  either direction.
- **Self-critique artifacts have downstream value** (Reflexion,
  arXiv:2303.11366): the debrief is exactly the artifact a future
  cross-match memory ("RL for context compaction") would feed on —
  this phase we only collect it.
- **Instrument design**: fixed wording, fixed question order, no
  examples embedded in questions — LLM questionnaire responses are
  sensitive to phrasing and ordering the way human surveys are;
  holding the instrument constant is what makes debriefs comparable
  across models and games.

**Debrief-fidelity metric** (cheap, automatable, later): parse checkable
claims from the debrief (scores, key events, "I never got my Killer
out") and verify against the records — the postgame sibling of the
state-echo fidelity metric from the game-1 review.

## Implementation sketch

Reuses the existing free-text path: `client.summarize` (built for D01
compaction) IS the debrief call — no new client surface. `llmgame.ts`
makes the call after the result is known, writes
`<gameId>-debrief.json` ({instrument_version, prompt, text, usage,
latency_ms}), and the game record gets `debriefPath`. The formatter
appends a "🎤 Debrief" section to both views. Flag: `--debrief on|off`
— proposed default ON for real games (one mostly-cache-hit call, ~cents;
free data for the M5 acceptance run), mock exercises it keylessly with
canned text in CI.

## Open questions for review

1. Debrief default on — agreed?
2. Instrument wording above — any question to add/cut/rephrase before
   it becomes v1? (It is versioned; changing later forks comparability.)
3. Should the debrief prompt DISCLOSE the result ("you lost by
   flatline")? Proposal: no — the final decisions and log tail are in
   its transcript; whether it KNOWS how the game ended is itself
   informative (and game 1's model diagnosed its own killer-gap
   unprompted).
