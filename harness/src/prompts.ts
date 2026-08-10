/** System prompt for the LLM Runner (PHASE1 M4).
 *
 *  Static per game (rules digest + interface guide + both decklists), so it
 *  is sent with a prompt-cache breakpoint — ~300+ decisions per game reuse
 *  the cached prefix.
 */

export const RULES_DIGEST = `# Android: Netrunner — rules digest (NSG / System Gateway era)

You are playing the RUNNER against the CORP. The Corp installs cards facedown
and defends servers; you make runs to breach them and steal agendas.

## Winning
First to 7 agenda points wins. The Corp scores agendas by advancing them in a
remote server; you steal them by accessing them during runs. You LOSE if you
take more damage than cards in your grip (flatline). The Corp loses if it
must draw from an empty R&D.

## Your turn
You get 4 clicks. Basic actions (1 click each): gain 1 credit; draw 1 card;
install a card from your grip (paying its cost); play an event (paying its
cost); make a run; remove 1 tag (2 credits); use a card ability marked with
a click cost. At end of turn, discard down to your maximum hand size
(normally 5).

## The Corp's turn
The Corp gets 3 clicks: draw (mandatory first draw is free), gain credits,
install cards facedown into servers, play operations, advance installed
cards, purge virus counters, or trash resources if you are tagged. Cards
with advancement counters in remotes may be agendas — or traps (ambushes).

## Servers and runs
Central servers: HQ (Corp hand), R&D (Corp deck), Archives (Corp discard).
Remote servers hold installed agendas/assets, protected by ice. A run
approaches the server's OUTERMOST ice first. For each ice: if unrezzed, the
Corp may rez it (paying its cost); if rezzed, you ENCOUNTER it — use
icebreakers of the matching type (Fracter breaks Barriers, Decoder breaks
Code Gates, Killer breaks Sentries; AI breakers break anything) to boost
strength to at least the ice's strength and break subroutines, paying
credits. UNBROKEN subroutines fire: "End the run" stops you; others deal
damage, give tags, cost credits, etc. Passing all ice = breach: you access
cards (steal agendas for free; optionally pay trash costs to trash assets/
upgrades; ambush cards may hurt you when accessed). Accessing HQ = 1 random
card from Corp hand; R&D = top card(s) of Corp deck; Archives = all cards
there. You may JACK OUT (abandon the run) between ice, but not before the
first ice.

## Economy and hazards
Everything costs credits — install costs, breaker pumps, trash costs. Tags
let the Corp trash your resources and play tag-punishment cards; remove tags
when the punishment risk is real. Damage discards random cards from your
grip; at 0 cards, damage kills you. Programs consume memory (MU) — default
limit 4. Viruses accumulate counters the Corp can purge.

## Strategic basics
Pressure centrals early while remotes are unprotected; force the Corp to
spend on rezzing ice, then exploit poverty windows. An advanced card in a
remote is an agenda or a trap — weigh the Corp's identity and credits
(traps need money to matter; ambushes like Urtica Cipher punish poor
runners). Keep enough credits to break what you expect plus surprises, and
enough grip cards to survive damage. Icebreakers in play beat icebreakers
in hand; install your breaker suite before committing to expensive runs.`;

export interface PromptProfile {
  name: string;
  framing: string;
  strategyHints: boolean; // include HARNESS-authored strategic advice
  reasoningStyle: "brief" | "extended" | "scot" | "none";
}

/** Named, versioned prompt configurations. The profile (and the full
 *  rendered system prompt) is recorded per game — every authored word is
 *  an experimental variable, not a constant. Literature notes: persona
 *  framing alone shows little strategic effect (arXiv:2512.06867), but
 *  logging it keeps the comparison honest; reasoning is elicited BEFORE
 *  the option to avoid ex-post rationalization (arXiv:2508.03368). */
export const PROFILES: Record<string, Omit<PromptProfile, "reasoningStyle">> = {
  neutral: {
    name: "neutral",
    // Says NOTHING about the opponent's nature — opponent framing is a
    // test-time variable (see PROMPTING.md "Opponent framing"), and the
    // default arm is silence.
    framing:
      "You are playing Android: Netrunner as the Runner. Your objective is " +
      "to win the game.",
    strategyHints: false,
  },
  expert: {
    name: "expert",
    framing:
      "You are an expert Android: Netrunner player controlling the Runner " +
      "in a harnessed game against a rules-based Corp AI. Play to win.",
    strategyHints: true,
  },
};

export const STRATEGY_HINT_DECKLIST =
  "The Corp's decklist above tells you what ice, ambushes and agendas may\n" +
  "be hidden behind facedown cards — reason about probabilities from it.";

export const REASONING_DIRECTIVES: Record<PromptProfile["reasoningStyle"], string> = {
  brief:
    "- reasoning: one to three sentences of your strategic reasoning\n" +
    "  (concise; it is logged for analysis, not shown to the opponent).",
  extended:
    "- reasoning: think the position through thoroughly here BEFORE the\n" +
    "  option — threats, economy, information, and the main alternative\n" +
    "  lines. It is logged for analysis, not shown to the opponent.",
  scot:
    "- reasoning: FIRST predict what the Corp is likely holding and how it\n" +
    "  would respond to each of your plausible actions; THEN reason from\n" +
    "  those predictions to your choice. (Logged for analysis, not shown\n" +
    "  to the opponent.)",
  none:
    "- reasoning: may be left as an empty string.",
};

export const INTERFACE_GUIDE = `# How you play (harness interface)

Each decision you receive contains: the current game state as JSON (your
full view — hidden Corp cards appear as {"hidden": true}), the recent public
game log (with "=== turn ===" markers), and a numbered list of LEGAL
options. You MUST pick exactly one option index. The engine enumerates
legality for you — every listed option is legal; nothing else is possible.

Decision types:
- "command": top-level actions. Common commands: "gain" = click for 1
  credit; "draw" = click to draw; "install"/"play" = start installing or
  playing a card (you pick which card in a follow-up decision); "run" =
  start a run (server chosen in a follow-up); "trigger" = use a card
  ability; "remove tag"; "jack" = jack out of the run; "n" = continue /
  decline / pass priority (very common — choose it when you don't want to
  act in a response window).
- "select": choose the parameter for the action (which card, which server,
  which subroutine, etc.). Option entries carry the card/server details.

Command options that lead to a follow-up choice include a "choices" list
previewing that follow-up menu (e.g. "play" lists the events you could
currently play; "run" lists the servers). Previews are computed at the
moment the menu is shown; the follow-up decision itself is authoritative.

Multi-step actions arrive as chains: e.g. command "run" then select the
server. Your state JSON shows "run" context while a run is in progress.

Notation: card text and log lines use bracket icons: [c] = credit,
[click] = click, [sub] = subroutine, [mu] = memory unit, [trash] = trash
symbol, [recurring] = recurring credit. Three state terms not covered by
the learn-to-play guides, per the Comprehensive Rules (v26.03): "core
damage" — suffered like other damage (1 random card trashed from your
grip per point) and each core damage also reduces your maximum hand size
by 1 for the rest of the game; you are flatlined if damage exceeds cards
in grip, or at your discard step if your maximum hand size is below 0
(CR 10.4, 1.7.2b). "bad publicity" — when you initiate a run you gain 1
bad publicity credit per bad publicity the Corp has, spendable only
during that run; unspent ones are lost when the run ends (CR 10.6,
6.3.3). "link" — your link strength opposes the Corp's trace strength
when a trace attempt resolves; if trace strength exceeds link strength
the trace succeeds (CR 10.7, 10.8).

Respond ONLY via the choose_option tool. Write the "reasoning" field
FIRST, then the "option" index — your reasoning should produce the choice,
not justify it afterwards.
- option: the integer index of your choice`;

/** Appended to the interface guide in conversational mode (D01): honest
 *  mechanics disclosure only — how the model's memory works, no advice on
 *  what to do with it. */
export const CONVERSATIONAL_NOTE = `
This is a continuous conversation: your previous decisions and reasoning
remain in your context as the game proceeds. If the transcript nears the
context limit, you will be asked to write a summary for your future self,
and play continues from that summary plus your most recent exchanges
verbatim.`;

export function buildSystemPrompt(
  runnerReference: string,
  corpReference: string,
  rulesText: string = RULES_DIGEST,
  profile: PromptProfile = { ...PROFILES["neutral"]!, reasoningStyle: "brief" },
  contextMode: "conversational" | "stateless" = "conversational"
): string {
  // The digest's "Strategic basics" section is harness-authored advice;
  // strip it under hint-free profiles. Official rules text keeps its own
  // strategy content — that is part of the official-text neutrality choice.
  let rules = rulesText;
  if (!profile.strategyHints && rules === RULES_DIGEST) {
    rules = rules.split("## Strategic basics")[0]!.trimEnd();
  }
  const parts = [
    profile.framing,
    "",
    rules,
    "",
    INTERFACE_GUIDE + (contextMode === "conversational" ? CONVERSATIONAL_NOTE : ""),
    REASONING_DIRECTIVES[profile.reasoningStyle],
    "",
    "# Card reference (open decklists)",
    "",
    runnerReference,
    "",
    corpReference,
  ];
  if (profile.strategyHints) {
    parts.push("", STRATEGY_HINT_DECKLIST.replace(/\\n/g, "\n"));
  }
  return parts.join("\n");
}

export interface PageDecisionRequest {
  seat: string;
  decisionType: "command" | "select";
  seq: number;
  turn: { side: string; number: number } | null;
  phase: { identifier: string; title: string } | null;
  options: Record<string, unknown>[];
  state: Record<string, unknown>;
  reproductionCode: string | null;
  /** D05 analysis marker (select decisions only): set when the follow-up
   *  menu differs from the preview attached to the chosen command.
   *  NEVER included in the decision message — the model sees the
   *  authoritative actual menu, not this. */
  previewDivergence?: {
    command: string;
    previewed_at_seq: number;
    preview: unknown[];
  };
  /** D03: single-option decision auto-resolved at the page layer — the
   *  host logs it (no API call, no transcript entry) and answers 0. */
  forced?: boolean;
}

function decisionHeader(request: PageDecisionRequest): string {
  const turn = request.turn
    ? `${request.turn.side} turn ${request.turn.number}`
    : "setup";
  const phase = request.phase
    ? `${request.phase.identifier} (${request.phase.title})`
    : "unknown phase";
  return `Decision #${request.seq} — ${turn}, phase ${phase}, type ${request.decisionType}.`;
}

export function buildDecisionMessage(request: PageDecisionRequest): string {
  return [
    decisionHeader(request),
    "",
    "GAME STATE (your view):",
    JSON.stringify(request.state),
    "",
    "LEGAL OPTIONS:",
    ...request.options.map((o, i) => `${i}: ${JSON.stringify(o)}`),
    "",
    `Choose one option index (0-${request.options.length - 1}) via the choose_option tool.`,
  ].join("\n");
}

/** History-variant B (D01 "lean"): what a PAST decision's user turn keeps
 *  in the transcript — header + options, no state, no log tail. The
 *  decision as SENT always carries the fresh state (buildDecisionMessage);
 *  under lean, only this reduced form persists, so past board positions
 *  live in the model's own words. */
export function buildLeanDecisionMessage(request: PageDecisionRequest): string {
  return [
    decisionHeader(request),
    "",
    "LEGAL OPTIONS:",
    ...request.options.map((o, i) => `${i}: ${JSON.stringify(o)}`),
  ].join("\n");
}

/** Compaction trigger (D01): the harness supplies the trigger and the empty
 *  page; every remembered word is the model's own. */
export function buildCompactionNotice(keepTurns: number): string {
  return (
    "The transcript is approaching the context limit and will be " +
    "compacted. Write a summary of the game so far for your future self — " +
    "whatever you will want to remember to keep playing well. After " +
    "compaction, your context will be: the system prompt, this summary, " +
    `and your last ${keepTurns} decision exchanges verbatim. Reply with ` +
    "the summary text only."
  );
}
