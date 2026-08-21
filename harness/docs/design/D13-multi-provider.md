# D13 — Multi-provider models via OpenRouter

**Status: implemented** (cohort per review — final: `deepseek/deepseek-v4-flash-0731`,
`google/gemini-3.7-flash`, `openai/gpt-5.4-mini`. **qwen/qwen3.7-flash
dropped** (per Dante, shakedown finding): Alibaba rejects forced
`tool_choice` — by name or `"required"` — while thinking mode is on, and
qwen3.7-flash ships thinking-on; honoring our forced-call contract would
require disabling thinking via `reasoning:{enabled:false}`, a per-provider
decoding deviation we chose not to make. Compounding: OpenRouter's shared
Alibaba pool was upstream-quota-limited during shakedown
(`insufficient_quota`). Both findings kept here as the first live instance
of the tool-calling-dialect-drift risk below. Added in its place (per
Dante): `mistralai/mistral-small-2603` (Mistral Small 4) — $0.15/$0.60,
262K window, standard non-thinking model with confirmed tool calling;
gets a 200K threshold automatically via the mistralai prefix entry in
cli.ts (see threshold exception below). Also added (per Dante):
`meta/muse-glimmer-30b` — $0.30/$1.10, open-weight dense 30B from Meta
Superintelligence Labs (distilled from Muse Spark), standard
non-thinking, tool use supported, five providers; 131K window → 100K
threshold via its own map entry. Also added (per Dante):
`qwen/qwen3.8-27b` — $0.40/$3.00, open-weight dense 27B, 1M window
(standard 300K threshold), released 2026-08-14. Unlike the dropped
qwen3.7-flash it has toggleable thinking and seven providers (six
non-Alibaba), so forced tool_choice is expected to work; if default
routing intermittently lands on Alibaba and 400s, the contingency is
`provider: {require_parameters: true}` routing — a request-shape
change requiring sign-off before adoption. Also added (per Dante):
`minimax/minimax-m3` — $0.23/$0.96, multimodal foundation model
billed as suited for long-horizon agentic work and tool use, 1M
window (standard 300K threshold), released 2026-05-31, 12 providers.
Also added (per Dante): `xiaomi/mimo-v2.5` — $0.119/$0.238, native
omnimodal, 1M window (standard 300K threshold), released 2026-04-22,
five providers incl. Xiaomi first-party; cheapest cohort entry after
deepseek-flash. Final addition (per Dante — cohort closed here):
`tencent/hy3` — $0.126/$0.522, released 2026-07-06, six providers,
toggleable thinking defaulting to no-think (no qwen3.7-style
conflict), "stable tool-calling" claimed; 262K window → 200K
threshold via its own map entry in cli.ts.
Considered and deferred to the later medium-tier round (per Dante,
on cost): `x-ai/grok-4.3` ($1.25/$2.50, 1M, shipped-default low
reasoning effort) alongside the sonnet-class candidates
(gpt-5.6-terra $2/$12, gemini-3.1-pro-preview $2/$12,
mistral-medium-3-5 $1.50/$7.50). `deepseek/deepseek-v4-pro-0813`
($1.188/$3.564, 1M, 300K default) already ran its seed-7 shakedown
ahead of that round. Original cohort listing —
tier check: all haiku-tier or below at current prices, none sonnet-tier;
gpt-5.4-mini ($0.75/$4.50) is the closest haiku peer, gemini-3.7-flash
($0.375/$1.875) sits below it, deepseek-v4-flash ($0.07/$0.17) and
qwen3.7-flash ($0.03/$0.13) a full tier cheaper. **Discount caveat**
(as of 2026-08-21): gemini-3.7-flash's price is a 75%-off OpenRouter
promotion — list is ≈$1.50/$7.50, which is *above* gpt-5.4-mini and
sonnet-adjacent. OpenRouter runs such discounts periodically
(openrouter.ai/models?discount=true); listed prices here are snapshots
and may mix promo and list. This never corrupts the corpus:
`reportedCostUsd` is the actually-billed amount per game, discounts
included — measured beats modeled. But tier labels drawn from list
prices should be re-checked before any run whose framing depends on
them. Client in llm.ts via global fetch, no
SDK dep; usage.cost accumulated to `reportedCostUsd` on the game record;
keyless guard verified; mock ladder green. Shakedown round 1: qwen and
gpt-5.4-mini both crashed on unretried OpenRouter 429s — a transient
provider blip and the new-account 10 rpm limit respectively — exposing
that the raw-fetch client lacked the HTTP retries the Anthropic SDK does
invisibly. Fixed: bounded backoff ladder (2s→60s, honors Retry-After) for
429/5xx/network errors, surfaced as `httpRetries` on the game record and
as an incident in the CORPUS report.) · Per Dante: the benchmark's point is
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
  present — measured beats modeled. This also absorbs OpenRouter's
  periodic discounts automatically: each game's recorded cost is what
  was billed at play time, so a promo lapsing between runs changes
  future games' costs, never past records.
- Caching is whatever the underlying provider does automatically
  (OpenAI/Gemini implicit caching); we send no `cache_control`. The
  conversational transcript's stable prefix is exactly the shape
  implicit caches like; the cache_read field records how well that
  works per provider — itself a reportable difference.
- Compaction threshold: `openrouter/*` models default to 300K
  (cohort windows are 400K-1M; 300K = 75% of the smallest, and inside
  the effective-context comfort band for the 1M ones — see
  PROMPTING.md). Observed transcript sizes are each provider's own
  tokenizer units, so the threshold comparison stays like-for-like
  per provider. 150K remains the generic fallback; the floor guard is
  the safety net either way. **Exceptions** (longest-prefix
  THRESHOLD_DEFAULTS map in cli.ts; no flags needed): Mistral windows are 262K —
  below the 300K default — so `openrouter/mistralai/*` defaults to
  200K (~76% of the window, same ratio). meta/muse-glimmer-30b's
  window is 131K — smallest in the bench — so it maps to 100K (~75%).
  That sits close to the transcript floor, so expect frequent
  compaction and heavy summary reliance; `compactionsSuppressed > 0`
  in its record means the model can't fit our config at all, which is
  itself the finding, not a bug to fix. Any future cohort model with
  a window under ~400K gets its own map entry: the 300K default
  assumes the window clears it with room to spare.

## First cohort (haiku-tier)

Verified current equivalents at build time (names move fast); the
design intent is 2–3 of: OpenAI's mini tier, Google's Flash tier, and
one strong open-weight (DeepSeek/Qwen class). One game each at seed 7
is the shakedown: the Urtica trap read is the immediate
cross-provider probe, and the machinery-health pass (retry forensics
especially — every provider has its own tool-syntax quirks) is the
real acceptance test.

## Risks, named

- **Gateway flakiness**: 429s and 5xx are routine at the gateway
  (upstream provider blips, per-model rate limits — new OpenRouter
  accounts get 10 rpm on some models). The client retries these with a
  deterministic backoff ladder (2s, 5s, 10s, 20s, 40s, 60s; a
  `Retry-After` header wins when sent) and counts survivals in
  `httpRetries` — per-provider flakiness is itself reportable. Only
  after the ladder is exhausted does the game crash. Distinct from D10
  retries, which are about the *content* of a response; these are about
  getting a response at all.
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

## Parked (address later)

- **List-equivalent cost normalization**: hand-maintained discount map
  in `prices.ts` (model → promo factor + date range; currently
  gemini-3.7-flash at 0.25); CORPUS report adds a billed ÷ factor
  column with footnote for games played inside a promo window. The
  record's `reportedCostUsd` stays billed ground truth, never
  adjusted.

## Non-goals

Native reasoning/thinking modes per provider (Phase 2), per-provider
prompt tuning (never — one interface, one guide), provider-side
batching, running Claude via the gateway.
