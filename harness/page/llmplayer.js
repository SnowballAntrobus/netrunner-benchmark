/* LLMPlayer (PHASE1 M4): an LLM in a player's seat.
 *
 * Activated by &llm=runner (corp support is an increment: the code is
 * seat-agnostic; only the swap site below names a side). Requires the host
 * to expose two functions before page load:
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
 * - Option descriptions go through __harness.cardEntry (PlayerCanLook
 *   honesty) — option objects can reference facedown cards and must not
 *   leak titles.
 * - Loaded after serializer.js; plain JS, no host-framework coupling.
 */
(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);
  var llmSeat = params.get("llm"); // "runner" (only supported seat for now)
  if (llmSeat !== "runner") return;

  // ---- option serialization ----------------------------------------------

  // Fallback descriptions in official (NSG rulebook) terminology for engine
  // command names that arrive without a phase tooltip. The engine's own
  // tooltips take precedence. "n" and "jack" are engine vernacular the
  // rulebooks never use — always translated.
  var COMMAND_GLOSSARY = {
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
      return out;
    }
    // SelectChoice: parameter objects
    ["label", "button", "text", "alt"].forEach(function (k) {
      if (typeof option[k] === "string") out[k] = option[k];
    });
    if (option.card && option.card.isCard) {
      out.card = window.__harness.cardEntry(option.card, side);
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

  // ---- the decision bridge ------------------------------------------------

  function decide(decisionType, optionList) {
    window.__harness.decisions++;
    var request = {
      seat: llmSeat,
      decisionType: decisionType,
      seq: window.__harness.decisions,
      turn: window.__harness.turn,
      phase: currentPhase
        ? { identifier: currentPhase.identifier, title: currentPhase.title }
        : null,
      options: describeOptions(optionList, llmSeat),
      state: window.__harness.stateFor(llmSeat),
      reproductionCode: safeReproductionCode(),
    };
    return window
      .__harnessDecide(JSON.stringify(request))
      .then(function (responseJson) {
        var response = JSON.parse(responseJson);
        var idx = response.option;
        if (typeof idx !== "number" || idx < 0 || idx >= optionList.length) {
          window.__harness.errors.push(
            "llmplayer: host returned out-of-range option " + idx + ", using 0"
          );
          idx = 0;
        }
        return idx;
      })
      .catch(function (e) {
        window.__harness.errors.push("llmplayer: bridge failure: " + String(e));
        return 0; // keep the game alive; the incident is recorded
      });
  }

  // ---- rules-AI decision logging (opponent seat) --------------------------
  // Wrap the Corp AI's decision entry points (outermost — bootstrap's
  // counting wrap stays inside) so every rules-AI decision lands in the same
  // decision stream, with options described from the CORP's own view.

  function wrapOpponentForLogging(ai, seat) {
    if (!ai || !ai.prototype) return;
    ["CommandChoice", "SelectChoice"].forEach(function (m) {
      var orig = ai.prototype[m];
      if (typeof orig !== "function") return;
      var decisionType = m === "CommandChoice" ? "command" : "select";
      ai.prototype[m] = function (optionList) {
        var self = this;
        var described = describeOptions(optionList, seat);
        var reproductionCode = safeReproductionCode();
        var phase = currentPhase
          ? { identifier: currentPhase.identifier, title: currentPhase.title }
          : null;
        var turn = window.__harness.turn;
        var result = orig.apply(self, arguments);
        return Promise.resolve(result).then(function (idx) {
          try {
            window.__harnessLogDecision(
              JSON.stringify({
                seat: seat,
                decisionType: decisionType,
                seq: window.__harness.decisions,
                turn: turn,
                phase: phase,
                options: described,
                choice: idx,
                reproductionCode: reproductionCode,
              })
            );
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
  // time StartGame runs; swap the LLM shell in just before the first Main().

  var engineStartGame = StartGame;
  StartGame = function () {
    var shadow = runner.AI; // rules RunnerAI instance created by Init
    var shell = Object.create(shadow);
    shell.CommandChoice = function (optionList) {
      return decide("command", optionList);
    };
    shell.SelectChoice = function (optionList) {
      return decide("select", optionList);
    };
    runner.AI = shell;
    window.__rulesRunnerAI = shadow; // kept for future agreement metrics
    wrapOpponentForLogging(CorpAI, "corp");
    return engineStartGame.apply(this, arguments);
  };
})();
