# D13 — Multi-provider models via OpenRouter

**Status: awaiting review** · Per Dante: the benchmark's point is
cross-model comparison; plug in non-Anthropic providers through one
gateway (OpenRouter), starting with the haiku-tier so exploratory
games stay cheap.

## Shape

One new client behind the existing `ChoiceClient` interface — the
harness, page, records, and prompts don't change. `makeClient` routes
on the model string:

- `claude-*` → AnthropicClient (direct API, prompt caching, as today)
- `openrouter/<vendor>/<slug>` → OpenRouterClient (OpenAI-compatible
  `/chat/completions`), key from `OPENROUTER_API_KEY`
- `mock` → MockClient

The full model string (including the `openrouter/` prefix) is
recorded in every record — provenance is never ambiguous. Claude
models always run direct (first-party caching + billing), never
through the gateway.

## Decision calls

Same contract as the Anthropic client: the `choose_option` tool
(schema `{reasoning, option}`) forced via
`tool_choice: {type: "function", function: {name: "choose_option"}}`,
one round per decision, D10 retry classification unchanged (parse the
function arguments; `unparseable` / `missing-option` / `out-of-range`
all still apply — tool-call syntax leaks are exactly the kind of
per-model behavior the forensics exist to compare). `summarize`
(compaction + debrief) is a plain completion, no tools.

## Decoding policy

Provider defaults, exactly as with Anthropic — the benchmark measures
models as shipped. No temperature override, and NO `seed` parameter
even where offered (OpenAI/Gemini expose best-effort ones): using it
for some providers and not others would make within-seed variance
incomparable. Sampling knobs are a Phase-2 experiment axis.

## Usage, cost, caching

- Mapping: `prompt_tokens → tokens_in`, `completion_tokens →
  tokens_out`, `prompt_tokens_details.cached_tokens → cache_read`
  (where reported), `cache_write = 0` (not a gateway concept).
- **Cost**: requests set `usage: {include: true}`; OpenRouter returns
  the actual billed cost per call. Accumulated into a new game-record
  field `usage.reportedCostUsd` (null for Anthropic/mock). The CORPUS
  report prefers reported cost over price-table estimates whenever
  present — measured beats modeled.
- Caching is whatever the underlying provider does automatically
  (OpenAI/Gemini implicit caching); we send no `cache_control`. The
  conversational transcript's stable prefix is exactly the shape
  implicit caches like; the cache_read field records how well that
  works per provider — itself a reportable difference.
- Compaction threshold: the per-model default map extends as models
  arrive (window sizes vary widely); 150K stays the fallback, with
  the floor guard as the safety net.

## First cohort (haiku-tier)

Verified current equivalents at build time (names move fast); the
design intent is 2–3 of: OpenAI's mini tier, Google's Flash tier, and
one strong open-weight (DeepSeek/Qwen class). One game each at seed 7
is the shakedown: the Urtica trap read is the immediate
cross-provider probe, and the machinery-health pass (retry forensics
especially — every provider has its own tool-syntax quirks) is the
real acceptance test.

## Risks, named

- **Tool-calling dialect drift**: providers differ in how strictly
  they honor forced tool choice; some emit prose alongside. The D10
  ladder absorbs this (retries → forensics), but a provider that
  persistently can't produce `{reasoning, option}` fails loudly as
  fallbacks — which is a finding, not a bug.
- **Token accounting is provider-defined**: cross-provider token
  counts are not comparable (different tokenizers); dollars and
  decisions are the cross-provider units, tokens stay per-provider.
- **The interface guide mentions "the choose_option tool"** —
  neutral, works everywhere; no prompt fork needed (a per-provider
  prompt would fork comparability).

## Acceptance

- Typecheck; mock path untouched (full ladder green).
- Keyless guard: helpful error when `openrouter/` model given without
  the key.
- One live short game per cohort model: completed, 0 invalid records,
  records carry full model string + reportedCostUsd, corpus report
  ingests and renders them in the era-3 table with reported cost.
- Retry-forensics spot check on each provider's failed attempts (if
  any) — classified, not mysterious.

## Non-goals

Native reasoning/thinking modes per provider (Phase 2), per-provider
prompt tuning (never — one interface, one guide), provider-side
batching, running Claude via the gateway.
