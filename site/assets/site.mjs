// Project page data: featured game, gallery, results table and card-pool
// summary, all from data/index.json (written by `npx tsx src/cli.ts site`).

const $ = (sel) => document.querySelector(sel);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

const SEAT = { corp: "Corp", runner: "Runner" };
const usd = (v) => (v === null || v === undefined ? "—" : `$${v.toFixed(2)}`);

/** Display name: the OpenRouter routing prefix is plumbing, not a name;
 *  seats played from a chat app over MCP say so. */
const playerName = (s) => `${s.model.replace(/^openrouter\//, "")}${s.driver === "mcp" ? " (MCP)" : ""}`;

function modelsLabel(game) {
  return game.seats.map((s) => `${playerName(s)} (${SEAT[s.seat]})`).join(" vs ");
}

/** Did the model(s) win? One seat: that seat's outcome; both: the winner. */
function outcome(game) {
  if (game.status !== "completed") return { text: game.status, cls: "" };
  if (game.seats.length === 1) {
    const won = game.winner === game.seats[0].seat;
    return { text: won ? "won" : "lost", cls: won ? "win" : "loss" };
  }
  const w = game.seats.find((s) => s.seat === game.winner);
  return { text: w ? `${playerName(w)} won` : `${game.winner} won`, cls: "" };
}

/** API seats in dollars, chat-app seats as "subscription". */
function costLabel(game) {
  const api = game.seats.filter((s) => s.driver !== "mcp").map((s) => s.costUsd).filter((c) => c !== null);
  const dollars = api.length ? usd(api.reduce((a, b) => a + b, 0)) : "";
  const mcp = game.seats.some((s) => s.driver === "mcp") ? "subscription" : "";
  return [dollars, mcp].filter(Boolean).join(" + ") || "—";
}

const viewerHref = (bundle) => `./viewer/?game=../${bundle}`;

function setFeatured(data) {
  const playable = data.games.filter((g) => g.bundle && g.status === "completed");
  const best = playable.sort((a, b) => (b.decisions ?? 0) - (a.decisions ?? 0))[0];
  let href;
  let caption;
  if (best) {
    href = viewerHref(best.bundle);
    caption =
      `${modelsLabel(best)}: ${best.corpPrecon} vs ${best.runnerPrecon}, seed ${best.seed}. ` +
      `${best.winner === "corp" ? "The Corp" : "The Runner"} won (${best.reason}), ` +
      `${best.corpAP}–${best.runnerAP} on agenda points over ${best.corpTurns} turns.`;
  } else if (data.demo) {
    href = viewerHref(data.demo.bundle);
    caption =
      `Demonstration: a random-move player (the harness's keyless test model) as the Runner against the ` +
      `rules-based Corp, ${data.demo.corpPrecon} vs ${data.demo.runnerPrecon}, seed ${data.demo.seed}. ` +
      `Recorded model games appear here once the corpus has them.`;
  } else {
    return;
  }
  $("#featured-frame").src = href;
  $("#featured-open").href = href;
  $("#featured-caption").textContent = caption;
}

function renderGallery(data) {
  const ul = $("#gallery");
  ul.replaceChildren();
  const playable = data.games.filter((g) => g.bundle);
  if (!playable.length) {
    ul.appendChild(el("li", "table-note", "No recorded model games in the current corpus yet."));
    return;
  }
  playable
    .sort((a, b) => (b.decisions ?? 0) - (a.decisions ?? 0))
    .forEach((g) => {
      const li = el("li");
      const a = el("a", "game-card");
      a.href = viewerHref(g.bundle);
      const m = el("span", "gc-model");
      g.seats.forEach((s, i) => {
        if (i) m.appendChild(document.createTextNode(" vs "));
        m.appendChild(el("span", `seat-dot ${s.seat}`));
        m.appendChild(document.createTextNode(playerName(s)));
      });
      a.appendChild(m);
      a.appendChild(el("span", "gc-meta", `${g.seats.map((s) => SEAT[s.seat]).join(" + ")} · ${g.corpPrecon} vs ${g.runnerPrecon} · seed ${g.seed}`));
      const o = outcome(g);
      const r = el("span", "gc-result");
      r.appendChild(el("span", o.cls, o.text));
      r.appendChild(document.createTextNode(` · ${g.reason ?? ""} · ${g.corpAP ?? "?"}–${g.runnerAP ?? "?"} · ${g.corpTurns ?? "?"} turns`));
      a.appendChild(r);
      li.appendChild(a);
      ul.appendChild(li);
    });
}

function renderTable(data) {
  const tbody = $("#games-table tbody");
  tbody.replaceChildren();
  if (!data.games.length) {
    const td = el("td", "table-note", "No games yet.");
    td.colSpan = 7;
    const tr = el("tr");
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  data.games
    .slice()
    .sort((a, b) => Number(b.standard) - Number(a.standard) || modelsLabel(a).localeCompare(modelsLabel(b)))
    .forEach((g) => {
      const tr = el("tr");
      const th = el("th");
      th.scope = "row";
      if (g.bundle) {
        const a = el("a", null, modelsLabel(g));
        a.href = viewerHref(g.bundle);
        th.appendChild(a);
      } else th.textContent = modelsLabel(g);
      tr.appendChild(th);
      tr.appendChild(el("td", null, `${g.corpPrecon} vs ${g.runnerPrecon} · seed ${g.seed}${g.standard ? "" : " · ablation"}`));
      const o = outcome(g);
      const td = el("td");
      td.appendChild(el("span", o.cls, o.text));
      td.appendChild(document.createTextNode(` · ${g.reason ?? ""}`));
      tr.appendChild(td);
      tr.appendChild(el("td", "num", `${g.corpAP ?? "?"}–${g.runnerAP ?? "?"}`));
      tr.appendChild(el("td", "num", String(g.corpTurns ?? "—")));
      tr.appendChild(el("td", "num", g.seats.map((s) => s.llmDecisions).join(" + ")));
      tr.appendChild(el("td", "num", costLabel(g)));
      tbody.appendChild(tr);
    });
  if (data.games.some((g) => !g.standard))
    $("#games-note").textContent += ` Rows marked “ablation” ran with ${data.ablation}; compare them only with each other.`;
}

function renderPool(pool) {
  if (!pool) return;
  const q = pool.qualified;
  $("#pool-summary").textContent =
    `${q.corp + q.runner} of ${pool.total} decks currently qualify (${q.corp} Corp, ${q.runner} Runner); ` +
    `the rest hit engine defects such as crashes or stalls and are refused unless explicitly allowed`;
}

async function main() {
  try {
    const res = await fetch("./data/index.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setFeatured(data);
    renderGallery(data);
    renderTable(data);
    renderPool(data.pool);
  } catch (err) {
    const msg = `Could not load the game index (${err}). Build it with \`npx tsx src/cli.ts site\`.`;
    $("#gallery").replaceChildren(el("li", "table-note", msg));
    const td = el("td", "table-note", msg);
    td.colSpan = 7;
    const tr = el("tr");
    tr.appendChild(td);
    $("#games-table tbody").replaceChildren(tr);
  }
}

main();
