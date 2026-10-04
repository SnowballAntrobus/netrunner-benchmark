/* LLMPlayer (PHASE1 M4; seat-general since D14): an LLM in a player's seat.
 *
 * Activated by &llm=runner, &llm=corp, or &llm=both (both seats LLM). The
 * code is seat-agnostic; every decision request names its seat. Requires
 * the host to expose two functions before page load:
 *   __harnessDecide(requestJson) → Promise<responseJson>   (LLM decisions)
 *   __harnessLogDecision(recordJson) → Promise<void>       (rules-AI log)
 *
 * Design notes:
 * - The engine and card scripts call ~70 rules-AI methods/fields on
 *   player.AI behind `if (player.AI != null)` guards (belief bookkeeping,
 *   cached run costs, hand valuations...). A bare object would crash the
 *   first time a card consults it. The LLMPlayer is therefore a DELEGATION
 *   SHELL: Object.create(rulesAiInstance) with only CommandChoice /
 *   SelectChoice overridden — cards get sane rules-AI bookkeeping, the
 *   engine gets LLM decisions. The shell deliberately ignores
 *   `this.preferred` hints that cards set for the rules AI.
 * - D14: card scripts ALSO branch on player.AI to decide FOR the rules AI
 *   (`//**AI code` branches) — pruning a menu to the rules AI's pick,
 *   suppressing an option entirely, or pre-filling a multi-select. For an
 *   LLM seat that silently replaces the model's choice with the rules
 *   AI's. The neutralizer below makes player.AI read as null to card code
 *   (and only card code) for LLM seats, so cards take their human-player
 *   branches and the model sees the full legal menu a human would.
 * - Option descriptions go through __harness.cardEntry (PlayerCanLook
 *   honesty) — option objects can reference facedown cards and must not
 *   leak titles.
 * - Loaded after serializer.js; plain JS, no host-framework coupling.
 */
(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);
  // "runner" | "corp" | "both" (or an explicit "corp,runner" list).
  var LLM_SEATS = (function (v) {
    if (!v) return [];
    if (v === "both") return ["corp", "runner"];
    return v.split(",").filter(function (s) {
      return s === "corp" || s === "runner";
    });
  })(params.get("llm"));
  if (LLM_SEATS.length === 0) return;

  function isLLMSeat(seat) {
    return LLM_SEATS.indexOf(seat) !== -1;
  }
  function playerOf(seat) {
    return seat === "corp" ? corp : runner;
  }

  // D03: auto-resolve single-option decisions (default ON; &autoresolve=0
  // disables — the game-1-interface comparison arm). A 1-option menu has
  // exactly one possible outcome; the request is still fully built and
  // logged (forced: true), the preview-divergence check still runs, but
  // no API call is made and nothing enters the transcript. Game-1 data:
  // 601/768 runner decisions (78%) were single-option, consuming 77% of
  // input tokens and eliciting 18 of 25 retries.
  var AUTO_RESOLVE = params.get("autoresolve") !== "0";

  // D09: compound action menus (default ON; &actions=split disables — the
  // game-1/2-interface comparison arm). Subject-taking command options are
  // expanded into complete actions using their D05 previews; the engine's
  // follow-up select is answered by the page by matching the chosen
  // subject. Mismatch falls back to a REAL select decision (and D05's
  // divergence flag fires via the usual check) — fusion can never wedge.
  var COMPOUND = params.get("actions") !== "split";
  // Per seat: {queue: [<stripped promised subjects, in order>]}
  var pendingCompound = { runner: null, corp: null };

  // D14: rules-AI branch neutralization (default ON; &aibranches=rules
  // restores the era-3 behavior, where card code saw LLM seats as rules AI).
  var NEUTRALIZE = params.get("aibranches") !== "rules";

  // D15: viewer frames on (&frames=1, set by the host). Rules-AI decisions
  // carry their board snapshot in the log record (the opponent wrapper).
  var FRAMES = params.get("frames") === "1";

  // The engine's utility.js overrides the global JSON.stringify with a
  // title-collapsing replacer (readable logs). Harness requests must keep
  // full structure — use the pristine stringify captured by harness.html
  // before the engine loaded. (Root cause of the game-1 "compact strings"
  // schema drift.)
  var stringify =
    (window.__pristineJSON && window.__pristineJSON.stringify) || JSON.stringify;

  // D05 counters (read into the game record by the host).
  window.__harness.previewChecks = 0;
  window.__harness.previewDivergences = 0;
  // D14 counters: multi-select prompts answered card-by-card, and reads of
  // player.AI that the neutralizer answered with null (card code saw a
  // human seat).
  window.__harness.multiSelects = 0;
  window.__harness.neutralizedReads = 0;

  // ---- D14: rules-AI branch neutralizer -----------------------------------
  // player.AI becomes an accessor on each LLM seat. It answers null exactly
  // when the reading code is a card script (sets/*.js) AND no rules-AI
  // deliberation (ai_corp/ai_runner/runcalculator) is on the stack:
  //   - card Enumerate/Resolve code and its callbacks (closures keep their
  //     sets/*.js source location) take their human-player branches, so
  //     menus are never pruned to the rules AI's pick;
  //   - engine code (dispatch in Main/MakeChoice, belief bookkeeping) sees
  //     the shell, so decisions still route to the LLM;
  //   - card AI-helper functions (AIWorthKeeping, ...) invoked by rules-AI
  //     deliberation see the shell — they read player.AI unguarded.
  // Golden fixtures are unaffected: the accessor exists only on LLM seats.
  var CARD_CODE = /\/sets\/[^/:]+\.js/;
  var RULES_AI_CODE = /\/(ai_corp|ai_runner|runcalculator)\.js/;
  var THIS_FILE = /\/harness\/page\/llmplayer\.js/;

  function cardCodeIsReading() {
    var savedLimit = Error.stackTraceLimit;
    try {
      // Cheap pass first: most reads come from engine code.
      Error.stackTraceLimit = 6;
      var lines = String(new Error().stack).split("\n");
      var reader = null;
      for (var i = 1; i < lines.length; i++) {
        if (!THIS_FILE.test(lines[i])) {
          reader = lines[i];
          break;
        }
      }
      if (!reader || !CARD_CODE.test(reader)) return false;
      Error.stackTraceLimit = 200;
      return !RULES_AI_CODE.test(String(new Error().stack));
    } finally {
      Error.stackTraceLimit = savedLimit;
    }
  }

  function installNeutralizer(player, shell) {
    var stored = shell;
    Object.defineProperty(player, "AI", {
      configurable: true,
      enumerable: true,
      get: function () {
        if (stored === null || stored === undefined) return stored;
        if (cardCodeIsReading()) {
          window.__harness.neutralizedReads++;
          return null;
        }
        return stored;
      },
      set: function (v) {
        stored = v;
      },
    });
  }

  // ---- option serialization ----------------------------------------------

  // Fallback descriptions in official (NSG rulebook) terminology for engine
  // command names that arrive without a phase tooltip. The engine's own
  // tooltips take precedence. "n" and "jack" are engine vernacular the
  // rulebooks never use — always translated.
  var COMMAND_GLOSSARY = {
    m: "Mulligan (shuffle your starting hand back and draw 5 new cards)",
    n: "Continue / decline (take no action in this window)",
    jack: "Jack out (voluntarily end the run)",
    gain: "Basic action: gain 1 credit",
    draw: "Basic action: draw 1 card",
    install: "Basic action: install a card from your grip",
    play: "Basic action: play an event",
    run: "Basic action: initiate a run on a server",
    trigger: "Use a card ability",
    advance: "Basic action: advance an installed card",
    rez: "Rez a card (turn it faceup, paying its rez cost)",
    score: "Score an agenda",
    trash: "Trash a card",
    discard: "Discard down to maximum hand size",
    purge: "Basic action: purge all virus counters",
    remove: "Basic action: remove 1 tag (1 click and 2 credits)",
  };

  // Multi-select options carry a `.cards` slot array (the human UI fills it
  // card by card). They need the D14 adapter and must never be fused or
  // folded: matching one card would resolve with empty slots.
  function hasCardSlots(option) {
    return !!option && Array.isArray(option.cards);
  }
  function isMultiSelectMenu(optionList) {
    for (var i = 0; i < optionList.length; i++) {
      var o = optionList[i];
      if (hasCardSlots(o) && o.cards.indexOf(null) !== -1) return true;
    }
    return false;
  }

  // D05 (generalizing D04): dry-run the exact enumeration the engine will
  // perform if a command is chosen, so every verb-level option previews
  // the follow-up menu it leads to — the #281 guard ("play" chosen blind,
  // railroaded into Overclock). Parity, not help: the engine UI shows a
  // human which cards light up as playable/installable and which servers
  // are runnable; entries are rendered by the SAME describeOption as the
  // real follow-up menu (minus index), so preview and menu are identical
  // in shape. Subjectless commands (gain, draw, ...) enumerate to bare
  // [{}] and mechanically get no preview. Read-only: these are the same
  // menu-builder calls the engine performs for human play (verified via
  // double mock-run byte comparison).
  function describeCommandChoices(cmd, side) {
    try {
      if (
        !currentPhase ||
        !currentPhase.Enumerate ||
        typeof currentPhase.Enumerate[cmd] !== "function"
      ) {
        return null;
      }
      // RNG guard: card-authored Enumerates may consume seeded randomness
      // in AI branches (found empirically: the fast-advance operation
      // Shuffles its target list when corp.AI != null — 3 draws shifted
      // the whole stream and changed the game). Dry-runs must not consume
      // the seeded stream, so Math.random is swapped for a local
      // fixed-seed LCG for the duration of the enumeration: the game
      // stream is untouched and previews stay run-to-run deterministic.
      var seededRandom = Math.random;
      var localRng = 987654321;
      Math.random = function () {
        localRng = (localRng * 48271) % 2147483647;
        return localRng / 2147483648;
      };
      var choices;
      var out = [];
      var hasContent = false;
      try {
        choices = currentPhase.Enumerate[cmd]();
        if (!choices || !choices.length) return null;
        // D14: a multi-select follow-up is answered card by card — no
        // preview, so no fusion (the follow-up arrives as a real select).
        if (isMultiSelectMenu(choices)) return null;
        for (var i = 0; i < choices.length; i++) {
          var entry = describeOption(choices[i], side, i);
          delete entry.index; // previews carry no index — not a commitment
          for (var k in entry) {
            if (Object.prototype.hasOwnProperty.call(entry, k)) hasContent = true;
          }
          // D09-2: second-level preview where the follow-up menu is
          // enumerable from a PURE card/ability Enumerate (same safety
          // class as the phase Enumerate above; still under the RNG
          // guard). Class (a): playing an event whose card carries its
          // own choice (Jailbreak's server). Class (b): triggering an
          // ability with its own parameter list (Mayfly's "which
          // subroutine"). Anything deeper, or any card whose follow-up
          // is created by resolution, still arrives as a real select.
          var subEnum = null;
          var subThis = null;
          if (choices[i].card && choices[i].card.cardType === "event" &&
              typeof choices[i].card.Enumerate === "function") {
            subEnum = choices[i].card.Enumerate;
            subThis = choices[i].card;
          } else if (choices[i].ability &&
                     typeof choices[i].ability.Enumerate === "function") {
            subEnum = choices[i].ability.Enumerate;
            subThis = choices[i].card || choices[i].ability;
          }
          if (subEnum) {
            try {
              var sub = subEnum.call(subThis);
              if (sub && sub.length && !isMultiSelectMenu(sub)) {
                var subOut = [];
                var subSeen = {};
                var subUsable = true;
                for (var s = 0; s < sub.length; s++) {
                  var subEntry = describeOption(sub[s], side, s);
                  delete subEntry.index;
                  // A second level is only fusable when every entry is
                  // visible AND distinct — hidden entries (Mutual
                  // Favor's stack search) or duplicates would make the
                  // fused choice ambiguous and first-match fulfillment
                  // would commit an ARBITRARY card. Those follow-ups
                  // stay real selects.
                  if (subEntry.card && subEntry.card.hidden) { subUsable = false; break; }
                  var key = stringify(stripEntry(subEntry));
                  if (key === "{}" || subSeen[key]) { subUsable = false; break; }
                  subSeen[key] = true;
                  subOut.push(subEntry);
                }
                if (subUsable && subOut.length) entry.choices = subOut;
              }
            } catch (e2) {
              /* second level is best-effort — omit on any failure */
            }
          }
          out.push(entry);
        }
      } finally {
        Math.random = seededRandom;
      }
      if (!hasContent) return null; // subjectless — nothing to preview
      return out;
    } catch (e) {
      return null; // enrichment must never break a decision
    }
  }

  // ---- preview-divergence tracking (D05) ----------------------------------
  // A preview is computed at command-decision time; the eventual follow-up
  // menu could in rare cases differ (e.g. a response window between the two
  // steps changing affordability). Every followed preview is compared
  // against the actual follow-up menu; mismatches are flagged on the select
  // decision's record for analysis. The MODEL is never shown the marker —
  // it sees the (authoritative) actual menu anyway.

  var pendingPreview = { runner: null, corp: null }; // per-seat {command, preview, seq}

  function stripIndex(described) {
    return described.map(function (o) {
      var copy = {};
      for (var k in o) {
        if (Object.prototype.hasOwnProperty.call(o, k) && k !== "index") copy[k] = o[k];
      }
      return copy;
    });
  }

  // On a select decision: compare the pending preview (if any) with the
  // actual menu; always clears pending. On any other decision type the
  // stale preview is dropped.
  function checkPreviewDivergence(seat, decisionType, described) {
    var pending = pendingPreview[seat];
    pendingPreview[seat] = null;
    if (!pending || decisionType !== "select") return null;
    window.__harness.previewChecks++;
    // Compare with nested second-level previews stripped from both sides —
    // actual select menus never carry a .choices field (D09-2).
    if (
      stringify(stripIndex(described).map(stripEntry)) ===
      stringify(pending.preview.map(stripEntry))
    ) return null;
    window.__harness.previewDivergences++;
    return {
      command: pending.command,
      previewed_at_seq: pending.seq,
      preview: pending.preview,
    };
  }

  // After a command decision resolves: if the chosen option carried a
  // preview, remember it for comparison against the next select.
  function notePreviewFromChoice(seat, decisionType, described, idx, seq) {
    if (decisionType !== "command") return;
    var chosen = described[idx];
    if (chosen && chosen.choices) {
      pendingPreview[seat] = { command: chosen.command, preview: chosen.choices, seq: seq };
    }
  }

  // D14: with both seats LLM the page renders as the Runner (viewingPlayer
  // = runner keeps the shared log and labels Runner-honest), so engine
  // labels name the Corp's own unseen-by-Runner cards "hidden card". Where
  // the deciding seat CAN see the option's card, restore its title — never
  // a leak (the title is the seat's own knowledge), only a clearer label.
  var HIDDEN_LABEL = "hidden card";
  function seatLabel(label, option, side) {
    if (
      typeof label === "string" &&
      label.indexOf(HIDDEN_LABEL) === 0 &&
      option.card && option.card.isCard &&
      (PlayerCanLook(playerOf(side), option.card) || ownDeckCard(option.card, side))
    ) {
      return option.card.title + label.slice(HIDDEN_LABEL.length);
    }
    return label;
  }

  // D14: a menu entry naming a card in the deciding seat's OWN deck (stack
  // or R&D) is a search — the seat looks at its deck to choose. Before D14
  // the rules-AI branch made these picks; with the branch neutralized the
  // model must see what it is choosing between. Opponent decks never.
  function ownDeckCard(card, side) {
    try {
      return side === "runner"
        ? runner.stack.indexOf(card) !== -1
        : corp.RnD.cards.indexOf(card) !== -1;
    } catch (e) {
      return false;
    }
  }

  function describeOption(option, side, index) {
    var out = { index: index };
    if (typeof option === "string") {
      // CommandChoice: engine command names ("gain", "run", "n", ...)
      out.command = option;
      if (currentPhase && currentPhase.text && currentPhase.text[option]) {
        out.description = String(currentPhase.text[option]);
      } else if (COMMAND_GLOSSARY[option]) {
        out.description = COMMAND_GLOSSARY[option];
      }
      var choices = describeCommandChoices(option, side);
      if (choices) out.choices = choices;
      return out;
    }
    // SelectChoice: parameter objects
    ["label", "button", "text", "alt"].forEach(function (k) {
      if (typeof option[k] === "string") out[k] = option[k];
    });
    if (out.label) out.label = seatLabel(out.label, option, side);
    if (option.card && option.card.isCard) {
      out.card = window.__harness.cardEntry(option.card, side, ownDeckCard(option.card, side));
      // D14: a menu entry must not name a card its entry says is hidden.
      // The engine unmasks breach access-order labels for a human Runner
      // (ChoicesAccess: "don't hide the name") — every card about to be
      // accessed was named before its access. Found by the option-menu
      // invariant; in era-3 records such menus were all auto-resolved or
      // folded, so no model ever saw one.
      if (out.card && out.card.hidden && option.card.title) {
        var title = String(option.card.title);
        ["label", "button", "text", "alt"].forEach(function (k) {
          if (typeof out[k] === "string" && out[k].indexOf(title) !== -1) {
            out[k] = out[k].split(title).join(HIDDEN_LABEL);
          }
        });
      }
    }
    if (option.server) {
      try { out.server = ServerName(option.server); } catch (e) { /* not a server */ }
    }
    if (option.host && option.host.isCard) {
      out.host = window.__harness.cardEntry(option.host, side);
    }
    return out;
  }

  function describeOptions(optionList, side) {
    var out = [];
    for (var i = 0; i < optionList.length; i++) {
      out.push(describeOption(optionList[i], side, i));
    }
    return out;
  }

  function safeReproductionCode() {
    try {
      return ReproductionCode();
    } catch (e) {
      return null;
    }
  }

  // ---- compound fusing (D09) ----------------------------------------------

  function stripEntry(o) {
    var copy = {};
    for (var k in o) {
      if (Object.prototype.hasOwnProperty.call(o, k) && k !== "index" && k !== "choices") copy[k] = o[k];
    }
    return copy;
  }

  // Fuse a described command menu: each preview choice becomes a complete
  // action entry; preview-less options pass through. D09-2: a preview
  // choice that itself carries a second-level preview (nested .choices)
  // cross-products into entries with a `then` field — choosing one
  // commits both steps, fulfilled in order. Returns
  // {options, map: fusedIdx -> {verbIndex, subjects: [...]|null}}.
  function fuseCommandMenu(described) {
    var options = [];
    var map = [];
    function pushFused(o, subj, sub) {
      var entry = { index: options.length, command: o.command };
      if (o.description) entry.description = o.description;
      for (var k in subj) {
        if (Object.prototype.hasOwnProperty.call(subj, k) && k !== "choices") entry[k] = subj[k];
      }
      var subjects = [stripEntry(subj)];
      if (sub) {
        entry.then = stripEntry(sub);
        subjects.push(stripEntry(sub));
      }
      options.push(entry);
      map.push({ verbIndex: o.index, subjects: subjects });
    }
    for (var i = 0; i < described.length; i++) {
      var o = described[i];
      if (o.choices && o.choices.length) {
        for (var j = 0; j < o.choices.length; j++) {
          var subj = o.choices[j];
          if (subj.choices && subj.choices.length) {
            for (var j2 = 0; j2 < subj.choices.length; j2++) {
              pushFused(o, subj, subj.choices[j2]);
            }
          } else {
            pushFused(o, subj, null);
          }
        }
      } else {
        var plain = {};
        for (var k2 in o) {
          if (Object.prototype.hasOwnProperty.call(o, k2)) plain[k2] = o[k2];
        }
        plain.index = options.length;
        options.push(plain);
        map.push({ verbIndex: o.index, subjects: null });
      }
    }
    return { options: options, map: map };
  }

  // Find the actual select option matching the promised subject (same
  // equality as the divergence check). Identical duplicates (two copies of
  // a card) match the first — semantically the same choice.
  function matchSubject(described, subject) {
    var want = stringify(subject);
    for (var i = 0; i < described.length; i++) {
      if (stringify(stripEntry(described[i])) === want) return i;
    }
    return -1;
  }

  // ---- the decision bridge ------------------------------------------------

  // `extra.multiSelect` (D14): this select is one step of a card-by-card
  // multi-select — {slot, of, chosen} — shown to the model in the decision
  // message; such steps are never fused, fulfilled, or folded.
  function decide(seat, decisionType, optionList, extra) {
    window.__harness.decisions++;
    var multiStep = extra && extra.multiSelect ? extra.multiSelect : null;
    var described = describeOptions(optionList, seat);
    if (multiStep) {
      // Dynamic button captions ("Trash 2 from R&D") track the selection.
      for (var b = 0; b < optionList.length; b++) {
        var dyn = optionList[b].multiSelectDynamicButtonText;
        if (typeof dyn === "function") {
          try { described[b].button = String(dyn(multiStep.chosen.length)); } catch (e0) { /* keep static */ }
        }
      }
    }
    var divergence = checkPreviewDivergence(seat, decisionType, described);

    // D09 select fulfillment: a compound choice promised subject(s) — a
    // queue since D09-2 (two-level fusion). Match the head; on success
    // consume it and keep any remainder for the NEXT select; on mismatch
    // flush the whole queue and fall through to a real ask.
    var compoundChoice = -1;
    if (COMPOUND && decisionType === "select" && pendingCompound[seat] && !multiStep) {
      compoundChoice = matchSubject(described, pendingCompound[seat].queue[0]);
      if (compoundChoice >= 0) {
        pendingCompound[seat].queue.shift();
        if (pendingCompound[seat].queue.length === 0) pendingCompound[seat] = null;
      } else {
        pendingCompound[seat] = null;
      }
    }

    // D09-2 class (c): access-order folds. During breach, "which card to
    // access next" is strategically null UNLESS a steal trigger could
    // alter the rest of the sequence — pool-audited guard: fold only
    // when the accessed server's root holds no unrezzed installed card
    // (see design/D09-2-deeper-fusion.md for the audit). Answered with
    // option 0 host-side; full record, no API call. Runner seat only —
    // breach access order is the Runner's decision.
    var orderFolded = false;
    if (
      COMPOUND &&
      seat === "runner" &&
      decisionType === "select" &&
      !multiStep &&
      compoundChoice < 0 &&
      !pendingCompound[seat] &&
      described.length > 1 &&
      currentPhase &&
      /^Run 5/.test(currentPhase.identifier || "")
    ) {
      var allCards = true;
      for (var ci = 0; ci < described.length; ci++) {
        if (!described[ci].card || described[ci].button || described[ci].ability ||
            hasCardSlots(optionList[ci])) {
          allCards = false;
          break;
        }
      }
      var rootSafe = false;
      try {
        rootSafe =
          typeof attackedServer !== "undefined" &&
          attackedServer &&
          Array.isArray(attackedServer.root) &&
          !attackedServer.root.some(function (c) { return !c.rezzed; });
      } catch (e) {
        rootSafe = false;
      }
      orderFolded = allCards && rootSafe;
    }

    // D09 command fusing: the model sees complete actions.
    var fused = null;
    if (COMPOUND && decisionType === "command") {
      fused = fuseCommandMenu(described);
    }
    var modelOptions = fused ? fused.options : described;
    var request = {
      seat: seat,
      decisionType: decisionType,
      logIndex: typeof capturedLog !== "undefined" ? capturedLog.length : null,
      seq: window.__harness.decisions,
      turn: window.__harness.turn,
      phase: currentPhase
        ? { identifier: currentPhase.identifier, title: currentPhase.title }
        : null,
      options: modelOptions,
      state: window.__harness.stateFor(seat),
      reproductionCode: safeReproductionCode(),
    };
    // Analysis marker only — buildDecisionMessage never includes it, so
    // the model never sees it (it sees the authoritative actual menu).
    if (divergence) request.previewDivergence = divergence;
    if (fused) request.compound = true;
    if (multiStep) request.multiSelect = multiStep;
    // D09-2: unbounded cross-products by review decision — but large
    // menus are alerted for post-hoc inspection.
    if (fused && fused.options.length >= 40) request.largeMenu = fused.options.length;
    var seq = request.seq;
    // D14: no-cheating invariant at LLM decisions (&invariant=1 only).
    if (typeof window.__harness.invariantAtLLMDecision === "function") {
      window.__harness.invariantAtLLMDecision(seat, stringify(modelOptions));
    }
    // D09: fulfilled select — host records it and answers the matched
    // index; no API call, no transcript entry.
    if (compoundChoice >= 0) {
      request.compoundFulfilled = true;
      request.compoundChoice = compoundChoice;
    } else if (orderFolded) {
      // D09-2 class (c): host records the fold and answers option 0.
      request.orderFolded = true;
    }
    // D03: decisions with a single choice for the MODEL short-circuit at
    // the host (logged as forced, no API call). Under compound the model's
    // menu is the fused one — a lone verb with several subjects is a REAL
    // choice, so the forced test uses the model-visible length.
    else if (AUTO_RESOLVE && modelOptions.length === 1) {
      request.forced = true;
    }
    return window
      .__harnessDecide(stringify(request))
      .then(function (responseJson) {
        var response = JSON.parse(responseJson);
        if (response.abort) {
          // Host declared the API unusable: freeze the game loop rather
          // than play on with meaningless fallback choices.
          pauseFaceoff = true;
          window.__harness.errors.push("llmplayer: host aborted (API failure)");
          return 0;
        }
        var idx = response.option;
        var limit = fused ? fused.options.length : optionList.length;
        if (typeof idx !== "number" || idx < 0 || idx >= limit) {
          window.__harness.errors.push(
            "llmplayer: host returned out-of-range option " + idx + ", using 0"
          );
          idx = 0;
        }
        if (fused) {
          var m = fused.map[idx];
          if (m.subjects) pendingCompound[seat] = { queue: m.subjects.slice() };
          notePreviewFromChoice(seat, decisionType, described, m.verbIndex, seq);
          return m.verbIndex;
        }
        notePreviewFromChoice(seat, decisionType, described, idx, seq);
        return idx;
      })
      .catch(function (e) {
        window.__harness.errors.push("llmplayer: bridge failure: " + String(e));
        notePreviewFromChoice(seat, decisionType, described, 0, seq);
        return 0; // keep the game alive; the incident is recorded
      });
  }

  // ---- D14: multi-select adapter -------------------------------------------
  // Some selects ask for several cards at once ("trash 2 cards from your
  // grip", "shuffle up to 3 cards from Archives", sabotage). Each option
  // carries a `.cards` slot array that the human UI fills one click at a
  // time: a click writes the card into the first empty slot of every
  // same-length multi-selector, filling the LAST slot resolves with the
  // clicked card's option, and a button option (often gated by
  // multiSelectDynamicButtonEnabler) resolves early with what is filled.
  // The rules AIs instead pre-fill slots from `preferred` hints, which the
  // shell ignores — so without this adapter an LLM seat resolved such
  // prompts with EMPTY slots. Here the model answers the same protocol
  // one card per decision; each step is an ordinary logged select.
  function multiSelect(seat, optionList) {
    window.__harness.multiSelects++;
    pendingCompound[seat] = null; // fused promises never target multi-selects
    var slots = 0;
    for (var i = 0; i < optionList.length; i++) {
      if (hasCardSlots(optionList[i]) && optionList[i].cards.length > slots) {
        slots = optionList[i].cards.length;
      }
    }
    var chosen = []; // engine card objects, in slot order

    function step() {
      var entries = []; // {kind: "slot"|"single"|"button", index}
      for (var i = 0; i < optionList.length; i++) {
        var o = optionList[i];
        var isCard = !!(o.card && o.card.isCard);
        if (isCard && hasCardSlots(o)) {
          if (chosen.indexOf(o.card) === -1) entries.push({ kind: "slot", index: i });
        } else if (isCard) {
          // A plain card option fires immediately in the UI.
          entries.push({ kind: "single", index: i });
        } else {
          var enabled = true;
          if (typeof o.multiSelectDynamicButtonEnabler === "function") {
            try { enabled = !!o.multiSelectDynamicButtonEnabler(chosen.length); } catch (e) { enabled = true; }
          }
          if (enabled) entries.push({ kind: "button", index: i });
        }
      }
      if (entries.length === 0) {
        window.__harness.errors.push("llmplayer: multi-select with no selectable entry");
        return Promise.resolve(0);
      }
      var subList = entries.map(function (e) { return optionList[e.index]; });
      var info = {
        slot: chosen.length + 1,
        of: slots,
        chosen: chosen.map(function (c) {
          return window.__harness.cardEntry(c, seat, ownDeckCard(c, seat));
        }),
      };
      return decide(seat, "select", subList, { multiSelect: info }).then(function (k) {
        var e = entries[k] || entries[0];
        if (e.kind !== "slot") return e.index;
        var card = optionList[e.index].card;
        var slotIndex = chosen.length;
        for (var j = 0; j < optionList.length; j++) {
          var cards = optionList[j].cards;
          if (Array.isArray(cards) && cards.length === slots) cards[slotIndex] = card;
        }
        chosen.push(card);
        if (chosen.length >= slots) return e.index; // last slot filled
        return step();
      });
    }
    return step();
  }

  // ---- rules-AI decision logging (opponent seat) --------------------------
  // Wrap the rules AI's decision entry points (outermost — bootstrap's
  // counting wrap stays inside) so every rules-AI decision lands in the same
  // decision stream, with options described from that seat's own view.

  function wrapOpponentForLogging(ai, seat) {
    if (!ai || !ai.prototype) return;
    ["CommandChoice", "SelectChoice"].forEach(function (m) {
      var orig = ai.prototype[m];
      if (typeof orig !== "function") return;
      var decisionType = m === "CommandChoice" ? "command" : "select";
      ai.prototype[m] = function (optionList) {
        var self = this;
        var described = describeOptions(optionList, seat);
        // Same divergence tracking as the LLM seat — the opponent stream is
        // host-side analysis data, and preview drift is equally worth
        // surfacing there.
        var divergence = checkPreviewDivergence(seat, decisionType, described);
        var reproductionCode = safeReproductionCode();
        var phase = currentPhase
          ? { identifier: currentPhase.identifier, title: currentPhase.title }
          : null;
        var turn = window.__harness.turn;
        var result = orig.apply(self, arguments);
        // Read AFTER orig ran: bootstrap's inner counting wrap increments
        // the decision counter synchronously at call time.
        var seq = window.__harness.decisions;
        return Promise.resolve(result).then(function (idx) {
          notePreviewFromChoice(seat, decisionType, described, idx, seq);
          try {
            var logged = {
              seat: seat,
              decisionType: decisionType,
              logIndex: typeof capturedLog !== "undefined" ? capturedLog.length : null,
              seq: seq,
              turn: turn,
              phase: phase,
              options: described,
              choice: idx,
              reproductionCode: reproductionCode,
            };
            if (divergence) logged.previewDivergence = divergence;
            // D15: the viewer's board for this decision, taken NOW — the
            // log call below does not pause the game, so a snapshot taken
            // later by the host would show a board that has moved on.
            if (FRAMES && typeof window.__harness.snapshot === "function") {
              try {
                logged.frame = window.__harness.snapshot(seq, logged.logIndex);
              } catch (e) {
                /* a missing frame must never cost the decision record */
              }
            }
            window.__harnessLogDecision(stringify(logged));
          } catch (e) {
            /* logging must never break the game */
          }
          return idx;
        });
      };
    });
  }

  // ---- seat swap ----------------------------------------------------------
  // Init() (faceoff mode) has already put rules AIs in both seats by the
  // time StartGame runs; swap the LLM shell(s) in just before the first
  // Main().

  function makeShell(seat) {
    var player = playerOf(seat);
    var shadow = player.AI; // rules AI instance created by Init
    var shell = Object.create(shadow);
    shell.CommandChoice = function (optionList) {
      return decide(seat, "command", optionList);
    };
    shell.SelectChoice = function (optionList) {
      if (isMultiSelectMenu(optionList)) return multiSelect(seat, optionList);
      return decide(seat, "select", optionList);
    };
    window.__rulesAI = window.__rulesAI || {};
    window.__rulesAI[seat] = shadow; // kept for future agreement metrics
    if (NEUTRALIZE) installNeutralizer(player, shell);
    else player.AI = shell;
  }

  var engineStartGame = StartGame;
  StartGame = function () {
    LLM_SEATS.forEach(makeShell);
    if (!isLLMSeat("corp")) wrapOpponentForLogging(CorpAI, "corp");
    if (!isLLMSeat("runner")) wrapOpponentForLogging(RunnerAI, "runner");
    return engineStartGame.apply(this, arguments);
  };
})();
