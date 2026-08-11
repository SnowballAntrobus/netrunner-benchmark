/* Replay viewer (D08): the game as a sequence of still lifes on the real
 * board, with the model's mind alongside.
 *
 * Boot: inspect.html loads the graphical engine with NO ai/faceoff params —
 * the engine idles at Corp Mulligan awaiting a human who never acts. Once
 * booted, this script locks interactions, fetches the game's records, and
 * per step performs the engine's own rewind recipe (delete all cards, eval
 * the record's reproduction_code, recreate renderers, render).
 *
 * Assets: the repo ships no card art; the static server serves solid
 * placeholders for engine textures, and card FACES are canvas-generated
 * here with real titles/types/stats from cardSet — title-text cards read
 * better in review than art anyway. Omniscient mode (default) renders
 * facedown cards with their generated face plus a FACEDOWN/UNREZZED
 * banner; player view renders engine-style backs.
 *
 * Engine quarantine: page-level only — globals rebound, no engine edits.
 * NOTE: not strict mode — the RC eval writes engine globals.
 */
(function () {
  var params = new URLSearchParams(window.location.search);
  var srcPath = params.get("src");
  var gamePath = params.get("game");
  if (!srcPath) {
    document.getElementById("replay-title").textContent =
      "Missing ?src=<decision log .jsonl> parameter.";
    return;
  }
  var startSeq = params.get("seq") ? parseInt(params.get("seq"), 10) : null;

  var parse = (window.__pristineJSON && window.__pristineJSON.parse) || JSON.parse;

  // Neutralize BOTH AIs before the boot game starts: with no live AI and
  // interactions locked, the engine idles at the first mulligan forever —
  // the neutral canvas the still lifes paint over. (Without this, the
  // default seat config leaves the runner rules-AI live and PLAYING the
  // boot game under the replay.)
  var engineStartGame = StartGame;
  StartGame = function () {
    runner.AI = null;
    corp.AI = null;
    return engineStartGame.apply(this, arguments);
  };

  // ---- state ---------------------------------------------------------------
  window.__replayErrors = []; // per-step board-rebuild failures (walk check)
  var steps = []; // decision + compaction records in file order, + result step
  var gameRecord = null;
  var debrief = null;
  var current = 0;
  var lastBoardSeq = null; // seq of the record whose RC is on the board
  var omniscient = true;
  var booted = false;

  // ---- canvas card faces ---------------------------------------------------

  var TYPE_COLORS = {
    identity: "#4a3b6b", agenda: "#8a6d1a", ice: "#155e63", asset: "#3d4b5c",
    upgrade: "#54455c", operation: "#274b73", event: "#7a3030",
    program: "#2e6b46", hardware: "#7a5230", resource: "#6b5b3b",
  };

  function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
    var words = String(text).split(" ");
    var line = "";
    var lines = 0;
    for (var i = 0; i < words.length; i++) {
      var test = line + (line ? " " : "") + words[i];
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x, y);
        y += lineHeight;
        lines++;
        if (lines >= maxLines - 1) {
          ctx.fillText(words.slice(i).join(" ").slice(0, 18) + "…", x, y);
          return y + lineHeight;
        }
        line = words[i];
      } else {
        line = test;
      }
    }
    ctx.fillText(line, x, y);
    return y + lineHeight;
  }

  function cardFaceCanvas(card, banner) {
    var def = cardSet[card.cardId] || card;
    var c = document.createElement("canvas");
    c.width = 300; c.height = 418;
    var ctx = c.getContext("2d");
    ctx.fillStyle = TYPE_COLORS[card.cardType] || "#444";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, c.width - 6, c.height - 6);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 34px sans-serif";
    var y = wrapText(ctx, card.title || "?", 16, 52, c.width - 32, 40, 3);
    ctx.font = "26px sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    var typeLine = (card.cardType || "").toUpperCase();
    if (card.subTypes && card.subTypes.length) typeLine += " · " + card.subTypes.join(" ");
    y = wrapText(ctx, typeLine, 16, y + 14, c.width - 32, 30, 2);
    ctx.font = "24px sans-serif";
    var stats = [];
    if (typeof def.playCost !== "undefined") stats.push("cost " + def.playCost);
    if (typeof def.installCost !== "undefined") stats.push("cost " + def.installCost);
    if (typeof def.rezCost !== "undefined") stats.push("rez " + def.rezCost);
    if (typeof card.strength !== "undefined" && card.strength !== null) stats.push("str " + card.strength);
    if (typeof def.advancementRequirement !== "undefined") stats.push("adv " + def.advancementRequirement);
    if (typeof def.agendaPoints !== "undefined") stats.push("pts " + def.agendaPoints);
    if (typeof def.trashCost !== "undefined") stats.push("trash " + def.trashCost);
    wrapText(ctx, stats.join("  "), 16, y + 12, c.width - 32, 28, 2);
    if (banner) {
      ctx.fillStyle = "rgba(120,20,20,0.85)";
      ctx.fillRect(0, c.height - 64, c.width, 44);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 28px sans-serif";
      ctx.fillText(banner, 16, c.height - 32);
    }
    return c;
  }

  function backCanvas(side) {
    var c = document.createElement("canvas");
    c.width = 300; c.height = 418;
    var ctx = c.getContext("2d");
    ctx.fillStyle = side === "corp" ? "#1e3a5f" : "#7f1d1d";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = "bold 40px sans-serif";
    ctx.fillText(side === "corp" ? "CORP" : "RUNNER", 60, 220);
    return c;
  }

  // Texture cache: faces are pure functions of (title, banner, strength) —
  // regenerating canvases per step made full-game walks take minutes.
  var faceTexCache = {};
  // Real-art mode: true iff the image pack is extracted at the repo root.
  // Probed once at boot — the server answers /images/ requests with an
  // X-Harness-Placeholder header when it had to substitute a solid PNG.
  var useRealArt = false;
  function probeRealArt(done) {
    // Probe a STATIC pack file (credit.png ships in the pack and the engine
    // always requests it) — probing a card's imageFile raced engine setup:
    // identityCard is undefined until Setup() runs, so the probe silently
    // resolved to canvas mode every time.
    fetch("images/credit.png")
      .then(function (r) {
        useRealArt = r.ok && !r.headers.get("x-harness-placeholder");
        done();
      })
      .catch(function () { done(); });
  }

  // ---- board layout, corner labels, corp-hand hover ------------------------
  var PANEL_W = 410; // #replay-panel width + border
  var hoverWired = false;

  // Shrink the canvas' DISPLAYED size so the side panel never covers the
  // board (the engine sizes canvas + stage from window.innerWidth on every
  // field apply, so this must be re-asserted after each rebuild).
  function applyLayout() {
    if (typeof cardRenderer === "undefined" || !cardRenderer || !cardRenderer.app) return;
    var v = cardRenderer.app.view;
    var availW = Math.max(400, window.innerWidth - PANEL_W);
    var scale = Math.min(1, availW / window.innerWidth);
    v.style.width = Math.floor(window.innerWidth * scale) + "px";
    v.style.height = Math.floor(window.innerHeight * scale) + "px";
    if (!hoverWired) { wireHover(v); hoverWired = true; }
  }
  window.addEventListener("resize", function () {
    setTimeout(function () { applyLayout(); updateBoardLabels(); }, 50);
  });

  function cssScale() {
    var v = cardRenderer.app.view;
    return v.clientWidth ? v.clientWidth / v.width : 1;
  }

  // Small text labels under the engine's corner counters (credits/clicks/
  // hand/MU/tags) — anchored to each counter's rendered position, so they
  // survive layout scaling and hideWhenZero visibility.
  function updateBoardLabels() {
    var host = document.getElementById("board-labels");
    if (!host) return;
    host.innerHTML = "";
    if (typeof countersUI === "undefined" || typeof cardRenderer === "undefined" || !cardRenderer.app) return;
    var s = cssScale();
    var defs = [
      [countersUI.credits && countersUI.credits.corp, "credits"],
      [countersUI.click && countersUI.click.corp, "clicks"],
      [countersUI.hand_size && countersUI.hand_size.corp, "hand/max"],
      [countersUI.bad_publicity && countersUI.bad_publicity.corp, "bad pub"],
      [countersUI.credits && countersUI.credits.runner, "credits"],
      [countersUI.click && countersUI.click.runner, "clicks"],
      [countersUI.hand_size && countersUI.hand_size.runner, "grip/max"],
      [countersUI.mu && countersUI.mu.runner, "MU"],
      [countersUI.tag && countersUI.tag.runner, "tags"],
    ];
    // Collect anchor points first, then lay out with a two-lane collision
    // dodge: adjacent counters sit closer than a label's width, so
    // overlapping labels drop to a second row instead of mashing together.
    var anchors = [];
    for (var i = 0; i < defs.length; i++) {
      var c = defs[i][0];
      if (!c || !c.richText || !c.richText.visible || !c.sprite || !c.sprite.visible) continue;
      var b;
      try { b = c.richText.getBounds(); } catch (e) { continue; }
      if (!b || (b.width === 0 && b.height === 0)) continue;
      anchors.push({ x: (b.x + b.width / 2) * s, y: (b.y + b.height) * s, text: defs[i][1] });
    }
    anchors.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    var lanes = []; // per lane: rightmost occupied x
    for (var k = 0; k < anchors.length; k++) {
      var a = anchors[k];
      var w = a.text.length * 5.5 + 6; // ~9px font estimate
      var lane = 0;
      while (lanes[lane] !== undefined && a.x - w / 2 < lanes[lane] + 4 &&
             Math.abs((lanes[lane + "_y"] || a.y) - a.y) < 22) lane++;
      lanes[lane] = a.x + w / 2;
      lanes[lane + "_y"] = a.y;
      var el = document.createElement("div");
      el.className = "board-label";
      el.textContent = a.text;
      el.style.left = a.x + "px";
      el.style.top = a.y + 1 + lane * 11 + "px";
      host.appendChild(el);
    }
  }

  // Hover tooltip for corp hand cards (omniscient only): the fanned cards
  // at the top are small and rotated — hit-test their rendered bounds and
  // name them without zooming.
  function wireHover(view) {
    var tip = document.getElementById("board-tip");
    if (!tip) return;
    view.addEventListener("mousemove", function (e) {
      if (!omniscient || typeof corp === "undefined" || !corp.HQ) {
        tip.style.display = "none";
        return;
      }
      var s = cssScale();
      var rect = view.getBoundingClientRect();
      var px = (e.clientX - rect.left) / s;
      var py = (e.clientY - rect.top) / s;
      var hit = null;
      for (var i = 0; i < corp.HQ.cards.length; i++) {
        var card = corp.HQ.cards[i];
        var r = card.renderer;
        if (!r || !r.sprite) continue;
        var b;
        try { b = r.sprite.getBounds(); } catch (err) { continue; }
        if (px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height) hit = card;
      }
      if (hit) {
        tip.textContent =
          hit.title +
          (hit.cardType ? " · " + hit.cardType : "") +
          (typeof hit.rezCost !== "undefined" ? " · rez " + hit.rezCost : "") +
          (typeof hit.playCost !== "undefined" ? " · cost " + hit.playCost : "");
        tip.style.display = "block";
        tip.style.left = e.clientX + 14 + "px";
        tip.style.top = e.clientY + 14 + "px";
      } else {
        tip.style.display = "none";
      }
    });
    view.addEventListener("mouseleave", function () { tip.style.display = "none"; });
  }
  function faceTexture(card, banner) {
    var key = (card.title || "?") + "|" + (banner || "") + "|" + (card.strength != null ? card.strength : "");
    if (!faceTexCache[key]) {
      faceTexCache[key] = PIXI.Texture.fromCanvas(cardFaceCanvas(card, banner));
    }
    return faceTexCache[key];
  }

  var backTexCache = {};
  function backTextures(side) {
    if (!backTexCache[side]) {
      var tex = PIXI.Texture.fromCanvas(backCanvas(side));
      backTexCache[side] = { back: tex, known: tex };
    }
    return backTexCache[side];
  }

  // ---- board rebuild (the engine's rewind recipe, minus Main) --------------

  function destroyRenderer(card) {
    if (card && card.renderer) {
      try { card.renderer.Destroy(); } catch (e) { /* already gone */ }
      delete card.renderer;
    }
  }

  // Counters we create per rebuild. The engine Counter adds its sprite,
  // richText AND a stage-attached glowSprite; the engine's own cleanup
  // path misses the glow (fine for one rewind, a 435-sprite/step leak for
  // a 600-step walk — found by stage census). Full destruction, and only
  // counters with value > 0 (a defined-but-zero prop renders nothing).
  var myCounters = [];
  function destroyMyCounters() {
    // Sweep EVERY card-attached counter — the RC eval itself creates them
    // (InstanceCard makes one per counter prop, glow included), not just
    // our recreate pass. Global UI counters (address = corp/runner) stay.
    var doomed = myCounters.slice();
    for (var s = 0; s < cardRenderer.counters.length; s++) {
      var c = cardRenderer.counters[s];
      if (c && c.address && c.address.isCard && doomed.indexOf(c) === -1) doomed.push(c);
    }
    for (var i = 0; i < doomed.length; i++) {
      var ctr = doomed[i];
      try { ctr.sprite.destroy(); } catch (e) { /* gone */ }
      try { ctr.richText.destroy(); } catch (e) { /* gone */ }
      try { ctr.glowSprite.destroy(); } catch (e) { /* gone */ }
      var at = cardRenderer.counters.indexOf(ctr);
      if (at > -1) cardRenderer.counters.splice(at, 1);
    }
    myCounters = [];
  }

  function recreateRenderers() {
    var all = AllCards(null);
    if (corp.identityCard) all = all.concat([corp.identityCard]);
    if (runner.identityCard) all = all.concat([runner.identityCard]);
    for (var i = 0; i < all.length; i++) {
      var card = all[i];
      destroyRenderer(card);
      var side = card.player == corp ? "corp" : "runner";
      var isUp = IsFaceUp(card);
      var banner = null;
      if (!isUp) banner = card.cardType === "ice" ? "UNREZZED" : "FACEDOWN";
      var front, backs;
      // Real card art when the image pack is present (probed at boot via
      // the server's placeholder header); canvas faces otherwise. Facedown
      // cards ALWAYS use the canvas title face — in omniscient mode the
      // banner+title schematic keeps hidden-state legible at a glance, and
      // compositing banners over async-loading art isn't worth it.
      var artFront =
        useRealArt && typeof card.imageFile !== "undefined"
          ? cardRenderer.LoadTexture("images/" + ChangeImageFileToJPG(card.imageFile))
          : null;
      if (omniscient) {
        front = artFront || faceTexture(card, null);
        backs = { back: faceTexture(card, banner || "FACEDOWN"), known: backTextures(side).known };
      } else {
        front = artFront || faceTexture(card, null);
        backs = backTextures(side);
      }
      var costTexture = null;
      if (card.player == runner) costTexture = strengthTextures.rc;
      else if (card.cardType == "ice" || card.cardType == "asset" || card.cardType == "upgrade")
        costTexture = strengthTextures.crc;
      var strengthInfo = { texture: null, num: 0, ice: false, cost: costTexture };
      if (typeof card.strength !== "undefined" && card.strength !== null) {
        if (card.cardType == "ice")
          strengthInfo = { texture: strengthTextures.ice, num: card.strength, ice: true, brokenTexture: strengthTextures.broken, cost: costTexture };
        if (card.cardType == "program")
          strengthInfo = { texture: strengthTextures.ib, num: card.strength, ice: false, cost: costTexture };
      }
      card.renderer = cardRenderer.CreateCard(card, front, backs, glowTextures, strengthInfo);
      for (var j = 0; j < counterList.length; j++) {
        if (typeof card[counterList[j]] === "number" && card[counterList[j]] > 0) {
          myCounters.push(
            cardRenderer.CreateCounter(countersUI[counterList[j]].texture, card, counterList[j], 1, true)
          );
        }
      }
    }
  }

  function rebuildBoard(code) {
    // run-context globals: a still life has no live run
    attackedServer = null;
    approachIce = -1;
    encountering = false;
    encounteredIce = null;
    movement = false;
    accessingCard = null;
    accessedCards = { root: [], cards: [] };
    try { cardRenderer.UpdateGlow(null, 0); } catch (e) { /* fine */ }
    var all = AllCards(null);
    for (var i = 0; i < all.length; i++) {
      if (all[i] === corp.identityCard || all[i] === runner.identityCard) continue;
      if (all[i].cardLocation) RemoveFromGame(all[i]);
      destroyRenderer(all[i]);
    }
    removedFromGame = [];
    // CorpTestField PUSHES remotes without clearing — without this reset
    // the server list grows with empty zombies every step and the RC's
    // corp.remoteServers[i] references miss.
    corp.remoteServers = [];
    corp.serverIncrementer = 0;
    // Identities: CorpTestField touches the OLD identity's renderer with no
    // null check (decks.js:256), so their renderers must survive the eval;
    // the replaced identities are cleaned up afterwards.
    var oldCorpId = corp.identityCard;
    var oldRunnerId = runner.identityCard;
    var savedLog = logDisabled;
    logDisabled = true;
    try {
      eval(code); // the engine's own rewind mechanism (init.js)
    } finally {
      logDisabled = savedLog;
    }
    if (oldCorpId && oldCorpId !== corp.identityCard) destroyRenderer(oldCorpId);
    if (oldRunnerId && oldRunnerId !== runner.identityCard) destroyRenderer(oldRunnerId);
    // Sweep BEFORE recreate and BEFORE the engine's UpdateCounters cleanup
    // path can splice-and-leak: this catches the counters the eval itself
    // created (InstanceCard makes one per counter prop, glow included).
    destroyMyCounters();
    recreateRenderers();
    try { UpdateCounters(); } catch (e) { /* renderer quirk — nonfatal */ }
    Render();
    ApplyToAllCards(function (card) {
      if (card.renderer && card.renderer.destinationPosition) {
        card.renderer.sprite.x = card.renderer.destinationPosition.x;
        card.renderer.sprite.y = card.renderer.destinationPosition.y;
      }
    });
  }

  // ---- panel rendering -----------------------------------------------------

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function optionLabel(o) {
    if (!o || typeof o !== "object") return String(o);
    var card = o.card && typeof o.card === "object" ? o.card : {};
    var primary = o.command || o.label || o.button || card.title ||
      (card.hidden ? "(hidden card)" : null) || o.text || ("option " + o.index);
    var bits = [primary];
    if (o.server && !o.label) bits.push("→ " + o.server);
    if (o.description && primary !== o.description) bits.push("— " + o.description);
    return bits.join(" ");
  }

  function renderPanel(step) {
    var body = document.getElementById("replay-body");
    body.innerHTML = "";
    if (step.kind === "result") {
      body.appendChild(el("div", "rp-head", "Game over — " +
        (gameRecord ? gameRecord.winner + " wins: " + gameRecord.reason : "?")));
      if (gameRecord) {
        body.appendChild(el("div", "rp-dim",
          "AP " + gameRecord.corpAgendaPoints + "–" + gameRecord.runnerAgendaPoints +
          " (corp–runner) · " + gameRecord.llmDecisions + " API / " +
          gameRecord.forcedDecisions + " forced decisions · " +
          gameRecord.compactions + " compactions · " +
          gameRecord.previewDivergences + " preview divergences"));
      }
      if (debrief) {
        body.appendChild(el("div", "rp-head", "🎤 Debrief (instrument v" + debrief.instrument_version + ")"));
        body.appendChild(el("div", "rp-reason", debrief.text));
      }
      return;
    }
    var r = step.rec;
    if (r.record_type === "compaction") {
      body.appendChild(el("div", "rp-head", "🗜️ Compaction #" + r.compaction_id));
      body.appendChild(el("div", "rp-dim",
        "before seq " + r.seq_before + " · ~" + r.transcript_tokens_before +
        " tokens → summary + " + r.kept_turns + " exchanges kept (" +
        r.dropped_turns + " dropped)"));
      body.appendChild(el("div", "rp-compact", r.summary));
      body.appendChild(el("div", "rp-dim", "The board is unchanged — this is the model's memory being rewritten."));
      return;
    }
    var head = "#" + r.seq + " · " +
      (r.turn ? r.turn.side + " turn " + r.turn.number : "setup") + " · " +
      (r.phase ? (r.phase.identifier || r.phase.title) : "?") + " · " +
      r.seat + " " + r.decision_type;
    body.appendChild(el("div", "rp-head", head));
    var badges = el("div");
    if (r.forced) badges.appendChild(el("span", "rp-badge forced", "forced — no API call"));
    if (r.seat === "corp") badges.appendChild(el("span", "rp-badge", "rules AI"));
    if (r.retries) badges.appendChild(el("span", "rp-badge warn", r.retries + " retries"));
    if (r.fallback) badges.appendChild(el("span", "rp-badge warn", "FALLBACK"));
    if (r.preview_divergence) badges.appendChild(el("span", "rp-badge warn", "⚠️ preview divergence (" + r.preview_divergence.command + " @#" + r.preview_divergence.previewed_at_seq + ")"));
    if (r.transcript_tokens) badges.appendChild(el("span", "rp-badge", "ctx " + Math.round(r.transcript_tokens / 1000) + "K"));
    body.appendChild(badges);

    var opts = el("div", "rp-section");
    for (var i = 0; i < (r.options || []).length; i++) {
      var o = r.options[i];
      var d = el("div", "rp-opt" + (i === r.choice ? " chosen" : ""),
        (i === r.choice ? "✔ " : "") + i + ": " + optionLabel(o));
      if (o.choices && o.choices.length) {
        d.appendChild(el("div", "rp-choices", "→ " + o.choices.map(optionLabel).join(" | ")));
      }
      opts.appendChild(d);
    }
    body.appendChild(opts);

    if (r.reasoning) {
      body.appendChild(el("div", "rp-reason", r.reasoning));
    } else if (r.forced) {
      body.appendChild(el("div", "rp-dim", "Auto-resolved: single legal option; the model was not consulted."));
    }

    // run context the board can't show (from the record's own state)
    var st = r.state || {};
    if (st.run) {
      var run = st.run;
      var runLine = "RUN on " + run.server +
        (run.approachIcePosition >= 0 ? " · approaching ice position " + run.approachIcePosition : "") +
        (run.encounteredIce && run.encounteredIce.title ? " · encountering " + run.encounteredIce.title : "") +
        (run.accessingCard ? " · accessing " + (run.accessingCard.title || "a hidden card") : "");
      var rc = el("div", "rp-section");
      rc.appendChild(el("span", "rp-badge warn", runLine));
      body.appendChild(rc);
    }
    if (st.log && st.log.length) {
      var lg = el("div", "rp-section rp-dim");
      lg.appendChild(el("div", "rp-head", "Log tail"));
      st.log.slice(-6).forEach(function (line) { lg.appendChild(el("div", null, line)); });
      body.appendChild(lg);
    }
  }

  function renderStep(i) {
    current = Math.max(0, Math.min(i, steps.length - 1));
    var step = steps[current];
    // board: latest RC at or before this step
    var rcStep = null;
    for (var k = current; k >= 0; k--) {
      var s = steps[k];
      if (s.rec && s.rec.record_type !== "compaction" && s.rec.reproduction_code) { rcStep = s; break; }
    }
    if (rcStep && rcStep.rec.seq !== lastBoardSeq) {
      try {
        rebuildBoard(rcStep.rec.reproduction_code);
        lastBoardSeq = rcStep.rec.seq;
      } catch (e) {
        // A bad snapshot must not kill the walk — record and continue;
        // the panel still shows the decision.
        window.__replayErrors.push("seq " + rcStep.rec.seq + ": " + String(e).slice(0, 200));
        lastBoardSeq = rcStep.rec.seq;
      }
    }
    renderPanel(step);
    var slider = document.getElementById("replay-slider");
    slider.value = String(current);
    document.getElementById("rp-pos").textContent =
      "step " + (current + 1) + " / " + steps.length +
      (rcStep ? " · board @ seq " + rcStep.rec.seq : "");
    applyLayout();
    updateBoardLabels();
    window.__inspectReady = true;
  }
  window.__replayGoto = renderStep; // CLI / headless driving
  window.__replayStepCount = function () { return steps.length; };

  // ---- boot ----------------------------------------------------------------

  function lockEngine() {
    // View-only: neutralize interaction entry points (page-level rebinding).
    window.ResolveChoice = function () {};
    window.ExecuteCommand = function () {};
    window.MakeChoice = function () {};
  }

  function buildTurnJump() {
    var sel = document.getElementById("rp-turn");
    sel.appendChild(el("option", null, "Jump to turn…"));
    var seen = {};
    steps.forEach(function (s, i) {
      var t = s.rec && s.rec.turn;
      if (!t) return;
      var key = t.side + t.number;
      if (!seen[key]) {
        seen[key] = true;
        var o = el("option", null, t.side + " " + t.number);
        o.value = String(i);
        sel.appendChild(o);
      }
    });
    sel.addEventListener("change", function () {
      if (sel.value !== "") renderStep(parseInt(sel.value, 10));
    });
  }

  var skipAuto = true;
  // Skip-walk (review mode): step over records the model never saw as real
  // decisions — D03 forced and D09 compound-fulfilled. The slider and
  // jump-to-turn still reach every step; only Prev/Next/arrows skip.
  function isAutoResolved(step) {
    var r = step.rec;
    return !!r && r.record_type !== "compaction" &&
      (r.forced === true || r.compound_fulfilled === true);
  }
  function move(dir) {
    var i = current + dir;
    while (skipAuto && i > 0 && i < steps.length - 1 && isAutoResolved(steps[i])) i += dir;
    renderStep(i);
  }

  function wireControls() {
    document.getElementById("rp-prev").addEventListener("click", function () { move(-1); });
    document.getElementById("rp-next").addEventListener("click", function () { move(1); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft") move(-1);
      if (e.key === "ArrowRight") move(1);
    });
    document.getElementById("rp-skip").addEventListener("change", function (e) {
      skipAuto = e.target.checked;
    });
    var slider = document.getElementById("replay-slider");
    slider.max = String(steps.length - 1);
    slider.addEventListener("input", function () { renderStep(parseInt(slider.value, 10)); });
    document.getElementById("rp-omni").addEventListener("change", function (e) {
      omniscient = e.target.checked;
      lastBoardSeq = null; // force board rebuild in the new mode
      renderStep(current);
    });
    buildTurnJump();
  }

  function start() {
    var fetches = [
      fetch(srcPath).then(function (r) { return r.text(); }),
      gamePath ? fetch(gamePath).then(function (r) { return r.json(); }).catch(function () { return null; }) : Promise.resolve(null),
    ];
    Promise.all(fetches).then(function (results) {
      var lines = results[0].split("\n").filter(function (l) { return l.trim() !== ""; });
      steps = lines.map(function (l) { return { rec: parse(l) }; });
      gameRecord = results[1];
      steps.push({ kind: "result" });
      var debriefPath = srcPath.replace(/\.jsonl$/, "-debrief.json");
      fetch(debriefPath).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { debrief = d; })
        .catch(function () {});
      document.getElementById("replay-title").textContent =
        (gameRecord ? gameRecord.model + " · seed " + gameRecord.seed + " · " +
          gameRecord.winner + " wins (" + gameRecord.reason + ")" : srcPath);
      wireControls();
      var startIndex = 0;
      if (startSeq != null) {
        for (var i = 0; i < steps.length; i++) {
          if (steps[i].rec && steps[i].rec.seq === startSeq &&
              steps[i].rec.record_type !== "compaction") { startIndex = i; break; }
        }
      }
      probeRealArt(function () { renderStep(startIndex); });
    }).catch(function (e) {
      document.getElementById("replay-title").textContent = "Failed to load: " + e;
    });
  }

  // Wait for the engine to finish booting (StartGame fires once textures
  // resolve; the human-corp mulligan then idles). Poll for readiness.
  var bootPoll = setInterval(function () {
    if (typeof cardRenderer !== "undefined" && cardRenderer &&
        typeof currentPhase !== "undefined" && currentPhase && !booted) {
      booted = true;
      clearInterval(bootPoll);
      lockEngine();
      $("#loading").hide();
      start();
    }
  }, 200);
})();
