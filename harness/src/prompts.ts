/** System prompts for the LLM seats (PHASE1 M4; Corp seat since D14).
 *
 *  Static per game (rules digest + interface guide + both decklists), so it
 *  is sent with a prompt-cache breakpoint — ~300+ decisions per game reuse
 *  the cached prefix. Every Runner-seat string is unchanged from era 3 (a
 *  Runner vs rules-Corp prompt is byte-identical); the Corp seat gets
 *  parallel texts written to the same standard, and the opponent is only
 *  ever characterized by the `expert` profile.
 */

export type Seat = "runner" | "corp";
/** Who sits across the table: the engine's rules AI, or another model. */
export type OpponentKind = "rules" | "model";

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

export const CORP_RULES_DIGEST = `# Android: Netrunner — rules digest (NSG / System Gateway era)

You are playing the CORP against the RUNNER. You install cards facedown in
servers and protect them with ice; the Runner makes runs to breach your
servers and steal agendas.

## Winning
First to 7 agenda points wins. You score agendas by advancing them in a
remote server until their advancement counters meet the agenda's
advancement requirement; the Runner steals agendas by accessing them
during runs. You also win if the Runner takes more damage than cards in
their grip (flatline). You LOSE if you must draw from an empty R&D.

## Your turn
Your turn begins with a mandatory draw, then you get 3 clicks. Basic
actions (1 click each): gain 1 credit; draw 1 card; install an agenda,
asset, upgrade or piece of ice (installing ice costs 1 credit for each ice
already protecting that server); play an operation; advance an installed
card (also costs 1 credit); trash a resource while the Runner is tagged
(also costs 2 credits); use a card ability marked with a click cost.
Purging virus counters takes all 3 clicks. At end of turn, discard down to
your maximum hand size (normally 5).

## The Runner's turn
The Runner gets 4 clicks: gain credits, draw, install programs, hardware
and resources, play events, remove tags, and make runs on your servers.

## Servers, ice and runs
Central servers: HQ (your hand), R&D (your deck), Archives (your discard
pile). Each remote server holds at most one agenda or asset, plus any
number of upgrades, behind the ice installed in front of it. A run
approaches the OUTERMOST ice first. When the Runner approaches a piece of
unrezzed ice you may rez it (paying its rez cost); rezzed ice is
encountered and its subroutines fire unless the Runner breaks them with
icebreakers. Assets and upgrades are installed facedown and may be rezzed
later (for example, as the Runner approaches the server). If the Runner
passes all ice they breach the server and access cards: they steal
agendas, may pay trash costs to trash assets and upgrades, and suffer the
effects of ambushes they access.

## Economy and hazards
Credits pay for rezzing, installing ice, advancing and operations. Tags on
the Runner let you trash their resources and power tag-punishment cards.
Each bad publicity you have gives the Runner 1 extra credit for every run.

## Strategic basics
Build a scoring remote protected by ice, and keep enough credits to rez
ice when the Runner runs. Advance agendas when the Runner cannot afford to
break into the server, or bluff with advanced ambushes. Protect HQ and R&D
enough that the Runner cannot freely access agendas from them, and use
economy assets to stay ahead on credits.`;

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

/** The profile's framing sentence for a seat. Runner vs the rules AI is
 *  exactly the profile's stored text (era-3 comparability); other seats
 *  and opponents get the same sentence with the roles swapped. */
export function framingFor(
  profile: Omit<PromptProfile, "reasoningStyle">,
  seat: Seat = "runner",
  opponent: OpponentKind = "rules"
): string {
  if (seat === "runner" && opponent === "rules") return profile.framing;
  const role = seat === "runner" ? "Runner" : "Corp";
  if (profile.name === "neutral") {
    return `You are playing Android: Netrunner as the ${role}. Your objective is to win the game.`;
  }
  const against =
    opponent === "model"
      ? "another AI model"
      : `a rules-based ${seat === "runner" ? "Corp" : "Runner"} AI`;
  return (
    `You are an expert Android: Netrunner player controlling the ${role} ` +
    `in a harnessed game against ${against}. Play to win.`
  );
}

export const STRATEGY_HINT_DECKLIST =
  "The Corp's decklist above tells you what ice, ambushes and agendas may\n" +
  "be hidden behind facedown cards — reason about probabilities from it.";

export const CORP_STRATEGY_HINT_DECKLIST =
  "The Runner's decklist above tells you which icebreakers, events and\n" +
  "economy they may draw — reason about probabilities from it.";

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
  credit; "draw" = click to draw; "install"/"play" = install or play a
  card; "run" = make a run; "trigger" = use a card ability;
  "remove tag"; "jack" = jack out of the run; "n" = continue /
  decline / pass priority (very common — choose it when you don't want to
  act in a response window).
- "select": choose the parameter for the action (which card, which server,
  which subroutine, etc.). Option entries carry the card/server details.
ACTIONS_MODE_PARAGRAPH

Your state JSON shows "run" context while a run is in progress. Ice
positions count from the server: position 0 is the INNERMOST piece; a
run encounters the outermost (highest position) first and works inward.
Advancement and other counters on facedown/hidden cards are public
information — they appear in that entry's "counters" field even when
the card itself shows as hidden.

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

/** D14: the Corp seat's interface guide — the Runner guide's structure
 *  and standards, with the Corp's commands and point of view. */
export const CORP_INTERFACE_GUIDE = `# How you play (harness interface)

Each decision you receive contains: the current game state as JSON (your
full view — hidden Runner cards appear as {"hidden": true}), the recent
public game log (with "=== turn ===" markers), and a numbered list of LEGAL
options. You MUST pick exactly one option index. The engine enumerates
legality for you — every listed option is legal; nothing else is possible.

Decision types:
- "command": top-level actions. Common commands: "gain" = click for 1
  credit; "draw" = click to draw; "install" = install a card from HQ into
  a server; "play" = play an operation; "advance" = place an advancement
  counter on an installed card; "rez" = rez a card, paying its rez cost;
  "score" = score an agenda whose advancement requirement is met;
  "trigger" = use a card ability; "trash" = trash a resource while the
  Runner is tagged; "purge" = remove all virus counters; "n" = continue /
  decline / pass priority (very common — choose it when you don't want to
  act in a response window).
- "select": choose the parameter for the action (which card, which server,
  which subroutine, etc.). Option entries carry the card/server details.
ACTIONS_MODE_PARAGRAPH

Your state JSON shows "run" context while the Runner is making a run. Ice
positions count from the server: position 0 is the INNERMOST piece; a
run encounters the outermost (highest position) first and works inward.
Your own installed and archived cards are fully visible to you even
while facedown to the Runner: "rezzed": false or "faceUp": false marks
what the Runner cannot see.LOG_PERSPECTIVE_NOTE

Notation: card text and log lines use bracket icons: [c] = credit,
[click] = click, [sub] = subroutine, [mu] = memory unit, [trash] = trash
symbol, [recurring] = recurring credit. Three state terms not covered by
the learn-to-play guides, per the Comprehensive Rules (v26.03): "core
damage" — suffered by the Runner like other damage (1 random card trashed
from their grip per point) and each core damage also reduces their
maximum hand size by 1 for the rest of the game; the Runner is flatlined
if damage exceeds cards in their grip, or at their discard step if their
maximum hand size is below 0 (CR 10.4, 1.7.2b). "bad publicity" — when
the Runner initiates a run they gain 1 bad publicity credit per bad
publicity you have, spendable only during that run (CR 10.6, 6.3.3).
"link" — the Runner's link strength opposes your trace strength when a
trace attempt resolves; if your trace strength exceeds their link
strength the trace succeeds (CR 10.7, 10.8).

Respond ONLY via the choose_option tool. Write the "reasoning" field
FIRST, then the "option" index — your reasoning should produce the choice,
not justify it afterwards.
- option: the integer index of your choice`;

/** D14: when both seats are models the page renders as the Runner (the
 *  shared log must stay Runner-honest), so the Corp is told how its own
 *  cards appear in the narration — mechanics disclosure only. */
export const CORP_SHARED_LOG_NOTE = `
The game log is written from the Runner's point of view: your own cards
appear in it as "hidden card" until they are rezzed or revealed. The
state JSON and your options always show your full view.`;

/** Appended to the interface guide in conversational mode (D01): honest
 *  mechanics disclosure only — how the model's memory works, no advice on
 *  what to do with it. */
export const CONVERSATIONAL_NOTE = `
This is a continuous conversation: your previous decisions and reasoning
remain in your context as the game proceeds. If the transcript nears the
context limit, you will be asked to write a summary for your future self,
and play continues from that summary plus your most recent exchanges
verbatim.`;

/** D09: the actions-mode paragraph of the interface guide — worded for
 *  whichever protocol the model actually faces; recorded in the saved
 *  system prompt like every authored word. */
export const ACTIONS_PARAGRAPHS = {
  compound:
    "\nCommand options that carry a subject are COMPLETE actions: choosing\n" +
    '"install" with a named card installs that card; "run" with a server\n' +
    'runs that server; "trigger" with an ability uses it. Some entries\n' +
    'also carry a "then" field showing the follow-up step they commit to\n' +
    '(e.g. play Jailbreak then run R&D) — choosing such an entry performs\n' +
    "both steps. Follow-up \"select\" decisions appear only when a further\n" +
    "choice remains (where to host, what to trash for memory, and so on).",
  split:
    "\nCommand options that lead to a follow-up choice include a \"choices\"\n" +
    "list previewing that follow-up menu (e.g. \"play\" lists the events you\n" +
    "could currently play). Previews are computed at the moment the menu\n" +
    "is shown; the follow-up decision itself is authoritative. Multi-step\n" +
    'actions arrive as chains: e.g. command "run" then select the server.',
};

export interface SystemPromptOptions {
  /** Card reference for the seat's own deck, then the opponent's. */
  ownReference: string;
  opponentReference: string;
  /** Default: the seat's digest (RULES_DIGEST / CORP_RULES_DIGEST). */
  rulesText?: string;
  profile?: PromptProfile;
  contextMode?: "conversational" | "stateless";
  actionsMode?: "compound" | "split";
  seat?: Seat;
  opponent?: OpponentKind;
  /** D14: the page narrates from the Runner's view (both seats are models)
   *  — the Corp guide then discloses how its own cards appear in the log. */
  runnerPerspectiveLog?: boolean;
}

/** D14: the Corp seat's actions-mode paragraph (same protocol, Corp verbs). */
export const CORP_ACTIONS_PARAGRAPHS = {
  compound:
    "\nCommand options that carry a subject are COMPLETE actions: choosing\n" +
    '"install" with a named card and server installs that card there ("new\n' +
    'server" creates a remote); "advance", "rez" or "score" with a named card\n' +
    'acts on that card; "trigger" with an ability uses it. Some entries also\n' +
    'carry a "then" field showing the follow-up step they commit to —\n' +
    "choosing such an entry performs both steps. Follow-up \"select\" decisions\n" +
    "appear only when a further choice remains (which card to trash, which\n" +
    "subroutine effect to apply, and so on).",
  split:
    "\nCommand options that lead to a follow-up choice include a \"choices\"\n" +
    "list previewing that follow-up menu (e.g. \"install\" lists each card\n" +
    "and server you could install it in). Previews are computed at the\n" +
    "moment the menu is shown; the follow-up decision itself is\n" +
    'authoritative. Multi-step actions arrive as chains: e.g. command\n' +
    '"advance" then select the card.',
};

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const seat = options.seat ?? "runner";
  const opponent = options.opponent ?? "rules";
  const profile = options.profile ?? { ...PROFILES["neutral"]!, reasoningStyle: "brief" };
  const contextMode = options.contextMode ?? "conversational";
  const actionsMode = options.actionsMode ?? "compound";
  const digest = seat === "runner" ? RULES_DIGEST : CORP_RULES_DIGEST;
  // The digest's "Strategic basics" section is harness-authored advice;
  // strip it under hint-free profiles. Official rules text keeps its own
  // strategy content — that is part of the official-text neutrality choice.
  let rules = options.rulesText ?? digest;
  if (!profile.strategyHints && rules === digest) {
    rules = rules.split("## Strategic basics")[0]!.trimEnd();
  }
  const guide =
    seat === "runner"
      ? INTERFACE_GUIDE.replace("ACTIONS_MODE_PARAGRAPH", ACTIONS_PARAGRAPHS[actionsMode])
      : CORP_INTERFACE_GUIDE.replace(
          "ACTIONS_MODE_PARAGRAPH",
          CORP_ACTIONS_PARAGRAPHS[actionsMode]
        ).replace("LOG_PERSPECTIVE_NOTE", options.runnerPerspectiveLog ? CORP_SHARED_LOG_NOTE : "");
  const parts = [
    framingFor(profile, seat, opponent),
    "",
    rules,
    "",
    guide + (contextMode === "conversational" ? CONVERSATIONAL_NOTE : ""),
    REASONING_DIRECTIVES[profile.reasoningStyle],
    "",
    "# Card reference (open decklists)",
    "",
    options.ownReference,
    "",
    options.opponentReference,
  ];
  if (profile.strategyHints) {
    const hint = seat === "runner" ? STRATEGY_HINT_DECKLIST : CORP_STRATEGY_HINT_DECKLIST;
    parts.push("", hint.replace(/\\n/g, "\n"));
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
  /** D09: this command menu was FUSED (options are complete actions). */
  compound?: boolean;
  /** D09: this select fulfills a prior compound choice — host records it
   *  and answers compoundChoice; no API call, no transcript entry. */
  compoundFulfilled?: boolean;
  compoundChoice?: number;
  /** D09-2: access-order select folded by the structural guard — host
   *  records it and answers 0; no API call. */
  orderFolded?: boolean;
  /** D09-2: fused menu length when at/over the alert threshold. */
  largeMenu?: number;
  /** D14: one step of a card-by-card multi-select — shown to the model. */
  multiSelect?: { slot: number; of: number; chosen: unknown[] };
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

/** D14: the multi-select step line — present only on those decisions, so
 *  every other decision message is unchanged. */
function multiSelectLine(request: PageDecisionRequest): string[] {
  const m = request.multiSelect;
  if (!m) return [];
  const chosen = m.chosen.length
    ? ` (chosen so far: ${m.chosen.map((c) => JSON.stringify(c)).join(", ")})`
    : "";
  return [
    `MULTI-SELECT, card ${m.slot} of up to ${m.of}${chosen}: this prompt ` +
      "selects several cards, one per decision. Picking a card adds it to the " +
      "selection; an option without a card (if offered) finishes the selection " +
      "with the cards chosen so far.",
    "",
  ];
}

export function buildDecisionMessage(request: PageDecisionRequest): string {
  return [
    decisionHeader(request),
    "",
    "GAME STATE (your view):",
    JSON.stringify(request.state),
    "",
    ...multiSelectLine(request),
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
    ...multiSelectLine(request),
    "LEGAL OPTIONS:",
    ...request.options.map((o, i) => `${i}: ${JSON.stringify(o)}`),
  ].join("\n");
}

/** Postgame debrief instrument (D07). Fixed, versioned wording — changing
 *  it forks comparability across games/models, so any edit bumps the
 *  version. Neutral and open-ended. Q5 is the harness-feedback channel
 *  ("models dictate their harness"): answers feed the design-review
 *  queue, never the model. Zero-contamination by construction: sent as a
 *  separate call after the game; the reply enters no transcript.
 *
 *  Rev 2 (game-3 finding): the prompt now opens with a terminal
 *  catch-up — the public log lines since the model's last API-delivered
 *  decision, exactly what the next decision message would have carried
 *  had one arrived. Without it, every event after the last real
 *  decision is invisible (auto-resolve widens this to whole terminal
 *  chains: game 3's model never saw its fatal access and reported the
 *  ending as an interface bug). The result is then stated plainly
 *  ("you won/lost (reason)") — verdict-blind debriefing is parked as a
 *  Phase-2 experiment. The model's IN-GAME epistemic state remains
 *  measurable where it always lived: the decision records. */
export const DEBRIEF_INSTRUMENT_VERSION = 2;

export function buildDebriefPrompt(
  finalEvents: string[] = [],
  result?: { won: boolean; reason: string }
): string {
  const catchUp =
    finalEvents.length > 0
      ? [
          "Since your last decision, the following events occurred:",
          "",
          ...finalEvents.map((l) => `  ${l}`),
          "",
        ]
      : [];
  const verdict = result
    ? `The game has ended: you ${result.won ? "won" : "lost"} (${result.reason}).`
    : "The game has ended.";
  return [
    ...catchUp,
    `${verdict} Please answer the following questions.`,
    "",
    "1. Summarize how the game went from your perspective.",
    "2. What was your plan, and how did it change as the game developed?",
    "3. What were the key turning points?",
    "4. What would you do differently?",
    "5. Was there anything about the interface — the way state, options,",
    "   or rules were presented — that hindered you?",
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
