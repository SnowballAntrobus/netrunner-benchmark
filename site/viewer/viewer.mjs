// Netrunner Benchmark — board viewer (D15).
//
// Sources (URL params):
//   ?game=<url>   a game bundle written by `cli.ts site` / `cli.ts replay`
//   ?live=1       the live SSE stream of a running `llm-game --live`
// Deep links: #step=<index> (or #seq=<decision seq>).

import {
  GameBuilder,
  cardDictionary,
  frameCardIds,
  isAutoStep,
  isModelStep,
  metaFromRecord,
  narration,
} from "./model.mjs";

const $ = (sel, root = document) => root.querySelector(sel);
const params = new URLSearchParams(location.search);

const state = {
  game: null,
  idx: 0,
  persp: "omni",
  skipAuto: true,
  showAI: false,
  playing: false,
  timer: null,
  live: false,
  following: true,
  showAllOpts: false,
};

// ---------------------------------------------------------------- helpers

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

const ICONS = {
  credit: "c", click: "⏵", subroutine: "↳", trash: "✕", mu: "MU", "recurring-credit": "↺c",
  link: "⛓", interrupt: "!", anarch: "A", criminal: "C", shaper: "S",
};
const NAMED_ICON = /\[(credit|click|subroutine|trash|mu|recurring-credit|link|interrupt|anarch|criminal|shaper|haas-bioroid|jinteki|nbn|weyland-consortium)\]/g;

/** NetrunnerDB card text → safe HTML (only <strong>/<em> survive). */
function cardTextHtml(text) {
  let s = esc(text || "");
  s = s.replace(/&lt;(\/?)(strong|em|b|i)&gt;/g, "<$1$2>");
  s = s.replace(/\n/g, "<br>");
  s = s.replace(NAMED_ICON, (_, k) => `<span class="ic">${esc(ICONS[k] ?? k[0].toUpperCase())}</span>`);
  // The harness's own bracket notation ([c], [click]) in labels and logs.
  s = s.replace(/\[c\]/g, '<span class="ic">c</span>').replace(/\[sub\]/g, '<span class="ic">↳</span>');
  return s;
}

/** Model-written prose (memos, debriefs): escape, then honor the little
 *  markdown models use — **bold**, # headings, and bullet lines. */
function proseHtml(text) {
  return esc(text || "")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/^#{1,4}\s*(.+)$/gm, "<strong>$1</strong>")
    .replace(/^\s*[-*]\s+/gm, "• ");
}

function inlineIcons(text) {
  return cardTextHtml(text).replace(/<br>/g, " ");
}

const TYPE_ABBR = {
  identity: "ID", agenda: "Agenda", asset: "Asset", upgrade: "Upgrade", operation: "Op", ice: "Ice",
  event: "Event", program: "Program", hardware: "Hardware", resource: "Resource",
};

function info(id) {
  return (state.game && state.game.cards[id]) || { t: `#${id}`, ty: "?", f: "neutral" };
}

function seatOf(side) {
  const m = state.game.meta.seats || {};
  return m[side] ? m[side].model : null;
}

function seatChip(side, withSeat = false) {
  const model = seatOf(side);
  const chip = el("span", `seat-chip ${side}`);
  chip.appendChild(el("span", "dot"));
  const who = model ? model : "rules AI";
  chip.appendChild(document.createTextNode(withSeat ? `${side === "corp" ? "Corp" : "Runner"} · ${who}` : who));
  chip.title = model ? `${side} played by ${model}` : `${side} played by the engine's rules AI`;
  return chip;
}

// ------------------------------------------------------------ visibility

/** Can the current perspective see this card's face? */
function canSee(ref) {
  if (state.persp === "omni") return true;
  return state.persp === "runner" ? (ref.v & 1) === 1 : (ref.v & 2) === 2;
}

// ------------------------------------------------------------- card tiles

let prevSig = new Map(); // u → signature in the previously shown frame

function signature(ref, zone) {
  return `${zone}|${ref.rz ? 1 : 0}|${ref.fu ? 1 : 0}|${JSON.stringify(ref.ct || {})}|${ref.str ?? ""}|${(ref.h || []).length}`;
}

/** Every card of a frame keyed by instance id → signature, with the same
 *  zone names the renderer uses (so a move between zones also glows). */
function sigMapOf(frame) {
  const map = new Map();
  const visit = (ref, zone) => {
    if (!ref) return;
    map.set(ref.u, signature(ref, zone));
    (ref.h || []).forEach((h) => visit(h, `${zone}>h`));
  };
  const piles = (o, pairs) => pairs.forEach(([k, zone]) => (o[k] || []).forEach((ref) => visit(ref, zone)));
  visit(frame.c.id, "c-id");
  piles(frame.c, [["sc", "c-sc"], ["hq", "c-hq"], ["rs", "c-rs"], ["ar", "c-ar"]]);
  frame.sv.forEach((sv, i) => {
    sv.ice.forEach((ref) => visit(ref, `ice:${i}`));
    sv.root.forEach((ref) => visit(ref, `root:${i}`));
  });
  visit(frame.r.id, "r-id");
  piles(frame.r, [["prog", "r-prog"], ["hw", "r-hw"], ["res", "r-res"], ["sc", "r-sc"], ["grip", "r-grip"], ["heap", "r-heap"], ["rs", "r-rs"], ["aside", "r-aside"]]);
  (frame.rfg || []).forEach((ref) => visit(ref, "rfg"));
  return map;
}

function cardEl(ref, zone, opts = {}) {
  const ci = info(ref.id);
  const ice = ci.ty === "ice" && zone.startsWith("ice");
  const visible = canSee(ref);
  const side = ci.s === "corp" || zone.startsWith("c-") ? "corp-card" : "runner-card";
  const card = el("div", `card ${ice ? "ice" : ""} ${side}`);
  if (opts.highlightChanges !== false && prevSig.size && prevSig.get(ref.u) !== signature(ref, zone)) {
    card.classList.add("changed");
  }
  if (!visible || opts.forceBack) {
    card.classList.add("back");
    const glyph = el("div", "glyph", ci.s === "corp" || zone === "c-rd" ? "CORP" : "RUNNER");
    card.appendChild(glyph);
  } else {
    card.classList.add(`f-${ci.f}`);
    let tl = ci.ty === "identity" ? "Identity" : TYPE_ABBR[ci.ty] || ci.ty;
    if (ci.st && ci.ty !== "identity") tl += ` · ${ci.st.split(" - ")[0]}`;
    card.appendChild(el("div", "ty", tl));
    const nm = el("div", "nm", ci.t);
    // Hyphenation dictionaries aren't everywhere (headless Chromium): size
    // the title so its longest word fits the text box instead of splitting.
    const mini = /^(c-id|c-sc|c-hq|c-rs|r-id|r-sc|r-grip|r-heap|r-rs|r-aside)$/.test(zone) || zone.includes(">h");
    const size = fitTitle(ci.t, (mini ? 42 : 60) + (ice ? 26 : 0), mini ? 9 : 10.5);
    nm.style.fontSize = `${size}px`;
    // Words too long even at the floor size break with a visible hyphen
    // (soft hyphens) rather than at an arbitrary letter.
    if (size <= 7) nm.textContent = ci.t.replace(/[^\s-]{10,}/g, (w) => w.slice(0, 3) + w.slice(3, -3).split("").join("\u00ad") + "\u00ad" + w.slice(-3));
    card.appendChild(nm);
    const cost = ci.ty === "agenda" ? (ci.adv !== undefined ? `${ci.adv}/${ci.ap}` : null) : ci.c;
    if (cost !== null && cost !== undefined) card.appendChild(el("div", "cost", String(cost)));
    if (ref.str !== undefined || (ci.str !== undefined && (ci.ty === "ice" || ci.ty === "program"))) {
      const cur = ref.str ?? ci.str;
      const s = el("div", "strn", String(cur));
      if (ref.str !== undefined && ci.str !== undefined && ref.str !== ci.str) s.classList.add(ref.str > ci.str ? "up" : "down");
      card.appendChild(s);
    }
    // Omniscient: mark installed cards the OPPONENT cannot see.
    if (state.persp === "omni" && opts.installed) {
      const opponentSees = ci.s === "corp" ? (ref.v & 1) === 1 : (ref.v & 2) === 2;
      if (!opponentSees) {
        card.classList.add("unseen");
        card.appendChild(el("div", "tag", ci.ty === "ice" ? "UNREZZED" : "FACEDOWN"));
      }
    }
    if (ref.sub && ref.sub.length) {
      const subs = el("div", "subs");
      ref.sub.forEach((b) => subs.appendChild(el("i", b ? "broken" : "")));
      card.appendChild(subs);
    }
  }
  if (ref.ct) {
    const ctrs = el("div", "ctrs");
    for (const [k, n] of Object.entries(ref.ct)) {
      // Advancement is public even on facedown cards; other counters only
      // when the face is visible.
      if (!visible && k !== "adv") continue;
      ctrs.appendChild(el("span", `ctr ${k}`, `${n}${{ adv: "▲", cr: "c", vir: "v", pow: "p", ag: "a" }[k] ?? ""}`));
    }
    card.appendChild(ctrs);
  }
  if (opts.extraClass) card.classList.add(opts.extraClass);
  card.dataset.id = String(ref.id);
  card.dataset.visible = visible ? "1" : "0";
  card._ref = ref;
  card._zone = zone;
  if (ref.h && ref.h.length) {
    const wrap = el("div", "with-hosted");
    wrap.appendChild(card);
    const hosted = el("div", "hosted");
    ref.h.forEach((h) => hosted.appendChild(cardEl(h, `${zone}>h`, { installed: opts.installed })));
    wrap.appendChild(hosted);
    return wrap;
  }
  return card;
}

const measureCtx = document.createElement("canvas").getContext("2d");
const fitCache = new Map();
/** Largest font size (≤ max, ≥ 6.5px) at which the title's longest word
 *  fits `width` pixels in the card title font. */
function fitTitle(title, width, max) {
  const key = `${title}|${width}|${max}`;
  if (fitCache.has(key)) return fitCache.get(key);
  // Canvas font parsing is stricter than CSS (no weight 650, fragile with
  // long family lists) — keep this in step with .card .nm in viewer.css.
  measureCtx.font = `700 ${max}px system-ui, sans-serif`;
  let widest = 0;
  for (const word of title.split(/\s+/)) widest = Math.max(widest, measureCtx.measureText(word).width);
  const usable = width * 0.94;
  const size = widest > usable ? Math.max(7, Math.floor((max * usable / widest) * 10) / 10) : max;
  fitCache.set(key, size);
  return size;
}

function pileEl(label, refs, zone, opts = {}) {
  const z = el("div", "zone");
  const head = el("div", "zone-label");
  head.innerHTML = `${esc(label)} <em>${opts.total ?? (refs ? refs.length : 0)}</em>`;
  z.appendChild(head);
  const row = el("div", "cards");
  if (!refs || refs.length === 0) {
    row.classList.add("empty");
    row.appendChild(el("span", "empty-note", opts.emptyText || "empty"));
  } else {
    refs.forEach((r) => row.appendChild(cardEl(r, zone, opts)));
  }
  z.appendChild(row);
  return z;
}

function stat(label, value, cls) {
  const s = el("span", `stat ${cls || ""}`);
  s.appendChild(el("b", null, String(value)));
  s.appendChild(el("span", null, label));
  return s;
}

function clicksStat(n, of) {
  const s = el("span", "stat");
  const c = el("span", "clicks");
  for (let i = 0; i < Math.max(of, n); i++) c.appendChild(el("i", i < n ? "on" : ""));
  s.appendChild(c);
  s.appendChild(el("span", null, "clicks"));
  return s;
}

// ------------------------------------------------------------- the board

function renderBoard() {
  const g = state.game;
  const step = g.steps[state.idx];
  const frame = g.frames[step ? step.fr : 0];
  const corpSide = $("#corp-side");
  const runnerSide = $("#runner-side");
  corpSide.replaceChildren();
  runnerSide.replaceChildren();
  if (!frame) {
    corpSide.appendChild(el("p", "note", "No board snapshot for this step."));
    return;
  }
  // Previously shown board, for change highlighting.
  const prevStep = state.prevIdx !== undefined ? g.steps[state.prevIdx] : null;
  const prevFrame = prevStep ? g.frames[prevStep.fr] : null;
  prevSig = prevFrame && prevFrame !== frame ? sigMapOf(prevFrame) : new Map();

  const run = frame.run;
  const c = frame.c;
  const r = frame.r;

  // ---- Corp
  const ch = el("div", "side-head");
  ch.appendChild(el("span", "side-name", "Corp"));
  ch.appendChild(seatChip("corp"));
  const cst = el("div", "stats");
  cst.appendChild(stat("credits", c.cr));
  cst.appendChild(clicksStat(c.ck, 3));
  cst.appendChild(stat("agenda pts", c.pts, "ap"));
  cst.appendChild(stat("in HQ", c.hq.length));
  cst.appendChild(stat("in R&D", c.rd));
  if (c.bp) cst.appendChild(stat("bad pub", c.bp, "alert"));
  ch.appendChild(cst);
  corpSide.appendChild(ch);

  const ctop = el("div", "zone-row mini");
  const idz = el("div", "zone");
  idz.appendChild(el("div", "zone-label", "Identity"));
  const idc = el("div", "cards");
  if (c.id) idc.appendChild(cardEl(c.id, "c-id"));
  idz.appendChild(idc);
  ctop.appendChild(idz);
  ctop.appendChild(pileEl("Score area", c.sc, "c-sc", { emptyText: "no agendas" }));
  ctop.appendChild(pileEl("HQ (hand)", c.hq, "c-hq"));
  if (c.rs && c.rs.length) ctop.appendChild(pileEl("Resolving", c.rs, "c-rs"));
  corpSide.appendChild(ctop);

  const servers = el("div", "servers");
  frame.sv.forEach((sv, i) => {
    const s = el("div", "server");
    if (run && run.s === i) s.classList.add("attacked");
    const ice = el("div", "ice-stack");
    // Outermost ice on top: engine order is innermost first.
    for (let k = sv.ice.length - 1; k >= 0; k--) {
      const ref = sv.ice[k];
      const approached = run && run.s === i && run.i === k;
      ice.appendChild(cardEl(ref, `ice:${i}`, { installed: true, extraClass: approached ? "approached" : null }));
    }
    s.appendChild(ice);
    const root = el("div", "root");
    sv.root.forEach((ref) => {
      const accessing = run && run.acc && run.acc.u === ref.u;
      root.appendChild(cardEl(ref, `root:${i}`, { installed: true, extraClass: accessing ? "accessing" : null }));
    });
    if (i === 1) {
      // R&D: the deck itself (omniscient shows the top card).
      const p = el("div", "pile");
      if (state.persp === "omni" && c.rdTop && c.rdTop[0]) p.appendChild(cardEl(c.rdTop[0], "c-rdtop", { highlightChanges: false }));
      else p.appendChild(cardEl({ id: 0, u: -1, v: 0 }, "c-rd", { highlightChanges: false, forceBack: true }));
      p.appendChild(el("span", "count", state.persp === "omni" && c.rdTop && c.rdTop[0] ? `top card · ${c.rd} in R&D` : `${c.rd} in R&D`));
      root.appendChild(p);
    }
    if (i === 2) {
      const p = el("div", "pile");
      const ar = c.ar || [];
      const top = ar[ar.length - 1];
      if (top) p.appendChild(cardEl(top, "c-ar", { highlightChanges: false }));
      p.appendChild(el("span", "count", `${ar.length} in Archives`));
      root.appendChild(p);
    }
    if (!root.children.length) root.classList.add("empty");
    s.appendChild(root);
    s.appendChild(el("div", "server-name", sv.n));
    servers.appendChild(s);
  });
  corpSide.appendChild(servers);

  // ---- run bar
  const runbar = $("#runbar");
  if (run && frame.sv[run.s]) {
    runbar.hidden = false;
    const sv = frame.sv[run.s];
    let where = "";
    if (run.acc) {
      const ci = info(run.acc.id);
      where = ` · accessing <b>${esc(canSee(run.acc) ? ci.t : "a card")}</b>`;
    } else if (run.i >= 0) where = ` · at ice position ${run.i} of ${sv.ice.length}`;
    else where = " · at the server";
    runbar.innerHTML = `⚡ Run on <b>${esc(sv.n)}</b>${where}`;
  } else {
    runbar.hidden = true;
  }

  // ---- Runner
  const rh = el("div", "side-head");
  rh.appendChild(el("span", "side-name", "Runner"));
  rh.appendChild(seatChip("runner"));
  const rst = el("div", "stats");
  rst.appendChild(stat(r.tmp ? `credits (${r.tmp} temporary)` : "credits", r.cr));
  rst.appendChild(clicksStat(r.ck, 4));
  rst.appendChild(stat("agenda pts", r.pts, "ap"));
  if (r.tg) rst.appendChild(stat(r.tg === 1 ? "tag" : "tags", r.tg, "alert"));
  if (r.cd) rst.appendChild(stat("core dmg", r.cd, "alert"));
  if (r.mu) rst.appendChild(stat("MU", `${r.mu[0]}/${r.mu[1]}`));
  if (r.link) rst.appendChild(stat("link", r.link));
  rst.appendChild(stat("in grip", r.grip.length));
  rst.appendChild(stat("in stack", r.st));
  rh.appendChild(rst);
  runnerSide.appendChild(rh);

  const rig = el("div", "zone-row");
  rig.appendChild(pileEl("Programs", r.prog, "r-prog", { installed: true }));
  rig.appendChild(pileEl("Hardware", r.hw, "r-hw", { installed: true }));
  rig.appendChild(pileEl("Resources", r.res, "r-res", { installed: true }));
  runnerSide.appendChild(rig);

  const rbot = el("div", "zone-row mini");
  const ridz = el("div", "zone");
  ridz.appendChild(el("div", "zone-label", "Identity"));
  const ridc = el("div", "cards");
  if (r.id) ridc.appendChild(cardEl(r.id, "r-id"));
  ridz.appendChild(ridc);
  rbot.appendChild(ridz);
  rbot.appendChild(pileEl("Score area", r.sc, "r-sc", { emptyText: "no agendas" }));
  rbot.appendChild(pileEl("Grip (hand)", r.grip, "r-grip"));
  const heap = r.heap || [];
  rbot.appendChild(pileEl(heap.length > 6 ? "Heap (latest 6)" : "Heap", heap.slice(-6), "r-heap", { emptyText: "empty", total: heap.length }));
  if (r.rs && r.rs.length) rbot.appendChild(pileEl("Resolving", r.rs, "r-rs"));
  if (r.aside && r.aside.length) rbot.appendChild(pileEl("Set aside", r.aside, "r-aside"));
  runnerSide.appendChild(rbot);
  if (frame.rfg && frame.rfg.length) runnerSide.appendChild(pileEl("Removed from game", frame.rfg, "rfg"));
}

// ------------------------------------------------------------ the panel

function stepHeader(step) {
  const head = el("div", "step-head");
  const meta = el("div", "step-meta");
  const turn = step.turn ? `${step.turn.side} turn ${step.turn.number}` : "setup";
  if (step.k === "d") {
    meta.innerHTML = `<b>#${step.seq}</b> · ${esc(turn)} · ${esc(step.pt || step.ph)}`;
  } else if (step.k === "c") {
    meta.innerHTML = `<b>memory compaction #${step.id}</b> · ${esc(turn)}`;
  }
  head.appendChild(meta);
  const badges = el("div", "badges");
  const add = (text, cls) => badges.appendChild(el("span", `badge ${cls || ""}`, text));
  if (step.k === "d") {
    badges.appendChild(seatChip(step.seat, true));
    if (isModelStep(step)) add("model decision", "model");
    else if (step.forced) add("auto-resolved (one option)", "auto");
    else if (step.fulfilled) add("fulfilled by earlier choice", "auto");
    else if (step.folded) add("access order folded", "auto");
    if (step.multi) add(`multi-select ${step.multi.slot}/${step.multi.of}`, "warn");
    if (step.retries) add(`${step.retries} ${step.retries === 1 ? "retry" : "retries"}`, "warn");
    if (step.fallback) add("FALLBACK (option 0)", "bad");
    if (step.divergence) add("preview divergence", "warn");
    if (step.ctx) add(`context ${Math.round(step.ctx / 1000)}K tokens`);
  } else if (step.k === "c") {
    badges.appendChild(seatChip(step.seat, true));
    if (step.tokens) add(`~${Math.round(step.tokens / 1000)}K tokens → memo + ${step.kept} kept exchanges`);
    if (step.truncated) add("memo truncated", "bad");
  }
  head.appendChild(badges);
  return head;
}

function optionsEl(step) {
  const wrap = el("div");
  wrap.appendChild(el("div", "section-label", `Menu · ${step.opts.length} option${step.opts.length === 1 ? "" : "s"}`));
  const list = el("div", "opts");
  const N = step.opts.length;
  const limit = 14;
  let shown = step.opts.map((o, i) => i);
  if (!state.showAllOpts && N > limit) {
    const lo = Math.max(0, Math.min(step.ch - 5, N - limit));
    shown = shown.slice(lo, lo + limit);
  }
  shown.forEach((i) => {
    const o = step.opts[i];
    const row = el("div", `opt ${i === step.ch ? "chosen" : ""}`);
    row.appendChild(el("span", "ix", i === step.ch ? `✔${i}` : String(i)));
    const body = el("span");
    body.innerHTML = inlineIcons(o.l);
    if (o.d) {
      const d = el("span", "desc");
      d.innerHTML = inlineIcons(o.d);
      body.appendChild(d);
    }
    row.appendChild(body);
    if (o.id) row.dataset.id = String(o.id);
    list.appendChild(row);
  });
  wrap.appendChild(list);
  if (N > limit) {
    const more = el("button", "more", state.showAllOpts ? "Show fewer" : `Show all ${N} options`);
    more.type = "button";
    more.addEventListener("click", () => {
      state.showAllOpts = !state.showAllOpts;
      renderPanel();
    });
    wrap.appendChild(more);
  }
  return wrap;
}

function logEl(step) {
  const g = state.game;
  const until = step.li ?? Infinity;
  const prev = state.prevIdx !== undefined && g.steps[state.prevIdx] ? g.steps[state.prevIdx].li ?? -1 : -1;
  const lines = g.log.filter(([i, kind]) => i < until && (state.showAI || kind !== "a"));
  const tail = lines.slice(-14);
  if (!tail.length) return null;
  const wrap = el("div");
  wrap.appendChild(el("div", "section-label", "Game log"));
  const box = el("div", "log");
  tail.forEach(([i, kind, text]) => {
    const cls = kind === "t" ? "turn" : kind === "a" ? "ai" : "";
    const ln = el("div", `ln ${cls} ${i >= prev ? "new" : ""}`);
    ln.innerHTML = kind === "a" ? `🤖 ${inlineIcons(text)}` : inlineIcons(text);
    box.appendChild(ln);
  });
  wrap.appendChild(box);
  return wrap;
}

function renderPanel() {
  const g = state.game;
  const panel = $("#panel");
  panel.replaceChildren();
  const step = g.steps[state.idx];
  if (!step) return;
  if (step.k === "end") {
    const res = el("div", "result");
    const m = g.meta;
    const winnerModel = m.winner ? seatOf(m.winner) : null;
    res.innerHTML =
      `<div class="section-label">Result</div><h2>${esc(m.winner ? `${m.winner === "corp" ? "Corp" : "Runner"} wins` : "No result")}</h2>` +
      `<div class="note">${esc(m.reason || m.status || "")}</div>` +
      `<p>Agenda points ${m.corpAP ?? "?"}–${m.runnerAP ?? "?"} (Corp–Runner)` +
      (m.turns ? ` · ${m.turns.corp} Corp turns` : "") +
      (winnerModel ? ` · winner played by <b>${esc(winnerModel)}</b>` : m.winner ? " · winner: rules AI" : "") +
      `</p>`;
    panel.appendChild(res);
    (g.debrief || []).forEach((d) => {
      const wrap = el("div");
      wrap.appendChild(el("div", "section-label", `Post-game debrief · ${d.seat}${d.model ? ` (${d.model})` : ""}`));
      const p = el("p", "debrief");
      p.innerHTML = proseHtml(d.text);
      wrap.appendChild(p);
      panel.appendChild(wrap);
    });
    const lg = logEl({ li: Infinity });
    if (lg) panel.appendChild(lg);
    return;
  }
  panel.appendChild(stepHeader(step));
  if (step.k === "c") {
    panel.appendChild(el("div", "section-label", "The model's memo to its future self"));
    const memo = el("p", "memo");
    memo.innerHTML = proseHtml(step.text);
    panel.appendChild(memo);
    panel.appendChild(el("p", "note", `The transcript was reset to: system prompt + this memo + the last ${step.kept} exchanges (${step.dropped} dropped). The board is unchanged.`));
    return;
  }
  if (step.rs) {
    const wrap = el("div");
    wrap.appendChild(el("div", "section-label", "Reasoning (written before choosing)"));
    wrap.appendChild(el("p", `reasoning ${step.seat}`, step.rs));
    panel.appendChild(wrap);
  } else if (step.forced) {
    panel.appendChild(el("p", "note", "Only one legal option — resolved without asking the model."));
  } else if (step.fulfilled) {
    panel.appendChild(el("p", "note", "Answered by the model's previous combined choice (verb + subject) — no API call."));
  } else if (step.folded) {
    panel.appendChild(el("p", "note", "Access order provably irrelevant here — folded without asking the model."));
  } else if (!seatOf(step.seat)) {
    panel.appendChild(el("p", "note", "Decision by the engine's rules AI."));
  }
  panel.appendChild(optionsEl(step));
  const lg = logEl(step);
  if (lg) panel.appendChild(lg);
}

// ----------------------------------------------------------- navigation

function stepAllowed(i) {
  const s = state.game.steps[i];
  if (!s) return false;
  if (!state.skipAuto) return true;
  if (s.k !== "d") return true;
  return !isAutoStep(s);
}

// Change glow compares with the previously shown step — only for
// step-wise navigation (next/prev/play); jumps start clean.
function go(i, { stepwise = false } = {}) {
  const g = state.game;
  if (!g || !g.steps.length) return;
  const clamped = Math.max(0, Math.min(i, g.steps.length - 1));
  state.prevIdx = stepwise && state.idx !== clamped ? state.idx : undefined;
  state.idx = clamped;
  state.showAllOpts = false;
  render();
  if (!state.live) history.replaceState(null, "", `#step=${clamped}`);
}

function move(dir) {
  const g = state.game;
  let i = state.idx + dir;
  while (i > 0 && i < g.steps.length - 1 && !stepAllowed(i)) i += dir;
  go(i, { stepwise: true });
  if (state.live) state.following = state.idx === g.steps.length - 1;
}

function moveModel(dir) {
  const g = state.game;
  let i = state.idx + dir;
  while (i >= 0 && i < g.steps.length && !(isModelStep(g.steps[i]) || g.steps[i].k !== "d")) i += dir;
  go(i, { stepwise: true });
}

function render() {
  renderBoard();
  renderPanel();
  const g = state.game;
  const sc = $("#scrubber");
  sc.max = String(Math.max(0, g.steps.length - 1));
  sc.value = String(state.idx);
  const s = g.steps[state.idx];
  const model = g.steps.filter(isModelStep).length;
  $("#pos").textContent = `step ${state.idx + 1}/${g.steps.length} · ${model} model decisions` + (s && s.k === "d" ? ` · seq ${s.seq}` : "");
  const live = $("#btn-live");
  if (state.live) {
    live.hidden = false;
    live.classList.toggle("following", state.following);
    live.textContent = state.following ? "● Live" : "Jump to live";
  }
}

function renderMarks() {
  const g = state.game;
  const marks = $("#marks");
  marks.replaceChildren();
  const n = Math.max(1, g.steps.length - 1);
  let lastTurn = null;
  let lastPts = null;
  g.steps.forEach((s, i) => {
    const pos = `${(i / n) * 100}%`;
    const key = s.turn ? `${s.turn.side}${s.turn.number}` : null;
    if (key && key !== lastTurn) {
      lastTurn = key;
      const m = el("i", s.turn.side === "corp" ? "turn-c" : "turn-r");
      m.style.left = pos;
      marks.appendChild(m);
    }
    const f = g.frames[s.fr];
    if (f) {
      const pts = `${f.c.pts}:${f.r.pts}`;
      if (lastPts !== null && pts !== lastPts) {
        const m = el("i", "score");
        m.style.left = pos;
        m.title = `agenda points ${pts}`;
        marks.appendChild(m);
      }
      lastPts = pts;
    }
    if (s.k === "c") {
      const m = el("i", "compact");
      m.style.left = pos;
      marks.appendChild(m);
    }
  });
}

function setTitle() {
  const m = state.game.meta;
  const vs = `${m.corpPrecon} vs ${m.runnerPrecon}`;
  const who = ["corp", "runner"].map((s) => seatOf(s)).filter(Boolean);
  $("#game-title").textContent = who.length ? `${who.join(" vs ")} — ${vs}` : vs;
  document.title = `${who.join(" vs ") || "Game"} · Netrunner Benchmark`;
  const sub = $("#game-sub");
  sub.replaceChildren();
  sub.appendChild(seatChip("corp"));
  sub.appendChild(seatChip("runner"));
  const bits = [`seed ${m.seed}`];
  if (m.winner) bits.push(`${m.winner} wins — ${m.reason}`);
  if (m.cardSets && m.cardSets.length) bits.push(`sets: ${m.cardSets.join(", ")}`);
  sub.appendChild(document.createTextNode(bits.join(" · ")));
}

// ------------------------------------------------------------- playback

function play(on) {
  state.playing = on;
  $("#btn-play").textContent = on ? "❚❚" : "▶";
  $("#btn-play").setAttribute("aria-label", on ? "Pause" : "Play");
  clearTimeout(state.timer);
  if (on) tick();
}

function tick() {
  if (!state.playing) return;
  const g = state.game;
  if (state.idx >= g.steps.length - 1) {
    if (!state.live) play(false);
    else state.timer = setTimeout(tick, 400);
    return;
  }
  move(1);
  state.timer = setTimeout(tick, parseInt($("#speed").value, 10));
}

// -------------------------------------------------------------- popover

function showPopover(target, x, y) {
  const pop = $("#popover");
  const id = parseInt(target.dataset.id, 10);
  if (!id || target.dataset.visible === "0") {
    if (target._ref && target._ref.ct && target._ref.ct.adv) {
      pop.innerHTML = `<h3>Facedown card</h3><div class="state">${target._ref.ct.adv} advancement counter(s)</div>`;
    } else {
      pop.hidden = true;
      return;
    }
  } else {
    const ci = info(id);
    const facts = [];
    if (ci.c !== undefined) facts.push(`${ci.ty === "ice" || ci.ty === "asset" || ci.ty === "upgrade" ? "rez" : "cost"} ${ci.c}`);
    if (ci.str !== undefined) facts.push(`str ${ci.str}`);
    if (ci.adv !== undefined) facts.push(`adv ${ci.adv}`);
    if (ci.ap !== undefined) facts.push(`${ci.ap} AP`);
    if (ci.tc !== undefined) facts.push(`trash ${ci.tc}`);
    if (ci.mu !== undefined) facts.push(`${ci.mu} MU`);
    const ref = target._ref;
    const st = [];
    if (ref) {
      if (ref.rz) st.push("rezzed");
      if (ref.ct) st.push(Object.entries(ref.ct).map(([k, n]) => `${n} ${{ adv: "advancement", cr: "credits", vir: "virus", pow: "power", ag: "agenda" }[k] || k}`).join(", "));
      if (ref.str !== undefined && ci.str !== undefined && ref.str !== ci.str) st.push(`strength now ${ref.str}`);
      if (state.persp === "omni" && ref.v !== undefined) {
        const seen = [];
        if (ref.v & 1) seen.push("Runner");
        if (ref.v & 2) seen.push("Corp");
        st.push(`visible to: ${seen.length ? seen.join(" + ") : "nobody"}`);
      }
    }
    pop.innerHTML =
      `<h3>${esc(ci.t)}</h3><div class="tl">${esc(TYPE_ABBR[ci.ty] || ci.ty)}${ci.st ? ` · ${esc(ci.st)}` : ""}</div>` +
      (facts.length ? `<div class="facts">${facts.map((f) => `<span>${esc(f)}</span>`).join("")}</div>` : "") +
      `<div class="tx">${cardTextHtml(ci.tx || "")}</div>` +
      (st.length ? `<div class="state">${esc(st.filter(Boolean).join(" · "))}</div>` : "");
  }
  pop.hidden = false;
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  pop.style.left = `${Math.min(x + 14, innerWidth - w - 8)}px`;
  pop.style.top = `${Math.min(y + 14, innerHeight - h - 8)}px`;
}

function wirePopover() {
  document.addEventListener("mousemove", (e) => {
    const t = e.target.closest ? e.target.closest(".card, .opt[data-id]") : null;
    if (!t) {
      $("#popover").hidden = true;
      return;
    }
    showPopover(t, e.clientX, e.clientY);
  });
  document.addEventListener("scroll", () => ($("#popover").hidden = true), true);
}

// --------------------------------------------------------------- wiring

function wire() {
  document.querySelectorAll("[data-persp]").forEach((b) =>
    b.addEventListener("click", () => setPerspective(b.dataset.persp))
  );
  $("#opt-skip").addEventListener("change", (e) => (state.skipAuto = e.target.checked));
  $("#opt-ai").addEventListener("change", (e) => {
    state.showAI = e.target.checked;
    renderPanel();
  });
  $("#btn-prev").addEventListener("click", () => move(-1));
  $("#btn-next").addEventListener("click", () => move(1));
  $("#btn-prev-model").addEventListener("click", () => moveModel(-1));
  $("#btn-next-model").addEventListener("click", () => moveModel(1));
  $("#btn-first").addEventListener("click", () => go(0));
  $("#btn-last").addEventListener("click", () => go(state.game.steps.length - 1));
  $("#btn-play").addEventListener("click", () => play(!state.playing));
  $("#btn-live").addEventListener("click", () => {
    state.following = true;
    go(state.game.steps.length - 1);
  });
  $("#scrubber").addEventListener("input", (e) => {
    go(parseInt(e.target.value, 10));
    if (state.live) state.following = state.idx === state.game.steps.length - 1;
  });
  document.addEventListener("keydown", (e) => {
    if (e.target && (e.target.tagName === "INPUT" && e.target.type !== "range" || e.target.tagName === "SELECT")) return;
    if (e.key === "ArrowRight") { e.preventDefault(); e.shiftKey ? moveModel(1) : move(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); e.shiftKey ? moveModel(-1) : move(-1); }
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(state.game.steps.length - 1);
    else if (e.key === " ") { e.preventDefault(); play(!state.playing); }
    else if (e.key === "1") setPerspective("omni");
    else if (e.key === "2") setPerspective("runner");
    else if (e.key === "3") setPerspective("corp");
  });
  wirePopover();
}

function setPerspective(p) {
  state.persp = p;
  $("#app").dataset.perspective = p;
  document.querySelectorAll("[data-persp]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.persp === p)));
  prevSig = new Map();
  render();
}

function initialIndex() {
  const h = new URLSearchParams(location.hash.slice(1));
  const g = state.game;
  if (h.has("step")) return parseInt(h.get("step"), 10) || 0;
  if (h.has("seq")) {
    const seq = parseInt(h.get("seq"), 10);
    const i = g.steps.findIndex((s) => s.k === "d" && s.seq === seq);
    if (i >= 0) return i;
  }
  // Start on the first decision a model made.
  const first = g.steps.findIndex(isModelStep);
  return first >= 0 ? first : 0;
}

// --------------------------------------------------------------- sources

async function loadBundle(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function startLive() {
  state.live = true;
  let carddata = null;
  let builder = null;
  const pendingFrames = [];
  const ensureCards = async (ids) => {
    if (!carddata) carddata = (await (await fetch("/carddata/carddata.json")).json()).data;
    Object.assign(builder.game.cards, cardDictionary(carddata, ids));
  };
  const src = new EventSource("/live/events");
  let rendered = false;
  const refresh = () => {
    if (!builder || !builder.game.steps.length) return;
    if (!rendered) {
      rendered = true;
      setTitle();
      go(builder.game.steps.length - 1);
    } else if (state.following) {
      state.prevIdx = state.idx;
      state.idx = builder.game.steps.length - 1;
      render();
    } else {
      render();
    }
    renderMarks();
  };
  src.addEventListener("meta", async (e) => {
    const { meta } = JSON.parse(e.data);
    builder = new GameBuilder(
      {
        ...metaFromRecord({ ...meta, model: meta.models && (meta.models.runner || meta.models.corp) }),
        seats: Object.fromEntries(Object.entries(meta.models || {}).map(([s, m]) => [s, { model: m }])),
      },
      {}
    );
    state.game = builder.game;
    const ids = [meta.corpDeck.identity, ...meta.corpDeck.cards, meta.runnerDeck.identity, ...meta.runnerDeck.cards];
    await ensureCards(ids);
    pendingFrames.splice(0).forEach((f) => builder.addFrame(f));
    setTitle();
  });
  src.addEventListener("frame", (e) => {
    const { frame } = JSON.parse(e.data);
    if (!builder) return pendingFrames.push(frame);
    builder.addFrame(frame);
    if (frame.lg) frame.lg.forEach((entry) => builder.game.log.push(entry));
  });
  const onRow = (e) => {
    if (!builder) return;
    const { record } = JSON.parse(e.data);
    builder.addRow(record);
    refresh();
  };
  src.addEventListener("decision", onRow);
  src.addEventListener("compaction", onRow);
  src.addEventListener("end", (e) => {
    const { record } = JSON.parse(e.data);
    if (!builder) return;
    Object.assign(builder.game.meta, metaFromRecord(record), { seats: builder.game.meta.seats });
    builder.finish({ winner: record.winner, reason: record.reason });
    refresh();
    src.close();
  });
  src.onerror = () => {
    if (!builder) $("#game-title").textContent = "Waiting for a live game… (start one with llm-game --live)";
  };
}

async function main() {
  wire();
  try {
    if (params.get("live")) {
      $("#game-title").textContent = "Connecting to the live game…";
      await startLive();
      return;
    }
    const url = params.get("game");
    if (!url) {
      $("#game-title").textContent = "No game selected";
      $("#game-sub").innerHTML = 'Open a game from the <a href="../#games">project page</a>, or pass <code>?game=&lt;bundle.json&gt;</code>.';
      return;
    }
    state.game = await loadBundle(url);
    if (!state.game.log) state.game.log = [];
    setTitle();
    renderMarks();
    go(initialIndex());
  } catch (err) {
    $("#game-title").textContent = "Could not load the game";
    $("#game-sub").textContent = String(err);
  }
}

main();

// Exposed for headless checks (screenshots, walk tests).
window.__viewer = {
  go,
  steps: () => (state.game ? state.game.steps.length : 0),
  ready: () => !!state.game && state.game.steps.length > 0,
  narration,
  frameCardIds,
};
