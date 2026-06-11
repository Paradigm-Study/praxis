// Praxis Studio — zero-dependency SPA over the ledger API.

const api = (p, opts) => fetch(p, opts).then((r) => r.json());
const h = (html) => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstChild;
};
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const confClass = (c) => (c >= 0.85 ? "high" : c >= 0.6 ? "mid" : "low");
const trunc = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n) + "…" : String(s ?? ""));

const VIEWS = [
  { id: "feed", title: "Live Feed", sub: "What it sees now — the raw event ledger." },
  { id: "actions", title: "Action Timeline", sub: "Exact reconstructed actions, with confidence + evidence." },
  { id: "episodes", title: "Episode Timeline", sub: "Fused work episodes." },
  { id: "connections", title: "Connections", sub: "Recurring patterns across days." },
  { id: "graph", title: "Memory Graph", sub: "Workflow, know-how, taste, decisions." },
  { id: "questions", title: "Questions", sub: "What the agent is unsure about — verify it." },
  { id: "corrections", title: "Corrections", sub: "Your edits to the agent's interpretation." },
  { id: "transfer", title: "Transfer", sub: "Operate from the learned model." },
];

let current = location.hash.slice(1) || "feed";

async function boot() {
  const nav = document.getElementById("nav");
  for (const v of VIEWS) {
    const b = h(`<button data-view="${v.id}"><span>${v.title}</span><span class="badge" id="badge-${v.id}"></span></button>`);
    b.onclick = () => go(v.id);
    nav.appendChild(b);
  }
  document.getElementById("refresh").onclick = () => render();
  document.getElementById("drawer-close").onclick = closeDrawer;
  await refreshCounts();
  render();
}

function go(id) {
  current = id;
  location.hash = id;
  render();
}

async function refreshCounts() {
  const s = await api("/api/status");
  const c = s.counts;
  document.getElementById("counts").innerHTML =
    `events ${c.events}<br>actions ${c.actions}<br>episodes ${c.episodes}<br>` +
    `claims ${c.claims}<br>graph ${c.graph.nodes}n / ${c.graph.edges}e`;
  setBadge("feed", c.events);
  setBadge("actions", c.actions);
  setBadge("episodes", c.episodes);
  setBadge("graph", c.graph.nodes);
}
const setBadge = (id, n) => {
  const e = document.getElementById(`badge-${id}`);
  if (e) e.textContent = n;
};

async function render() {
  const v = VIEWS.find((x) => x.id === current) ?? VIEWS[0];
  document.querySelectorAll("#nav button").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === v.id),
  );
  document.getElementById("view-title").textContent = v.title;
  document.getElementById("view-sub").textContent = v.sub;
  const content = document.getElementById("content");
  content.innerHTML = `<div class="empty">loading…</div>`;
  try {
    await RENDER[v.id](content);
  } catch (e) {
    content.innerHTML = `<div class="empty">error: ${esc(e)}</div>`;
  }
}

const RENDER = {
  async feed(c) {
    const events = await api("/api/feed");
    c.innerHTML = "";
    c.appendChild(h(`<div class="livebar"><span class="dot"></span> live — streaming new events as they're captured</div>`));
    const list = h(`<div id="feed-list"></div>`);
    c.appendChild(list);
    if (!events.length) list.appendChild(h(`<div class="empty">No events yet. Run \`praxis demo\` or \`praxis capture\`.</div>`));
    for (const e of events) list.appendChild(feedRow(e));
    // The global SSE stream (opened at boot) prepends new events into #feed-list.
  },

  async actions(c) {
    const actions = await api("/api/actions");
    c.innerHTML = "";
    if (!actions.length) return empty(c, "No actions yet.");
    for (const a of actions) {
      const row = h(`<div class="row">
        <span class="conf ${confClass(a.confidence)}">${a.confidence.toFixed(2)}</span>
        <span class="atype">${esc(a.action)}</span>
        <span class="app">${esc(a.app)}</span>
        <span class="atext">${esc(trunc(a.text, 70))}</span>
        ${a.uncertainty ? `<span class="warn">⚠</span>` : ""}
        <span class="evcount">ev ${a.evidence.length}</span>
      </div>`);
      row.querySelector(".evcount").onclick = () => showEvidence(a.evidence, a.action);
      c.appendChild(row);
    }
  },

  async episodes(c) {
    const eps = await api("/api/episodes");
    c.innerHTML = "";
    if (!eps.length) return empty(c, "No episodes yet.");
    for (const e of eps) {
      const card = h(`<div class="card">
        <h3>${esc(e.goal || e.summary)}</h3>
        <div class="meta">${esc(e.id)} · ${esc(e.boundaryReason || "")} · ${esc(e.startTs)} → ${esc(e.endTs)} · ${e.actions.length} actions</div>
        <div class="kv"><span class="k">summary</span><span>${esc(e.summary)}</span></div>
        ${e.artifacts.length ? `<div class="kv"><span class="k">artifacts</span><span>${e.artifacts.map((a) => `<span class="tag">${esc(a)}</span>`).join("")}</span></div>` : ""}
        ${e.decisionPoints.length ? `<div class="kv"><span class="k">decisions</span><span>${e.decisionPoints.map((d) => esc(trunc(d, 90))).join("<br>")}</span></div>` : ""}
        ${e.rejectedPaths.length ? `<div class="kv"><span class="k">rejected</span><span>${e.rejectedPaths.map((d) => `<span class="tag reject">${esc(d)}</span>`).join("")}</span></div>` : ""}
        ${e.uncertainty.length ? `<div class="kv"><span class="k">uncertainty</span><span class="warn">${e.uncertainty.map(esc).join("<br>")}</span></div>` : ""}
      </div>`);
      c.appendChild(card);
    }
  },

  async connections(c) {
    const conns = await api("/api/connections");
    c.innerHTML = "";
    if (!conns.length) return empty(c, "No cross-day patterns yet. Capture more than one day.");
    for (const x of conns) {
      c.appendChild(h(`<div class="card">
        <h3>${esc(x.node.label)}</h3>
        <div class="meta">${esc(x.node.kind)} · confidence ${x.node.confidence.toFixed(2)}</div>
        <div class="kv"><span class="k">reused on</span><span>${x.days.map((d) => `<span class="tag day">${esc(d)}</span>`).join("")}</span></div>
      </div>`));
    }
  },

  async graph(c) {
    const [{ nodes, edges }, episodes] = await Promise.all([api("/api/graph"), api("/api/episodes")]);
    c.innerHTML = "";
    if (!nodes.length) return empty(c, "Graph is empty.");
    c.appendChild(renderGraph(nodes, edges, episodes));
  },

  async questions(c) {
    const data = await api("/api/questions");
    const agent = data.agent || [];
    const cards = data.cards || [];
    c.innerHTML = "";
    if (agent.length) {
      c.appendChild(h(`<div class="livebar"><span class="dot"></span> the agent is unsure — pick an answer or type your own</div>`));
      for (const q of agent) c.appendChild(askCard(q));
    }
    if (!cards.length && !agent.length)
      return empty(c, "Nothing uncertain — the agent is confident. ✓");
    if (cards.length)
      c.appendChild(h(`<div class="meta" style="color:var(--muted);margin:14px 2px 8px">Uncertain actions to verify</div>`));
    for (const q of cards) c.appendChild(qcard(q));
  },

  async corrections(c) {
    const list = await api("/api/corrections");
    c.innerHTML = "";
    if (!list.length) return empty(c, "No corrections yet. Confirm or reject a card in Questions.");
    for (const x of list) {
      c.appendChild(h(`<div class="row">
        <span class="pill">${esc(x.verdict)}</span>
        <span class="atype">${esc(x.targetKind)}</span>
        <span class="atext">${esc(x.targetId)} ${x.note ? "· " + esc(x.note) : ""}</span>
        <span class="app">${esc(x.createdTs)}</span>
      </div>`));
    }
  },

  async transfer(c) {
    const pb = await api("/api/playbook");
    c.innerHTML = "";
    const card = h(`<div class="card">
      <h3>Learned Playbook</h3>
      <div class="kv"><span class="k">workflow</span><span>${pb.workflow.map((s) => `<span class="tag">${esc(s)}</span>`).join(" → ") || "—"}</span></div>
      <div class="kv"><span class="k">decision rules</span><span>${pb.decisionRules.map((r) => esc(r.text)).join("<br>") || "—"}</span></div>
      <div class="kv"><span class="k">know-how</span><span>${pb.knowHow.map((r) => esc(r.text)).join("<br>") || "—"}</span></div>
      <div class="kv"><span class="k">taste</span><span>${pb.tasteRules.map((r) => esc(r.text)).join("<br>") || "—"}</span></div>
      <div class="kv"><span class="k">artifacts</span><span>${pb.artifactTypes.map(esc).join(", ") || "—"}</span></div>
      <div class="kv"><span class="k">open questions</span><span class="warn">${pb.openQuestions.map(esc).join("<br>") || "—"}</span></div>
    </div>`);
    c.appendChild(card);
  },
};

// The agent's proactive question: pick an option or type your own answer.
function askCard(q) {
  const card = h(`<div class="qcard">
    <div class="proposed">❝ ${esc(q.question)} ❞</div>
    <div class="opts"></div>
    <div class="answerrow">
      <input class="answerbox" type="text" placeholder="…or type your own answer" />
      <button class="btn ok send">Send</button>
    </div>
  </div>`);
  const submit = async (answer) => {
    answer = (answer || "").trim();
    if (!answer) return;
    await api("/api/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId: q.questionId, question: q.question, answer }),
    });
    const done = h(`<div class="qcard"><div class="resolved">✓ Answered: ${esc(answer)}</div></div>`);
    card.replaceWith(done);
    refreshCounts();
  };
  const opts = card.querySelector(".opts");
  for (const opt of q.options || []) {
    const b = h(`<button class="btn optbtn">${esc(opt)}</button>`);
    b.onclick = () => submit(opt);
    opts.appendChild(b);
  }
  const box = card.querySelector(".answerbox");
  card.querySelector(".send").onclick = () => submit(box.value);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit(box.value);
  });
  return card;
}

function qcard(q) {
  const card = h(`<div class="qcard">
    <div class="proposed">❝ ${esc(q.proposed)} ❞</div>
    <div class="evidence"></div>
    <div class="actions">
      <button class="btn ok">✓ Correct</button>
      <button class="btn no">✕ Wrong</button>
      <button class="btn edit">✎ Edit</button>
    </div>
  </div>`);
  const ev = card.querySelector(".evidence");
  for (const e of q.evidence) {
    const chip = h(`<span class="echip"><span class="src">${esc(e.label || e.id)}</span> <span class="snip">${esc(trunc(e.snippet || "", 40))}</span></span>`);
    chip.onclick = () => showEvent(e.id);
    ev.appendChild(chip);
  }
  const submit = async (verdict, correctedText) => {
    await api("/api/correction", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetKind: "action", targetId: q.actionId, verdict, correctedText }),
    });
    card.querySelector(".actions").outerHTML = `<div class="resolved">✓ recorded: ${verdict}</div>`;
    refreshCounts();
  };
  card.querySelector(".ok").onclick = () => submit("confirmed");
  card.querySelector(".no").onclick = () => submit("rejected");
  card.querySelector(".edit").onclick = () => {
    const t = prompt("What actually happened?", q.text || "");
    if (t != null) submit("edited", t);
  };
  return card;
}

// --- Memory graph (simple column layout) ---
function renderGraph(nodes, edges, episodes) {
  const KINDS = ["workflow_pattern", "decision_rule", "know_how", "taste_rule", "artifact_type", "correction", "unresolved_question"];
  const COLOR = {
    workflow_pattern: "#5ac8fa", decision_rule: "#c084fc", know_how: "#4ade80",
    taste_rule: "#fbbf24", artifact_type: "#94a3b8", correction: "#f87171", unresolved_question: "#fb923c",
  };
  const W = 980, colX = 230, epX = 760, rowH = 64, pad = 50;
  const pos = {};
  const byKind = {};
  for (const k of KINDS) byKind[k] = [];
  for (const n of nodes) (byKind[n.kind] || (byKind[n.kind] = [])).push(n);
  let y = pad;
  const order = [];
  for (const k of KINDS) for (const n of byKind[k] || []) { pos[n.id] = { x: colX, y }; order.push(n); y += rowH; }
  const H = Math.max(y + pad, 360);
  episodes.forEach((e, i) => { pos[e.id] = { x: epX, y: pad + i * 90 + 30 }; });

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.id = "graph-svg";
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  for (const e of edges) {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) continue;
    const path = document.createElementNS(svgNS, "path");
    const mx = (a.x + b.x) / 2;
    path.setAttribute("d", `M ${a.x + 150} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x - 8} ${b.y}`);
    path.setAttribute("class", `gedge ${e.kind}`);
    svg.appendChild(path);
  }
  for (const n of order) {
    const p = pos[n.id];
    const g = document.createElementNS(svgNS, "g");
    g.setAttribute("class", "gnode");
    const rect = document.createElementNS(svgNS, "rect");
    rect.setAttribute("x", p.x); rect.setAttribute("y", p.y - 18);
    rect.setAttribute("width", 150); rect.setAttribute("height", 36);
    rect.setAttribute("rx", 8);
    rect.setAttribute("fill", "#131722");
    rect.setAttribute("stroke", COLOR[n.kind] || "#444");
    g.appendChild(rect);
    const t1 = document.createElementNS(svgNS, "text");
    t1.setAttribute("x", p.x + 8); t1.setAttribute("y", p.y - 2);
    t1.setAttribute("fill", COLOR[n.kind] || "#999");
    t1.style.fontSize = "9px";
    t1.textContent = n.kind;
    g.appendChild(t1);
    const t2 = document.createElementNS(svgNS, "text");
    t2.setAttribute("x", p.x + 8); t2.setAttribute("y", p.y + 12);
    t2.textContent = trunc(n.label.replace(/^Workflow:\s*/, ""), 20);
    g.appendChild(t2);
    svg.appendChild(g);
  }
  episodes.forEach((e) => {
    const p = pos[e.id]; if (!p) return;
    const circ = document.createElementNS(svgNS, "circle");
    circ.setAttribute("cx", p.x); circ.setAttribute("cy", p.y); circ.setAttribute("r", 7);
    circ.setAttribute("fill", "#1a1f2e"); circ.setAttribute("stroke", "#5ac8fa");
    svg.appendChild(circ);
    const t = document.createElementNS(svgNS, "text");
    t.setAttribute("x", p.x + 12); t.setAttribute("y", p.y + 4);
    t.textContent = trunc(e.goal || e.id, 26);
    svg.appendChild(t);
  });
  const wrap = h(`<div></div>`);
  wrap.appendChild(svg);
  wrap.appendChild(h(`<div class="meta" style="margin-top:10px;color:var(--muted);font-size:12px">
    Left: claim nodes by kind. Right: episodes. <span style="color:var(--accent)">— —</span> reused across days ·
    <span style="color:var(--red)">—</span> contradicted by correction</div>`));
  return wrap;
}

// --- Evidence drawer ---
async function showEvidence(ids, title) {
  openDrawer(`Evidence · ${title}`);
  const body = document.getElementById("drawer-body");
  body.innerHTML = "";
  for (const id of ids) {
    const ev = await api(`/api/event/${encodeURIComponent(id)}`);
    body.appendChild(renderEvent(ev));
  }
}
async function showEvent(id) {
  openDrawer("Raw event");
  const ev = await api(`/api/event/${encodeURIComponent(id)}`);
  const body = document.getElementById("drawer-body");
  body.innerHTML = "";
  body.appendChild(renderEvent(ev));
}
function renderEvent(ev) {
  if (ev.error) return h(`<div class="field">not found</div>`);
  const wrap = h(`<div class="field">
    <div class="k">${esc(ev.source)} / ${esc(ev.type)} · ${esc(ev.app)}</div>
    <div style="color:var(--muted);font-size:11px">${esc(ev.ts)} · ${esc(ev.id)}</div>
    <pre>${esc(JSON.stringify(ev.payload, null, 2))}</pre>
  </div>`);
  for (const ref of ev.blobRefs || []) {
    if (ev.source === "screen_video") {
      wrap.appendChild(h(`<img src="/api/blob/${encodeURIComponent(ref)}" alt="frame" onerror="this.style.display='none'"/>`));
    } else {
      const pre = h(`<pre style="color:var(--muted)">loading blob…</pre>`);
      wrap.appendChild(pre);
      fetch(`/api/blob/${encodeURIComponent(ref)}`).then((r) => r.text()).then((t) => (pre.textContent = t));
    }
  }
  return wrap;
}
function openDrawer(title) {
  document.getElementById("drawer-title").textContent = title;
  document.getElementById("drawer").classList.remove("hidden");
}
function closeDrawer() {
  document.getElementById("drawer").classList.add("hidden");
}

function empty(c, msg) {
  c.innerHTML = `<div class="empty">${esc(msg)}</div>`;
}

// --- Live feed (SSE) ---
function feedRow(e) {
  const text =
    e.payload.text || e.payload.value || e.payload.cmd || e.payload.title ||
    e.payload.to || (e.payload.ocrText ? "OCR: " + e.payload.ocrText : "") || "";
  const row = h(`<div class="row">
    <span class="pill">${esc(e.source)}</span>
    <span class="atype" style="min-width:150px">${esc(e.type)}</span>
    <span class="app">${esc(e.app)}</span>
    <span class="atext">${esc(trunc(text, 80))}</span>
    <span class="evcount">${e.blobRefs.length ? "📎" + e.blobRefs.length : ""}</span>
  </div>`);
  row.querySelector(".evcount").onclick = () => showEvent(e.id);
  return row;
}

let es = null;
function openGlobalStream() {
  try {
    es = new EventSource("/api/stream");
    es.addEventListener("raw", (ev) => {
      const list = document.getElementById("feed-list");
      if (!list) return; // only the Live Feed view renders the stream
      const row = feedRow(JSON.parse(ev.data));
      row.classList.add("flash");
      list.prepend(row);
      while (list.children.length > 400) list.removeChild(list.lastChild);
    });
    es.addEventListener("counts", (ev) => {
      const c = JSON.parse(ev.data);
      setBadge("feed", c.events);
      setBadge("actions", c.actions);
    });
    es.addEventListener("decision", (ev) => {
      const d = JSON.parse(ev.data);
      showDecision(d);
      if (current === "questions") render();
    });
  } catch {
    /* SSE unsupported — UI stays static */
  }
}

const DECISION_LABEL = {
  ask_expert: "needs your input",
  intervene: "intervening",
  summarize_pattern: "pattern found",
  mark_uncertainty: "uncertain",
  keep_observing: "observing",
};

let decisionTimer = null;
function showDecision(d) {
  const toast = document.getElementById("agent-toast");
  if (!toast) return;
  const label = DECISION_LABEL[d.kind] || d.kind;
  toast.innerHTML =
    `<div class="toast-head"><span class="dot"></span> agent · ${esc(label)}</div>` +
    (d.question
      ? `<div class="toast-q">❝ ${esc(d.question)} ❞</div>`
      : `<div class="toast-r">${esc(d.reason)}</div>`);
  toast.classList.remove("hidden");
  clearTimeout(decisionTimer);
  if (d.kind !== "ask_expert" && d.kind !== "intervene") {
    decisionTimer = setTimeout(() => toast.classList.add("hidden"), 9000);
  }
  toast.onclick = () => {
    toast.classList.add("hidden");
    if (current !== "questions") go("questions");
  };
}

function decisionCard(d) {
  return h(`<div class="qcard">
    <div class="proposed">${d.question ? "❝ " + esc(d.question) + " ❞" : esc(d.reason)}</div>
    <div class="meta" style="color:var(--muted);font-size:12px">agent · ${esc(d.kind)} · ${esc(d.createdTs)}</div>
  </div>`);
}

boot();
openGlobalStream();
