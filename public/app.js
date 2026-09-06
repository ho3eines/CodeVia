/* CodeVia SPA — vanilla JS, no build step. Talks to the REST API + Socket.io. */
(() => {
  "use strict";

  /* ---------- API client ---------- */
  function authHeaders() {
    try {
      const t = localStorage.getItem("cv_token");
      return t ? { Authorization: "Bearer " + t } : {};
    } catch (_) { return {}; }
  }
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...authHeaders(), ...(opts.headers || {}) },
      method: opts.method || "GET",
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      let msg = res.statusText;
      let body = null;
      try {
        body = await res.json();
        msg = body.message || body.error || body.hint || msg;
      } catch (_) { /* ignore */ }
      const err = new Error(msg);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }
  /* ---------- auth/session state ---------- */
  // Cached session introspection. /auth/me is a PUBLIC endpoint that always
  // answers 200 (it never 401s): { authenticated, loginConfigured, requireAuth }.
  // The SPA fetches it once at boot and refreshes it after login/logout, then
  // uses it to (a) show the login screen *before* firing protected calls that
  // would guaranteed-401 in strict mode, and (b) gate the user slot + repo
  // listing without per-request console noise.
  const authState = { authenticated: false, requireAuth: false, loginConfigured: false, user: null };
  async function refreshAuthState() {
    try {
      const me = await api("/auth/me");
      authState.authenticated = !!me.authenticated;
      authState.user = me.user || null;
      authState.requireAuth = !!me.requireAuth;
      authState.loginConfigured = !!me.loginConfigured;
      authState.githubToken = me.githubToken || null;
    } catch (err) {
      // A 401 here means the server is enforcing authentication before its
      // session-introspection route (for example, an older Railway image is
      // still running). Treat that as strict mode so we do not immediately
      // request every protected resource and produce a cascade of 401s.
      // Network failures are left alone so a temporary outage is not shown as
      // a login problem.
      if (err && err.status === 401) {
        authState.authenticated = false;
        authState.user = null;
        authState.requireAuth = true;
        const status = await apiRaw("/auth/github/status").catch(() => null);
        authState.loginConfigured = !!status?.ok && !!status.body?.configured;
      }
    }
    return authState;
  }
  // True when a logged-in session is required right now (strict mode is on and
  // GitHub login is configured). Mirrors the server guard exactly.
  function loginIsRequired() {
    return !authState.authenticated && authState.requireAuth;
  }

  // Raw fetch that returns json body even on error (for diagnostics)
  async function apiRaw(path, opts = {}) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...authHeaders(), ...(opts.headers || {}) },
      method: opts.method || "GET",
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let body = null;
    try { body = await res.json(); } catch (_) {}
    return { ok: res.ok, status: res.status, body, headers: res.headers };
  }

  /* ---------- helpers ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const timeAgo = (iso) => {
    if (!iso) return "";
    const d = new Date(iso); const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return Math.floor(diff / 86400) + "d ago";
  };
  const money = (n) => (n ? "$" + Number(n).toFixed(2) : "$0.00");
  function toast(title, msg, kind = "") {
    const el = document.createElement("div");
    el.className = "toast " + kind;
    el.innerHTML = `<div class="toast-title">${esc(title)}</div><div class="toast-msg">${esc(msg || "")}</div>`;
    $("#toasts").appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }
  function showSkeleton() {
    $("#content").innerHTML = `<div class="skeleton-line w60"></div><div class="skeleton-line w90"></div><div class="skeleton-card-grid"><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div></div>`;
  }
  function renderError(err) {
    $("#content").innerHTML = `<div class="error-state"><h4>Something went wrong</h4><pre>${esc(err && (err.message || err))}</pre><div class="flex mt"><button class="btn btn-primary" onclick="location.reload()">Retry</button></div></div>`;
  }
  /* Strict mode (REQUIRE_AUTH) + no session: show a login screen instead of a raw 401. */
  async function renderLoginRequired() {
    const st = await api("/auth/github/status").catch(() => ({ configured: false }));
    const next = encodeURIComponent(location.hash || "#/dashboard");
    const stepsHtml = st.setupSteps ? `<ol style="font-size:12px;color:var(--text-muted);text-align:left;margin:8px 0 0 18px">${st.setupSteps.map(s=>`<li>${esc(s)}</li>`).join("")}</ol>` : "";
    $("#content").innerHTML = `<div class="card card-body auth-hero">
      <div class="auth-glyph">🔐</div>
      <h2>Sign in required</h2>
      <p class="auth-sub">This CodeVia instance requires a GitHub login for API access.</p>
      ${st.configured
        ? `<div class="flex mt" style="justify-content:center"><a class="btn btn-primary btn-lg" href="/auth/github/login?next=${next}">🐙 Continue with GitHub</a></div>`
        : `<div class="error-state mt" style="text-align:left"><h4>GitHub login is not configured</h4>
            <p style="font-size:12px;color:var(--text-muted)">${esc(st.setupHint || "Strict mode is on, but there is no way to sign in yet.")}</p>
            ${stepsHtml}
            <p style="font-size:11px;color:var(--text-muted);margin-top:8px">یا <span class="mono">REQUIRE_AUTH=false</span> را تنظیم کنید و سرویس را ری‌استارت کنید تا بدون ورود کار کند — <span class="mono">docs/GITHUB_SETUP.md</span> را ببینید.</p></div>`}
    </div>`;
  }
  function emptyState(emoji, title, text) {
    return `<div class="empty"><div class="empty-emoji">${emoji}</div><h3>${esc(title)}</h3><p>${esc(text || "")}</p></div>`;
  }
  function searchBlob(value) {
    if (value == null) return "";
    if (["string", "number", "boolean"].includes(typeof value)) return String(value);
    if (Array.isArray(value)) return value.map(searchBlob).join(" ");
    if (typeof value === "object") return Object.entries(value).map(([k, v]) => `${k} ${searchBlob(v)}`).join(" ");
    return "";
  }
  function matchesQuery(item, query, extra = "") {
    const terms = String(query || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    const haystack = `${searchBlob(item)} ${extra}`.toLowerCase();
    return terms.every((t) => haystack.includes(t));
  }
  function searchPanelHtml(id, placeholder, hint = "Search supports multiple words and matches IDs, names, status, tags and related metadata.") {
    return `<div class="card card-body search-card">
      <div class="search-row">
        <div class="search-box"><span class="search-icon">⌕</span><input class="input" id="${esc(id)}" placeholder="${esc(placeholder)}" autocomplete="off"/></div>
        <button class="btn btn-ghost" id="${esc(id)}-clear" disabled>Clear</button>
      </div>
      <div class="field-hint" id="${esc(id)}-summary">${esc(hint)}</div>
    </div>`;
  }
  function bindSearchPanel(id, items, render, targetSelector, noun, opts = {}) {
    const input = $("#" + id), clear = $("#" + id + "-clear"), summary = $("#" + id + "-summary"), target = $(targetSelector);
    if (!input || !target) return;
    const emptyHtml = opts.emptyHtml || (() => emptyState("🔎", `No matching ${noun}s`, "Try a different search term or clear the filter."));
    const update = () => {
      const q = input.value || "";
      const filtered = items.filter((item) => matchesQuery(item, q, opts.extraText ? opts.extraText(item) : ""));
      target.innerHTML = filtered.length ? render(filtered) : emptyHtml(q);
      if (summary) summary.textContent = q.trim() ? `Showing ${filtered.length} of ${items.length} ${noun}(s) for “${q.trim()}”.` : `Showing all ${items.length} ${noun}(s).`;
      if (clear) clear.disabled = !q.trim();
    };
    input.addEventListener("input", update);
    if (clear) clear.onclick = () => { input.value = ""; update(); input.focus(); };
    update();
  }
  const badge = (s) => {
    const map = { succeeded: "ok", running: "info", pending: "muted", failed: "err", waiting_for_approval: "warn", dead: "err", cancelled: "muted" };
    return `<span class="badge badge-${map[s] || "muted"}">${esc(s)}</span>`;
  };

  /* ---------- model capability badges + provider test rendering ---------- */
  const CAP_NAMES = { vision: "vision", tools: "tools", structuredOutput: "structured", code: "code", reasoning: "reasoning", streaming: "streaming" };
  function capsBadges(caps) {
    if (!caps) return "";
    return Object.keys(CAP_NAMES).filter((k) => caps[k]).map((k) => `<span class="badge badge-muted">${CAP_NAMES[k]}</span>`).join(" ");
  }
  // Render a provider/model test result: destination URL(s), discovered models,
  // and — for chat tests — the text the model actually replied with.
  /* ---------- test verdict dialog ----------
     Raw test payloads used to be dumped inline as a wall of text. These render
     the outcome as a dialog with an animated tick/cross, the model's reply up
     front, and the diagnostic noise tucked into a collapsible section. */

  /** Animated success tick / failure cross. */
  function verdictMark(ok) {
    return `<div class="verdict-mark"><svg viewBox="0 0 60 60" aria-hidden="true">
      <circle class="vm-ring" cx="30" cy="30" r="26"/>
      ${ok
        ? '<path class="vm-path" d="M18 31 L26 39 L43 22"/>'
        : '<path class="vm-path" d="M21 21 L39 39 M39 21 L21 39"/>'}
    </svg></div>`;
  }

  /** Build the verdict body for a test result payload. */
  function verdictHtml(r, opts = {}) {
    const ok = !!r.ok;
    const title = opts.title || (ok ? "Test passed" : "Test failed");
    const chips = [];
    if (typeof r.latencyMs === "number") chips.push(`<span class="badge badge-muted">⏱ ${r.latencyMs} ms</span>`);
    if (typeof r.status === "number") chips.push(`<span class="badge badge-${r.status < 400 ? "ok" : "err"}">HTTP ${r.status}</span>`);
    if (typeof r.found === "boolean") chips.push(`<span class="badge badge-${r.found ? "ok" : "warn"}">${r.found ? "in catalog" : "not in catalog"}</span>`);
    if (opts.modelId) chips.push(`<span class="badge badge-info mono">${esc(opts.modelId)}</span>`);

    const reply = typeof r.responseText === "string" && r.responseText.trim()
      ? `<div class="verdict-reply">
           <div class="vr-head"><span>💬 Model reply</span><span class="mono">${esc(String(r.responseText.trim().length))} chars</span></div>
           <pre class="vr-body">${esc(r.responseText.trim())}</pre>
         </div>`
      : (typeof r.responseText === "string"
          ? `<div class="verdict-hint">The request succeeded but the model returned an empty response.</div>` : "");

    const hint = r.hint ? `<div class="verdict-hint">💡 ${esc(r.hint)}</div>` : "";

    // Diagnostics (URLs, capabilities, catalog) collapsed by default.
    const urls = Array.from(new Set([r.catalogUrl, r.chatUrl, ...(r.urls || []), r.url].filter(Boolean)));
    const label = (u) => u === r.url && r.method ? `${r.method} request`
      : u === r.catalogUrl ? "📚 catalog" : u === r.chatUrl ? "💬 chat" : "→ request";
    const caps = r.detectedCapabilities || r.capabilities;
    const infos = r.modelInfos || [];
    const diagBits = [
      urls.length ? `<div style="font-size:11px;color:var(--text-muted)">Endpoints contacted:</div>${urls.map((u) => `<div class="mono verdict-url"><span class="badge badge-muted">${esc(label(u))}</span> ${esc(u)}</div>`).join("")}` : "",
      caps && typeof caps === "object" ? `<div class="mt" style="font-size:11px;color:var(--text-muted)">Capabilities:</div><div>${capsBadges(caps)}</div>` : "",
      infos.length ? `<div class="mt" style="font-size:11px;color:var(--text-muted)">Catalog (${infos.length}):</div>${infos.slice(0, 12).map((m) => `<div class="mono" style="font-size:11px">${esc(m.id)}</div>`).join("")}${infos.length > 12 ? "<div style=\"font-size:11px;color:var(--text-muted)\">…</div>" : ""}` : "",
    ].filter(Boolean).join("");
    const diagnostics = diagBits
      ? `<details class="verdict-details"><summary>Technical details</summary><div class="vd-body">${diagBits}</div></details>` : "";

    return `<div class="verdict ${ok ? "ok" : "err"}">
      ${verdictMark(ok)}
      <h3>${esc(title)}</h3>
      <p class="verdict-msg">${esc(r.message || (ok ? "The provider responded successfully." : "The request did not succeed."))}</p>
      ${chips.length ? `<div class="verdict-chips">${chips.join("")}</div>` : ""}
      ${reply}${hint}${diagnostics}
      <div class="verdict-actions">
        ${opts.retry ? `<button class="btn" onclick="${esc(opts.retry)}">↻ Test again</button>` : ""}
        <button class="btn btn-primary" onclick="closeModal()">Done</button>
      </div>
    </div>`;
  }

  /* The verdict lives on its own layer so it can stack above an open form
     modal without clearing it. Closing it returns you to the form. */
  function openVerdict(title, bodyHtml) {
    $("#verdict-title").textContent = title;
    $("#verdict-body").innerHTML = bodyHtml;
    $("#verdict-backdrop").hidden = false;
  }
  function closeVerdict() { $("#verdict-backdrop").hidden = true; }
  window.closeVerdict = closeVerdict;
  $("#verdict-close")?.addEventListener("click", closeVerdict);

  /** Show the in-flight state, then swap in the verdict when it resolves. */
  function showTestPending(title, subtitle) {
    openVerdict(title, `<div class="verdict"><div class="verdict-spinner"></div>
      <h3>Testing…</h3><p class="verdict-msg">${esc(subtitle || "Contacting the provider.")}</p></div>`);
  }
  function showTestVerdict(r, opts = {}) {
    openVerdict(opts.title || (r.ok ? "✓ Test passed" : "✗ Test failed"), verdictHtml(r, opts));
  }
  window.showTestVerdict = showTestVerdict;
  window.showTestPending = showTestPending;

  /**
   * Run a model chat test and present it as an animated verdict.
   * Used by the model editor and the model list.
   */
  async function runModelTest(providerId, modelId) {
    showTestPending("Testing model", `Sending a test message to ${modelId}…`);
    try {
      const r = await api("/models/test", { method: "POST", body: { providerId, modelId, message: MODEL_TEST_MSG } });
      showTestVerdict(r, {
        modelId,
        title: r.ok ? "✓ Model replied" : "✗ Model test failed",
        retry: `runModelTest('${esc(providerId)}','${esc(modelId)}')`,
      });
    } catch (e) {
      showTestVerdict({ ok: false, message: e.message, hint: e.body?.hint, status: e.status }, {
        modelId,
        title: "✗ Model test failed",
        retry: `runModelTest('${esc(providerId)}','${esc(modelId)}')`,
      });
    }
  }
  window.runModelTest = runModelTest;

  /* ---------- modal ----------
     Modals are the primary surface for detail + configuration in this UI: the
     pages stay as compact overviews and everything deep opens in glass. */
  function openModal(title, bodyHtml, opts = {}) {
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = bodyHtml;
    $("#modal").classList.toggle("modal-wide", !!opts.wide);
    $("#modal-backdrop").hidden = false;
  }
  function closeModal() { $("#modal-backdrop").hidden = true; $("#modal").classList.remove("modal-wide"); }
  window.openModal = openModal;
  window.closeModal = closeModal;

  /* ---------- tabs ----------
     Pure-CSS-ish tab strip: `tabsHtml` renders the buttons + panels and
     `switchTab` flips the active classes without a re-render. */
  function tabsHtml(groupId, tabs) {
    const strip = tabs.map((t, i) =>
      `<button class="tab ${i === 0 ? "active" : ""}" data-tab-btn="${esc(groupId)}:${esc(t.id)}" onclick="switchTab('${esc(groupId)}','${esc(t.id)}')">
        ${esc(t.label)}${t.badge != null ? `<span class="tab-badge">${esc(String(t.badge))}</span>` : ""}
      </button>`).join("");
    const panels = tabs.map((t, i) =>
      `<div class="tab-panel" data-tab-panel="${esc(groupId)}:${esc(t.id)}" ${i === 0 ? "" : "hidden"}>${t.html}</div>`).join("");
    return `<div class="tabs" role="tablist">${strip}</div>${panels}`;
  }
  window.switchTab = (groupId, tabId) => {
    $$(`[data-tab-btn^="${groupId}:"]`).forEach((b) => b.classList.toggle("active", b.dataset.tabBtn === `${groupId}:${tabId}`));
    $$(`[data-tab-panel^="${groupId}:"]`).forEach((p) => { p.hidden = p.dataset.tabPanel !== `${groupId}:${tabId}`; });
  };

  /* ---------- SVG chart kit ----------
     Small dependency-free chart helpers. Everything is plain SVG styled by
     app.css (.cv-chart) so charts inherit the theme and animate on render. */
  const CHART_COLORS = ["#7c6cff", "#22d3ee", "#e879f9", "#34d399", "#fbbf24", "#fb7185", "#5b8cff", "#a3e635"];
  const chartColor = (i) => CHART_COLORS[i % CHART_COLORS.length];

  /** Smooth area+line chart over a numeric series. */
  function lineChart(values, opts = {}) {
    const w = opts.width || 520, h = opts.height || 170, pad = { l: 34, r: 10, t: 12, b: 22 };
    const data = (values || []).map((v) => Number(v) || 0);
    if (data.length < 2) return `<div class="empty" style="padding:28px"><p>Not enough data to plot yet.</p></div>`;
    const max = Math.max(...data, 1), min = Math.min(...data, 0);
    const span = max - min || 1;
    const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    const x = (i) => pad.l + (i / (data.length - 1)) * iw;
    const y = (v) => pad.t + ih - ((v - min) / span) * ih;
    const line = data.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const area = `${line} L${x(data.length - 1).toFixed(1)},${(pad.t + ih).toFixed(1)} L${pad.l},${(pad.t + ih).toFixed(1)} Z`;
    const gid = "g" + Math.random().toString(36).slice(2, 8);
    const ticks = [0, 0.5, 1].map((f) => {
      const yy = pad.t + ih * f;
      return `<line class="grid-line" x1="${pad.l}" y1="${yy.toFixed(1)}" x2="${w - pad.r}" y2="${yy.toFixed(1)}"/>
              <text class="axis-label" x="4" y="${(yy + 3).toFixed(1)}">${Math.round(max - span * f)}</text>`;
    }).join("");
    const dots = data.map((v, i) => `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" stroke="${opts.color || CHART_COLORS[0]}"><title>${esc(String(opts.labels?.[i] ?? i))}: ${v}</title></circle>`).join("");
    const labels = (opts.labels || []).map((l, i) =>
      i % Math.ceil(data.length / 6) === 0 ? `<text class="axis-label" text-anchor="middle" x="${x(i).toFixed(1)}" y="${h - 6}">${esc(String(l))}</text>` : "").join("");
    return `<svg class="cv-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${opts.color || CHART_COLORS[0]}" stop-opacity="0.42"/>
        <stop offset="100%" stop-color="${opts.color || CHART_COLORS[0]}" stop-opacity="0"/>
      </linearGradient></defs>
      ${ticks}
      <path class="area-path" d="${area}" fill="url(#${gid})"/>
      <path class="line-path" d="${line}" stroke="${opts.color || CHART_COLORS[0]}"/>
      ${dots}${labels}
    </svg>`;
  }

  /** Vertical bar chart from [{label, value}]. */
  function barChart(items, opts = {}) {
    const rows = (items || []).filter(Boolean);
    if (!rows.length) return `<div class="empty" style="padding:28px"><p>Nothing to chart yet.</p></div>`;
    const w = opts.width || 520, h = opts.height || 170, pad = { l: 30, r: 8, t: 12, b: 26 };
    const max = Math.max(...rows.map((r) => Number(r.value) || 0), 1);
    const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    const bw = Math.min(46, (iw / rows.length) * 0.62);
    const step = iw / rows.length;
    const bars = rows.map((r, i) => {
      const v = Number(r.value) || 0;
      const bh = Math.max(2, (v / max) * ih);
      const bx = pad.l + step * i + (step - bw) / 2;
      const by = pad.t + ih - bh;
      return `<rect class="bar-rect" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="6"
                fill="${r.color || chartColor(i)}" style="animation-delay:${i * 60}ms"><title>${esc(r.label)}: ${v}</title></rect>
        <text class="axis-label" text-anchor="middle" x="${(bx + bw / 2).toFixed(1)}" y="${h - 8}">${esc(String(r.label).slice(0, 9))}</text>
        <text class="axis-label" text-anchor="middle" x="${(bx + bw / 2).toFixed(1)}" y="${(by - 4).toFixed(1)}" style="font-weight:700">${v}</text>`;
    }).join("");
    const grid = [0, 0.5, 1].map((f) => `<line class="grid-line" x1="${pad.l}" y1="${(pad.t + ih * f).toFixed(1)}" x2="${w - pad.r}" y2="${(pad.t + ih * f).toFixed(1)}"/>`).join("");
    return `<svg class="cv-chart" viewBox="0 0 ${w} ${h}" role="img">${grid}${bars}</svg>`;
  }

  /** Donut / progress ring. `segments` = [{label, value, color}]. */
  function donutChart(segments, opts = {}) {
    const rows = (segments || []).filter((s) => Number(s.value) > 0);
    const size = opts.size || 168, stroke = opts.stroke || 16, r = (size - stroke) / 2, c = 2 * Math.PI * r;
    const total = rows.reduce((s, x) => s + Number(x.value), 0);
    if (!total) {
      return `<div class="donut-wrap"><svg class="cv-chart" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"/>
        <text x="50%" y="52%" text-anchor="middle" class="axis-label">no data</text></svg></div>`;
    }
    let offset = 0;
    const arcs = rows.map((s, i) => {
      const frac = Number(s.value) / total;
      const dash = `${(frac * c).toFixed(2)} ${(c - frac * c).toFixed(2)}`;
      const el = `<circle class="ring-value" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="${s.color || chartColor(i)}"
        stroke-width="${stroke}" stroke-dasharray="${dash}" stroke-dashoffset="${(-offset * c).toFixed(2)}" style="animation-delay:${i * 90}ms">
        <title>${esc(s.label)}: ${s.value}</title></circle>`;
      offset += frac;
      return el;
    }).join("");
    const legend = opts.legend === false ? "" : `<div class="chart-legend">${rows.map((s, i) =>
      `<span class="key"><i style="background:${s.color || chartColor(i)}"></i>${esc(s.label)} <strong style="color:var(--text)">${s.value}</strong></span>`).join("")}</div>`;
    return `<div class="donut-wrap"><svg class="cv-chart" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img">
        <circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"/>
        ${arcs}
        <text x="50%" y="48%" text-anchor="middle" style="fill:var(--text);font-size:26px;font-weight:800;font-family:var(--font)">${esc(String(opts.centerValue ?? total))}</text>
        <text x="50%" y="62%" text-anchor="middle" class="axis-label">${esc(opts.centerLabel || "total")}</text>
      </svg>${legend}</div>`;
  }

  /** Single-value progress ring (health score, percentages). */
  function gaugeRing(percent, opts = {}) {
    const p = Math.max(0, Math.min(100, Number(percent) || 0));
    const size = opts.size || 130, stroke = opts.stroke || 12, r = (size - stroke) / 2, c = 2 * Math.PI * r;
    const color = opts.color || (p >= 80 ? "#34d399" : p >= 50 ? "#fbbf24" : "#fb7185");
    return `<svg class="cv-chart" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" style="flex:0 0 auto">
      <circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"/>
      <circle class="ring-value" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="${color}" stroke-width="${stroke}"
        stroke-dasharray="${((p / 100) * c).toFixed(2)} ${c.toFixed(2)}"/>
      <text x="50%" y="47%" text-anchor="middle" style="fill:var(--text);font-size:27px;font-weight:800;font-family:var(--font)">${Math.round(p)}<tspan style="font-size:14px">%</tspan></text>
      <text x="50%" y="63%" text-anchor="middle" class="axis-label">${esc(opts.label || "healthy")}</text>
    </svg>`;
  }

  /** Tiny inline sparkline for stat cards. */
  function sparkline(values, color = CHART_COLORS[0]) {
    const data = (values || []).map((v) => Number(v) || 0);
    if (data.length < 2) return "";
    const w = 120, h = 34, max = Math.max(...data, 1), min = Math.min(...data, 0), span = max - min || 1;
    const pts = data.map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(h - ((v - min) / span) * (h - 4) - 2).toFixed(1)}`);
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts.join(" ")}"
      fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/></svg>`;
  }

  /** Group timestamped rows into N buckets for trend charts. */
  function bucketByDay(rows, days = 7, dateKey = "createdAt") {
    const out = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now); d.setDate(now.getDate() - i); d.setHours(0, 0, 0, 0);
      const next = new Date(d); next.setDate(d.getDate() + 1);
      const n = (rows || []).filter((r) => {
        const t = new Date(r?.[dateKey] || r?.createdAt || 0).getTime();
        return t >= d.getTime() && t < next.getTime();
      }).length;
      out.push({ label: d.toLocaleDateString(undefined, { weekday: "short" }), value: n });
    }
    return out;
  }

  /* ---------- realtime ---------- */
  let socket = null;
  function setLivePill(online) {
    const pill = $("#live-pill");
    if (!pill) return;
    pill.classList.toggle("offline", !online);
    // Write into the dedicated label element only. Targeting the last span
    // would clobber the status dot itself (it is the pill's last child when
    // the label is a bare text node), which is what broke the pill before.
    const label = pill.querySelector("#live-label");
    if (label) label.textContent = online ? "Live" : "Offline";
    pill.title = online ? "Realtime connected" : "Realtime disconnected — retrying automatically";
  }
  window.setLivePill = setLivePill;
  function connectSocket() {
    if (typeof io === "undefined") return;
    // Reconnect forever with backoff; a failed websocket upgrade (common
    // behind proxies) silently falls back to long-polling instead of
    // spamming the console with ERR_CONNECTION_RESET noise.
    try {
      socket = io({
        transports: ["polling", "websocket"],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000,
        randomizationFactor: 0.5,
        timeout: 20000,
        withCredentials: true,
      });
    } catch (_) { return; }
    socket.on("connect", () => setLivePill(true));
    socket.on("disconnect", () => setLivePill(false));
    // Swallow handshake/upgrade errors: the client keeps retrying in the
    // background and the pill shows the state. Never throws into route().
    socket.on("connect_error", () => setLivePill(false));
    socket.on("run.updated", (ev) => {
      if (ev.runId && location.hash.startsWith("#/runs")) refreshCurrent();
      if (ev.data && ev.data.status === "succeeded") toast("Run completed", ev.runId, "ok");
    });
    socket.on("step.updated", (ev) => {
      if (ev.runId && location.hash.includes("/console")) refreshCurrent();
    });
    socket.on("task.updated", (ev) => {
      if (ev.taskId && location.hash.startsWith("#/tasks")) refreshCurrent();
    });
    socket.on("notification", (ev) => {
      const kind = ev && ev.data && ev.data.kind;
      if (kind === "approval.required") toast("Approval required", ev.data.action || "", "warn");
      if (kind && kind.startsWith("approval.") && (location.hash.startsWith("#/approvals") || location.hash.startsWith("#/dashboard"))) refreshCurrent();
    });
  }

  /* ---------- router ---------- */
  const routes = {};
  function on(path, fn) { routes[path] = fn; }
  function renderNav() {
    const groups = [
      ["Platform", [
        ["#/dashboard", "📊", "Dashboard"],
        ["#/projects", "📁", "Projects"],
        ["#/runs", "▶️", "Runs"],
        ["#/tasks", "🧩", "Tasks"],
        ["#/approvals", "🛑", "Approvals"],
        ["#/logs", "📜", "Logs"],
        ["#/conversations", "💬", "Conversations"],
      ]],
      ["AI", [
        ["#/agents", "🤖", "Agents"],
        ["#/models", "🧠", "Models"],
        ["#/providers", "🔌", "Providers"],
        ["#/skills", "🛠️", "Skills"],
        ["#/workflows", "🔀", "Workflows"],
        ["#/memory", "🗂️", "Memory"],
      ]],
      ["Integrations", [
        ["#/github", "🐙", "GitHub"],
        ["#/telegram", "📱", "Telegram"],
      ]],
      ["System", [
        ["#/settings", "⚙️", "Settings"],
        ["#/admin", "🛡️", "Admin"],
        ["#/search", "🔍", "Search"],
      ]],
    ];
    $("#nav").innerHTML = groups.map(([label, items]) =>
      `<div class="nav-group">${label}</div>` +
      items.map(([href, icon, text]) => `<a href="${href}" data-href="${href}"><span class="nav-icon">${icon}</span>${text}</a>`).join("")
    ).join("");
  }
  // Match a path against registered routes, supporting ":param" segments.
  function matchRoute(path) {
    const segments = path.split("/").filter(Boolean);
    // Prefer exact literal keys first, then parameterized patterns in registration order.
    if (routes[path]) return { handler: routes[path], params: {}, pattern: path };
    for (const pattern of Object.keys(routes)) {
      const pSegs = pattern.split("/").filter(Boolean);
      if (pSegs.length !== segments.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < pSegs.length; i++) {
        const p = pSegs[i];
        if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(segments[i]);
        else if (p !== segments[i]) { ok = false; break; }
      }
      if (ok) return { handler: routes[pattern], params, pattern };
    }
    return null;
  }

  async function route() {
    showSkeleton();
    // Strip the query part ("#/github?login=success") before matching routes.
    const hash = (location.hash.replace(/^#/, "").split("?")[0]) || "/dashboard";
    renderNav();
    const [pathKey, ...rest] = hash.split("/").filter(Boolean);
    const key = "/" + (pathKey || "dashboard");
    const full = "/" + [pathKey, ...rest].join("/");
    const matched = matchRoute(full) || matchRoute(key) || matchRoute("/dashboard");
    const handler = matched.handler;
    const params = matched.params || {};
    const title = $("#topbar-title");
    handleLoginResultParams();
    // Refresh session introspection up front. /auth/me is public (never 401),
    // so when strict mode is on and we are logged out we can show the login
    // screen *instead of* dispatching protected calls that would guaranteed
    // 401 (which logs unavoidable console errors in the browser).
    await refreshAuthState();
    if (loginIsRequired()) {
      await renderLoginRequired();
    } else {
      try {
        await handler(rest, params);
      } catch (err) {
        if (err && err.status === 401) {
          // Session expired between refreshes (or revoked server-side):
          // re-sync state and show the login screen.
          await refreshAuthState();
          await renderLoginRequired();
        } else {
          renderError(err);
          toast("Error", err.message, "err");
        }
      }
    }
    {
      const shown = titleMap[matched.pattern] || titleMap[full] || titleMap[key] || "Dashboard";
      title.textContent = document.title = shown;
      $("nav").setAttribute("aria-current", "true");
      $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.href === key));
      setLangDir();
    }
    // Keep the top-bar login/user slot in sync with the refreshed state.
    renderUserSlot();
  }
  const titleMap = {
    "/dashboard": "Dashboard", "/projects": "Projects", "/agents": "Agents", "/models": "Models",
    "/providers": "Providers", "/skills": "Skills", "/workflows": "Workflows", "/tasks": "Tasks",
    "/runs": "Runs", "/conversations": "Conversations", "/memory": "Memory", "/github": "GitHub",
    "/telegram": "Telegram", "/settings": "Settings", "/admin": "Admin", "/search": "Search",
    "/projects/:id": "Project", "/agents/:id": "Agent", "/workflows/:id": "Workflow",
    "/runs/:id/console": "Run Console", "/conversations/:id": "Conversation",
  };
  function setLangDir() {
    const pref = localStorage.getItem("cv-dir") || "ltr";
    document.documentElement.setAttribute("dir", pref);
  }
  function refreshCurrent() {
    return route();
  }
  // Views are rendered with inline handlers in the generated HTML. Functions
  // declared inside this IIFE are not visible to inline `onclick` attributes,
  // so expose the refresh action explicitly for those handlers and realtime
  // callbacks.
  window.refreshCurrent = refreshCurrent;
  $("#cmd-palette-btn")?.addEventListener("click", () => openPalette());

  /* ---------- Command Palette ---------- */
  const commands = [
    ["#/projects", "📁", "Create Project", "go to projects"],
    ["#/agents", "🤖", "View Agents", "agent registry"],
    ["#/models", "🧠", "Models", "model registry"],
    ["#/providers", "🔌", "Providers", "provider config"],
    ["#/skills", "🛠️", "Skills", "skill marketplace"],
    ["#/workflows", "🔀", "Workflows", "workflow engine"],
    ["#/runs", "▶️", "Runs", "AI run console"],
    ["#/tasks", "🧩", "Tasks", "task queue"],
    ["#/approvals", "🛑", "Approvals", "approve / reject gated steps"],
    ["#/logs", "📜", "Logs", "errors, audit, notifications"],
    ["#/memory", "🗂️", "Memory", "GitHub-backed memory"],
    ["#/github", "🐙", "GitHub", "source of truth"],
    ["#/telegram", "📱", "Telegram", "bot interface"],
    ["#/settings", "⚙️", "Settings", "import/export/backup"],
    ["#/admin", "🛡️", "Admin", "system health"],
    // Action commands: a leading "!" is dispatched instead of navigated.
    ["!theme-light", "☀️", "Switch to Light mode", "theme · appearance"],
    ["!theme-dark", "🌙", "Switch to Dark mode", "theme · appearance"],
    ["!dir-toggle", "⇄", "Toggle text direction", "LTR / RTL"],
  ];
  /** Run a palette entry: "#/route" navigates, "!action" runs a command. */
  function runPaletteCommand(target) {
    if (!target) return;
    if (!target.startsWith("!")) { location.hash = target; return; }
    if (target === "!theme-light") setTheme("light");
    else if (target === "!theme-dark") setTheme("dark");
    else if (target === "!dir-toggle") $("#dir-toggle")?.click();
  }
  let paletteIdx = -1; let paletteItems = commands;
  function openPalette() {
    $("#palette-backdrop").hidden = false;
    const inp = $("#palette-input"); inp.value = ""; inp.focus();
    renderPalette();
  }
  function renderPalette() {
    const q = ($("#palette-input").value || "").toLowerCase();
    paletteItems = commands.filter((c) => (c[1] + c[2] + c[3]).toLowerCase().includes(q));
    $("#palette-list").innerHTML = paletteItems.map((c, i) =>
      `<li data-i="${i}" class="${i === paletteIdx ? "active" : ""}"><span class="pl-ico">${c[1]}</span>${esc(c[2])}<span class="pl-sub">${esc(c[3])}</span></li>`).join("");
    $$("#palette-list li").forEach((li) => li.addEventListener("click", () => { runPaletteCommand(paletteItems[+li.dataset.i][0]); closePalette(); }));
  }
  function closePalette() { $("#palette-backdrop").hidden = true; paletteIdx = -1; }
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
    if (e.key === "Escape") {
      // Close only the topmost layer so Escape unwinds dialogs one at a time.
      if (!$("#palette-backdrop").hidden) { closePalette(); return; }
      if (!$("#verdict-backdrop").hidden) { closeVerdict(); return; }
      if (!$("#chat-modal-backdrop").hidden) { window.closeModelChat?.(); return; }
      if (!$("#modal-backdrop").hidden) { closeModal(); return; }
      if ($("#sidebar")?.classList.contains("open")) setSidebar(false);
    }
    if (!$("#palette-backdrop").hidden) {
      const inp = $("#palette-input");
      if (e.key === "ArrowDown") { e.preventDefault(); paletteIdx = Math.min(paletteIdx + 1, paletteItems.length - 1); renderPalette(); }
      if (e.key === "ArrowUp") { e.preventDefault(); paletteIdx = Math.max(paletteIdx - 1, 0); renderPalette(); }
      if (e.key === "Enter") { e.preventDefault(); if (paletteItems[paletteIdx]) runPaletteCommand(paletteItems[paletteIdx][0]); closePalette(); }
    }
  });
  $("#palette-input")?.addEventListener("input", renderPalette);
  // The command palette is a transient picker, so tapping outside dismisses it.
  $("#palette-backdrop")?.addEventListener("click", (e) => { if (e.target.id === "palette-backdrop") closePalette(); });
  // Dialogs deliberately do NOT close on an outside click: they hold forms and
  // test output, and a stray tap used to discard work. The × button is the
  // only pointer affordance (Escape still works as a keyboard accelerator).
  $("#modal-close")?.addEventListener("click", closeModal);
  $("#chat-modal-close")?.addEventListener("click", () => window.closeModelChat?.());

  /* ---------- theme + direction ----------
     Dark is the default; the choice is persisted and applied pre-paint by the
     inline script in index.html so there is never a flash of the wrong theme. */
  function currentTheme() { return document.documentElement.getAttribute("data-theme") || "dark"; }
  function paintThemeButton() {
    const d = $("#dir-toggle");
    if (d) d.innerHTML = (document.documentElement.getAttribute("dir") === "rtl") ? "⇄ LTR" : "⇄ RTL";
    // The segmented switch is driven purely by the [data-theme] attribute in
    // CSS, so there is no separate active-state to keep in sync here.
    $$("[data-theme-set]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeSet === currentTheme())));
  }
  /** Apply + persist a theme. Exposed so the palette can switch it too. */
  function setTheme(next, announce = true) {
    if (next !== "dark" && next !== "light") return;
    if (next === currentTheme()) return;
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("cv-theme", next); } catch (_) {}
    paintThemeButton();
    if (announce) toast(next === "dark" ? "🌙 Dark mode" : "☀️ Light mode", "Saved for your next visit", "");
  }
  window.setTheme = setTheme;
  $$("[data-theme-set]").forEach((btn) => btn.addEventListener("click", () => setTheme(btn.dataset.themeSet)));
  // Legacy single-button toggle (kept for older markup/tests).
  $("#theme-toggle")?.addEventListener("click", () => setTheme(currentTheme() === "dark" ? "light" : "dark"));
  $("#dir-toggle")?.addEventListener("click", () => {
    const next = (document.documentElement.getAttribute("dir") === "rtl") ? "ltr" : "rtl";
    document.documentElement.setAttribute("dir", next);
    localStorage.setItem("cv-dir", next);
    paintThemeButton();
  });
  if (!localStorage.getItem("cv-theme")) document.documentElement.setAttribute("data-theme", "dark");
  paintThemeButton();

  /* ---------- Mobile sidebar (off-canvas drawer) ----------
     Closing must be possible in every direction mode, so there are three
     independent affordances: the × button, the scrim, and Escape. */
  function setSidebar(open) {
    const sb = $("#sidebar");
    if (!sb) return;
    sb.classList.toggle("open", open);
    const scrim = $("#sidebar-scrim");
    if (scrim) scrim.hidden = !open;
    document.body.style.overflow = open ? "hidden" : "";
    $("#menu-toggle")?.setAttribute("aria-expanded", String(open));
  }
  window.setSidebar = setSidebar;
  $("#menu-toggle")?.addEventListener("click", () => setSidebar(!$("#sidebar")?.classList.contains("open")));
  $("#sidebar-close")?.addEventListener("click", () => setSidebar(false));
  $("#sidebar-scrim")?.addEventListener("click", () => setSidebar(false));
  $("#nav")?.addEventListener("click", (e) => { if (e.target.closest("a")) setSidebar(false); });
  // Leaving the mobile breakpoint must reset the drawer, otherwise the scroll
  // lock and scrim can persist on a desktop-width layout.
  window.matchMedia?.("(min-width: 901px)")?.addEventListener?.("change", (ev) => { if (ev.matches) setSidebar(false); });

  /* ---------- Views ---------- */

  /* DASHBOARD */
  on("/dashboard", async () => {
    // The dashboard aggregates a few endpoints; each is optional so a partial
    // outage degrades one widget instead of blanking the whole page.
    const [d, runsRaw, usage, providers] = await Promise.all([
      api("/dashboard"),
      api("/runs").catch(() => []),
      api("/admin/usage").catch(() => null),
      api("/providers").catch(() => []),
    ]);
    const runs = Array.isArray(runsRaw) ? runsRaw : (runsRaw?.items || []);
    const q = d.queue || {};

    // ---- derived series ----
    const trend = bucketByDay(runs, 7);
    const statusCounts = runs.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
    const statusSegments = [
      { label: "succeeded", value: statusCounts.succeeded || 0, color: "#34d399" },
      { label: "running", value: statusCounts.running || 0, color: "#60a5fa" },
      { label: "pending", value: statusCounts.pending || 0, color: "#8990b5" },
      { label: "failed", value: statusCounts.failed || 0, color: "#fb7185" },
    ];
    const done = (statusCounts.succeeded || 0);
    const attempted = done + (statusCounts.failed || 0);
    const successRate = attempted ? Math.round((done / attempted) * 100) : 100;
    const agentCounts = Object.entries(runs.reduce((acc, r) => { acc[r.agentType] = (acc[r.agentType] || 0) + 1; return acc; }, {}))
      .sort((a, b) => b[1] - a[1]).slice(0, 6).map(([label, value]) => ({ label, value }));
    const readyProviders = providers.filter((p) => p.readiness?.ready !== false && p.active).length;

    const statCard = (label, value, sub, icon, spark) => `<div class="card stat">
      <span class="stat-icon">${icon}</span>
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${esc(String(value))}</div>
      <div class="stat-sub">${sub}</div>
      ${spark || ""}
    </div>`;

    $("#content").innerHTML = `
      <div class="overview">
        <div><h1>Dashboard</h1><p>Live overview of your AI engineering organization — runs, agents, spend and system health.</p></div>
        <div class="action-row">
          <button class="btn" onclick="openDashboardDetails()">📈 Analytics</button>
          <button class="btn btn-primary" onclick="location.hash='#/projects'">＋ New Project</button>
        </div>
      </div>

      <div class="stat-grid">
        ${statCard("Projects", d.totalProjects, `${d.activeAgents} active agents`, "📁", "")}
        ${statCard("Runs", d.totalRuns, `${successRate}% success rate`, "▶️", sparkline(trend.map((t) => t.value)))}
        ${statCard("Running now", d.runningTasks, `${q.pending || 0} queued · ${d.failedTasks} failed`, "⚡", "")}
        <a class="card stat" href="#/approvals" style="text-decoration:none;color:inherit">
          <span class="stat-icon">🛑</span>
          <div class="stat-label">Approvals</div>
          <div class="stat-value">${d.pendingApprovals}</div>
          <div class="stat-sub">${d.pendingApprovals ? "waiting for your review" : "nothing to review"}</div>
        </a>
      </div>

      <div class="grid-2">
        <div class="card card-body">
          <div class="card-title">Run activity <span class="sub">last 7 days · ${trend.reduce((s, t) => s + t.value, 0)} runs</span></div>
          ${lineChart(trend.map((t) => t.value), { labels: trend.map((t) => t.label), color: "#7c6cff" })}
        </div>
        <div class="card card-body">
          <div class="card-title">Run outcomes</div>
          ${donutChart(statusSegments, { centerValue: runs.length, centerLabel: "total runs" })}
        </div>
      </div>

      <div class="grid-2 mt">
        <div class="card card-body">
          <div class="card-title">Busiest agents <span class="sub">runs per agent type</span></div>
          ${barChart(agentCounts)}
        </div>
        <div class="card card-body">
          <div class="card-title">Recent activity <span class="sub">${d.recentActivity.length} events</span></div>
          ${d.recentActivity.length ? `<div class="activity-feed">${d.recentActivity.map((r) => {
            const color = r.status === "succeeded" ? "var(--ok)" : r.status === "failed" ? "var(--err)" : r.status === "running" ? "var(--info)" : "var(--text-muted)";
            return `<div class="activity-item">
              <span class="activity-dot" style="background:${color};box-shadow:0 0 10px ${color}"></span>
              <div class="activity-body"><strong>${esc(r.agentType)}</strong><span>${timeAgo(r.createdAt)} · ${esc(r.status)}${r.durationMs ? ` · ${Math.round(r.durationMs / 1000)}s` : ""}</span></div>
              <button class="btn btn-ghost" onclick="location.hash='#/runs/${esc(r.runId)}/console'">Open</button>
            </div>`;
          }).join("")}</div>` : emptyState("📭", "No activity yet", "Run a task or a workflow to see agent activity here.")}
        </div>
      </div>

      <div class="grid-2 mt">
        <div class="card card-body">
          <div class="card-title">Queue &amp; spend</div>
          <div class="kpi-row">
            <div class="kpi"><b>${q.pending || 0}</b><span>pending</span></div>
            <div class="kpi"><b>${q.running || 0}</b><span>running</span></div>
            <div class="kpi"><b>${d.modelUsage.calls}</b><span>calls</span></div>
            <div class="kpi"><b>${(d.modelUsage.tokens / 1000).toFixed(1)}k</b><span>tokens</span></div>
            <div class="kpi"><b>${money(d.modelUsage.costUsd)}</b><span>cost</span></div>
          </div>
          <div class="meter-row mt"><span class="lbl">Providers ready</span><div class="bar"><span style="width:${providers.length ? (readyProviders / providers.length) * 100 : 0}%"></span></div><span class="val">${readyProviders}/${providers.length}</span></div>
          <div class="meter-row"><span class="lbl">Success rate</span><div class="bar"><span style="width:${successRate}%"></span></div><span class="val">${successRate}%</span></div>
        </div>
        <div class="card card-body">
          <div class="card-title">Quick actions</div>
          <div class="quick-grid">
            <a class="quick-btn" href="#/projects"><span class="q-ico">📁</span>Projects</a>
            <a class="quick-btn" href="#/models"><span class="q-ico">🧠</span>Models</a>
            <a class="quick-btn" href="#/providers"><span class="q-ico">🔌</span>Providers</a>
            <a class="quick-btn" href="#/runs"><span class="q-ico">▶️</span>Runs</a>
            <a class="quick-btn" href="#/approvals"><span class="q-ico">🛑</span>Approvals</a>
            <a class="quick-btn" href="#/admin"><span class="q-ico">🛡️</span>Admin</a>
          </div>
        </div>
      </div>`;

    // Deeper analytics live in a modal so the page itself stays uncluttered.
    window.openDashboardDetails = () => {
      openModal("📈 Analytics", tabsHtml("dashx", [
        { id: "trend", label: "Trends", html: `
          <div class="card card-body"><div class="card-title">Runs per day <span class="sub">7 days</span></div>${lineChart(trend.map((t) => t.value), { labels: trend.map((t) => t.label), width: 640 })}</div>
          <div class="card card-body mt"><div class="card-title">Runs by agent</div>${barChart(agentCounts, { width: 640 })}</div>` },
        { id: "outcomes", label: "Outcomes", badge: runs.length, html: `
          <div class="card card-body">${donutChart(statusSegments, { centerValue: `${successRate}%`, centerLabel: "success" })}</div>
          <div class="card card-body mt"><div class="card-title">Breakdown</div>
            ${statusSegments.map((s) => `<div class="meter-row"><span class="lbl">${esc(s.label)}</span><div class="bar"><span style="width:${runs.length ? (s.value / runs.length) * 100 : 0}%;background:${s.color}"></span></div><span class="val">${s.value}</span></div>`).join("")}
          </div>` },
        { id: "usage", label: "Usage", html: usage ? `
          <div class="card card-body"><div class="card-title">Platform totals</div>
            <div class="kpi-row">
              <div class="kpi"><b>${usage.projects}</b><span>projects</span></div>
              <div class="kpi"><b>${usage.agents}</b><span>agents</span></div>
              <div class="kpi"><b>${usage.models}</b><span>models</span></div>
              <div class="kpi"><b>${usage.skills}</b><span>skills</span></div>
              <div class="kpi"><b>${usage.tasks}</b><span>tasks</span></div>
              <div class="kpi"><b>${usage.runs}</b><span>runs</span></div>
            </div>
            <div class="card-title mt">Model spend</div>
            <div class="meter-row"><span class="lbl">Calls</span><span class="val">${usage.costs.calls}</span></div>
            <div class="meter-row"><span class="lbl">Tokens</span><span class="val">${usage.costs.tokens.toLocaleString()}</span></div>
            <div class="meter-row"><span class="lbl">Cost</span><span class="val">${money(usage.costs.costUsd)}</span></div>
          </div>` : `<div class="card card-body">${emptyState("🔒", "Usage unavailable", "The usage endpoint is restricted or offline.")}</div>` },
      ]), { wide: true });
    };
  });

  /* PROJECTS */
  on("/projects", async () => {
    const list = await api("/projects");
    $("#content").innerHTML = `
      <div class="overview"><div><h1>Projects</h1><p>Multi-project AI engineering workspaces</p></div>
        <button class="btn btn-primary" onclick="openProjectModal()">＋ Create Project</button></div>
      ${searchPanelHtml("project-search", "Search projects by name, repo, branch, framework or status…")}
      ${list.length ? `<div class="card card-body"><div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Repo</th><th>Branch</th><th>Framework</th><th>Status</th><th>Created</th><th></th></tr></thead>
        <tbody id="project-tbody"></tbody></table></div></div>` :
        `<div class="card card-body">${emptyState("📁", "No projects yet", "Create your first project and the platform will auto-generate agents, skills, and a workflow.")}</div>`}`;
    bindSearchPanel("project-search", list, projectRows, "#project-tbody", "project", { emptyHtml: () => `<tr><td colspan="7">${emptyState("🔎", "No matching projects", "Try searching by repo, branch, framework or status.")}</td></tr>` });
  });
  function projectRows(list) {
    return list.map((p) => `<tr>
      <td><a href="#/projects/${p.id}"><strong>${esc(p.name)}</strong></a><div class="mono" style="color:var(--text-muted)">${esc(p.slug)}</div></td>
      <td class="mono">${esc(p.configRepo)}</td>
      <td class="mono">${esc(p.branch)}</td>
      <td>${esc(((p.capabilities?.frameworks || []).join(", ") || p.framework || "—"))}</td>
      <td>${p.active ? '<span class="badge badge-ok">active</span>' : '<span class="badge badge-muted">inactive</span>'}</td>
      <td>${timeAgo(p.createdAt)}</td>
      <td><button class="btn btn-ghost" onclick="location.hash='#/projects/${p.id}'">Open</button></td>
    </tr>`).join("");
  }

  /* ---------- multi-select chips + repo picker (shared by project forms) ---------- */
  let optionCatalogCache = null;
  async function loadOptionCatalog() {
    if (optionCatalogCache) return optionCatalogCache;
    optionCatalogCache = await api("/projects/options");
    return optionCatalogCache;
  }
  const CAPABILITY_GROUPS = [
    ["platforms", "Platform(s)", "Web, Mobile, API…"],
    ["languages", "Language(s)", "TypeScript, C#…"],
    ["frameworks", "Framework(s) — multi-select + writeable", ".NET, MudBlazor, HTML, CSS…"],
    ["databases", "Database (single-select)", "SQL Server, Oracle, SQLite…"],
    ["deploymentTargets", "Deployment target(s)", "Docker, Kubernetes…"],
    ["features", "Features / concerns", "Auth, Payments…"],
    ["integrations", "Integrations", "GitHub Actions, Sentry…"],
  ];
  /* Renders a chip group. `selected` = array of ids; custom values allowed via the add box. */
  function chipGroupHtml(key, label, options, selected = [], opts = {}) {
    const sel = new Set(selected);
    const single = !!opts.single;
    const norm = options.map((o) => ({ id: o.value ?? o.id, label: o.label, icon: o.icon || "", description: o.description || "" }));
    const known = new Set(norm.map((o) => o.id));
    const extra = [...sel].filter((id) => !known.has(id)).map((id) => ({ id, label: id, icon: "", description: "custom" }));
    const all = [...norm, ...extra];
    const core = new Set(opts.core || []);
    return `<div class="field" data-chips="${esc(key)}" ${single ? 'data-single="1"' : ""}>
      <label>${esc(label)} <span class="select-count" data-count="${esc(key)}">${single ? (sel.size ? "selected" : "select one") : sel.size ? sel.size + " selected" : "multi-select"}</span></label>
      <div class="chip-group">
        ${all.map((o) => `<span class="chip ${sel.has(o.id) || core.has(o.id) ? "on" : ""} ${core.has(o.id) ? "core" : ""}" data-id="${esc(o.id)}" title="${esc(o.description || (core.has(o.id) ? "core agent — always included" : ""))}">${o.icon ? o.icon + " " : ""}${esc(o.label)}</span>`).join("")}
        ${opts.allowCustom === false ? "" : `<span class="chip-add"><input class="input" data-add="${esc(key)}" placeholder="+ ${esc(opts.placeholder || "other…")}"/></span>`}
      </div>
      ${opts.hint ? `<div class="field-hint">${esc(opts.hint)}</div>` : ""}
    </div>`;
  }
  function bindChipGroups(root) {
    $$("[data-chips]", root).forEach((grp) => {
      const key = grp.dataset.chips;
      const refreshCount = () => {
        const n = $$(".chip.on", grp).length;
        const c = $(`[data-count="${key}"]`, grp);
        if (c) c.textContent = n ? n + " selected" : "multi-select";
      };
      const single = grp.dataset.single === "1";
      grp.addEventListener("click", (e) => {
        const chip = e.target.closest(".chip");
        if (!chip || chip.classList.contains("chip-add")) return;
        if (chip.classList.contains("core")) return; // always on
        if (single && !chip.classList.contains("on")) {
          $$(".chip.on", grp).forEach((c) => { if (!c.classList.contains("core")) c.classList.remove("on"); });
          chip.classList.add("on");
        } else {
          chip.classList.toggle("on");
        }
        refreshCount();
      });
      const add = $(`[data-add="${key}"]`, grp);
      if (add) add.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== ",") return;
        e.preventDefault();
        const raw = add.value.trim().replace(/,$/, "");
        if (!raw) return;
        const id = raw.toLowerCase().replace(/[^a-z0-9.+#]+/g, "-").replace(/^-+|-+$/g, "") || raw;
        const existing = $(`.chip[data-id="${CSS.escape(id)}"]`, grp);
        if (existing) existing.classList.add("on");
        else {
          const chip = document.createElement("span");
          chip.className = "chip on"; chip.dataset.id = id; chip.textContent = raw;
          add.parentElement.before(chip);
        }
        if (single) $$(".chip.on", grp).forEach((c) => c.dataset.id !== id && !c.classList.contains("core") && c.classList.remove("on"));
        add.value = ""; refreshCount();
      });
    });
  }
  function readChipGroups(root) {
    const out = {};
    $$("[data-chips]", root).forEach((grp) => { out[grp.dataset.chips] = $$(".chip.on", grp).map((c) => c.dataset.id); });
    return out;
  }

  /* Repo picker state lives on the element (data attributes) + closure. */
  function repoPickerHtml() {
    return `<div class="repo-picker" id="repo-picker">
      <div class="field"><label>Repository <span class="select-count">pick a connected GitHub repo</span></label>
        <select class="select mono" id="rp-repo-select">
          <option value="">Loading connected GitHub repositories…</option>
        </select>
      </div>
      <div class="repo-search">
        <input class="input" id="rp-search" placeholder="Search your GitHub repositories…"/>
        <button class="btn" id="rp-refresh" title="Reload from GitHub">↻</button>
      </div>
      <div class="repo-list" id="rp-list"><div class="repo-empty">Loading repositories…</div></div>
      <div class="field-hint" id="rp-hint"></div>
      <details style="margin-top:6px"><summary style="font-size:11px;color:var(--text-muted);cursor:pointer">Repository not listed? add manually (owner/name)</summary>
        <div class="flex mt"><input class="input mono" id="rp-manual" placeholder="owner/name"/><button class="btn" id="rp-manual-add">Add</button></div></details>
      <details style="margin-top:6px"><summary style="font-size:11px;color:var(--text-muted);cursor:pointer">Create new repository</summary>
        <div class="field"><input class="input mono" id="rp-new-name" placeholder="new-repo-name"/></div>
        <div class="field"><input class="input" id="rp-new-desc" placeholder="Repository description (optional)"/></div>
        <div class="flex"><label style="font-size:11px;color:var(--text-muted)"><input type="checkbox" id="rp-new-priv"/> Private</label><span class="spacer"></span><button class="btn" id="rp-new-go">Create</button></div>
      </details>
      <div class="repo-selected" id="rp-selected"></div>
    </div>`;
  }
  /* mount picker; `selected` = [{repo, branch, role, isConfigRepo}] */
  function mountRepoPicker(root, selected = [], onChange = () => {}) {
    const state = { repos: [], selected: selected.map((r) => ({ ...r })), branches: {}, source: "", hint: "" };
    const list = $("#rp-list", root), selEl = $("#rp-selected", root), hintEl = $("#rp-hint", root), search = $("#rp-search", root), repoSelect = $("#rp-repo-select", root);
    const ROLES = ["primary", "backend", "frontend", "mobile", "infrastructure", "docs", "library", "other"];
    const renderRepoSelect = () => {
      if (!repoSelect) return;
      const q = (search.value || "").toLowerCase();
      const rows = state.repos.filter((r) => !q || r.fullName.toLowerCase().includes(q) || (r.description || "").toLowerCase().includes(q));
      repoSelect.innerHTML = `<option value="">${state.repos.length ? "Choose a connected GitHub repository…" : "No connected repositories yet — create one below"}</option>` +
        rows.map((r) => `<option value="${esc(r.fullName)}">${esc(r.fullName)}${r.description ? " — " + esc(r.description.slice(0, 60)) : ""}${r.private ? " [private]" : ""}</option>`).join("");
    };
    const fetchBranches = async (full) => {
      if (state.branches[full] && state.branches[full].length) return;
      const [owner, ...rest] = full.split("/");
      const name = rest.join("/");
      const r = await apiRaw(`/github/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches`).catch(() => null);
      if (r && r.ok && Array.isArray(r.body)) state.branches[full] = r.body.map((b) => b.name || b);
      else state.branches[full] = [state.selected.find((x) => x.repo === full)?.defaultBranch || "main"];
      renderSelected();
    };
    const isSel = (full) => state.selected.some((r) => r.repo.toLowerCase() === full.toLowerCase());
    const renderList = () => {
      const q = (search.value || "").toLowerCase();
      const rows = state.repos.filter((r) => !q || r.fullName.toLowerCase().includes(q) || (r.description || "").toLowerCase().includes(q));
      renderRepoSelect();
      if (!state.repos.length) {
        list.innerHTML = `<div class="repo-empty">${state.error ? esc(state.error) : "No repositories found for this account."}</div>`;
        return;
      }
      list.innerHTML = rows.slice(0, 200).map((r) => `<div class="repo-row ${isSel(r.fullName) ? "selected" : ""}" data-full="${esc(r.fullName)}">
          <span class="check">${isSel(r.fullName) ? "✓" : ""}</span>
          <div><div class="repo-name">${esc(r.fullName)}</div>${r.description ? `<div class="repo-desc">${esc(r.description)}</div>` : ""}</div>
          <div class="repo-meta">${r.private ? '<span class="badge badge-warn">private</span>' : '<span class="badge badge-muted">public</span>'}${r.language ? `<span class="badge badge-info">${esc(r.language)}</span>` : ""}${r.archived ? '<span class="badge badge-muted">archived</span>' : ""}</div>
        </div>`).join("") || `<div class="repo-empty">No match for “${esc(q)}”.</div>`;
    };
    const renderSelected = () => {
      if (!state.selected.length) { selEl.innerHTML = `<div class="field-hint warn">No repository selected yet — pick at least one above.</div>`; renderRepoSelect(); onChange(state.selected); return; }
      if (!state.selected.some((r) => r.isConfigRepo)) state.selected[0].isConfigRepo = true;
      selEl.innerHTML = state.selected.map((r, i) => `<div class="repo-sel-row" data-i="${i}">
          <span class="repo-name">${esc(r.repo)}${r.private ? ' <span class="badge badge-warn">private</span>' : ""}</span>
          <select class="select mono" data-branch title="branch" style="width:120px">${(state.branches[r.repo] || [r.branch || r.defaultBranch || "main"]).map((b) => `<option ${b === (r.branch || r.defaultBranch) ? "selected" : ""}>${esc(b)}</option>`).join("")}</select>
          <select class="select" data-role>${ROLES.map((x) => `<option ${x === (r.role || (i === 0 ? "primary" : "other")) ? "selected" : ""}>${x}</option>`).join("")}</select>
          <label class="cfg" title="Holds the .ai-engineering config folder"><input type="radio" name="rp-cfg" data-cfg ${r.isConfigRepo ? "checked" : ""}/> config</label>
          <button class="btn btn-ghost" data-remove title="Remove">✕</button>
        </div>`).join("");
      renderRepoSelect();
      onChange(state.selected);
    };
    const toggle = (full, meta = {}) => {
      const idx = state.selected.findIndex((r) => r.repo.toLowerCase() === full.toLowerCase());
      if (idx >= 0) state.selected.splice(idx, 1);
      else state.selected.push({ repo: full, branch: meta.defaultBranch || "main", role: state.selected.length ? "other" : "primary", isConfigRepo: state.selected.length === 0, private: meta.private, defaultBranch: meta.defaultBranch, htmlUrl: meta.htmlUrl });
      renderList(); renderSelected(); fetchBranches(full);
    };
    const load = async () => {
      list.innerHTML = `<div class="repo-empty">Loading repositories…</div>`;
      const r = await apiRaw("/github/repositories?limit=500");
      if (!r.ok) {
        state.repos = []; state.error = (r.body && (r.body.error || r.body.message)) || `HTTP ${r.status}`;
        hintEl.className = "field-hint err";
        hintEl.innerHTML = esc(r.body?.hint || "Could not load repositories.") + (r.status === 401 ? ` <a href="/auth/github/login?next=${encodeURIComponent(location.hash)}">Login with GitHub</a>` : "");
        renderList(); return;
      }
      const body = r.body || {};
      state.repos = Array.isArray(body) ? body : (body.repositories || []);
      state.source = body.source || "";
      const srcLabel = { "user-oauth": "your GitHub account", "server-token": "server token (GITHUB_TOKEN)", mock: "demo/mock data" }[state.source] || state.source;
      hintEl.className = "field-hint" + (state.source === "mock" ? " warn" : "");
      hintEl.innerHTML = `${state.repos.length} repositories · source: <strong>${esc(srcLabel)}</strong>${body.hint ? ` — ${esc(body.hint)}` : ""}` +
        (state.source !== "user-oauth" && authState.loginConfigured ? ` <a href="/auth/github/login?next=${encodeURIComponent(location.hash)}">Login with GitHub</a>` : "");
      renderList();
    };
    list.addEventListener("click", (e) => {
      const row = e.target.closest(".repo-row"); if (!row) return;
      const meta = state.repos.find((r) => r.fullName === row.dataset.full) || {};
      toggle(row.dataset.full, meta);
    });
    if (repoSelect) repoSelect.addEventListener("change", () => {
      const full = repoSelect.value;
      if (!full) return;
      const meta = state.repos.find((r) => r.fullName === full) || {};
      toggle(full, meta);
    });
    search.addEventListener("input", renderList);
    $("#rp-refresh", root).onclick = load;
    $("#rp-manual-add", root).onclick = () => {
      const v = $("#rp-manual", root).value.trim();
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) { toast("Invalid repository", "Use the owner/name format", "err"); return; }
      if (!isSel(v)) toggle(v); $("#rp-manual", root).value = "";
    };
    $("#rp-new-go", root).onclick = async () => {
      const name = $("#rp-new-name", root).value.trim();
      if (!name) { toast("Repository name required", "", "err"); return; }
      const btn = $("#rp-new-go", root); btn.disabled = true;
      try {
        const r = await api("/github/repositories", { method: "POST", body: { name, description: $("#rp-new-desc", root).value.trim(), private: $("#rp-new-priv", root).checked, autoInit: true } });
        const repo = r.repository || r;
        if (!isSel(repo.fullName || `${repo.owner || "mock-user"}/${repo.name}`)) {
          toggle(repo.fullName || `${repo.owner || "mock-user"}/${repo.name}`, { defaultBranch: repo.defaultBranch, private: repo.private, htmlUrl: repo.htmlUrl });
        }
        state.repos = state.repos.filter((x) => x.fullName !== (repo.fullName || `${repo.owner}/${repo.name}`));
        state.repos.unshift(repo);
        renderList();
        toast("Repository created", repo.fullName || "", "ok");
      } catch (e) { toast("Create failed", e.message, "err"); }
      finally { btn.disabled = false; $("#rp-new-name", root).value = ""; }
    };
    selEl.addEventListener("click", (e) => {
      const row = e.target.closest(".repo-sel-row"); if (!row) return;
      const i = Number(row.dataset.i);
      if (e.target.closest("[data-remove]")) { state.selected.splice(i, 1); renderList(); renderSelected(); }
    });
    selEl.addEventListener("change", (e) => {
      const row = e.target.closest(".repo-sel-row"); if (!row) return;
      const r = state.selected[Number(row.dataset.i)]; if (!r) return;
      if (e.target.matches("[data-branch]")) r.branch = e.target.value.trim() || "main";
      if (e.target.matches("[data-role]")) r.role = e.target.value;
      if (e.target.matches("[data-cfg]")) { state.selected.forEach((x) => (x.isConfigRepo = false)); r.isConfigRepo = true; }
      onChange(state.selected);
    });
    renderSelected();
    load();
    return { get selected() { return state.selected; } };
  }

  async function openProjectModal() {
    openModal("Create Project", `<div class="repo-empty">Loading options…</div>`);
    let catalog;
    try { catalog = await loadOptionCatalog(); } catch (e) { $("#modal-body").innerHTML = `<div class="error-state"><h4>Could not load options</h4><pre>${esc(e.message)}</pre></div>`; return; }
    const singleKeys = new Set(catalog.singleSelectKeys || ["databases"]);
    const groups = CAPABILITY_GROUPS.map(([k, label, ph]) => chipGroupHtml(k, label, catalog[k] || [], [], { placeholder: ph, single: singleKeys.has(k) })).join("");
    const agentGroup = chipGroupHtml("agentTypes", "Agents to generate", catalog.agentTypes || [], [], {
      core: catalog.coreAgentTypes || [], allowCustom: false,
      hint: "Leave empty to let the platform pick agents from the selected stack. Core agents are always included.",
    });
    $("#modal-body").innerHTML = `
      <div class="field"><label>Name</label><input class="input" id="pj-name" placeholder="Accounting System"/></div>
      <div class="field"><label>Description</label><textarea class="textarea" id="pj-desc" placeholder="A .NET + SQL Server accounting system…"></textarea></div>
      <div class="field"><label>GitHub Repositories <span class="select-count">pick one or more · the “config” repo stores .ai-engineering</span></label>${repoPickerHtml()}</div>
      ${groups}
      ${agentGroup}
      <div class="flex mt"><button class="btn btn-primary" id="pj-submit">Create & Onboard</button><button class="btn" onclick="closeModal()">Cancel</button><span class="field-hint" id="pj-status"></span></div>`;
    const body = $("#modal-body");
    bindChipGroups(body);
    const picker = mountRepoPicker($("#repo-picker", body));
    $("#pj-submit").onclick = async () => {
      const name = $("#pj-name").value.trim();
      if (!name) { toast("Name required", "Give the project a name", "err"); $("#pj-name").focus(); return; }
      if (!picker.selected.length) { toast("Repository required", "Select at least one GitHub repository", "err"); return; }
      const caps = readChipGroups(body);
      const btn = $("#pj-submit"); btn.disabled = true; $("#pj-status").textContent = "Creating project & generating agents…";
      try {
        const p = await api("/projects", { method: "POST", body: {
          name, description: $("#pj-desc").value,
          repositories: picker.selected.map((r) => ({ repo: r.repo, branch: r.branch, role: r.role, isConfigRepo: !!r.isConfigRepo, private: r.private, defaultBranch: r.defaultBranch, htmlUrl: r.htmlUrl })),
          capabilities: caps,
        }});
        closeModal(); toast("Project created", `${p.name} — ${p.agents ?? 0} agents ready`, "ok");
        location.hash = "#/projects/" + p.id;
      } catch (e) { toast("Could not create project", e.message, "err"); btn.disabled = false; $("#pj-status").textContent = ""; }
    };
  }
  window.openProjectModal = openProjectModal;

  /* PROJECT DETAIL */
  const capLabel = (catalog, key, id) => ((catalog && catalog[key]) || []).find((o) => (o.value ?? o.id) === id)?.label || id;
  on("/projects/:id", async (rest) => {
    const id = rest[0];
    const p = await api("/projects/" + id);
    const [agents, tasks, runs, workflows, catalog] = await Promise.all([
      api(`/projects/${id}/agents`).catch(() => []),
      api(`/projects/${id}/tasks`).catch(() => []),
      api(`/projects/${id}/runs`).catch(() => []),
      api(`/projects/${id}/workflows`).catch(() => []),
      loadOptionCatalog().catch(() => null),
    ]);
    const caps = p.capabilities || {};
    const repos = p.repositories || [{ repo: p.configRepo, branch: p.branch, role: "primary", isConfigRepo: true }];
    const capRows = CAPABILITY_GROUPS.map(([k, label]) => {
      const vals = caps[k] || [];
      return `<div class="meter-row"><span class="lbl">${esc(label)}</span><span style="flex:1;display:flex;flex-wrap:wrap;gap:4px">${vals.length ? vals.map((v) => `<span class="badge badge-info">${esc(capLabel(catalog, k, v))}</span>`).join("") : '<span class="badge badge-muted">—</span>'}</span></div>`;
    }).join("");
    const connKind = p.githubConnection?.kind ? ({ "user-oauth": `GitHub account${p.githubConnection.login ? " @" + p.githubConnection.login : ""}`, "server-token": "server token", mock: "mock/demo" }[p.githubConnection.kind] || p.githubConnection.kind) : "—";
    $("#content").innerHTML = `
      <div class="overview"><div><h1>${esc(p.name)} ${p.active ? '<span class="badge badge-ok">active</span>' : '<span class="badge badge-muted">inactive</span>'}</h1><p>${esc(p.description)}</p></div>
        <div class="action-row">
          <button class="btn btn-primary" onclick="projectAsk(${JSON.stringify(p.id)})">❓ Ask AI</button>
          <button class="btn" onclick="projectRun(${JSON.stringify(p.id)})">▶ Run Agent</button>
          <button class="btn" onclick="projectTask(${JSON.stringify(p.id)})">＋ Create Task</button>
          <button class="btn" onclick="projectWorkflow(${JSON.stringify(p.id)})">🔀 Run Workflow</button>
          <button class="btn" onclick="projectDryRun(${JSON.stringify(p.id)})">🧪 Dry Run</button>
          <button class="btn" onclick="projectRules(${JSON.stringify(p.id)})">📏 Rules</button>
          <button class="btn" onclick="projectReonboard(${JSON.stringify(p.id)})">🔎 Detect & Agent.md</button>
          <button class="btn" onclick="projectEdit(${JSON.stringify(p.id)})">⚙ Edit</button>
        </div></div>
      <div class="stat-grid">
        <div class="card stat"><div class="stat-label">Config repository</div><div class="stat-value" style="font-size:16px">${esc(p.configRepo)}</div><div class="stat-sub">${esc(p.branch)} · ${repos.length} repo${repos.length === 1 ? "" : "s"} linked</div></div>
        <div class="card stat"><div class="stat-label">Agents</div><div class="stat-value">${agents.filter((a) => a.enabled).length}<span class="stat-sub"> / ${agents.length}</span></div></div>
        <div class="card stat"><div class="stat-label">Tasks</div><div class="stat-value">${tasks.length}</div></div>
        <div class="card stat"><div class="stat-label">Runs</div><div class="stat-value">${runs.length}</div></div>
      </div>
      <div class="grid-2">
        <div class="card card-body">
          <div class="card-title">Repositories <span class="sub">GitHub: ${esc(connKind)}</span></div>
          <div class="table-wrap"><table><thead><tr><th>Repository</th><th>Branch</th><th>Role</th><th></th><th></th></tr></thead><tbody>
          ${repos.map((r) => `<tr><td class="mono">${r.htmlUrl ? `<a href="${esc(r.htmlUrl)}" target="_blank" rel="noopener">${esc(r.repo)}</a>` : esc(r.repo)} ${r.private ? '<span class="badge badge-warn">private</span>' : ""}</td><td class="mono">${esc(r.branch)}</td><td><span class="badge badge-muted">${esc(r.role || "primary")}</span></td><td>${r.isConfigRepo ? '<span class="badge badge-ok" title=".ai-engineering lives here">config</span>' : ""}</td><td style="text-align:right">${repos.length > 1 ? `<button class="btn btn-ghost" title="Unlink" onclick="projectUnlinkRepo(${JSON.stringify(p.id)}, ${JSON.stringify(r.repo)})">✕</button>` : ""}</td></tr>`).join("")}
          </tbody></table></div>
          <div class="flex mt"><button class="btn" onclick="projectAddRepo(${JSON.stringify(p.id)})">＋ Link repository</button></div>
        </div>
        <div class="card card-body">
          <div class="card-title">Stack & capabilities <a class="sub" href="#" onclick="projectEdit(${JSON.stringify(p.id)});return false">edit</a></div>
          ${capRows}
          <div class="meter-row"><span class="lbl">Agent roster</span><span style="flex:1;display:flex;flex-wrap:wrap;gap:4px">${(caps.agentTypes || []).length ? caps.agentTypes.map((v) => `<span class="badge badge-muted">${esc(capLabel(catalog, "agentTypes", v))}</span>`).join("") : '<span class="badge badge-muted">auto (derived from stack)</span>'}</span></div>
          <div class="meter-row"><span class="lbl">Detected skills</span><span style="flex:1;display:flex;flex-wrap:wrap;gap:4px">${(p.settings?.skills || []).length ? p.settings.skills.map((v) => `<span class="badge badge-info">${esc(v)}</span>`).join("") : '<span class="badge badge-muted">—</span>'}</span></div>
        </div>
      </div>
      <div class="grid-2 mt">
        <div class="card card-body">
          <div class="card-title">Agents <a href="#/agents" class="sub">manage</a></div>
          <div class="table-wrap"><table><thead><tr><th>Type</th><th>Name</th><th>Status</th></tr></thead><tbody>
          ${agents.map((a) => `<tr><td class="mono">${esc(a.type)}</td><td>${esc(a.name)}</td><td>${a.enabled ? '<span class="badge badge-ok">enabled</span>' : '<span class="badge badge-muted">disabled</span>'}</td></tr>`).join("")}
          </tbody></table></div>
        </div>
        <div class="card card-body">
          <div class="card-title">Workflows</div>
          ${workflows.length ? workflows.map((w) => `<div class="list-row"><span>🔀</span><div><strong>${esc(w.name)}</strong><div class="mono" style="color:var(--text-muted)">${esc(w.slug)} · v${w.version}</div></div><span class="spacer"></span>${w.enabled ? '<span class="badge badge-ok">enabled</span>' : '<span class="badge badge-muted">disabled</span>'}</div>`).join("") : emptyState("🔀", "No workflows yet", "Define a workflow to orchestrate agents.")}
        </div>
      </div>
      <div class="card card-body mt">
        <div class="card-title">Recent Runs</div>
        ${runs.length ? `<div class="table-wrap"><table><thead><tr><th>Run</th><th>Agent</th><th>Status</th><th>Tokens</th><th>Cost</th><th>Duration</th><th></th></tr></thead><tbody>
          ${runs.slice(0,10).map((r) => `<tr><td class="mono">${r.id.slice(0,8)}</td><td>${esc(r.agentType)}</td><td>${badge(r.status)}</td><td>${r.totalTokens}</td><td>${money(r.costUsd)}</td><td>${r.durationMs}ms</td><td><a class="btn btn-ghost" href="#/runs/${r.id}/console">Console</a></td></tr>`).join("")}
        </tbody></table></div>` : emptyState("▶️", "No runs yet", "Ask the AI or run an agent to see executions here.")}
      </div>`;
  });
  window.projectDryRun = (id) => {
    openModal("Dry Run — preview without changing anything", `<div class="field"><label>What should the agent do?</label><textarea class="textarea" id="dry-text" placeholder="Fix the login bug after the last commit"></textarea></div><div class="flex"><button class="btn btn-primary" id="dry-go">Preview plan</button><button class="btn" onclick="closeModal()">Close</button></div><div id="dry-out" class="mt"></div>`);
    $("#dry-go").onclick = async () => {
      const text = $("#dry-text").value.trim();
      if (!text) return;
      const r = await api(`/projects/${id}/dry-run`, { method: "POST", body: { title: text.slice(0, 80), description: text } });
      $("#dry-out").innerHTML = `<div class="card card-body"><div class="card-title">${esc(r.agent.name)} <span class="sub">${esc(r.agent.type)} · model ${esc(r.model.primary || "auto")} · ${r.approvalsNeeded} approval(s) needed · context ≈ ${r.context ? r.context.tokens : "?"} tokens</span></div>
        <div class="steps">${r.plan.map((s) => `<div class="step pending"><div class="step-ico">${s.requiresApproval ? "🛑" : "○"}</div><div><div class="step-label">${s.index + 1}. ${esc(s.label)}</div>${s.tool ? `<div class="step-detail mono">tool: ${esc(s.tool)}</div>` : ""}</div></div>`).join("")}</div>
        ${r.writes.length ? `<p class="mt"><strong>Would write to the repository via:</strong> ${r.writes.map((w) => `<span class="badge badge-warn">${esc(w.tool)}</span>`).join(" ")}</p>` : `<p class="mt">No repository writes.</p>`}
        <p style="color:var(--text-muted);font-size:12px">Budget: ${r.budget.maxTokensPerRun} tokens · $${r.budget.maxCostUsdPerRun} · ${r.budget.maxDurationMs}ms per run</p></div>`;
    };
  };
  window.projectRules = async (id) => {
    const rules = await api(`/projects/${id}/rules`);
    const manual = rules.filter((r) => !r.discovered);
    const discovered = rules.filter((r) => r.discovered);
    openModal("Project Rules — injected into every agent prompt", `
      <div class="field"><label>Your rules (one block per line; Markdown ok)</label><textarea class="textarea" id="rules-text" style="min-height:160px">${esc(manual.map((r) => r.text).join("\n"))}</textarea></div>
      <div class="flex"><button class="btn btn-primary" id="rules-save">Save</button><button class="btn" id="rules-rediscover">🔎 Re-discover from repository</button><button class="btn" onclick="closeModal()">Close</button></div>
      <div class="card-title mt">Discovered automatically <span class="sub">${discovered.length} block(s) from README / CONTRIBUTING / CODEOWNERS / .editorconfig / build files / CI</span></div>
      ${discovered.length ? discovered.map((r) => `<pre style="white-space:pre-wrap;background:var(--glass);padding:10px;border-radius:8px;border:1px solid var(--border);font-size:12px">${esc(r.text)}</pre>`).join("") : emptyState("📏", "Nothing discovered yet", "Run Detect & Agent.md to scan the repository.")}`);
    $("#rules-save").onclick = async () => {
      const lines = $("#rules-text").value.split("\n").map((l) => l.trim()).filter(Boolean);
      await api(`/projects/${id}/rules`, { method: "PUT", body: { rules: lines } });
      toast("Rules saved", `${lines.length} rule(s)`, "ok"); closeModal();
    };
    $("#rules-rediscover").onclick = async () => {
      await api(`/projects/${id}/onboard`, { method: "POST", body: {} });
      toast("Rules re-discovered", "", "ok"); closeModal(); window.projectRules(id);
    };
  };
  window.projectAsk = (id) => {
    openModal("Ask AI on Project", `<div class="field"><label>Prompt</label><textarea class="textarea" id="ask-prompt" placeholder="بررسی کن چرا Login بعد از آخرین Commit خراب شده"></textarea></div><div class="flex"><button class="btn btn-primary" id="ask-go">Submit</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    $("#ask-go").onclick = async () => {
      const prompt = $("#ask-prompt").value.trim();
      if (!prompt) { toast("Prompt required", "", "err"); return; }
      try {
        const r = await api(`/projects/${id}/ask`, { method: "POST", body: { title: prompt.slice(0, 80), description: prompt } });
        closeModal(); toast("Request queued", `Task ${r.task.id.slice(0, 8)} → agent ${r.task.agentType || "auto"}`, "ok"); refreshCurrent();
      } catch (e) { toast("Error", e.message, "err"); }
    };
  };
  window.projectRun = async (id) => {
    const agents = await api(`/projects/${id}/agents`).catch(() => []);
    const enabled = agents.filter((a) => a.enabled);
    openModal("Run Agent", `<div class="field"><label>Agent</label><select class="select" id="pa-type">${enabled.map((a) => `<option value="${esc(a.type)}">${esc(a.name)} (${esc(a.type)})</option>`).join("") || '<option value="">(no enabled agents)</option>'}</select></div><div class="field"><label>Task title</label><input class="input" id="pa-title" value="Analyze project"/></div><div class="field"><label>Instructions</label><textarea class="textarea" id="pa-desc" placeholder="What should the agent do?"></textarea></div><div class="flex"><button class="btn btn-primary" id="pa-go">Run</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    $("#pa-go").onclick = async () => {
      const agentType = $("#pa-type").value;
      if (!agentType) { toast("No agent", "Enable an agent for this project first", "err"); return; }
      try {
        const title = $("#pa-title").value.trim() || "Analyze project";
        const r = await api(`/projects/${id}/ask`, { method: "POST", body: { title, description: $("#pa-desc").value.trim() || title, agentType } });
        closeModal(); toast("Agent run queued", `${agentType} · task ${r.task.id.slice(0, 8)}`, "ok"); refreshCurrent();
      } catch (e) { toast("Error", e.message, "err"); }
    };
  };
  window.projectTask = (id) => {
    openModal("Create Task", `<div class="field"><label>Title</label><input class="input" id="pt-title"/></div><div class="field"><label>Description</label><textarea class="textarea" id="pt-desc"></textarea></div><div class="field"><label>Priority</label><select class="select" id="pt-prio">${["low","medium","high","critical"].map((x) => `<option ${x === "medium" ? "selected" : ""}>${x}</option>`).join("")}</select></div><div class="flex"><button class="btn btn-primary" id="pt-go">Create</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    $("#pt-go").onclick = async () => {
      const title = $("#pt-title").value.trim();
      if (!title) { toast("Title required", "", "err"); return; }
      try {
        const t = await api("/tasks", { method: "POST", body: { projectId: id, title, description: $("#pt-desc").value, priority: $("#pt-prio").value } });
        closeModal(); toast("Task created", t.title, "ok"); refreshCurrent();
      } catch (e) { toast("Error", e.message, "err"); }
    };
  };
  window.projectWorkflow = async (id) => {
    const wfs = await api(`/projects/${id}/workflows`).catch(() => []);
    openModal("Run Workflow", `<div class="field"><label>Workflow</label><select class="select" id="pw-id">${wfs.map((w) => `<option value="${esc(w.id)}">${esc(w.name)} (v${w.version})</option>`).join("") || '<option value="">(no workflows for this project)</option>'}</select></div><div class="field"><label>Description</label><textarea class="textarea" id="pw-desc" placeholder="Run QA on last commit"></textarea></div><div class="flex"><button class="btn btn-primary" id="pw-go">Run</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    $("#pw-go").onclick = async () => {
      const workflowId = $("#pw-id").value;
      if (!workflowId) { toast("No workflow", "Create a workflow for this project first", "err"); return; }
      try {
        const desc = $("#pw-desc").value.trim() || "Run workflow";
        await api(`/workflows/${workflowId}/run`, { method: "POST", body: { projectId: id, title: desc.slice(0, 80), description: desc } });
        closeModal(); toast("Workflow started", "", "ok"); refreshCurrent();
      } catch (e) { toast("Error", e.message, "err"); }
    };
  };
  window.projectAddRepo = (id) => {
    openModal("Link repository", `<div class="field"><label>Pick from GitHub</label>${repoPickerHtml()}</div><div class="flex mt"><button class="btn btn-primary" id="par-go">Link selected</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    const picker = mountRepoPicker($("#repo-picker"));
    $("#par-go").onclick = async () => {
      if (!picker.selected.length) { toast("Nothing selected", "", "err"); return; }
      try {
        for (const r of picker.selected) {
          await api(`/projects/${id}/repositories`, { method: "POST", body: { repo: r.repo, branch: r.branch, role: r.role, isConfigRepo: false, private: r.private, defaultBranch: r.defaultBranch, htmlUrl: r.htmlUrl } });
        }
        closeModal(); toast("Repositories linked", picker.selected.map((r) => r.repo).join(", "), "ok"); refreshCurrent();
      } catch (e) { toast("Error", e.message, "err"); }
    };
  };
  window.projectUnlinkRepo = async (id, repo) => {
    if (!confirm(`Unlink ${repo} from this project?`)) return;
    try { await api(`/projects/${id}/repositories/${repo}`, { method: "DELETE" }); toast("Repository unlinked", repo, "ok"); refreshCurrent(); }
    catch (e) { toast("Error", e.message, "err"); }
  };
  window.projectReonboard = async (id) => {
    openModal("Detecting project", `<div class="repo-empty">Reading GitHub repo, ensuring Agent.md and detecting skills…</div>`);
    try {
      const r = await api(`/projects/${id}/onboard`, { method: "POST", body: {} });
      closeModal(); toast("Project inspected", `Agents: ${r.agents} · Skills: ${r.skills} — Agent.md ensured`, "ok"); refreshCurrent();
    } catch (e) { closeModal(); toast("Detection failed", e.message, "err"); }
  };
  window.projectEdit = async (id) => {
    openModal("Edit project", `<div class="repo-empty">Loading…</div>`);
    const [p, catalog] = await Promise.all([api("/projects/" + id), loadOptionCatalog()]);
    const caps = p.capabilities || {};
    $("#modal-body").innerHTML = `
      <div class="field"><label>Name</label><input class="input" id="pe-name" value="${esc(p.name)}"/></div>
      <div class="field"><label>Description</label><textarea class="textarea" id="pe-desc">${esc(p.description || "")}</textarea></div>
      ${CAPABILITY_GROUPS.map(([k, label, ph]) => chipGroupHtml(k, label, catalog[k] || [], caps[k] || [], { placeholder: ph, single: new Set(catalog.singleSelectKeys || ["databases"]).has(k) })).join("")}
      ${chipGroupHtml("agentTypes", "Agents to generate", catalog.agentTypes || [], caps.agentTypes || [], { core: catalog.coreAgentTypes || [], allowCustom: false, hint: "Saving re-runs onboarding: generated system prompts are refreshed with the new stack, agents outside the roster are disabled (never deleted)." })}
      <div class="flex mt"><button class="btn btn-primary" id="pe-save">Save & re-onboard</button><button class="btn" onclick="closeModal()">Cancel</button></div>`;
    bindChipGroups($("#modal-body"));
    $("#pe-save").onclick = async () => {
      try {
        await api("/projects/" + id, { method: "PATCH", body: { name: $("#pe-name").value, description: $("#pe-desc").value, capabilities: readChipGroups($("#modal-body")) } });
        closeModal(); toast("Project updated", "Agents regenerated for the new stack", "ok"); refreshCurrent();
      } catch (e) { toast("Error", e.message, "err"); }
    };
  };

  /* AGENTS (global) */
  on("/agents", async () => {
    const list = await api("/agents");
    $("#content").innerHTML = `
      <div class="overview"><div><h1>Agents</h1><p>Agent registry — search, categorize, enable/disable</p></div></div>
      ${searchPanelHtml("agent-search", "Search agents by name, type, role, model, project, skill or permission…")}
      <div class="card card-body"><div class="table-wrap"><table><thead><tr><th>Type</th><th>Name</th><th>Role</th><th>Model</th><th>Status</th><th>Project</th></tr></thead>
      <tbody id="agent-tbody"></tbody></table></div></div>`;
    bindSearchPanel("agent-search", list, agentRows, "#agent-tbody", "agent", { emptyHtml: () => `<tr><td colspan="6">${emptyState("🔎", "No matching agents", "Try searching by type, role, model, skill or status.")}</td></tr>` });
  });
  function agentRows(list) {
    if (!list.length) return `<tr><td colspan="6">${emptyState("🤖", "No agents", "Create a project to auto-generate an agent roster.")}</td></tr>`;
    return list.map((a) => `<tr>
      <td><a href="#/agents/${a.id}"><span class="badge badge-info">${esc(a.type)}</span></a></td>
      <td><strong>${esc(a.name)}</strong></td><td>${esc(a.role)}</td>
      <td class="mono">${(a.models && (a.models.primary || "—"))}</td>
      <td>${a.enabled ? '<span class="badge badge-ok">enabled</span>' : '<span class="badge badge-muted">disabled</span>'}</td>
      <td class="mono">${(a.projectId || "—").slice(0,12)}</td></tr>`).join("");
  }

  /* AGENT DETAIL */
  on("/agents/:id", async (rest) => {
    const id = rest[0];
    const a = await api("/agents/" + id);
    $("#content").innerHTML = `
      <div class="overview"><div><h1>${esc(a.name)}</h1><p>${esc(a.role)} — ${esc(a.type)}</p></div>
        <div class="action-row">
          ${a.enabled ? `<button class="btn" id="toggle-agent">Disable</button>` : `<button class="btn btn-primary" id="toggle-agent">Enable</button>`}
          <button class="btn btn-primary" onclick="editPrompt('${a.id}')">✏️ Edit Prompt</button>
        </div></div>
      <div class="grid-2">
        <div class="card card-body">
          <div class="card-title">Description</div>
          <p>${esc(a.description)}</p>
          <div class="card-title">System Prompt</div>
          <pre style="white-space:pre-wrap;background:var(--glass);padding:12px;border-radius:8px;border:1px solid var(--border)">${esc(a.systemPrompt)}</pre>
        </div>
        <div class="card card-body">
          <div class="card-title">Configuration</div>
          <div class="meter-row"><span class="lbl">Version</span><span class="val">v${a.version}</span></div>
          <div class="meter-row"><span class="lbl">Max iterations</span><span class="val">${a.maxIterations}</span></div>
          <div class="meter-row"><span class="lbl">Timeout</span><span class="val">${a.timeoutMs}ms</span></div>
          <div class="meter-row"><span class="lbl">Token budget</span><span class="val">${a.tokenBudget}</span></div>
          <div class="card-title mt">Models</div>
          <p class="mono">Primary: ${a.models?.primary || "—"}</p>
          ${a.models?.falbacks ? "" : ""}
          <div class="card-title mt">Skills</div>
          <div class="flex" style="flex-wrap:wrap">${(a.skills||[]).map((s) => `<span class="badge badge-muted">${esc(s)}</span>`).join(" ") || "—"}</div>
          <div class="card-title mt">Permissions</div>
          <div class="flex" style="flex-wrap:wrap">${(a.permissions||[]).map((s) => `<span class="badge badge-info">${esc(s)}</span>`).join(" ") || "—"}</div>
        </div>
      </div>`;
    $("#toggle-agent").onclick = async () => {
      const act = a.enabled ? "disable" : "enable";
      await api(`/agents/${id}/${act}`, { method: "POST" });
      toast("Agent updated", a.name, "ok"); refreshCurrent();
    };
    // Prompt version history (compare / restore / clone)
    const versions = await api(`/agents/${id}/prompt-versions`).catch(() => []);
    const panel = document.createElement("div");
    panel.className = "card card-body mt";
    panel.innerHTML = `<div class="card-title">Prompt Versions <span class="sub">${versions.length} version(s) — every edit is kept, restore never rewrites history</span></div>
      <div class="table-wrap"><table><thead><tr><th>Version</th><th>Source</th><th>Note</th><th>Created</th><th></th></tr></thead><tbody>
      ${versions.slice().reverse().map((v) => `<tr><td class="mono">v${v.version} ${v.current ? '<span class="badge badge-ok">current</span>' : ""}</td><td>${esc(v.source)}${v.derivedFrom ? ` <span class="badge badge-muted">from v${v.derivedFrom}</span>` : ""}</td><td>${esc(v.note || "—")}</td><td>${timeAgo(v.createdAt)}</td>
        <td style="white-space:nowrap"><button class="btn btn-ghost" onclick="promptDiff('${id}', ${v.version})">Diff vs current</button>${v.current ? "" : `<button class="btn btn-ghost" onclick="promptRestore('${id}', ${v.version})">Restore</button>`}</td></tr>`).join("") || `<tr><td colspan="5">${emptyState("📝", "No versions yet", "Edit the prompt to create v1.")}</td></tr>`}
      </tbody></table></div>`;
    $("#content").appendChild(panel);
  });
  window.promptDiff = async (id, from) => {
    const d = await api(`/agents/${id}/prompt-versions/diff?from=${from}&to=current`);
    openModal(`Diff v${d.from} → ${d.to}`, `<p class="mono" style="color:var(--text-muted)">+${d.summary.added} / −${d.summary.removed} / ${d.summary.unchanged} unchanged</p>
      <pre class="diff" style="max-height:60vh;overflow:auto;background:var(--glass);padding:12px;border-radius:8px;border:1px solid var(--border);font-size:12px">${d.lines.map((l) => `<div class="diff-${l.type}">${l.type === "added" ? "+" : l.type === "removed" ? "−" : " "} ${esc(l.text)}</div>`).join("")}</pre>`);
  };
  window.promptRestore = async (id, version) => {
    if (!confirm(`Restore prompt v${version}? A new version will be created.`)) return;
    await api(`/agents/${id}/prompt-versions/${version}/restore`, { method: "POST" });
    toast("Prompt restored", `from v${version}`, "ok"); refreshCurrent();
  };
  window.editPrompt = async (id) => {
    const a = await api("/agents/" + id);
    openModal("Edit System Prompt", `<div class="field"><label>System Prompt</label><textarea class="textarea" id="prompt-text" style="min-height:220px">${esc(a.systemPrompt)}</textarea></div><div class="field"><label>Save as</label><input class="input" id="prompt-version" value="v${a.version+1}" readonly/></div><button class="btn btn-primary" id="prompt-save">Save (new version)</button>`);
    $("#prompt-save").onclick = async () => {
      await api("/agents/" + id, { method: "PATCH", body: { systemPrompt: $("#prompt-text").value } });
      closeModal(); toast("Prompt saved", "New version", "ok"); refreshCurrent();
    };
  };

  /* MODELS — grouped by provider, multi-select, streaming chat modal */
  // Selected model ids (survives re-renders of the Models page).
  const modelSelection = new Set();
  // Full model/provider caches for the Models page.
  let modelsCache = [];
  let providersCache = [];
  // Client-side search state. Kept outside the route so refreshes preserve the query.
  let modelSearchQuery = "";
  let modelVisibleCache = [];

  function providerNameOf(id) {
    return providersCache.find((p) => p.id === id)?.name || id || "Unknown provider";
  }
  // Group the flat model list into { providerId, name, models[] }, provider name ASC.
  function groupModelsByProvider(list) {
    const byProvider = new Map();
    for (const m of list) {
      const key = m.providerId || "__none__";
      if (!byProvider.has(key)) byProvider.set(key, []);
      byProvider.get(key).push(m);
    }
    return [...byProvider.entries()]
      .map(([providerId, models]) => ({
        providerId,
        name: providerNameOf(providerId),
        models: models.slice().sort((a, b) => String(a.modelId).localeCompare(String(b.modelId))),
        active: models.filter((m) => m.active).length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  on("/models", async () => {
    const [list, providers] = await Promise.all([api("/models"), api("/providers").catch(() => [])]);
    modelsCache = list;
    providersCache = providers;
    // Drop selections pointing at models that no longer exist.
    for (const id of [...modelSelection]) if (!list.some((m) => m.id === id)) modelSelection.delete(id);
    renderModelsPage();
  });

  function searchableModelText(m) {
    const caps = Object.entries(m.capabilities || {}).filter(([, enabled]) => enabled).map(([key]) => key).join(" ");
    const tags = Array.isArray(m.tags) ? m.tags.join(" ") : "";
    return [
      m.displayName, m.modelId, m.id, providerNameOf(m.providerId),
      m.active ? "active enabled" : "inactive disabled", caps, tags, m.notes,
    ].filter(Boolean).join(" ").toLowerCase();
  }

  function filteredModels() {
    const terms = modelSearchQuery.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return modelsCache;
    return modelsCache.filter((m) => {
      const haystack = searchableModelText(m);
      return terms.every((term) => haystack.includes(term));
    });
  }

  function renderModelsPage() {
    modelVisibleCache = filteredModels();
    const allGroups = groupModelsByProvider(modelsCache);
    const groups = groupModelsByProvider(modelVisibleCache);
    const hasModels = modelsCache.length > 0;
    const hasQuery = modelSearchQuery.trim().length > 0;
    $("#content").innerHTML = `<div class="overview">
        <div><h1>Models</h1><p>Model Registry — grouped by provider · ${modelsCache.length} model(s) in ${allGroups.length} group(s)</p></div>
        <div class="flex">
          <button class="btn" onclick="modelGroupsCollapseAll()">Collapse all</button>
          <button class="btn" onclick="modelGroupsExpandAll()">Expand all</button>
          <button class="btn" onclick="openModelGroups()">🗂 Groups</button>
          <button class="btn btn-primary" onclick="openModel()">＋ Add Model</button>
        </div>
      </div>
      <div class="card card-body model-search-card">
        <div class="model-search-row">
          <div class="model-search-box">
            <span class="model-search-icon">⌕</span>
            <input class="input" id="model-search" placeholder="Search models by name, ID, provider, capability, tag or status…" value="${esc(modelSearchQuery)}" autocomplete="off" oninput="modelSearch(this.value)"/>
          </div>
          <button class="btn btn-ghost" id="model-search-clear" onclick="modelSearchClear()" ${hasQuery ? "" : "disabled"}>Clear</button>
        </div>
        <div class="field-hint" id="model-search-summary">${modelSearchSummary()}</div>
      </div>
      <div id="model-bulkbar"></div>
      <div id="model-groups">${groups.map(renderProviderGroup).join("") || `<div class="card card-body">${emptyState(hasModels ? "🔎" : "🧠", hasModels ? "No matching models" : "No models", hasModels ? "Try a different search term or clear the filter." : "Add a model and attach it to a provider.")}</div>`}</div>`;
    renderBulkBar();
  }

  function modelSearchSummary() {
    const q = modelSearchQuery.trim();
    if (!modelsCache.length) return "No models in the registry yet.";
    if (!q) return `Showing all ${modelsCache.length} model(s). Search supports multiple words, provider names, capabilities like code or vision, and active/inactive status.`;
    return `Showing ${modelVisibleCache.length} of ${modelsCache.length} model(s) for “${esc(q)}”.`;
  }

  window.modelSearch = (value) => {
    modelSearchQuery = value || "";
    const input = $("#model-search");
    const start = input?.selectionStart ?? modelSearchQuery.length;
    const end = input?.selectionEnd ?? modelSearchQuery.length;
    modelVisibleCache = filteredModels();
    const groups = groupModelsByProvider(modelVisibleCache);
    const hasModels = modelsCache.length > 0;
    $("#model-groups").innerHTML = groups.map(renderProviderGroup).join("") || `<div class="card card-body">${emptyState(hasModels ? "🔎" : "🧠", hasModels ? "No matching models" : "No models", hasModels ? "Try a different search term or clear the filter." : "Add a model and attach it to a provider.")}</div>`;
    const summary = $("#model-search-summary");
    if (summary) summary.innerHTML = modelSearchSummary();
    const clear = $("#model-search-clear");
    if (clear) clear.disabled = !modelSearchQuery.trim();
    renderBulkBar();
    if (input) { input.focus(); try { input.setSelectionRange(start, end); } catch {} }
  };

  window.modelSearchClear = () => {
    modelSearchQuery = "";
    renderModelsPage();
    $("#model-search")?.focus();
  };

  /** One collapsible provider card holding its models. */
  function renderProviderGroup(g) {
    const allSelected = g.models.length > 0 && g.models.every((m) => modelSelection.has(m.id));
    const provider = providersCache.find((p) => p.id === g.providerId) || {};
    const inactive = g.models.length - g.active;
    const activePct = g.models.length ? Math.round((g.active / g.models.length) * 100) : 0;
    const caps = [...new Set(g.models.flatMap((m) => Object.entries(m.capabilities || {}).filter(([, on]) => on).map(([k]) => CAP_NAMES[k] || k)))].slice(0, 6);
    const groupId = esc(g.providerId);
    return `<section class="card model-group" data-provider="${groupId}">
      <div class="model-group-head">
        <div class="model-group-main" onclick="modelGroupToggle('${groupId}')" title="Collapse / expand this provider">
          <button class="chev-btn" type="button" aria-label="Collapse / expand"><span class="chev">▾</span></button>
          <div class="provider-avatar">${esc((g.name || "?").trim().slice(0, 1).toUpperCase())}</div>
          <div class="model-group-title">
            <strong>${esc(g.name)}</strong>
            <div class="model-group-sub">${esc(provider.type || provider.apiFormat || "provider")} ${provider.baseUrl ? `· ${esc(provider.baseUrl)}` : ""}</div>
          </div>
        </div>
        <div class="model-group-stats">
          <span class="badge badge-muted">${g.models.length} total</span>
          <span class="badge badge-ok">${g.active} active</span>
          ${inactive ? `<span class="badge badge-muted">${inactive} inactive</span>` : ""}
        </div>
        <div class="model-group-actions">
          <label class="model-check model-select-chip" title="Select visible models in this provider">
            <input type="checkbox" ${allSelected ? "checked" : ""} onchange="modelSelectProvider('${groupId}', this.checked)"/> Select
          </label>
          <button class="btn btn-ghost" onclick="openModelGroup('${groupId}')">Details</button>
        </div>
      </div>
      <div class="model-group-body">
        <div class="model-group-meta">
          <div class="model-active-meter" title="${activePct}% active"><span style="width:${activePct}%"></span></div>
          <div class="model-cap-strip">${caps.map((c) => `<span class="badge badge-muted">${esc(c)}</span>`).join(" ") || '<span class="badge badge-muted">no capabilities</span>'}</div>
        </div>
        <div class="model-card-grid">${g.models.map(renderModelCard).join("")}</div>
      </div>
    </section>`;
  }

  function renderModelCard(m) {
    const id = esc(m.id);
    const ctx = Number(m.contextWindow || 0);
    return `<article class="model-card ${modelSelection.has(m.id) ? "row-selected" : ""}" data-model="${id}">
      <div class="model-card-top">
        <label class="model-card-check" title="Select model"><input data-model-check type="checkbox" ${modelSelection.has(m.id) ? "checked" : ""} onchange="modelSelectOne('${id}', this.checked)"/></label>
        <div class="model-card-name">
          <strong>${esc(m.displayName || m.modelId)}</strong>
          <div class="mono model-id" title="${esc(m.modelId)}">${esc(m.modelId)}${tuningBadge(m)}</div>
        </div>
        ${m.active ? '<span class="badge badge-ok">active</span>' : '<span class="badge badge-muted">inactive</span>'}
      </div>
      <div class="model-card-facts">
        <span title="Context window">🧠 ${ctx ? ctx.toLocaleString() : "—"}</span>
        <span title="Priority">↕ ${Number(m.priority || 100)}</span>
        <span title="Cost per 1k tokens">${money(Number(m.inputCostPer1k || 0) + Number(m.outputCostPer1k || 0))}/1k</span>
      </div>
      <div class="model-card-caps">${capsBadges(m.capabilities) || '<span class="badge badge-muted">—</span>'}</div>
      <div class="model-card-actions">
        <button class="btn btn-ghost" onclick="openModelChat('${id}')">💬 Test</button>
        <button class="btn btn-ghost" onclick="openModelEdit('${id}')">✏️ Edit</button>
        <button class="btn btn-ghost" onclick="modelToggle('${id}', ${m.active ? "false" : "true"})">${m.active ? "Disable" : "Enable"}</button>
        <button class="btn btn-ghost danger-text" onclick="modelDelete('${id}')">🗑</button>
      </div>
    </article>`;
  }

  window.modelGroupsCollapseAll = () => $$(".model-group").forEach((el) => el.classList.add("collapsed"));
  window.modelGroupsExpandAll = () => $$(".model-group").forEach((el) => el.classList.remove("collapsed"));

  /** Small badge showing that a model carries per-model overrides. */
  function tuningBadge(m) {
    const bits = [];
    if (m.omitTemperature) bits.push("no temp");
    else if (typeof m.temperature === "number") bits.push("creativity " + m.temperature);
    if (typeof m.maxTokens === "number") bits.push("max " + m.maxTokens);
    return bits.length ? ` <span class="badge badge-info" title="Per-model overrides">⚙ ${esc(bits.join(" · "))}</span>` : "";
  }

  /* ---- Edit model — every field is editable, including the tuning that some
     provider routes require (e.g. a route that only accepts temperature 1.0). ---- */
  window.openModelEdit = async (id) => {
    let m;
    try { m = await api(`/models/${encodeURIComponent(id)}`); }
    catch (e) { toast("Error", e.message, "err"); return; }
    const providers = providersCache.length ? providersCache : await api("/providers").catch(() => []);
    const caps = m.capabilities || {};
    const capRow = (key, label) => `<label class="cap-toggle"><input type="checkbox" id="e-cap-${key}" ${caps[key] ? "checked" : ""}/> ${label}</label>`;
    openModal(`Edit Model — ${m.displayName || m.modelId}`, `
      <div class="grid-2">
        <div class="field"><label>Provider</label><select class="select" id="e-prov">${providers.map((p) => `<option value="${esc(p.id)}" ${p.id === m.providerId ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>
        <div class="field"><label>Display name</label><input class="input" id="e-name" value="${esc(m.displayName || "")}"/></div>
      </div>
      <div class="field"><label>Model ID <span class="select-count">exactly as the provider expects it</span></label><input class="input mono" id="e-mid" value="${esc(m.modelId || "")}"/></div>

      <div class="field"><label>Creativity (temperature) <span class="select-count">0.0 = precise &amp; repeatable · 1.0 = most creative</span></label>
        <div class="temp-row">
          <input type="range" class="temp-slider" id="e-temp-range" min="0" max="1" step="0.05" value="${typeof m.temperature === "number" ? m.temperature : 0.3}" ${typeof m.temperature === "number" ? "" : "disabled"}/>
          <input class="input temp-num" id="e-temp" placeholder="default" value="${typeof m.temperature === "number" ? m.temperature : ""}"/>
        </div>
        <div class="temp-scale"><span>0.0 precise</span><span>0.5 balanced</span><span>1.0 creative</span></div>
        <div class="field-hint" id="e-temp-desc"></div>
        <label class="cap-toggle" style="margin-top:6px"><input type="checkbox" id="e-omit" ${m.omitTemperature ? "checked" : ""}/> Do not send <span class="mono">temperature</span> at all</label>
        <div class="field-hint">Leave the box empty to use the provider default. If the provider says <em>"Supported values are between 1.0 and 1.0"</em>, set it to <strong>1</strong> (or tick the box above).</div>
      </div>
      <div class="field"><label>Max output tokens</label>
        <input class="input" id="e-maxtok" placeholder="provider default" value="${typeof m.maxTokens === "number" ? m.maxTokens : ""}"/>
        <div class="field-hint">Leave empty for the provider default.</div>
      </div>

      <div class="grid-2">
        <div class="field"><label>Context window</label><input class="input" id="e-ctx" value="${Number(m.contextWindow || 0)}"/></div>
        <div class="field"><label>Priority (lower = preferred)</label><input class="input" id="e-prio" value="${Number(m.priority || 100)}"/></div>
      </div>
      <div class="grid-2">
        <div class="field"><label>Input cost / 1k</label><input class="input" id="e-cin" value="${Number(m.inputCostPer1k || 0)}"/></div>
        <div class="field"><label>Output cost / 1k</label><input class="input" id="e-cout" value="${Number(m.outputCostPer1k || 0)}"/></div>
      </div>
      <div class="field"><label>Capabilities</label><div class="cap-grid">
        ${capRow("vision", "vision")}${capRow("tools", "tools")}${capRow("structuredOutput", "structured")}
        ${capRow("code", "code")}${capRow("reasoning", "reasoning")}${capRow("streaming", "streaming")}
      </div></div>
      <div class="grid-2">
        <div class="field"><label>Tags <span class="select-count">comma separated</span></label><input class="input" id="e-tags" value="${esc((m.tags || []).join(", "))}"/></div>
        <div class="field"><label>Status</label><select class="select" id="e-active"><option value="true" ${m.active ? "selected" : ""}>active</option><option value="false" ${m.active ? "" : "selected"}>inactive</option></select></div>
      </div>
      <div class="field"><label>Notes</label><textarea class="textarea" id="e-notes" rows="2" placeholder="e.g. this route only accepts temperature 1.0">${esc(m.notes || "")}</textarea></div>
      <div class="flex"><button class="btn" id="e-test">Test with these settings</button><button class="btn btn-primary" id="e-save">Save changes</button><button class="btn" onclick="closeModal()">Cancel</button></div>
      <div id="e-test-result"></div>`);

    // Slider ⇄ number box stay in sync; the label explains what the value does.
    const describeTemp = (v) => {
      if (v === "" || v === null || Number.isNaN(v)) return "Using the provider default creativity.";
      if (v <= 0.1) return `<strong>${v}</strong> — deterministic: same question, same answer. Best for code &amp; extraction.`;
      if (v <= 0.4) return `<strong>${v}</strong> — precise, slight variation. Good default for engineering tasks.`;
      if (v <= 0.7) return `<strong>${v}</strong> — balanced: some creativity, still focused.`;
      if (v < 1) return `<strong>${v}</strong> — creative and varied.`;
      return `<strong>${v}</strong> — maximum creativity (and the value some routes require).`;
    };
    const syncTemp = (from) => {
      const num = $("#e-temp");
      const range = $("#e-temp-range");
      if (from === "range") num.value = String(range.value);
      const raw = num.value.trim();
      const v = raw === "" ? "" : Number(raw);
      range.disabled = raw === "";
      if (raw !== "" && !Number.isNaN(v)) range.value = String(Math.min(1, Math.max(0, v)));
      $("#e-temp-desc").innerHTML = describeTemp(v);
    };
    $("#e-temp-range").addEventListener("input", () => syncTemp("range"));
    $("#e-temp").addEventListener("input", () => syncTemp("num"));
    syncTemp("num");

    // Read the tuning currently typed into the form (empty = clear the override).
    const formTuning = () => {
      const t = $("#e-temp").value.trim();
      const mt = $("#e-maxtok").value.trim();
      return {
        temperature: t === "" ? null : Number(t),
        maxTokens: mt === "" ? null : Number(mt),
        omitTemperature: $("#e-omit").checked,
      };
    };
    $("#e-test").onclick = async () => {
      const el = $("#e-test-result");
      const tune = formTuning();
      el.innerHTML = `<div class="test-result">Sending a test message with these settings…</div>`;
      try {
        const r = await api(`/models/${encodeURIComponent(id)}/test`, { method: "POST", body: {
          message: MODEL_TEST_MSG,
          ...(typeof tune.temperature === "number" && !Number.isNaN(tune.temperature) ? { temperature: tune.temperature } : {}),
          ...(typeof tune.maxTokens === "number" && !Number.isNaN(tune.maxTokens) ? { maxTokens: tune.maxTokens } : {}),
          omitTemperature: tune.omitTemperature,
        }});
        showTestVerdict(r, { modelId: id, title: r.ok ? "✓ Model replied" : "✗ Model test failed" });
      } catch (e) {
        showTestVerdict({ ok: false, message: e.message, hint: e.body?.hint, status: e.status }, { modelId: id, title: "✗ Model test failed" });
      }
    };
    $("#e-save").onclick = async () => {
      const tune = formTuning();
      if (tune.temperature !== null && (Number.isNaN(tune.temperature) || tune.temperature < 0 || tune.temperature > 1)) {
        toast("Invalid creativity", "Temperature must be between 0.0 and 1.0, or leave it empty.", "err"); return;
      }
      if (tune.maxTokens !== null && (Number.isNaN(tune.maxTokens) || tune.maxTokens < 1)) {
        toast("Invalid max tokens", "Use a positive number, or leave it empty.", "err"); return;
      }
      const capsOut = {};
      for (const k of Object.keys(CAP_NAMES)) capsOut[k] = $("#e-cap-" + k).checked;
      try {
        await api(`/models/${encodeURIComponent(id)}`, { method: "PATCH", body: {
          providerId: $("#e-prov").value,
          displayName: $("#e-name").value.trim() || undefined,
          modelId: $("#e-mid").value.trim() || undefined,
          contextWindow: Number($("#e-ctx").value) || 0,
          priority: Number($("#e-prio").value) || 100,
          inputCostPer1k: Number($("#e-cin").value) || 0,
          outputCostPer1k: Number($("#e-cout").value) || 0,
          capabilities: capsOut,
          tags: $("#e-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
          active: $("#e-active").value === "true",
          notes: $("#e-notes").value,
          temperature: tune.temperature,
          maxTokens: tune.maxTokens,
          omitTemperature: tune.omitTemperature,
        }});
        closeModal(); toast("Model updated", $("#e-mid").value.trim(), "ok"); refreshCurrent();
      } catch (e) { toast("Error", e.message, "err"); }
    };
  };

  window.modelGroupToggle = (providerId) => {
    const card = document.querySelector(`.model-group[data-provider="${CSS.escape(providerId)}"]`);
    if (card) card.classList.toggle("collapsed");
  };

  /* ---- multi-select ---- */
  window.modelSelectOne = (id, checked) => {
    if (checked) modelSelection.add(id); else modelSelection.delete(id);
    const row = document.querySelector(`[data-model="${CSS.escape(id)}"]`);
    if (row) row.classList.toggle("row-selected", checked);
    syncGroupCheckboxes();
    renderBulkBar();
  };
  window.modelSelectProvider = (providerId, checked) => {
    const visibleForProvider = modelVisibleCache.filter((x) => (x.providerId || "__none__") === providerId);
    for (const m of visibleForProvider) {
      if (checked) modelSelection.add(m.id); else modelSelection.delete(m.id);
      const box = document.querySelector(`[data-model="${CSS.escape(m.id)}"] input[data-model-check]`);
      if (box) box.checked = checked;
      const row = document.querySelector(`[data-model="${CSS.escape(m.id)}"]`);
      if (row) row.classList.toggle("row-selected", checked);
    }
    renderBulkBar();
  };
  window.modelSelectAll = (checked) => {
    const target = modelVisibleCache.length || !modelSearchQuery.trim() ? modelVisibleCache : [];
    for (const m of target) {
      if (checked) modelSelection.add(m.id); else modelSelection.delete(m.id);
    }
    renderModelsPage();
  };
  window.modelSelectionClear = () => { modelSelection.clear(); renderModelsPage(); };

  function syncGroupCheckboxes() {
    for (const card of $$(".model-group")) {
      const pid = card.dataset.provider;
      const models = modelVisibleCache.filter((m) => (m.providerId || "__none__") === pid);
      const box = card.querySelector(".model-check input");
      if (!box) continue;
      const selected = models.filter((m) => modelSelection.has(m.id)).length;
      box.checked = models.length > 0 && selected === models.length;
      box.indeterminate = selected > 0 && selected < models.length;
    }
  }

  /** Sticky action bar shown while at least one model is selected. */
  function renderBulkBar() {
    const el = $("#model-bulkbar");
    if (!el) return;
    const n = modelSelection.size;
    if (!n) { el.innerHTML = ""; return; }
    el.innerHTML = `<div class="bulk-bar">
      <span><strong>${n}</strong> model(s) selected</span>
      <div class="flex">
        <button class="btn" onclick="modelSelectAll(true)">Select visible (${modelVisibleCache.length})</button>
        <button class="btn" onclick="modelBulk('activate')">✓ Activate</button>
        <button class="btn" onclick="modelBulk('deactivate')">⏸ Deactivate</button>
        <button class="btn btn-danger" onclick="modelBulk('delete')">🗑 Delete selected</button>
        <button class="btn btn-ghost" onclick="modelSelectionClear()">Clear</button>
      </div>
    </div>`;
  }

  window.modelBulk = async (action) => {
    const ids = [...modelSelection];
    if (!ids.length) return;
    if (action === "delete" && !confirm(`Delete ${ids.length} selected model(s) from the system?`)) return;
    try {
      const r = await api("/models/bulk", { method: "POST", body: { action, ids } });
      modelSelection.clear();
      toast(`${r.affected} model(s) ${action === "delete" ? "deleted" : action + "d"}`, "", "ok");
      refreshCurrent();
    } catch (e) { toast("Error", e.message, "err"); }
  };

  /* ---- Groups modal ---- */
  /**
   * Group modal for ONE provider — opened by clicking the provider name on the
   * Models page. Lists that provider's models with per-row selection and the
   * bulk actions scoped to the group.
   */
  window.openModelGroup = (providerId) => {
    const g = groupModelsByProvider(modelsCache).find((x) => x.providerId === providerId);
    if (!g) { toast("Group not found", "", "err"); return; }
    openModal(`🗂 ${g.name}`, `<div class="group-modal">
      <div class="group-row">
        <div>
          <div class="field-hint mono">${esc(g.providerId)}</div>
          <div style="margin-top:4px"><span class="badge badge-muted">${g.models.length} model(s)</span> <span class="badge badge-${g.active ? "ok" : "muted"}">${g.active} active</span></div>
        </div>
        <div class="flex">
          <button class="btn btn-ghost" onclick="modelGroupSelect('${esc(g.providerId)}')">Select all</button>
          <button class="btn btn-ghost" onclick="modelGroupJump('${esc(g.providerId)}')">Go to group</button>
          <button class="btn btn-ghost" onclick="openModelGroups()">All groups</button>
        </div>
      </div>
      <div class="table-wrap" style="max-height:46vh;overflow:auto"><table><thead><tr>
        <th style="width:34px"></th><th>Model</th><th>Caps</th><th>Active</th><th></th>
      </tr></thead><tbody>
      ${g.models.map((m) => `<tr>
        <td><input type="checkbox" ${modelSelection.has(m.id) ? "checked" : ""} onchange="modelSelectOne('${esc(m.id)}', this.checked)"/></td>
        <td><strong>${esc(m.displayName)}</strong><div class="mono field-hint">${esc(m.modelId)}${tuningBadge(m)}</div></td>
        <td>${capsBadges(m.capabilities) || '<span class="badge badge-muted">—</span>'}</td>
        <td>${m.active ? '<span class="badge badge-ok">active</span>' : '<span class="badge badge-muted">inactive</span>'}</td>
        <td style="white-space:nowrap;text-align:right">
          <button class="btn btn-ghost" onclick="openModelChat('${esc(m.id)}')">💬</button>
          <button class="btn btn-ghost" onclick="openModelEdit('${esc(m.id)}')">✏️</button>
        </td></tr>`).join("") || `<tr><td colspan="5">${emptyState("🧠", "No models", "This provider has no models yet.")}</td></tr>`}
      </tbody></table></div>
      <div class="flex mt" style="justify-content:flex-end"><button class="btn" onclick="closeModal()">Close</button></div>
    </div>`);
  };

  window.openModelGroups = () => {
    const groups = groupModelsByProvider(modelsCache);
    openModal("Model Groups by Provider", `<div class="group-modal">
      ${groups.map((g) => `<div class="group-row">
        <div>
          <button class="linkish" onclick="openModelGroup('${esc(g.providerId)}')"><strong>${esc(g.name)}</strong></button>
          <div class="field-hint mono">${esc(g.providerId)}</div>
        </div>
        <div class="flex">
          <span class="badge badge-muted">${g.models.length} model(s)</span>
          <span class="badge badge-${g.active ? "ok" : "muted"}">${g.active} active</span>
          <button class="btn btn-ghost" onclick="modelGroupSelect('${esc(g.providerId)}')">Select all</button>
          <button class="btn btn-ghost" onclick="modelGroupJump('${esc(g.providerId)}')">Go to group</button>
        </div>
      </div>`).join("") || emptyState("🗂", "No groups", "Add a provider and its models first.")}
      <div class="flex mt" style="justify-content:flex-end"><button class="btn" onclick="closeModal()">Close</button></div>
    </div>`);
  };
  window.modelGroupSelect = (providerId) => {
    modelSelection.clear();
    for (const m of modelsCache.filter((x) => (x.providerId || "__none__") === providerId)) modelSelection.add(m.id);
    closeModal();
    refreshCurrent();
  };
  window.modelGroupJump = (providerId) => {
    closeModal();
    const card = document.querySelector(`.model-group[data-provider="${CSS.escape(providerId)}"]`);
    if (card) {
      card.classList.remove("collapsed");
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      card.classList.add("flash");
      setTimeout(() => card.classList.remove("flash"), 1200);
    }
  };

  /* ---- Add model (catalog dropdown OR manual model id) ---- */
  window.openModel = async () => {
    const providers = await api("/providers").catch(() => []);
    openModal("Add Model", `
      <div class="field"><label>Provider</label><select class="select" id="m-prov">${providers.map((p) => `<option value="${esc(p.id)}" ${p.active ? "" : "disabled"}>${esc(p.name)}${p.active ? "" : " (inactive)"}</option>`).join("")}</select></div>
      <div class="field">
        <label>Model source</label>
        <div class="seg">
          <button type="button" class="seg-btn active" id="m-mode-catalog">📚 From catalog</button>
          <button type="button" class="seg-btn" id="m-mode-manual">✍️ Manual Model ID</button>
        </div>
        <div class="field-hint">Some free / preview models are not listed by the provider — use <strong>Manual Model ID</strong> to type any model id by hand.</div>
      </div>
      <div class="field" id="m-catalog-field"><label>Model <span class="select-count">pick from the provider's live catalog — capabilities are detected automatically</span></label>
        <div style="display:flex;gap:6px;align-items:center">
          <select class="select" id="m-id" style="flex:1"></select>
          <button class="btn" id="m-refresh" type="button" title="Re-fetch the catalog from the provider">↻</button>
        </div>
        <div class="field-hint" id="m-catalog-hint">Loading catalog…</div>
      </div>
      <div class="field" id="m-manual-field" hidden><label>Model ID <span class="select-count">exactly as the provider expects it</span></label>
        <input class="input mono" id="m-id-manual" placeholder="e.g. meta-llama/llama-3.3-70b-instruct:free"/>
        <div class="field-hint">Not validated against the catalog — anything you type is saved as-is (a leading <span class="mono">models/</span> is stripped).</div>
      </div>
      <div class="field"><label>Display name <span class="select-count">optional — auto-filled from the model</span></label><input class="input" id="m-name" placeholder=""/></div>
      <div class="grid-2"><div class="field"><label>Context window</label><input class="input" id="m-ctx" value="128000"/></div><div class="field"><label>Priority (lower = preferred)</label><input class="input" id="m-prio" value="100"/></div></div>
      <div id="m-caps-preview" class="field-hint" style="margin-top:-4px">Capabilities (vision / tools / reasoning / structured output / code / streaming) are detected automatically from the model id. Use <strong>Test</strong> to verify the model &amp; see the exact endpoint.</div>
      <div class="flex"><button class="btn" id="m-test">Test model</button><button class="btn btn-primary" id="m-go">Save</button><button class="btn" onclick="closeModal()">Cancel</button></div>
`);

    let mode = "catalog";
    let lastCatalog = [];
    let lastInfo = null;
    // Read the model id from whichever input is active.
    const currentModelId = () => {
      const el = mode === "manual" ? document.getElementById("m-id-manual") : document.getElementById("m-id");
      return (el?.value || "").trim().replace(/^models\//, "");
    };
    const setMode = (next) => {
      mode = next;
      $("#m-mode-catalog").classList.toggle("active", next === "catalog");
      $("#m-mode-manual").classList.toggle("active", next === "manual");
      $("#m-catalog-field").hidden = next !== "catalog";
      $("#m-manual-field").hidden = next !== "manual";
      renderCapsPreview();
    };
    const renderCapsPreview = () => {
      const el = document.getElementById("m-caps-preview");
      const id = currentModelId();
      if (!id) { el.innerHTML = "Pick or type a model id to see its auto-detected capabilities."; return; }
      const detected = lastInfo && lastInfo.id === id ? lastInfo.capabilities : null;
      el.innerHTML = detected ? `Detected capabilities: ${capsBadges(detected)}` : "Capabilities will be auto-detected when the model is saved.";
    };
    // Fetch metadata (context window + capabilities) for the currently typed/picked id.
    let detectTimer = null;
    const detectSelected = () => {
      const id = currentModelId();
      if (!id) { renderCapsPreview(); return; }
      clearTimeout(detectTimer);
      detectTimer = setTimeout(() => {
        api("/models/test", { method: "POST", body: { providerId: $("#m-prov").value, modelId: id } })
          .then((r) => {
            lastInfo = { id, contextWindow: r.contextWindow || 128000, capabilities: r.detectedCapabilities || r.capabilities };
            $("#m-ctx").value = lastInfo.contextWindow;
            if (!$("#m-name").value.trim()) $("#m-name").placeholder = id;
            renderCapsPreview();
          })
          .catch(() => renderCapsPreview());
      }, 350);
    };
    // Turn the catalog <select> into a free-text input when no catalog is available.
    const fallbackToManual = (reason) => {
      setMode("manual");
      $("#m-catalog-hint").innerHTML = reason;
    };
    const loadCatalog = async (providerId) => {
      const hint = $("#m-catalog-hint");
      const sel = $("#m-id");
      if (!sel) return;
      sel.innerHTML = `<option value="">Loading…</option>`;
      hint.textContent = "Loading catalog from provider…";
      try {
        const r = await api(`/providers/${encodeURIComponent(providerId)}/models`);
        lastCatalog = r.models || [];
        if (!r.ok || !lastCatalog.length) {
          sel.innerHTML = `<option value="">— catalog unavailable —</option>`;
          fallbackToManual(`⚠ ${esc(r.message || "The provider returned no models")} — switched to manual entry.`);
          return;
        }
        sel.innerHTML = lastCatalog.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join("");
        const first = lastCatalog[0];
        sel.value = first;
        lastInfo = (r.modelInfos || []).find((m) => m.id === first) || null;
        $("#m-ctx").value = lastInfo?.contextWindow || 128000;
        if (!$("#m-name").value.trim()) $("#m-name").placeholder = first;
        hint.innerHTML = `${r.modelInfos?.length ?? lastCatalog.length} model(s) from <span class="mono">${esc(r.catalogUrl || "")}</span> · chat: <span class="mono">${esc(r.chatUrl || "")}</span>`;
        renderCapsPreview();
      } catch (e) {
        sel.innerHTML = `<option value="">— error —</option>`;
        fallbackToManual(`⚠ ${esc(e.message)} — switched to manual entry.`);
      }
    };

    $("#m-mode-catalog").onclick = () => setMode("catalog");
    $("#m-mode-manual").onclick = () => setMode("manual");
    $("#m-id-manual").addEventListener("input", detectSelected);
    $("#m-id").addEventListener("change", detectSelected);
    $("#m-refresh").onclick = () => loadCatalog($("#m-prov").value);
    $("#m-prov").addEventListener("change", () => { if (mode === "catalog") loadCatalog($("#m-prov").value); });

    const initial = providers.find((p) => p.active) || providers[0];
    if (initial) {
      $("#m-prov").value = initial.id;
      await loadCatalog(initial.id);
    } else {
      fallbackToManual("No provider available yet — add a provider first.");
    }

    $("#m-test").onclick = async () => {
      const modelId = currentModelId();
      const providerId = $("#m-prov").value;
      if (!modelId) { toast("Model required", "Pick a model or type a Model ID", "err"); return; }
      if (!providerId) { toast("Provider required", "", "err"); return; }
      // The verdict replaces this dialog, so remember the form to restore it.
      await runModelTest(providerId, modelId);
    };
    $("#m-go").onclick = async () => {
      const modelId = currentModelId();
      if (!modelId) { toast("Model required", "Pick a model or type a Model ID", "err"); return; }
      try {
        const saved = await api("/models", { method: "POST", body: {
          providerId: $("#m-prov").value, modelId, displayName: $("#m-name").value.trim() || modelId,
          contextWindow: Number($("#m-ctx").value) || 128000, priority: Number($("#m-prio").value) || 100,
          // capabilities omitted => auto-detected by the server
        }});
        closeModal();
        if (saved && saved.duplicate) toast("Already registered", saved.message || modelId, "warn");
        else toast("Model added", modelId, "ok");
        refreshCurrent();
      } catch (e) { toast("Error", e.message, "err"); }
    };
  };

  window.modelToggle = async (id, active) => {
    try { await api(`/models/${id}/${active ? "activate" : "deactivate"}`, { method: "POST" }); toast(active ? "Model activated" : "Model deactivated", "", "ok"); refreshCurrent(); }
    catch (e) { toast("Error", e.message, "err"); }
  };
  window.modelDelete = async (id) => {
    if (!confirm("Delete this model?")) return;
    try { await api(`/models/${id}`, { method: "DELETE" }); modelSelection.delete(id); toast("Model deleted", "", "ok"); refreshCurrent(); }
    catch (e) { toast("Error", e.message, "err"); }
  };
  // Default test message (mirrors the server default) — short, cheap, verifiable.
  const MODEL_TEST_MSG = "This is a connectivity test from CodeVia. Reply with exactly: OK";

  /* ---- Streaming chat modal (ChatGPT-style) ---- */
  // Conversation history per model id, so reopening the modal keeps the thread.
  const modelChats = new Map();
  let chatAbort = null;

  window.openModelChat = (id) => {
    const m = modelsCache.find((x) => x.id === id) || {};
    const history = modelChats.get(id) || [];
    const box = $("#chat-modal-backdrop");
    $("#chat-modal-title").textContent = `💬 ${m.displayName || m.modelId || "Model"}`;
    $("#chat-modal-sub").textContent = `${providerNameOf(m.providerId)} · ${m.modelId || ""}`;
    $("#chat-modal-body").innerHTML = `
      <div class="chat-thread" id="chat-thread"></div>
      <div class="chat-meta" id="chat-meta"></div>
      <div class="chat-composer">
        <textarea class="textarea" id="chat-input" rows="2" placeholder="Send a natural message… (Enter to send, Shift+Enter for a new line)"></textarea>
        <div class="flex" style="justify-content:space-between;align-items:center">
          <span class="field-hint">Replies stream in token by token.</span>
          <div class="flex">
            <button class="btn btn-ghost" id="chat-clear">Clear</button>
            <button class="btn" id="chat-stop" hidden>■ Stop</button>
            <button class="btn btn-primary" id="chat-send">Send ➤</button>
          </div>
        </div>
      </div>`;
    box.hidden = false;
    box.dataset.modelId = id;
    renderChatThread(history);
    $("#chat-send").onclick = () => sendChatMessage(id);
    $("#chat-clear").onclick = () => { modelChats.set(id, []); renderChatThread([]); $("#chat-meta").textContent = ""; };
    $("#chat-stop").onclick = () => { if (chatAbort) chatAbort.abort(); };
    const input = $("#chat-input");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChatMessage(id); }
    });
    setTimeout(() => input.focus(), 30);
  };
  window.closeModelChat = () => {
    if (chatAbort) chatAbort.abort();
    const box = $("#chat-modal-backdrop");
    if (box) box.hidden = true;
  };

  function renderChatThread(history) {
    const thread = $("#chat-thread");
    if (!thread) return;
    thread.innerHTML = history.length
      ? history.map((m) => chatBubble(m.role, m.content)).join("")
      : `<div class="chat-empty">Ask this model anything — the answer streams in like a normal chat.</div>`;
    thread.scrollTop = thread.scrollHeight;
  }
  function chatBubble(role, content, id = "") {
    return `<div class="chat-msg ${role}"${id ? ` id="${id}"` : ""}><div class="chat-role">${role === "user" ? "You" : "Model"}</div><div class="chat-text">${esc(content)}</div></div>`;
  }

  /**
   * POST the conversation to /models/:id/stream and consume the SSE frames,
   * appending each `delta` to the assistant bubble as it arrives.
   */
  async function sendChatMessage(id) {
    const input = $("#chat-input");
    const text = (input?.value || "").trim();
    if (!text) { toast("Empty message", "Type something to send.", "err"); return; }
    const history = modelChats.get(id) || [];
    history.push({ role: "user", content: text });
    modelChats.set(id, history);
    input.value = "";
    renderChatThread(history);

    const thread = $("#chat-thread");
    const bubbleId = "chat-live-" + Date.now();
    thread.insertAdjacentHTML("beforeend", chatBubble("assistant", "", bubbleId));
    const liveEl = document.getElementById(bubbleId);
    const textEl = liveEl.querySelector(".chat-text");
    textEl.innerHTML = `<span class="chat-cursor">▍</span>`;
    thread.scrollTop = thread.scrollHeight;

    $("#chat-send").disabled = true;
    $("#chat-stop").hidden = false;
    chatAbort = new AbortController();
    let acc = "";
    try {
      const res = await fetch(`/models/${encodeURIComponent(id)}/stream`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ messages: history }),
        signal: chatAbort.signal,
      });
      if (!res.ok || !res.body) {
        let msg = res.statusText;
        try { const b = await res.json(); msg = b.message || b.error || msg; } catch (_) {}
        throw new Error(msg);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
          if (ev.type === "meta") {
            $("#chat-meta").innerHTML = `→ <span class="mono">${esc(ev.url)}</span>`;
          } else if (ev.type === "delta") {
            acc += ev.text;
            textEl.innerHTML = `${esc(acc)}<span class="chat-cursor">▍</span>`;
            thread.scrollTop = thread.scrollHeight;
          } else if (ev.type === "done") {
            acc = ev.text || acc;
            textEl.textContent = acc || "(empty reply)";
            $("#chat-meta").innerHTML += ` · ${ev.latencyMs}ms${ev.status ? " · HTTP " + ev.status : ""}`;
          } else if (ev.type === "error") {
            liveEl.classList.add("err");
            textEl.textContent = ev.message + (ev.hint ? "\n" + ev.hint : "");
            acc = "";
          }
        }
      }
    } catch (e) {
      if (e.name === "AbortError") {
        textEl.textContent = acc ? acc + " …(stopped)" : "(stopped)";
      } else {
        liveEl.classList.add("err");
        textEl.textContent = "✗ " + e.message;
        acc = "";
      }
    } finally {
      $("#chat-send").disabled = false;
      $("#chat-stop").hidden = true;
      chatAbort = null;
      // Persist a successful reply into the thread history for multi-turn context.
      if (acc) {
        history.push({ role: "assistant", content: acc });
        modelChats.set(id, history);
      }
      const cursor = textEl.querySelector(".chat-cursor");
      if (cursor) cursor.remove();
    }
  }

  /* PROVIDERS — dashboard, filters, multi-select bulk actions, per-card control */

  // Page state kept outside the route so re-renders/refreshes preserve it.
  const providerSelection = new Set();
  const providerExpanded = new Set();
  let providersPageCache = [];
  let providersVisibleCache = [];
  let providerSummary = null;
  let providerQuery = "";
  let providerFilter = "all"; // all | active | inactive | ready | attention
  let providerSort = "name";  // name | status | models | type

  const PROVIDER_ICONS = {
    openai: "🟢", anthropic: "🟣", gemini: "🔵", openrouter: "🧭",
    "azure-openai": "☁️", ollama: "🦙", "openai-compatible": "🔗", "custom-http": "🛠", mock: "🧪",
  };
  const providerIcon = (type) => PROVIDER_ICONS[type] || "🔌";

  /**
   * Derive the catalog/chat URL the platform will hit for a provider, so users
   * can see the documented endpoint without having to run a test.
   */
  function providerUrlHints(p) {
    const base = String(p.baseUrl || "").replace(/\/+$/, "");
    const fmt = p.apiFormat;
    if (fmt === "anthropic") {
      return {
        catalog: base ? (base.endsWith("/v1") ? `${base}/models?limit=50` : `${base}/v1/models?limit=50`) : "—",
        chat: base ? (base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`) : "—",
      };
    }
    if (fmt === "gemini") {
      const b = base ? (base.endsWith("/v1beta") ? base : `${base}/v1beta`) : "";
      return { catalog: b ? `${b}/models` : "—", chat: b ? `${b}/models/<model>:generateContent` : "—" };
    }
    if (fmt === "ollama") {
      const b = base.endsWith("/v1") ? base.slice(0, -3) : base;
      return { catalog: b ? `${b}/api/tags` : "—", chat: b ? `${b}/api/chat` : "—" };
    }
    // openai / openrouter / azure-openai / openai-compatible / custom
    const b = base ? (base.endsWith("/v1") ? base : `${base}/v1`) : "";
    return { catalog: b ? `${b}/models` : "—", chat: b ? `${b}/chat/completions` : "—" };
  }

  /** Health verdict used for the status pill + the "needs attention" filter. */
  function providerHealth(p) {
    const ready = p.readiness?.ready !== false;
    if (!ready) return { key: "attention", label: "Needs a key", cls: "err", icon: "⚠", tip: p.readiness?.reason || "Not ready" };
    if (!p.active) return { key: "inactive", label: "Inactive", cls: "muted", icon: "⏸", tip: "Ready, but not activated yet" };
    if (!p.modelCount) return { key: "empty", label: "No models", cls: "warn", icon: "○", tip: "Active but no models attached — run Sync models" };
    return { key: "ok", label: "Operational", cls: "ok", icon: "●", tip: "Active, configured and serving models" };
  }

  function providerSearchText(p) {
    const u = providerUrlHints(p);
    return [
      p.name, p.type, p.apiFormat, p.authType, p.baseUrl, p.secretRef, p.id,
      p.active ? "active enabled on" : "inactive disabled off",
      p.keyPresent ? "key set ready configured" : "missing key not ready unconfigured",
      providerHealth(p).label, u.catalog, u.chat,
    ].filter(Boolean).join(" ").toLowerCase();
  }

  function filteredProviders() {
    const terms = providerQuery.toLowerCase().trim().split(/\s+/).filter(Boolean);
    let list = providersPageCache.filter((p) => {
      if (providerFilter === "active" && !p.active) return false;
      if (providerFilter === "inactive" && p.active) return false;
      if (providerFilter === "ready" && p.readiness?.ready === false) return false;
      if (providerFilter === "attention" && p.readiness?.ready !== false) return false;
      if (!terms.length) return true;
      const hay = providerSearchText(p);
      return terms.every((t) => hay.includes(t));
    });
    const rank = (p) => (p.readiness?.ready === false ? 0 : p.active ? 2 : 1);
    list = list.slice().sort((a, b) => {
      if (providerSort === "models") return (b.modelCount || 0) - (a.modelCount || 0) || a.name.localeCompare(b.name);
      if (providerSort === "type") return String(a.type).localeCompare(String(b.type)) || a.name.localeCompare(b.name);
      if (providerSort === "status") return rank(a) - rank(b) || a.name.localeCompare(b.name);
      return String(a.name).localeCompare(String(b.name));
    });
    return list;
  }

  on("/providers", async () => {
    const [list, summary] = await Promise.all([api("/providers"), api("/providers/summary").catch(() => null)]);
    providersPageCache = list;
    providerSummary = summary;
    for (const id of [...providerSelection]) if (!list.some((p) => p.id === id)) providerSelection.delete(id);
    renderProvidersPage();
  });

  function renderProvidersPage() {
    const s = providerSummary || {};
    const attention = providersPageCache.filter((p) => p.readiness?.ready === false).length;
    const counts = {
      all: providersPageCache.length,
      active: providersPageCache.filter((p) => p.active).length,
      inactive: providersPageCache.filter((p) => !p.active).length,
      ready: providersPageCache.filter((p) => p.readiness?.ready !== false).length,
      attention,
    };
    const chip = (key, label, n, cls = "") =>
      `<button class="filter-chip ${providerFilter === key ? "active" : ""} ${cls}" onclick="providerSetFilter('${key}')">${esc(label)} <span class="chip-count">${n}</span></button>`;

    $("#content").innerHTML = `<div class="overview">
        <div>
          <h1>Providers</h1>
          <p>Connect any OpenAI-, Anthropic-, Gemini- or Ollama-compatible endpoint. Keys can live in an env var or be stored encrypted here.</p>
        </div>
        <div class="flex">
          <button class="btn" onclick="providerTestAll()" title="Run a connection test against every active provider">🩺 Health check</button>
          <button class="btn btn-primary" onclick="openProvider()">＋ Add Provider</button>
        </div>
      </div>

      <div class="stat-grid provider-stats">
        <div class="card stat"><div class="stat-label">Providers</div><div class="stat-value">${counts.all}</div><div class="stat-sub">${counts.active} active · ${counts.inactive} inactive</div></div>
        <div class="card stat"><div class="stat-label">Ready to use</div><div class="stat-value" style="color:var(--ok)">${counts.ready}</div><div class="stat-sub">key resolved &amp; base URL set</div></div>
        <div class="card stat"><div class="stat-label">Needs attention</div><div class="stat-value" style="color:${attention ? "var(--err)" : "var(--text-muted)"}">${attention}</div><div class="stat-sub">${attention ? "missing or unreadable API key" : "everything is configured"}</div></div>
        <div class="card stat"><div class="stat-label">Models attached</div><div class="stat-value">${s.models ?? providersPageCache.reduce((n, p) => n + (p.modelCount || 0), 0)}</div><div class="stat-sub">${s.activeModels ?? providersPageCache.reduce((n, p) => n + (p.activeModelCount || 0), 0)} active · <a href="#/models">open Models</a></div></div>
      </div>

      ${attention ? `<div class="card card-body provider-alert">
        <div><strong>⚠ ${attention} provider(s) cannot connect yet.</strong> Each one is missing a usable API key — open <em>Edit</em> and either point <span class="mono">Secret Ref</span> at an environment variable or paste the key to store it encrypted.</div>
        <button class="btn" onclick="providerSetFilter('attention')">Show them</button>
      </div>` : ""}

      <div class="card card-body provider-toolbar">
        <div class="provider-toolbar-row">
          <div class="search-box"><span class="search-icon">⌕</span>
            <input class="input" id="provider-search" placeholder="Search by name, type, format, URL, secret or status…" autocomplete="off" value="${esc(providerQuery)}" oninput="providerSearch(this.value)"/>
          </div>
          <select class="select provider-sort" id="provider-sort" onchange="providerSetSort(this.value)" title="Sort providers">
            <option value="name" ${providerSort === "name" ? "selected" : ""}>Sort: Name</option>
            <option value="status" ${providerSort === "status" ? "selected" : ""}>Sort: Status</option>
            <option value="models" ${providerSort === "models" ? "selected" : ""}>Sort: Models</option>
            <option value="type" ${providerSort === "type" ? "selected" : ""}>Sort: Type</option>
          </select>
          <button class="btn btn-ghost" id="provider-search-clear" onclick="providerSearchClear()" ${providerQuery.trim() ? "" : "disabled"}>Clear</button>
        </div>
        <div class="filter-chips">
          ${chip("all", "All", counts.all)}
          ${chip("active", "Active", counts.active)}
          ${chip("inactive", "Inactive", counts.inactive)}
          ${chip("ready", "Ready", counts.ready)}
          ${chip("attention", "Needs attention", counts.attention, counts.attention ? "danger" : "")}
        </div>
        <div class="field-hint" id="provider-summary"></div>
      </div>

      <div id="provider-bulkbar"></div>
      <div class="provider-grid" id="provider-grid"></div>`;
    renderProviderList();
  }

  /** Re-render only the list + bulk bar (used by search / filter / sort). */
  function renderProviderList() {
    providersVisibleCache = filteredProviders();
    const grid = $("#provider-grid");
    if (!grid) return;
    grid.innerHTML = providersVisibleCache.length
      ? providersVisibleCache.map(renderProviderCard).join("")
      : `<div class="card card-body" style="grid-column:1/-1">${
          providersPageCache.length
            ? emptyState("🔎", "No matching providers", "Try a different search term, or switch the filter back to “All”.")
            : emptyState("🔌", "No providers yet", "Add your first provider — pick a preset, paste a key, and CodeVia imports its models for you.")
        }</div>`;
    const summary = $("#provider-summary");
    if (summary) {
      const q = providerQuery.trim();
      summary.textContent = providersPageCache.length
        ? `Showing ${providersVisibleCache.length} of ${providersPageCache.length} provider(s)${q ? ` for “${q}”` : ""}${providerFilter !== "all" ? ` · filter: ${providerFilter}` : ""}.`
        : "No providers configured yet.";
    }
    renderProviderBulkBar();
  }

  function renderProviderCard(p) {
    const id = esc(p.id);
    const u = providerUrlHints(p);
    const h = providerHealth(p);
    const open = providerExpanded.has(p.id);
    const selected = providerSelection.has(p.id);
    const models = Number(p.modelCount || 0);
    const activeModels = Number(p.activeModelCount || 0);
    const keyLabel = p.secretValuePresent
      ? `stored key ${esc(p.secretMasked || "••••")}`
      : p.secretRef
        ? `env ${esc(p.secretRef)}`
        : "no key needed";
    return `<section class="card provider-card ${selected ? "row-selected" : ""} health-${h.cls}" data-provider-card="${id}">
      <div class="provider-card-head">
        <label class="provider-check" title="Select this provider">
          <input type="checkbox" data-provider-check ${selected ? "checked" : ""} onchange="providerSelectOne('${id}', this.checked)"/>
        </label>
        <div class="provider-avatar" title="${esc(p.type)}">${providerIcon(p.type)}</div>
        <div class="provider-head-text">
          <strong title="${esc(p.name)}">${esc(p.name)}</strong>
          <div class="provider-head-sub">${esc(p.type)} · ${esc(p.apiFormat)} API · ${esc(p.authType)} auth</div>
        </div>
        <span class="badge badge-${h.cls} provider-health" title="${esc(h.tip)}">${h.icon} ${esc(h.label)}</span>
      </div>

      <div class="provider-facts">
        <span title="API key source">${p.keyPresent ? "🔑" : "🚫"} ${keyLabel}</span>
        <span title="Models attached to this provider">🧠 ${models} model${models === 1 ? "" : "s"}${models ? ` · ${activeModels} active` : ""}</span>
        <span title="Request timeout">⏱ ${Math.round(Number(p.timeoutMs || 0) / 1000)}s</span>
        <span title="Default max tokens">✎ ${Number(p.maxTokensDefault || 0).toLocaleString()} tok</span>
      </div>

      <div class="provider-url" title="${esc(p.baseUrl || "")}"><span class="lbl">Base URL</span><span class="mono">${esc(p.baseUrl || "—")}</span></div>

      ${p.readiness?.ready === false
        ? `<div class="provider-warn">⚠ ${esc(p.readiness.reason)}${p.readiness.hint ? `<div class="provider-warn-hint">${esc(p.readiness.hint)}</div>` : ""}</div>`
        : ""}

      <div class="provider-toggle-row">
        <label class="switch" title="${p.active ? "Deactivate this provider" : "Activate this provider"}">
          <input type="checkbox" ${p.active ? "checked" : ""} onchange="providerToggle('${id}', this.checked)"/>
          <span class="switch-track"><span class="switch-thumb"></span></span>
          <span class="switch-label">${p.active ? "Active" : "Inactive"}</span>
        </label>
        <button class="chev-btn" type="button" title="Show endpoints and details" onclick="providerToggleDetails('${id}')"><span class="chev" style="${open ? "" : "transform:rotate(-90deg)"}">▾</span></button>
      </div>

      <div class="provider-details" ${open ? "" : "hidden"}>
        <div class="meter-row"><span class="lbl">Catalog</span><span class="val mono provider-endpoint" title="${esc(u.catalog)}">${esc(u.catalog)}</span></div>
        <div class="meter-row"><span class="lbl">Chat</span><span class="val mono provider-endpoint" title="${esc(u.chat)}">${esc(u.chat)}</span></div>
        <div class="meter-row"><span class="lbl">Secret ref</span><span class="val mono">${esc(p.secretRef || "—")} ${p.keyPresent ? '<span class="badge badge-ok">set</span>' : '<span class="badge badge-err">missing</span>'}</span></div>
        <div class="meter-row"><span class="lbl">Provider ID</span><span class="val mono">${id}</span></div>
        <div class="flex mt" style="flex-wrap:wrap">
          <button class="btn btn-ghost" onclick="providerDuplicate('${id}')">⧉ Duplicate</button>
          ${p.id === "provider-mock" ? "" : `<button class="btn btn-ghost danger-text" onclick="providerDelete('${id}')">🗑 Delete</button>`}
        </div>
      </div>

      <div class="provider-actions">
        <button class="btn" onclick="providerTest('${id}')" title="Call the provider's catalog endpoint now">🩺 Test</button>
        <button class="btn" onclick="providerSyncModels('${id}')" title="Import any catalog models missing from the Models section">⇅ Sync models</button>
        <button class="btn" onclick="providerViewModels('${id}')" title="Show this provider's models">🧠 Models${models ? ` (${models})` : ""}</button>
        <button class="btn" onclick="openProvider('${id}')">✏️ Edit</button>
      </div>
      <div id="prov-test-${id}"></div>
    </section>`;
  }

  /* ---- toolbar handlers ---- */
  window.providerSearch = (value) => {
    providerQuery = value || "";
    const input = $("#provider-search");
    const start = input?.selectionStart ?? providerQuery.length;
    const end = input?.selectionEnd ?? providerQuery.length;
    renderProviderList();
    const clear = $("#provider-search-clear");
    if (clear) clear.disabled = !providerQuery.trim();
    if (input) { input.focus(); try { input.setSelectionRange(start, end); } catch {} }
  };
  window.providerSearchClear = () => { providerQuery = ""; renderProvidersPage(); $("#provider-search")?.focus(); };
  window.providerSetFilter = (key) => { providerFilter = key; renderProvidersPage(); };
  window.providerSetSort = (value) => { providerSort = value; renderProviderList(); };
  window.providerToggleDetails = (id) => {
    if (providerExpanded.has(id)) providerExpanded.delete(id); else providerExpanded.add(id);
    const card = document.querySelector(`[data-provider-card="${CSS.escape(id)}"]`);
    if (!card) return;
    const body = card.querySelector(".provider-details");
    const chev = card.querySelector(".provider-toggle-row .chev");
    if (body) body.hidden = !providerExpanded.has(id);
    if (chev) chev.style.transform = providerExpanded.has(id) ? "" : "rotate(-90deg)";
  };

  /* ---- multi-select + bulk actions ---- */
  window.providerSelectOne = (id, checked) => {
    if (checked) providerSelection.add(id); else providerSelection.delete(id);
    document.querySelector(`[data-provider-card="${CSS.escape(id)}"]`)?.classList.toggle("row-selected", checked);
    renderProviderBulkBar();
  };
  window.providerSelectVisible = (checked) => {
    for (const p of providersVisibleCache) {
      if (checked) providerSelection.add(p.id); else providerSelection.delete(p.id);
    }
    renderProviderList();
  };
  window.providerSelectionClear = () => { providerSelection.clear(); renderProviderList(); };

  function renderProviderBulkBar() {
    const el = $("#provider-bulkbar");
    if (!el) return;
    const n = providerSelection.size;
    if (!n) { el.innerHTML = ""; return; }
    el.innerHTML = `<div class="bulk-bar">
      <span><strong>${n}</strong> provider(s) selected</span>
      <div class="flex" style="flex-wrap:wrap">
        <button class="btn" onclick="providerSelectVisible(true)">Select visible (${providersVisibleCache.length})</button>
        <button class="btn" onclick="providerBulk('activate')">✓ Activate</button>
        <button class="btn" onclick="providerBulk('deactivate')">⏸ Deactivate</button>
        <button class="btn" onclick="providerBulk('test')">🩺 Test</button>
        <button class="btn btn-danger" onclick="providerBulk('delete')">🗑 Delete</button>
        <button class="btn btn-ghost" onclick="providerSelectionClear()">Clear</button>
      </div>
    </div>`;
  }

  window.providerBulk = async (action, force = false) => {
    const ids = [...providerSelection];
    if (!ids.length) return;
    if (action === "delete" && !confirm(`Delete ${ids.length} provider(s) and all of their models? This cannot be undone.`)) return;
    try {
      const r = await api("/providers/bulk", { method: "POST", body: { action, ids, force, cascade: action === "delete" } });
      if (action === "test") {
        const okCount = r.results.filter((x) => x.ok).length;
        openModal("🩺 Connection test results", `<div class="group-modal">
          ${r.results.map((x) => `<div class="group-row">
            <div><strong>${esc(x.name)}</strong><div class="field-hint">${esc(x.message)}</div></div>
            <span class="badge badge-${x.ok ? "ok" : "err"}">${x.ok ? "OK" : "failed"}</span>
          </div>`).join("") || emptyState("🩺", "Nothing tested", "")}
          <div class="flex mt" style="justify-content:flex-end"><button class="btn" onclick="closeModal()">Close</button></div>
        </div>`);
        toast(`${okCount}/${r.results.length} provider(s) reachable`, "", okCount === r.results.length ? "ok" : "warn");
        return;
      }
      // Some activations can be refused because the provider has no usable key.
      if (action === "activate" && r.skipped?.length && !force) {
        const names = r.skipped.map((sk) => providersPageCache.find((p) => p.id === sk.id)?.name || sk.id).join(", ");
        if (confirm(`${r.skipped.length} provider(s) are not ready (${names}).\n\nActivate them anyway? They will fail until a key is set.`)) {
          providerSelection.clear();
          for (const sk of r.skipped) providerSelection.add(sk.id);
          return window.providerBulk("activate", true);
        }
      }
      providerSelection.clear();
      const extra = r.skipped?.length ? ` · ${r.skipped.length} skipped` : "";
      toast(`${r.affected} provider(s) ${action === "delete" ? "deleted" : action + "d"}`, extra.trim(), "ok");
      refreshCurrent();
    } catch (e) { toast("Error", e.message, "err"); }
  };

  /* ---- per-provider actions ---- */
  window.providerToggle = async (id, active, force = false) => {
    try {
      await api(`/providers/${id}/${active ? "activate" : "deactivate"}${force ? "?force=true" : ""}`, { method: "POST" });
      toast(active ? "Provider activated" : "Provider deactivated", "", "ok"); refreshCurrent();
    } catch (e) {
      if (active && e.status === 422) {
        const hint = e.body?.hint ? "\n\n" + e.body.hint : "";
        if (confirm(`Cannot activate: ${e.message}${hint}\n\nActivate anyway (it will fail until the key is set)?`)) return window.providerToggle(id, true, true);
        refreshCurrent();
        return;
      }
      toast("Error", e.message, "err");
      refreshCurrent();
    }
  };
  window.providerTest = async (id) => {
    showTestPending("Testing provider", "Checking credentials and reaching the API…");
    try {
      const r = await api(`/providers/${id}/test`, { method: "POST" });
      showTestVerdict(r, { title: r.ok ? "✓ Provider reachable" : "✗ Provider test failed", retry: `providerTest('${id}')` });
    } catch (e) {
      showTestVerdict({ ok: false, message: e.message, hint: e.body?.hint, status: e.status }, { title: "✗ Provider test failed", retry: `providerTest('${id}')` });
    }
  };
  /** Import catalog models that are missing from the Models section. */
  window.providerSyncModels = async (id) => {
    const el = document.getElementById("prov-test-" + id);
    if (el) el.innerHTML = `<div class="test-result">Fetching the provider catalog and importing new models…</div>`;
    try {
      const r = await api(`/providers/${id}/sync-models`, { method: "POST" });
      if (el) el.innerHTML = `<div class="test-result ${r.added ? "ok" : ""}">${r.added ? "✓" : "•"} ${esc(r.message || "")}</div>`;
      toast(r.added ? `${r.added} model(s) imported` : "Nothing new to import", r.message || "", r.added ? "ok" : "");
      refreshCurrent();
    } catch (e) { if (el) el.innerHTML = `<div class="test-result err">✗ ${esc(e.message)}</div>`; toast("Error", e.message, "err"); }
  };
  /** Jump to the Models page pre-filtered to this provider's models. */
  window.providerViewModels = (id) => {
    const p = providersPageCache.find((x) => x.id === id);
    if (p && !p.modelCount) {
      if (confirm(`“${p.name}” has no models yet.\n\nImport them from the provider catalog now?`)) return window.providerSyncModels(id);
      return;
    }
    modelSearchQuery = p ? p.name : "";
    location.hash = "#/models";
  };
  window.providerDuplicate = async (id) => {
    try {
      const p = await api(`/providers/${id}/duplicate`, { method: "POST", body: {} });
      toast("Provider duplicated", `${p.name} — created inactive, review and activate it`, "ok");
      refreshCurrent();
    } catch (e) { toast("Error", e.message, "err"); }
  };
  window.providerDelete = async (id) => {
    const p = providersPageCache.find((x) => x.id === id);
    const models = Number(p?.modelCount || 0);
    if (!confirm(`Delete “${p?.name || id}”?${models ? `\n\nIts ${models} model(s) will be deleted too.` : ""}\n\nThis cannot be undone.`)) return;
    try { await api(`/providers/${id}?cascade=true`, { method: "DELETE" }); toast("Provider deleted", "", "ok"); refreshCurrent(); }
    catch (e) { toast("Error", e.message, "err"); }
  };
  /** Test every provider at once and show the results in a modal. */
  window.providerTestAll = async () => {
    const ids = providersPageCache.map((p) => p.id);
    if (!ids.length) { toast("Nothing to test", "Add a provider first", ""); return; }
    toast("Health check running…", `Testing ${ids.length} provider(s)`, "");
    try {
      const r = await api("/providers/bulk", { method: "POST", body: { action: "test", ids } });
      const okCount = r.results.filter((x) => x.ok).length;
      openModal("🩺 Provider health check", `<div class="group-modal">
        <div class="field-hint">${okCount} of ${r.results.length} provider(s) answered successfully.</div>
        ${r.results.map((x) => `<div class="group-row">
          <div><strong>${esc(x.name)}</strong><div class="field-hint">${esc(x.message)}</div></div>
          <span class="badge badge-${x.ok ? "ok" : "err"}">${x.ok ? "OK" : "failed"}</span>
        </div>`).join("")}
        <div class="flex mt" style="justify-content:flex-end"><button class="btn" onclick="closeModal()">Close</button></div>
      </div>`);
      toast(`${okCount}/${r.results.length} provider(s) reachable`, "", okCount === r.results.length ? "ok" : "warn");
    } catch (e) { toast("Error", e.message, "err"); }
  };

  /* ---- Add / Edit provider form ---- */
  window.openProvider = async (editId) => {
    const [meta, existing] = await Promise.all([
      api("/providers/presets").catch(() => ({ types: [], presets: {}, authTypes: ["bearer", "api-key", "none"], apiFormats: ["openai", "anthropic", "gemini", "ollama", "custom"] })),
      editId ? api("/providers/" + editId) : Promise.resolve(null),
    ]);
    const types = meta.types?.length ? meta.types : ["openai", "anthropic", "gemini", "openrouter", "azure-openai", "ollama", "openai-compatible", "custom-http", "mock"];
    const cur = existing || { type: "openai", ...(meta.presets?.openai || {}), name: "" };

    // Step 1 of the form is a visual preset picker — most users only need to
    // click their provider, type a name and paste a key.
    const presetTiles = types.map((t) => {
      const pr = meta.presets?.[t] || {};
      return `<button type="button" class="preset-tile ${t === cur.type ? "active" : ""}" data-preset="${esc(t)}" onclick="providerPickType('${esc(t)}')">
        <span class="preset-icon">${providerIcon(t)}</span>
        <span class="preset-name">${esc(pr.label || t)}</span>
        <span class="preset-sub mono">${esc((pr.baseUrl || "").replace(/^https?:\/\//, "") || "custom endpoint")}</span>
      </button>`;
    }).join("");

    openModal(editId ? `Edit Provider — ${cur.name}` : "Add Provider", `
      <div class="provider-form">
        <div class="form-section">
          <div class="form-section-title">1 · Which provider?</div>
          <div class="preset-grid" id="pv-presets">${presetTiles}</div>
          <select class="select" id="pv-type" hidden>${types.map((t) => `<option value="${esc(t)}" ${t === cur.type ? "selected" : ""}>${esc(meta.presets?.[t]?.label || t)}</option>`).join("")}</select>
        </div>

        <div class="form-section">
          <div class="form-section-title">2 · Name &amp; endpoint</div>
          <div class="field"><label>Display name</label><input class="input" id="pv-name" value="${esc(cur.name || "")}" placeholder="OpenAI (production)"/><div class="field-hint">Only used in the UI — pick something you will recognise, e.g. “OpenRouter (personal key)”.</div></div>
          <div class="field"><label>Base URL</label><input class="input mono" id="pv-base" value="${esc(cur.baseUrl || "")}" placeholder="https://api.openai.com/v1"/><div class="field-hint" id="pv-base-hint"></div></div>
        </div>

        <div class="form-section">
          <div class="form-section-title">3 · Authentication</div>
          <div class="seg" id="pv-key-mode">
            <button type="button" class="seg-btn active" id="pv-mode-env">🔐 Environment variable</button>
            <button type="button" class="seg-btn" id="pv-mode-paste">📋 Paste the key</button>
          </div>
          <div class="field mt" id="pv-env-field">
            <label>Secret Ref <span class="select-count">the NAME of the env var holding the key</span></label>
            <input class="input mono" id="pv-secret" value="${esc(cur.secretRef || "")}" placeholder="OPENAI_API_KEY"/>
            <div class="field-hint" id="pv-secret-hint"></div>
          </div>
          <div class="field mt" id="pv-paste-field" hidden>
            <label>API key <span class="select-count">stored encrypted at rest — survives restarts</span></label>
            <div class="key-input"><input class="input mono" id="pv-value" type="password" placeholder="sk-…" value=""/><button type="button" class="btn btn-ghost key-eye" id="pv-eye" title="Show / hide">👁</button></div>
            <div class="field-hint">${cur.secretValuePresent ? `A key is already stored (${esc(cur.secretMasked || "••••")}). Leave this empty to keep it.` : "The key never leaves this server and is never shown again after saving."}</div>
          </div>
        </div>

        <details class="form-advanced" ${editId ? "" : ""}>
          <summary>Advanced settings</summary>
          <div class="grid-2 mt">
            <div class="field"><label>Auth header style</label><select class="select" id="pv-auth">${(meta.authTypes || ["bearer", "api-key", "none"]).map((a) => `<option ${a === cur.authType ? "selected" : ""}>${a}</option>`).join("")}</select></div>
            <div class="field"><label>API format</label><select class="select" id="pv-format">${(meta.apiFormats || ["openai", "anthropic", "gemini", "ollama", "custom"]).map((a) => `<option ${a === cur.apiFormat ? "selected" : ""}>${a}</option>`).join("")}</select></div>
          </div>
          <div class="grid-2">
            <div class="field"><label>Timeout (ms)</label><input class="input" id="pv-timeout" value="${cur.timeoutMs || 60000}"/></div>
            <div class="field"><label>Max tokens default</label><input class="input" id="pv-maxtok" value="${cur.maxTokensDefault || 4096}"/></div>
          </div>
        </details>

        <div class="field endpoint-preview">
          <label>Endpoints CodeVia will call</label>
          <div class="field-hint mono" id="pv-urls"></div>
        </div>

        <div class="modal-actions">
          <button class="btn" id="pv-test">🩺 Test connection</button>
          <div class="flex">
            <button class="btn" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" id="pv-go">${editId ? "Save changes" : "Create provider"}</button>
          </div>
        </div>
      </div>`);

    // Preset picker keeps the (hidden) select in sync and re-applies defaults.
    window.providerPickType = (t) => {
      $("#pv-type").value = t;
      $$("#pv-presets .preset-tile").forEach((el) => el.classList.toggle("active", el.dataset.preset === t));
      applyPreset();
    };

    const computeUrls = () => providerUrlHints({ baseUrl: $("#pv-base").value, apiFormat: $("#pv-format").value });
    const renderUrls = () => {
      const u = computeUrls();
      $("#pv-urls").innerHTML = `📚 <strong>catalog</strong>: ${esc(u.catalog)}<br>💬 <strong>chat</strong>: ${esc(u.chat)}`;
      const bh = $("#pv-base-hint");
      const v = $("#pv-base").value.trim();
      if (bh) {
        if (!v && $("#pv-type").value !== "mock") { bh.className = "field-hint err"; bh.textContent = "A base URL is required for this provider type."; }
        else if (v && !/^https?:\/\//i.test(v)) { bh.className = "field-hint err"; bh.textContent = "The URL should start with http:// or https://"; }
        else { bh.className = "field-hint"; bh.textContent = "CodeVia adds the documented path suffix for you (/v1, /v1beta, /api/tags …)."; }
      }
    };
    ["#pv-base", "#pv-format", "#pv-type"].forEach((sel) => {
      const el = $(sel); if (!el) return;
      el.addEventListener("input", renderUrls);
      el.addEventListener("change", renderUrls);
    });

    const applyPreset = () => {
      const pr = meta.presets?.[$("#pv-type").value]; if (!pr) return;
      if (!editId) {
        $("#pv-base").value = pr.baseUrl || "";
        $("#pv-secret").value = pr.secretRef || "";
        if (!$("#pv-name").value) $("#pv-name").placeholder = pr.label;
      }
      $("#pv-auth").value = pr.authType; $("#pv-format").value = pr.apiFormat;
      renderUrls();
    };
    $("#pv-type").addEventListener("change", applyPreset);

    // Key mode: env var vs pasted key. Edit mode opens on whichever is in use.
    const setKeyMode = (mode) => {
      const paste = mode === "paste";
      $("#pv-mode-env").classList.toggle("active", !paste);
      $("#pv-mode-paste").classList.toggle("active", paste);
      $("#pv-env-field").hidden = paste;
      $("#pv-paste-field").hidden = !paste;
    };
    $("#pv-mode-env").onclick = () => setKeyMode("env");
    $("#pv-mode-paste").onclick = () => setKeyMode("paste");
    setKeyMode(cur.secretValuePresent && !cur.secretRef ? "paste" : "env");
    $("#pv-eye").onclick = () => {
      const f = $("#pv-value");
      f.type = f.type === "password" ? "text" : "password";
    };

    $("#pv-secret").addEventListener("input", () => {
      const v = $("#pv-secret").value.trim();
      const h = $("#pv-secret-hint");
      if (/^sk-|^[a-z0-9]{24,}$/i.test(v) && !/^[A-Z][A-Z0-9_]*$/.test(v)) {
        h.className = "field-hint err";
        h.textContent = "That looks like the key itself — switch to “Paste the key” to store it securely.";
      } else if (v && !/^[A-Z][A-Z0-9_]*$/i.test(v)) {
        h.className = "field-hint err";
        h.textContent = "This must be an environment variable NAME like OPENAI_API_KEY (not the key value).";
      } else { h.className = "field-hint"; h.textContent = v ? `The server reads process.env.${v}` : "Leave empty if this provider needs no key (e.g. local Ollama)."; }
    });
    renderUrls();
    $("#pv-secret").dispatchEvent(new Event("input"));

    const readForm = () => ({
      name: $("#pv-name").value.trim(),
      type: $("#pv-type").value,
      baseUrl: $("#pv-base").value.trim(),
      secretRef: $("#pv-env-field").hidden ? "" : $("#pv-secret").value.trim(),
      secretValue: $("#pv-value").value.trim(),
      authType: $("#pv-auth").value,
      apiFormat: $("#pv-format").value,
      timeoutMs: Number($("#pv-timeout").value) || 60000,
      maxTokensDefault: Number($("#pv-maxtok").value) || 4096,
    });

    // Test the values currently in the form (draft), never the stored config.
    $("#pv-test").onclick = async () => {
      // Stacks over the form; closing the verdict returns to the filled form.
      showTestPending("Testing connection", "Using the values currently in the form…");
      try {
        const r = await api("/providers/test", { method: "POST", body: { ...readForm(), ...(editId ? { providerId: editId } : {}) } });
        showTestVerdict(r, { title: r.ok ? "✓ Connection OK" : "✗ Connection failed" });
      } catch (e) {
        showTestVerdict({ ok: false, message: e.message, hint: e.body?.hint, status: e.status }, { title: "✗ Connection failed" });
      }
    };
    $("#pv-go").onclick = async () => {
      const body = readForm();
      if (!body.name) { toast("Name required", "Give the provider a display name", "err"); $("#pv-name").focus(); return; }
      if (body.type !== "mock" && !body.baseUrl) { toast("Base URL required", "Enter the provider's API base URL", "err"); $("#pv-base").focus(); return; }
      const btn = $("#pv-go");
      btn.disabled = true; btn.textContent = editId ? "Saving…" : "Creating…";
      try {
        const p = editId ? await api("/providers/" + editId, { method: "PATCH", body }) : await api("/providers", { method: "POST", body });
        closeModal();
        if (p.readiness && p.readiness.ready === false) toast("Provider saved (inactive)", p.readiness.reason + (p.readiness.hint ? " — " + p.readiness.hint : ""), "warn");
        else {
          let detail = p.name + (p.active ? " · active" : "");
          if (typeof p.discoveredModels === "number" && p.discoveredModels > 0) detail += ` · ${p.discoveredModels} model(s) added to Models`;
          toast(editId ? "Provider updated" : "Provider created", detail, "ok");
        }
        refreshCurrent();
      } catch (e) {
        btn.disabled = false; btn.textContent = editId ? "Save changes" : "Create provider";
        toast("Error", e.message, "err");
      }
    };
  };

  /* SKILLS */
  on("/skills", async () => {
    const list = await api("/skills");
    $("#content").innerHTML = `<div class="overview"><div><h1>Skills</h1><p>Skill Marketplace</p></div></div>
      ${searchPanelHtml("skill-search", "Search skills by name, description, category, version or compatible agent…")}
      <div class="grid-3" id="skill-grid"></div>`;
    bindSearchPanel("skill-search", list, skillCards, "#skill-grid", "skill", { emptyHtml: () => emptyState("🔎", "No matching skills", "Try searching by category, version or compatible agent type.") });
  });
  function skillCards(list) {
    if (!list.length) return emptyState("🛠️", "No skills", "Skills are attachable capabilities injected into agents.");
    return list.map((s) => `<div class="card card-body">
      <div class="card-title">${esc(s.name)} ${s.enabled?'<span class="badge badge-ok">enabled</span>':'<span class="badge badge-muted">disabled</span>'}</div>
      <p style="color:var(--text-muted);font-size:12px">${esc(s.description)}</p>
      <div class="flex" style="flex-wrap:wrap"><span class="badge badge-muted">${esc(s.category)}</span><span class="badge badge-info">v${esc(s.version)}</span></div>
      <div class="flex mt"><span class="badge badge-muted">${(s.compatibleAgentTypes||[]).slice(0,3).join(", ")}</span></div>
    </div>`).join("");
  }

  /* WORKFLOWS */
  on("/workflows", async () => {
    const list = await api("/workflows");
    $("#content").innerHTML = `<div class="overview"><div><h1>Workflows</h1><p>Workflow Engine — agent, tool, condition, approval, parallel nodes</p></div><button class="btn btn-primary" onclick="openWorkflow()">＋ New Workflow</button></div>
      ${searchPanelHtml("workflow-search", "Search workflows by name, slug, node type, project or status…")}
      <div class="card card-body"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Slug</th><th>Nodes</th><th>Version</th><th>Enabled</th><th>Project</th></tr></thead><tbody id="workflow-tbody"></tbody></table></div></div>`;
    bindSearchPanel("workflow-search", list, workflowRows, "#workflow-tbody", "workflow", { emptyHtml: () => `<tr><td colspan="6">${emptyState("🔎", "No matching workflows", "Try searching by node type, slug, project or status.")}</td></tr>` });
  });
  function workflowRows(list) {
    return list.map((w) => `<tr><td><a href="#/workflows/${w.id}"><strong>${esc(w.name)}</strong></a></td><td class="mono">${esc(w.slug)}</td><td>${w.nodes.length}</td><td>v${w.version}</td><td>${w.enabled?'<span class="badge badge-ok">enabled</span>':'<span class="badge badge-muted">disabled</span>'}</td><td class="mono">${(w.projectId||"—").slice(0,12)}</td></tr>`).join("");
  }
  window.openWorkflow = async () => {
    const projects = await api("/projects").catch(() => []);
    openModal("New Workflow", `<div class="field"><label>Name</label><input class="input" id="wf-name"/></div><div class="field"><label>Project</label><select class="select" id="wf-project">${projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("") || '<option value="">(no projects yet)</option>'}</select></div><div class="field"><label>Description</label><textarea class="textarea" id="wf-desc"></textarea></div><div class="flex"><button class="btn btn-primary" id="wf-go">Create</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    $("#wf-go").onclick = async () => {
      const name = $("#wf-name").value.trim(); const projectId = $("#wf-project").value;
      if (!name) { toast("Name required", "", "err"); return; }
      if (!projectId) { toast("Project required", "Create a project first", "err"); return; }
      try {
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";
        const w = await api("/workflows", { method: "POST", body: { name, slug, projectId, description: $("#wf-desc").value,
          nodes: [{ id: "start", type: "agent", name: "Orchestrate", config: { agentType: "orchestrator" }, retries: 0 }], edges: [] } });
        closeModal(); toast("Workflow created", w.name, "ok"); location.hash = "#/workflows/" + w.id;
      } catch (e) { toast("Error", e.message, "err"); }
    };
  };

  /* WORKFLOW DETAIL / BUILDER */
  const WF_NODE_TYPES = ["agent", "tool", "condition", "approval", "parallel", "trigger", "webhook", "telegram"];
  const WF_AGENT_TYPES = ["orchestrator","business-analyst","research","system-architect","backend-developer","frontend-developer","uiux","database","devops","qa","security","code-review","documentation","debugging","refactoring","performance","release"];
  let wfDraft = null;
  function wfNodeConfigHelp(type) {
    return { agent: "agentType (e.g. backend-developer), prompt", tool: "tool (name), input {…}", condition: "expression (JS-like, e.g. outputs.qa.ok === true)", approval: "message", parallel: "branches [node ids]", trigger: "event", webhook: "url", telegram: "chatId, text" }[type] || "";
  }
  function wfRenderGraph(w) {
    const nodes = w.nodes || [], edges = w.edges || [];
    // Simple layered layout: topological depth → column.
    const depth = {}; const incoming = {};
    nodes.forEach((n) => { depth[n.id] = 0; incoming[n.id] = 0; });
    edges.forEach((e) => { if (incoming[e.to] != null) incoming[e.to]++; });
    let changed = true, guard = 0;
    while (changed && guard++ < 50) { changed = false; edges.forEach((e) => { if (depth[e.from] != null && depth[e.to] != null && depth[e.to] < depth[e.from] + 1) { depth[e.to] = depth[e.from] + 1; changed = true; } }); }
    const cols = {}; nodes.forEach((n) => { (cols[depth[n.id]] = cols[depth[n.id]] || []).push(n); });
    const colW = 190, rowH = 78, pad = 20;
    const pos = {}; Object.keys(cols).forEach((d) => cols[d].forEach((n, i) => { pos[n.id] = { x: pad + d * colW, y: pad + i * rowH }; }));
    const width = pad * 2 + (Object.keys(cols).length || 1) * colW, height = pad * 2 + Math.max(1, ...Object.values(cols).map((c) => c.length)) * rowH;
    const color = { agent: "#6366f1", tool: "#0ea5e9", condition: "#f59e0b", approval: "#ef4444", parallel: "#10b981", trigger: "#8b5cf6", webhook: "#64748b", telegram: "#22c55e" };
    const lines = edges.map((e) => { const a = pos[e.from], b = pos[e.to]; if (!a || !b) return ""; const x1 = a.x + 150, y1 = a.y + 24, x2 = b.x, y2 = b.y + 24; const mx = (x1 + x2) / 2; return `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#wf-arrow)"/>${e.condition ? `<text x="${mx}" y="${(y1 + y2) / 2 - 4}" font-size="9" fill="#f59e0b" text-anchor="middle">${esc(e.condition).slice(0, 18)}</text>` : ""}`; }).join("");
    const boxes = nodes.map((n, i) => { const p = pos[n.id]; return `<g class="wf-node" data-i="${i}" style="cursor:pointer" onclick="wfSelect(${i})"><rect x="${p.x}" y="${p.y}" width="150" height="48" rx="8" fill="var(--panel,#fff)" stroke="${color[n.type] || "#999"}" stroke-width="2"/><text x="${p.x + 10}" y="${p.y + 19}" font-size="11" font-weight="600" fill="currentColor">${esc(String(n.name || n.id)).slice(0, 20)}</text><text x="${p.x + 10}" y="${p.y + 36}" font-size="10" fill="${color[n.type] || "#999"}">${esc(n.type)}${n.retries ? ` · ×${n.retries}` : ""}</text></g>`; }).join("");
    return `<svg width="${width}" height="${height}" style="max-width:100%;overflow:visible"><defs><marker id="wf-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#94a3b8"/></marker></defs>${lines}${boxes}</svg>`;
  }
  function wfRender() {
    const w = wfDraft;
    const nodes = w.nodes || [], edges = w.edges || [];
    const sel = window.__wfSel ?? -1;
    const node = nodes[sel];
    $("#wf-graph").innerHTML = nodes.length ? wfRenderGraph(w) : emptyState("🧩", "No nodes yet", "Add a node to start building the workflow.");
    $("#wf-nodes").innerHTML = nodes.map((n, i) => `<div class="step ${i === sel ? "running" : ""}" style="cursor:pointer" onclick="wfSelect(${i})"><div class="step-ico">${i + 1}</div><div><div class="step-label">${esc(n.name || n.id)} <span class="badge badge-muted">${esc(n.type)}</span></div><div class="step-detail mono">${esc(n.id)}${n.retries ? ` · retries ${n.retries}` : ""}</div></div></div>`).join("") || '<div class="muted">—</div>';
    $("#wf-edges").innerHTML = edges.map((e, i) => `<div class="flex" style="gap:6px;align-items:center;margin-bottom:6px"><span class="mono">${esc(e.from)} → ${esc(e.to)}</span>${e.condition ? `<span class="badge badge-warn">${esc(e.condition)}</span>` : ""}<button class="btn btn-ghost" onclick="wfRemoveEdge(${i})">✕</button></div>`).join("") || '<div class="muted">No edges</div>';
    const opts = nodes.map((n) => `<option value="${esc(n.id)}">${esc(n.name || n.id)}</option>`).join("");
    $("#wf-edge-from").innerHTML = opts; $("#wf-edge-to").innerHTML = opts;
    $("#wf-node-editor").innerHTML = node ? `
      <div class="field"><label>ID</label><input class="input mono" id="wfn-id" value="${esc(node.id)}"/></div>
      <div class="field"><label>Name</label><input class="input" id="wfn-name" value="${esc(node.name || "")}"/></div>
      <div class="field"><label>Type</label><select class="select" id="wfn-type">${WF_NODE_TYPES.map((t) => `<option ${t === node.type ? "selected" : ""}>${t}</option>`).join("")}</select></div>
      ${node.type === "agent" ? `<div class="field"><label>Agent type</label><select class="select" id="wfn-agent">${WF_AGENT_TYPES.map((t) => `<option ${t === (node.config || {}).agentType ? "selected" : ""}>${t}</option>`).join("")}</select></div>` : ""}
      <div class="field"><label>Retries</label><input class="input" type="number" min="0" max="5" id="wfn-retries" value="${node.retries || 0}"/></div>
      <div class="field"><label>Config (JSON) <span class="muted">${esc(wfNodeConfigHelp(node.type))}</span></label><textarea class="textarea mono" id="wfn-config">${esc(JSON.stringify(node.config || {}, null, 2))}</textarea></div>
      <div class="flex"><button class="btn btn-primary" onclick="wfApplyNode()">Apply</button><button class="btn" onclick="wfRemoveNode()">Remove node</button></div>` : '<div class="muted">Select a node to edit it.</div>';
    $("#wf-json").value = JSON.stringify({ nodes, edges }, null, 2);
  }
  window.wfSelect = (i) => { window.__wfSel = i; wfRender(); };
  window.wfAddNode = () => {
    const type = $("#wf-new-type").value; const n = (wfDraft.nodes || []).length + 1;
    const id = `${type}-${n}`;
    const config = type === "agent" ? { agentType: "backend-developer" } : type === "tool" ? { tool: "run_tests", input: {} } : type === "condition" ? { expression: "true" } : type === "approval" ? { message: "Approve this step?" } : {};
    wfDraft.nodes = [...(wfDraft.nodes || []), { id, type, name: id, config, retries: 0 }];
    // Auto-link from the previous node for a linear default.
    if (wfDraft.nodes.length > 1) wfDraft.edges = [...(wfDraft.edges || []), { from: wfDraft.nodes[wfDraft.nodes.length - 2].id, to: id }];
    window.__wfSel = wfDraft.nodes.length - 1; wfRender();
  };
  window.wfApplyNode = () => {
    const i = window.__wfSel; const node = wfDraft.nodes[i]; if (!node) return;
    let config; try { config = JSON.parse($("#wfn-config").value || "{}"); } catch (e) { toast("Invalid config JSON", e.message, "err"); return; }
    const oldId = node.id, newId = $("#wfn-id").value.trim() || oldId;
    if (newId !== oldId && wfDraft.nodes.some((n, j) => j !== i && n.id === newId)) { toast("Duplicate node id", newId, "err"); return; }
    const agentSel = $("#wfn-agent"); if (agentSel) config.agentType = agentSel.value;
    wfDraft.nodes[i] = { ...node, id: newId, name: $("#wfn-name").value.trim() || newId, type: $("#wfn-type").value, retries: Number($("#wfn-retries").value || 0), config };
    if (newId !== oldId) wfDraft.edges = (wfDraft.edges || []).map((e) => ({ ...e, from: e.from === oldId ? newId : e.from, to: e.to === oldId ? newId : e.to }));
    wfRender();
  };
  window.wfRemoveNode = () => {
    const i = window.__wfSel; const node = wfDraft.nodes[i]; if (!node) return;
    wfDraft.nodes.splice(i, 1); wfDraft.edges = (wfDraft.edges || []).filter((e) => e.from !== node.id && e.to !== node.id);
    window.__wfSel = -1; wfRender();
  };
  window.wfAddEdge = () => {
    const from = $("#wf-edge-from").value, to = $("#wf-edge-to").value, condition = $("#wf-edge-cond").value.trim();
    if (!from || !to || from === to) { toast("Pick two different nodes", "", "err"); return; }
    if ((wfDraft.edges || []).some((e) => e.from === from && e.to === to)) { toast("Edge exists", "", "err"); return; }
    wfDraft.edges = [...(wfDraft.edges || []), condition ? { from, to, condition } : { from, to }]; $("#wf-edge-cond").value = ""; wfRender();
  };
  window.wfRemoveEdge = (i) => { wfDraft.edges.splice(i, 1); wfRender(); };
  window.wfApplyJson = () => {
    try { const j = JSON.parse($("#wf-json").value); if (!Array.isArray(j.nodes) || !Array.isArray(j.edges)) throw new Error("expected {nodes:[], edges:[]}"); wfDraft.nodes = j.nodes; wfDraft.edges = j.edges; window.__wfSel = -1; wfRender(); toast("JSON applied", "Remember to save", "ok"); }
    catch (e) { toast("Invalid JSON", e.message, "err"); }
  };
  window.wfSave = async () => {
    const ids = new Set(); for (const n of wfDraft.nodes || []) { if (ids.has(n.id)) { toast("Duplicate node id", n.id, "err"); return; } ids.add(n.id); }
    for (const e of wfDraft.edges || []) if (!ids.has(e.from) || !ids.has(e.to)) { toast("Edge references unknown node", `${e.from} → ${e.to}`, "err"); return; }
    try {
      const w = await api(`/workflows/${wfDraft.id}`, { method: "PATCH", body: { name: $("#wf-title").value.trim() || wfDraft.name, description: $("#wf-description").value, nodes: wfDraft.nodes, edges: wfDraft.edges, enabled: $("#wf-enabled").checked } });
      wfDraft = w; toast("Workflow saved", `v${w.version}`, "ok"); refreshCurrent();
    } catch (e) { toast("Save failed", e.message, "err"); }
  };
  window.wfRun = async () => {
    try { const r = await api(`/workflows/${wfDraft.id}/run`, { method: "POST", body: { title: `Run ${wfDraft.name}` } }); toast("Workflow queued", (r.task && r.task.id || "").slice(0, 8), "ok"); setTimeout(refreshCurrent, 1200); }
    catch (e) { toast("Run failed", e.message, "err"); }
  };
  window.wfDelete = async () => {
    if (!confirm(`Delete workflow "${wfDraft.name}"?`)) return;
    await api(`/workflows/${wfDraft.id}`, { method: "DELETE" }); toast("Workflow deleted", "", "ok"); location.hash = "#/workflows";
  };
  on("/workflows/:id", async (rest) => {
    const id = rest[0];
    const w = await api(`/workflows/${id}`);
    if (!w || w.error) { $("#content").innerHTML = emptyState("🔍", "Workflow not found", id); return; }
    wfDraft = JSON.parse(JSON.stringify(w)); window.__wfSel = -1;
    const [tasks, runs] = await Promise.all([api("/tasks").catch(() => []), api("/runs").catch(() => [])]);
    const myTasks = tasks.filter((t) => t.workflowId === id).slice(0, 8);
    const taskIds = new Set(myTasks.map((t) => t.id));
    const myRuns = runs.filter((r) => taskIds.has(r.taskId)).slice(0, 8);
    $("#content").innerHTML = `
      <div class="overview"><div><a href="#/workflows" class="muted">← Workflows</a><h1><input class="input" id="wf-title" value="${esc(w.name)}" style="font-size:20px;font-weight:700;min-width:320px"/></h1><p class="mono">${esc(w.slug)} · v${w.version} · project ${esc((w.projectId || "").slice(0, 12))}</p></div>
        <div class="action-row"><label class="flex" style="gap:6px;align-items:center"><input type="checkbox" id="wf-enabled" ${w.enabled ? "checked" : ""}/> enabled</label><button class="btn" onclick="wfRun()">▶ Run</button><button class="btn btn-primary" onclick="wfSave()">Save</button><button class="btn btn-ghost" onclick="wfDelete()">Delete</button></div></div>
      <div class="card card-body"><div class="field"><label>Description</label><textarea class="textarea" id="wf-description">${esc(w.description || "")}</textarea></div></div>
      <div class="card card-body"><div class="card-title">Graph</div><div id="wf-graph" style="overflow:auto"></div></div>
      <div class="grid-2">
        <div class="card card-body"><div class="card-title flex" style="justify-content:space-between">Nodes <span class="flex" style="gap:6px"><select class="select" id="wf-new-type">${WF_NODE_TYPES.map((t) => `<option>${t}</option>`).join("")}</select><button class="btn" onclick="wfAddNode()">＋ Add node</button></span></div><div class="steps" id="wf-nodes"></div>
          <div class="card-title mt">Edges</div><div id="wf-edges"></div>
          <div class="flex" style="gap:6px;align-items:center;flex-wrap:wrap"><select class="select" id="wf-edge-from"></select><span>→</span><select class="select" id="wf-edge-to"></select><input class="input" id="wf-edge-cond" placeholder="condition (optional)" style="max-width:200px"/><button class="btn" onclick="wfAddEdge()">Link</button></div></div>
        <div class="card card-body"><div class="card-title">Node editor</div><div id="wf-node-editor"></div></div>
      </div>
      <div class="card card-body"><div class="card-title">JSON (nodes + edges)</div><textarea class="textarea mono" id="wf-json" style="min-height:180px"></textarea><div class="flex mt"><button class="btn" onclick="wfApplyJson()">Apply JSON</button></div></div>
      <div class="card card-body"><div class="card-title">Recent executions</div><div class="table-wrap"><table><thead><tr><th>Task</th><th>Status</th><th>Created</th><th>Runs</th></tr></thead><tbody>
        ${myTasks.map((t) => `<tr><td><strong>${esc(t.title)}</strong></td><td>${badge(t.status)}</td><td>${timeAgo(t.createdAt)}</td><td>${myRuns.filter((r) => r.taskId === t.id).map((r) => `<a class="btn btn-ghost" href="#/runs/${r.id}/console">${esc(r.agentType)} ${badge(r.status)}</a>`).join(" ") || "—"}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">No executions yet</td></tr>'}
      </tbody></table></div></div>`;
    wfRender();
  });

  /* TASKS */
  on("/tasks", async () => {
    const list = await api("/tasks");
    $("#content").innerHTML = `<div class="overview"><div><h1>Tasks</h1><p>Task queue & execution</p></div></div>
      ${searchPanelHtml("task-search", "Search tasks by title, status, agent, project or workflow…")}
      <div class="card card-body"><div class="table-wrap"><table><thead><tr><th>Title</th><th>Status</th><th>Agent</th><th>Project</th><th>Created</th><th></th></tr></thead><tbody id="task-tbody"></tbody></table></div></div>`;
    bindSearchPanel("task-search", list, taskRows, "#task-tbody", "task", { emptyHtml: () => `<tr><td colspan="6">${emptyState("🔎", "No matching tasks", "Try searching by title, agent, project, workflow or status.")}</td></tr>` });
  });
  function taskRows(list) {
    return list.map((t) => `<tr><td><strong>${esc(t.title)}</strong></td><td>${badge(t.status)}</td><td>${esc(t.agentType||"—")}</td><td class="mono">${(t.projectId||"—").slice(0,12)}</td><td>${timeAgo(t.createdAt)}</td><td><button class="btn btn-ghost" onclick="runTask('${t.id}')">Run</button></td></tr>`).join("");
  }
  window.runTask = async (id) => { await api(`/tasks/${id}/run`, { method: "POST" }); toast("Task queued", id.slice(0,8), "ok"); refreshCurrent(); };

  /* RUNS */
  on("/runs", async () => {
    const list = await api("/runs");
    $("#content").innerHTML = `<div class="overview"><div><h1>AI Run Console</h1><p>Observable agent executions (status, steps, results — never chain-of-thought)</p></div></div>
      ${searchPanelHtml("run-search", "Search runs by id, agent, status, model, task, project or correlation id…")}
      <div class="card card-body"><div class="table-wrap"><table><thead><tr><th>Run</th><th>Agent</th><th>Status</th><th>Tokens</th><th>Cost</th><th>Duration</th><th></th></tr></thead><tbody id="run-tbody"></tbody></table></div></div>`;
    bindSearchPanel("run-search", list, runRows, "#run-tbody", "run", { emptyHtml: () => `<tr><td colspan="7">${emptyState("🔎", "No matching runs", "Try searching by run id, agent, model, status or correlation id.")}</td></tr>` });
  });
  function runRows(list) {
    return list.map((r) => `<tr><td class="mono">${r.id.slice(0,8)}</td><td>${esc(r.agentType)}</td><td>${badge(r.status)}</td><td>${r.totalTokens}</td><td>${money(r.costUsd)}</td><td>${r.durationMs}ms</td><td><a class="btn btn-ghost" href="#/runs/${r.id}/console">Console</a></td></tr>`).join("");
  }
  on("/runs/:id/console", async (rest) => {
    const id = rest[0];
    const c = await api(`/runs/${id}/console`);
    $("#content").innerHTML = `
      <div class="overview"><div><h1>Run Console</h1><p class="mono">${esc(c.runId)}</p></div>
        <div class="action-row">${badge(c.status)}<span class="pill">Model: ${esc(c.modelId || "—")}</span></div></div>
      <div class="stat-grid">
        <div class="card stat"><div class="stat-label">Agent</div><div class="stat-value" style="font-size:16px">${esc(c.agent)}</div></div>
        <div class="card stat"><div class="stat-label">Tokens</div><div class="stat-value">${c.tokens.total}</div><div class="stat-sub">in ${c.tokens.input} · out ${c.tokens.output}</div></div>
        <div class="card stat"><div class="stat-label">Cost</div><div class="stat-value">${money(c.costUsd)}</div></div>
        <div class="card stat"><div class="stat-label">Duration</div><div class="stat-value">${c.durationMs}ms</div></div>
      </div>
      <div class="card card-body"><div class="card-title">Execution Steps</div>
        <div class="steps">${(c.steps||[]).map((s) => `<div class="step ${s.status}">
          <div class="step-ico">${s.status==="succeeded"?"✓":s.status==="failed"?"✗":s.status==="running"?"▶":s.status==="skipped"?"⏭":"○"}</div>
          <div><div class="step-label">${s.index+1}. ${esc(s.label)}</div>${s.detail?`<div class="step-detail">${esc(s.detail)}</div>`:""}${s.tool?`<div class="step-detail mono">tool: ${esc(s.tool)}</div>`:""}</div>
        </div>`).join("") || "No steps yet"}</div>
        ${c.error ? `<div class="error-state mt"><h4>Error</h4><pre>${esc(c.error)}</pre></div>` : ""}
      </div>`;
  });

  /* APPROVALS */
  on("/approvals", async () => {
    const [list, policy] = await Promise.all([api("/approvals"), api("/settings/approval").catch(() => ({ autoApprove: true, timeoutMs: 0 }))]);
    const row = approvalRow;
    const renderApprovalLists = (items) => {
      const pending = items.filter((a) => a.status === "pending");
      const history = items.filter((a) => a.status !== "pending").slice(0, 50);
      return `<div class="card card-body"><div class="card-title">Pending <span class="sub">${pending.length}</span></div>
        ${pending.length ? `<div class="table-wrap"><table><thead><tr><th>Id</th><th>Action</th><th>Project</th><th>Status</th><th>By</th><th>When</th><th></th></tr></thead><tbody>${pending.map(row).join("")}</tbody></table></div>` : emptyState("✅", "Nothing waiting", policy.autoApprove ? "Auto-approve is on — switch it off in Settings to gate dangerous steps." : "Agents will pause here (and ping Telegram) when they need a decision.")}
      </div>
      <div class="card card-body mt"><div class="card-title">History</div>
        ${history.length ? `<div class="table-wrap"><table><thead><tr><th>Id</th><th>Action</th><th>Project</th><th>Status</th><th>By</th><th>When</th><th></th></tr></thead><tbody>${history.map(row).join("")}</tbody></table></div>` : emptyState("📭", "No decisions yet", "")}
      </div>`;
    };
    $("#content").innerHTML = `<div class="overview"><div><h1>Approvals</h1><p>Human-in-the-loop gate for merges, deploys, migrations and other dangerous or costly steps</p></div>
        <div class="action-row"><span class="pill">${policy.autoApprove ? "⚠️ policy: auto-approve" : "🔒 policy: human approval required"}</span><button class="btn" onclick="location.hash='#/settings'">Policy</button></div></div>
      ${searchPanelHtml("approval-search", "Search approvals by id, action, task, project, status, decision source or approver…")}
      <div id="approval-lists"></div>`;
    bindSearchPanel("approval-search", list, renderApprovalLists, "#approval-lists", "approval", { emptyHtml: () => emptyState("🔎", "No matching approvals", "Try searching by action, task, project, status or approver.") });
  });
  function approvalRow(a) {
    return `<tr><td class="mono">${esc(a.id)}</td><td><strong>${esc(a.action)}</strong>${a.taskId ? `<div class="mono" style="color:var(--text-muted)">task ${esc(a.taskId)}</div>` : ""}</td><td class="mono">${(a.projectId || "—").slice(0, 12)}</td><td>${badge(a.status === "pending" ? "waiting_for_approval" : a.status === "approved" ? "succeeded" : a.status === "rejected" ? "failed" : "cancelled")}</td><td>${esc(a.decidedBy || "—")}<div style="color:var(--text-muted);font-size:11px">${esc(a.decisionSource || "")}</div></td><td>${timeAgo(a.decidedAt || a.requestedAt)}</td>
      <td style="white-space:nowrap">${a.status === "pending" ? `<button class="btn btn-primary" onclick="decideApproval('${a.id}','approve')">✅ Approve</button> <button class="btn" onclick="decideApproval('${a.id}','reject')">❌ Reject</button>` : ""}</td></tr>`;
  }
  window.decideApproval = async (id, decision) => {
    try {
      await api(`/approvals/${id}/${decision}`, { method: "POST", body: {} });
      toast(decision === "approve" ? "Approved" : "Rejected", id, decision === "approve" ? "ok" : "warn");
    } catch (e) { toast("Failed", e.message, "err"); }
    refreshCurrent();
  };

  /* LOGS */
  on("/logs", async () => {
    const [runs, audit, notes] = await Promise.all([api("/runs"), api("/audit").catch(() => []), api("/notifications").catch(() => [])]);
    const failed = runs.filter((r) => r.status === "failed" || r.error);
    $("#content").innerHTML = `<div class="overview"><div><h1>Logs</h1><p>Run outcomes, audit trail and notifications — traceable by correlation id</p></div></div>
      <div class="grid-2">
        <div class="card card-body"><div class="card-title">Run errors <span class="sub">${failed.length}</span></div>
          ${failed.length ? failed.slice(0, 30).map((r) => `<div class="list-row"><span>❌</span><div><strong>${esc(r.agentType)}</strong> <span class="mono" style="color:var(--text-muted)">${esc((r.correlationId || "").slice(0, 16))}</span><div style="font-size:12px;white-space:pre-wrap">${esc(r.error || (r.steps || []).filter((s) => s.status === "failed").map((s) => s.label + (s.detail ? ": " + s.detail : "")).join("; ") || "step failed")}</div></div><span class="spacer"></span><a class="btn btn-ghost" href="#/runs/${r.id}/console">Console</a></div>`).join("") : emptyState("🎉", "No errors", "All runs completed without errors.")}
        </div>
        <div class="card card-body"><div class="card-title">Notifications <span class="sub">${notes.length}</span></div>
          ${notes.length ? notes.slice(0, 30).map((n) => `<div class="list-row"><span>${n.severity === "error" ? "🔴" : n.severity === "warning" ? "🟠" : n.severity === "success" ? "🟢" : "🔵"}</span><div><strong>${esc(n.title)}</strong><div style="font-size:12px">${esc(n.message)}</div></div><span class="spacer"></span><span style="color:var(--text-muted);font-size:11px">${timeAgo(n.createdAt)}</span></div>`).join("") : emptyState("🔔", "No notifications", "")}
        </div>
      </div>
      <div class="card card-body mt"><div class="card-title">Audit log <span class="sub">${audit.length}</span></div>
        <div class="table-wrap"><table><thead><tr><th>When</th><th>Action</th><th>Result</th><th>Source</th><th>Project</th><th>Correlation</th></tr></thead><tbody>
        ${audit.slice(0, 100).map((a) => `<tr><td>${timeAgo(a.createdAt)}</td><td><strong>${esc(a.action)}</strong></td><td>${badge(a.result === "success" ? "succeeded" : a.result === "denied" || a.result === "failure" ? "failed" : "pending")}</td><td>${esc(a.source)}</td><td class="mono">${(a.projectId || "—").slice(0, 12)}</td><td class="mono">${esc((a.correlationId || "").slice(0, 16))}</td></tr>`).join("") || `<tr><td colspan="6">${emptyState("📭", "No audit entries", "")}</td></tr>`}
        </tbody></table></div>
      </div>`;
  });

  /* CONVERSATIONS */
  on("/conversations", async () => {
    const list = await api("/conversations");
    $("#content").innerHTML = `<div class="overview"><div><h1>Conversations</h1><p>Project-aware conversations with auto-summarization</p></div></div>
      ${searchPanelHtml("conversation-search", "Search conversations by title, project, source, message text or updated time…")}
      <div class="card card-body"><div class="table-wrap"><table><thead><tr><th>Title</th><th>Project</th><th>Source</th><th>Messages</th><th>Updated</th></tr></thead><tbody id="conversation-tbody"></tbody></table></div></div>`;
    bindSearchPanel("conversation-search", list, conversationRows, "#conversation-tbody", "conversation", { emptyHtml: () => `<tr><td colspan="5">${emptyState("🔎", "No matching conversations", "Try searching by title, project, source or message content.")}</td></tr>` });
  });
  function conversationRows(list) {
    return list.map((c) => `<tr><td><a href="#/conversations/${c.id}"><strong>${esc(c.title)}</strong></a></td><td class="mono">${(c.projectId||"—").slice(0,12)}</td><td>${esc(c.source)}</td><td>${c.messages.length}</td><td>${timeAgo(c.updatedAt)}</td></tr>`).join("");
  }

  /* MEMORY */
  on("/memory", async () => {
    const list = await api("/memory");
    $("#content").innerHTML = `<div class="overview"><div><h1>Memory</h1><p>GitHub-backed multi-level memory (project, agent, task, decisions, bugs, knowledge)</p></div>
      <button class="btn btn-primary" onclick="addMemory()">＋ Add Entry</button></div>
      ${searchPanelHtml("memory-search", "Search memory by type, scope, key, project, tag or content…")}
      <div class="card card-body"><div class="table-wrap"><table><thead><tr><th>Type</th><th>Scope</th><th>Key</th><th>Project</th><th>Tags</th></tr></thead><tbody id="memory-tbody"></tbody></table></div></div>`;
    bindSearchPanel("memory-search", list, memoryRows, "#memory-tbody", "memory entry", { emptyHtml: () => `<tr><td colspan="5">${emptyState("🔎", "No matching memory entries", "Try searching by type, key, tag, project or content.")}</td></tr>` });
  });
  function memoryRows(list) {
    return list.map((m) => `<tr><td><span class="badge badge-info">${esc(m.type)}</span></td><td>${esc(m.scope)}</td><td>${esc(m.key)}</td><td class="mono">${(m.projectId||"—").slice(0,12)}</td><td>${(m.tags||[]).map(t=>`<span class="badge badge-muted">${esc(t)}</span>`).join(" ")}</td></tr>`).join("");
  }
  window.addMemory = async () => {
    const projects = await api("/projects").catch(() => []);
    openModal("Add Memory Entry", `<div class="field"><label>Project</label><select class="select" id="mm-project"><option value="">(global)</option>${projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></div><div class="field"><label>Type</label><select class="select" id="mm-type">${["architecture","business","technical","decision","bug","knowledge","lesson","conversation"].map(t=>`<option ${t === "knowledge" ? "selected" : ""}>${t}</option>`).join("")}</select></div><div class="field"><label>Key</label><input class="input" id="mm-key" placeholder="auth.session-strategy"/></div><div class="field"><label>Content</label><textarea class="textarea" id="mm-content"></textarea></div><div class="field"><label>Tags (comma separated)</label><input class="input" id="mm-tags"/></div><div class="flex"><button class="btn btn-primary" id="mm-go">Save</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    $("#mm-go").onclick = async () => {
      const key = $("#mm-key").value.trim(); const content = $("#mm-content").value.trim();
      if (!key || !content) { toast("Key and content are required", "", "err"); return; }
      try {
        await api("/memory", { method: "POST", body: { projectId: $("#mm-project").value || undefined, scope: $("#mm-project").value ? "project" : "global", type: $("#mm-type").value, key, content, tags: $("#mm-tags").value.split(",").map((t) => t.trim()).filter(Boolean) } });
        closeModal(); toast("Memory saved", key, "ok"); refreshCurrent();
      } catch (e) { toast("Error", e.message, "err"); }
    };
  };

  /* GITHUB */
  // Renders the top-bar user/login slot from the cached authState. Uses the
  // OAuth config status from /auth/me (loginConfigured) — no extra request,
  // no 401 (these endpoints are public).
  async function renderUserSlot() {
    const slot = $("#user-slot");
    if (!slot) return;
    try {
      if (authState.authenticated && authState.user && authState.user.externalId !== "demo") {
        const u = authState.user;
        const avatar = u.avatarUrl ? `<img class="user-avatar" src="${esc(u.avatarUrl)}" alt=""/>` : `<span class="user-avatar user-avatar-fallback">${esc((u.name || "?").trim().slice(0, 1).toUpperCase())}</span>`;
        slot.innerHTML = `<span class="user-chip" title="${esc(u.email || "")} (${esc(u.role)})">${avatar}<span class="user-name">${esc(u.name)}</span><span class="badge badge-muted user-role">${esc(u.role)}</span></span>
          <button class="btn btn-ghost" id="logout-btn" title="Sign out">⏻</button>`;
        $("#logout-btn").onclick = async () => {
          await api("/auth/logout", { method: "POST" }).catch(() => {});
          try { localStorage.removeItem("cv_token"); } catch (_) {}
          toast("Logged out", "Signed out of GitHub.", "ok");
          await refreshAuthState();
          renderUserSlot(); refreshCurrent();
        };
      } else {
        slot.innerHTML = authState.loginConfigured
          ? `<a class="btn btn-primary" href="/auth/github/login">🐙 Sign in</a>`
          : `<a class="btn btn-ghost" href="#/github" title="GitHub OAuth is not configured — running in demo mode">👤 Demo</a>`;
      }
    } catch (_) { /* leave slot empty when API unreachable */ }
  }
  /* Login result toasts — the OAuth callback can land on any hash route
     (?login=success|error). route() refreshes session state right after this,
     so on success we use the now-valid cookie via the refreshed authState. */
  function handleLoginResultParams() {
    const q = new URLSearchParams((location.hash.split("?")[1] || ""));
    if (q.get("login") === "success" && !sessionStorage.getItem("cv-welcomed")) {
      sessionStorage.setItem("cv-welcomed", "1");
      // route() refreshes authState immediately after this function returns
      // and re-renders the user slot. Do not call /auth/me here as well: that
      // created duplicate requests (and duplicate 401s on stale deployments).
      toast("GitHub login successful", "", "ok");
    }
    if (q.get("login") === "error") {
      toast("GitHub login failed", q.get("reason") || "Please try again.", "err");
    }
  }
  on("/github", async () => {
    const status = await api("/integrations/github/status");
    // Use the cached session introspection (refreshed by route() before every
    // view). It tells us whether the protected repositories call would
    // succeed; skipping it while logged out avoids a guaranteed 401 (+ console
    // noise) in strict mode — the login card below is shown instead.
    const me = { authenticated: authState.authenticated, user: authState.user };
    const oauthStatus = await api("/auth/github/status").catch(() => ({ configured: false, diagnostics: {} }));
    // Repositories now come from the session's own GitHub token (or the server
    // token / demo data) — the API tells us which via `source`.
    const repoRes = await apiRaw("/github/repositories?limit=500").catch(() => null);
    const repoBody = repoRes && repoRes.ok ? (repoRes.body || {}) : {};
    const repos = Array.isArray(repoBody) ? repoBody : (repoBody.repositories || []);
    const repoErr = repoRes && !repoRes.ok ? ((repoRes.body && (repoRes.body.error || repoRes.body.message)) || `HTTP ${repoRes.status}`) : "";
    const repoHint = (repoRes && repoRes.body && repoRes.body.hint) || "";
    const sourceLabel = { "user-oauth": "your GitHub account", "server-token": "server GITHUB_TOKEN", mock: "demo / mock" }[repoBody.source || status.source] || (repoBody.source || status.source || "—");
    const diag = oauthStatus.diagnostics || {};
    const setupStepsHtml = oauthStatus.setupSteps ? `<ol style="font-size:12px;color:var(--text-muted);text-align:left;margin:8px 0 0 16px">${oauthStatus.setupSteps.map(s=>`<li>${esc(s)}</li>`).join("")}</ol>` : "";
    const mismatchWarn = diag.callbackUrlMismatchRisk ? `<p style="color:var(--warn, #d97706);font-size:11px">⚠️ Callback mismatch: GitHub App callback must be <span class="mono">${esc(oauthStatus.redirectUri||"")}</span></p>` : "";
    let loginCard = "";
    if (me.authenticated && me.user && me.user.externalId !== "demo") {
      loginCard = `<div class="card card-body"><div class="card-title">GitHub Login</div>
          <div class="status-grid"><div class="status-item"><span class="status-dot healthy"></span>Logged in</div></div>
          <p>${me.user.avatarUrl ? `<img src="${esc(me.user.avatarUrl)}" alt="" style="width:28px;height:28px;border-radius:50%;vertical-align:-8px;margin-right:8px"/>` : ""}<strong>${esc(me.user.name)}</strong></p>
          <p class="mono" style="color:var(--text-muted);font-size:12px">${esc(me.user.email || "")} · role: ${esc(me.user.role)}</p>
          <button class="btn" id="gh-logout">Logout</button></div>`;
    } else if (oauthStatus.configured) {
      loginCard = `<div class="card card-body"><div class="card-title">GitHub Login</div>
          <div class="status-grid"><div class="status-item"><span class="status-dot warn"></span>Not logged in</div></div>
          <p style="color:var(--text-muted);font-size:12px">Sign in with your GitHub account. The first user to log in becomes <strong>owner</strong>.</p>
          <p style="color:var(--text-muted);font-size:11px" class="mono">Callback: ${esc(oauthStatus.redirectUri||"")}</p>
          ${mismatchWarn}
          <a class="btn btn-primary" href="/auth/github/login" style="text-decoration:none">🐙 Login with GitHub</a>
          <button class="btn" id="gh-diag-btn" style="margin-left:6px">Diagnose</button>
          <div id="gh-diag" style="margin-top:8px;font-size:11px;color:var(--text-muted)"></div></div>`;
    } else {
      loginCard = `<div class="card card-body"><div class="card-title">GitHub Login — Not configured</div>
          <div class="status-grid"><div class="status-item"><span class="status-dot warn"></span>Not configured</div></div>
          ${oauthStatus.setupHint ? `<p style="color:var(--warn, #d97706);font-size:12px">${esc(oauthStatus.setupHint)}</p>` : `<p style="color:var(--text-muted);font-size:12px">Set <span class="mono">GITHUB_CLIENT_ID</span> + <span class="mono">GITHUB_CLIENT_SECRET</span> and restart — see <span class="mono">docs/GITHUB_SETUP.md</span>.</p>`}
          <div style="background:var(--glass);border:1px solid var(--border);border-radius:8px;padding:10px;margin:8px 0;text-align:left">
            <div class="meter-row"><span class="lbl">Client ID</span><span class="val">${diag.clientIdMissing ? '<span class="badge badge-err">missing</span>' : '<span class="badge badge-ok">set</span>'}</span></div>
            <div class="meter-row"><span class="lbl">Client Secret</span><span class="val">${diag.clientSecretMissing ? '<span class="badge badge-err">missing (env)</span>' : '<span class="badge badge-ok">set (env)</span>'}</span></div>
            <div class="meter-row"><span class="lbl">Session Secret</span><span class="val">${oauthStatus.secrets?.authSecret ? '<span class="badge badge-ok">set</span>' : '<span class="badge badge-err">missing</span>'}</span></div>
            <div class="meter-row"><span class="lbl">Callback</span><span class="val mono" style="font-size:10px">${esc(oauthStatus.redirectUri||"—")}</span></div>
          </div>
          ${setupStepsHtml}
          ${mismatchWarn}
          <p style="color:var(--text-muted);font-size:11px;margin-top:8px">💡 بعد از ذخیره Client ID، باید <span class="mono">GITHUB_CLIENT_SECRET</span> و <span class="mono">AUTH_SECRET</span> را در Railway → Variables (یا .env) تنظیم کنید و سرویس را Redeploy کنید.</p>
          <div class="flex mt"><a class="btn btn-primary" href="#/admin">Go to Admin → GitHub Login</a><button class="btn" id="gh-diag-btn2">Diagnose</button></div>
          <div id="gh-diag2" style="margin-top:8px;font-size:11px;color:var(--text-muted)"></div></div>`;
    }
    $("#content").innerHTML = `
      <div class="overview"><div><h1>GitHub Integration</h1><p>GitHub is the source of truth for persistent project data</p></div>
        <div class="action-row"><button class="btn btn-primary" onclick="openCreateRepo()">＋ Create repository</button><button class="btn" onclick="refreshCurrent()">Refresh</button></div></div>
      <div class="grid-3">
        <div class="card card-body"><div class="card-title">Connection</div>
          <div class="status-grid"><div class="status-item"><span class="status-dot ${status.connected?'healthy':'warn'}"></span>${status.connected?'Connected':'Mock (dev)'}</div></div>
          <p style="color:var(--text-muted);font-size:12px">Kind: ${esc(status.kind)} · Source of truth: ${status.sourceOfTruth}</p>
          <p style="color:var(--text-muted);font-size:11px">OAuth configured: ${oauthStatus.configured ? '<span class="badge badge-ok">yes</span>' : '<span class="badge badge-err">no</span>'}</p>
        </div>
        ${loginCard}
        <div class="card card-body"><div class="card-title">Repositories (${repos.length}) <span class="sub">source: ${esc(sourceLabel)}</span></div>
          ${status.viewer ? `<p class="mono" style="font-size:11px;color:var(--text-muted)">token: @${esc(status.viewer.login)}${status.viewer.scopes?.length ? " · scopes: " + esc(status.viewer.scopes.join(", ")) : ""}</p>` : ""}
          ${status.userToken && status.authenticated && !status.userToken.stored && oauthStatus.configured ? `<p class="field-hint warn">Your session has no GitHub token yet — <a href="/auth/github/login?next=%23%2Fgithub">log in again</a> to list your own repositories.</p>` : ""}
          ${status.userToken?.stored && status.userToken.canReadPrivateRepos === false ? `<p class="field-hint warn">Your token lacks the <span class="mono">repo</span> scope, so private repositories are hidden. Ask an admin to set the OAuth scope to <span class="mono">repo read:user user:email</span> and log in again.</p>` : ""}
          ${repoErr ? `<div class="error-state"><h4>Could not list repositories</h4><pre>${esc(repoErr)}</pre>${repoHint ? `<p style="font-size:12px">${esc(repoHint)}</p>` : ""}</div>` : ""}
          ${repos.length ? `<div class="repo-search"><input class="input" id="gh-repo-filter" placeholder="Filter…" style="max-width:260px;margin-bottom:8px"/></div><div class="table-wrap" style="max-height:420px;overflow:auto"><table><thead><tr><th>Repository</th><th>Visibility</th><th>Language</th><th>Default branch</th><th>Updated</th></tr></thead><tbody id="gh-repo-rows">${repos.map((r)=>`<tr data-full="${esc(r.fullName || (r.owner + "/" + r.name))}"><td class="mono">${r.htmlUrl ? `<a href="${esc(r.htmlUrl)}" target="_blank" rel="noopener">${esc(r.fullName || (r.owner + "/" + r.name))}</a>` : esc(r.fullName || (r.owner + "/" + r.name))}${r.description ? `<div style="color:var(--text-muted);font-size:11px;font-family:var(--font)">${esc(r.description)}</div>` : ""}</td><td>${r.private ? '<span class="badge badge-warn">private</span>' : '<span class="badge badge-muted">public</span>'}</td><td>${esc(r.language || "—")}</td><td class="mono">${esc(r.defaultBranch || "—")}</td><td>${timeAgo(r.updatedAt)}</td></tr>`).join("")}</tbody></table></div>` : (repoErr ? "" : emptyState("🐙", "No repositories", repoHint || "Log in with GitHub to list your repositories, or set GITHUB_TOKEN + GITHUB_ENABLED=true on the server."))}
          ${!repoErr && repoHint && repos.length ? `<p class="field-hint">${esc(repoHint)}</p>` : ""}
        </div>
      </div>`;
    const rf = document.getElementById("gh-repo-filter");
    if (rf) rf.addEventListener("input", () => { const q = rf.value.toLowerCase(); $$("#gh-repo-rows tr").forEach((tr) => { tr.style.display = tr.dataset.full.toLowerCase().includes(q) ? "" : "none"; }); });
    const lo = $("#gh-logout");
    if (lo) lo.onclick = async () => {
      await api("/auth/logout", { method: "POST" }).catch(() => {});
      try { localStorage.removeItem("cv_token"); } catch (_) {}
      toast("Logged out", "Signed out of GitHub.", "ok");
      renderUserSlot(); refreshCurrent();
    };
    const diagHandler = async (targetId) => {
      const el = document.getElementById(targetId);
      if (!el) return;
      el.innerHTML = "Checking…";
      const r = await apiRaw("/auth/github/login?format=json").catch(() => null);
      if (!r) { el.innerHTML = "Unable to contact server"; return; }
      if (r.ok) {
        el.innerHTML = `<span style="color:var(--success, #16a34a)">✓ Login URL ready — redirect to GitHub works. <a href="${esc(r.body?.url||"/auth/github/login")}">Test now</a></span>`;
      } else {
        const b = r.body || {};
        el.innerHTML = `<div style="color:var(--error, #dc2626);border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--glass);text-align:left">`+
          `<strong>${esc(b.error||"Not configured")}</strong><br/>${esc(b.hint||"")}`+
          (b.setupSteps ? `<ol style="margin:6px 0 0 16px;font-size:11px">${b.setupSteps.map(s=>`<li>${esc(s)}</li>`).join("")}</ol>` : "")+
          (b.diagnostics ? `<pre style="margin-top:6px;font-size:10px;white-space:pre-wrap">${esc(JSON.stringify(b.diagnostics,null,2))}</pre>` : "")+
          `</div>`;
      }
    };
    const b1 = document.getElementById("gh-diag-btn"); if (b1) b1.onclick = () => diagHandler("gh-diag");
    const b2 = document.getElementById("gh-diag-btn2"); if (b2) b2.onclick = () => diagHandler("gh-diag2");
  });

  /* Create a new GitHub repository from the UI (real API call). */
  window.openCreateRepo = async () => {
    openModal("Create GitHub repository", `
      <div class="field"><label>Repository name</label><input class="input mono" id="cr-name" placeholder="my-new-project"/></div>
      <div class="field"><label>Description (optional)</label><input class="input" id="cr-desc" placeholder="What is this project about?"/></div>
      <div class="field"><label class="flex" style="align-items:center;gap:8px"><input type="checkbox" id="cr-private"/> Private repository</label></div>
      <div class="flex"><button class="btn btn-primary" id="cr-go">Create</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    $("#cr-go").onclick = async () => {
      const name = $("#cr-name").value.trim();
      if (!name) { toast("Repository name required", "", "err"); $("#cr-name").focus(); return; }
      const btn = $("#cr-go"); btn.disabled = true;
      try {
        const r = await api("/github/repositories", { method: "POST", body: { name, description: $("#cr-desc").value.trim(), private: $("#cr-private").checked } });
        closeModal(); toast("Repository created", (r.repository || r).fullName, "ok"); refreshCurrent();
      } catch (e) { toast("Could not create repository", e.message, "err"); btn.disabled = false; }
    };
  };

  /* TELEGRAM */
  on("/telegram", async () => {
    const status = await api("/integrations/telegram/status");
    const accounts = status.accounts || [];
    const receiving = status.transport || "off";
    const recvBadge = receiving === "off"
      ? `<span class="badge badge-err">not receiving</span>`
      : status.ready && receiving === "polling"
        ? `<span class="badge badge-ok">long polling</span>`
        : status.ready && receiving === "webhook"
          ? `<span class="badge badge-ok">webhook</span>`
          : `<span class="badge badge-err">${esc(receiving)} — broken</span>`;
    const fixes = (status.fixes || []).length
      ? `<div class="field-hint err" style="margin-top:8px">${status.fixes.map((f) => `• ${esc(f)}`).join("<br/>")}</div>`
      : "";
    const poll = status.polling || {};
    $("#content").innerHTML = `<div class="overview"><div><h1>Telegram Integration</h1><p>Per-user Telegram bots — connect a token and the platform receives your messages, with or without a public URL.</p></div>
        <button class="btn btn-primary" onclick="openTelegramAccount()">＋ Connect a bot</button></div>
      <div class="grid-2">
        <div class="card card-body"><div class="card-title">Platform connection ${recvBadge}</div>
          <div class="status-grid"><div class="status-item"><span class="status-dot ${status.ready ? "healthy" : status.configured ? "warn" : "err"}"></span>${status.globalConnected ? `Global bot (TELEGRAM_BOT_TOKEN)${status.botUsername ? " · @" + esc(status.botUsername) : ""}` : status.configured ? `A token is set but Telegram rejected it${status.botUsername ? " · @" + esc(status.botUsername) : ""} — press 🧪 Run connection test` : "No global bot token — connect your own bot below"}</div></div>
          <div class="meter-row"><span class="lbl">Receiving mode</span><span class="val mono">${esc(status.mode || "auto")} → ${esc(receiving)}</span></div>
          <div class="meter-row"><span class="lbl">Bot API</span><span class="val mono">${esc(status.apiBase || "https://api.telegram.org")}${status.realApi === false ? ' <span class="badge badge-err">not Telegram</span>' : ""}</span></div>
          ${receiving === "polling"
            ? `<div class="meter-row"><span class="lbl">Poller</span><span class="val">${poll.running ? `✅ running · ${poll.updatesReceived || 0} update(s)` : "⏹ stopped"}</span></div>
               <div class="field-hint">No public URL needed — the bot asks Telegram for updates. Works on a laptop, a NAT'ed VPS, or a preview host.</div>`
            : `<div class="meter-row"><span class="lbl">Webhook URL</span><span class="val mono" style="font-size:10px;word-break:break-all">${esc(status.webhookUrl || "—")}</span></div>
               <div class="meter-row"><span class="lbl">Telegram sees</span><span class="val mono">${esc((status.webhookInfo && status.webhookInfo.url) || "no webhook yet")}</span></div>`}
          ${poll.lastError ? `<div class="field-hint err">${esc(poll.lastError)}</div>` : ""}
          ${fixes}
          <div class="provider-actions" style="margin-top:10px">
            <button class="btn" onclick="telegramTransport('polling')">📡 Use long polling</button>
            <button class="btn" onclick="telegramTransport('webhook')">🔗 Use webhook</button>
            <button class="btn btn-ghost" onclick="telegramTest()">🧪 Run connection test</button>
            <button class="btn btn-ghost" onclick="telegramDiagnostics()">🩺 Diagnostics</button>
            <button class="btn btn-ghost" onclick="telegramTransport('off')">⏹ Stop receiving</button>
          </div>
          <p style="color:var(--text-muted);font-size:11px;margin-top:8px">Commands: /start /projects /agents /task /run /status /tests /issues /pr /memory /skills /id /ping — or just write your request in Persian. Docs: <span class="mono">docs/TELEGRAM_SETUP.md</span></p>
        </div>
        <div class="card card-body"><div class="card-title">Preview (no bot needed)</div>
          <div class="field"><label>Message</label><input class="input" id="tg-msg" placeholder="/start" value="/start"/></div>
          <button class="btn btn-primary" id="tg-send">Show reply</button>
          <div class="card mt" id="tg-out" style="background:var(--glass);min-height:80px"></div>
        </div>
      </div>
      <div class="card card-body mt"><div class="card-title">Your bots (${accounts.length})</div>
        ${accounts.length ? `<div class="grid-2">${accounts.map((a) => `<div class="card card-body">
          <div class="card-title">${esc(a.name || a.botUsername || a.botId || a.accountId || "Bot account")} ${a.connected ? '<span class="badge badge-ok">connected</span>' : '<span class="badge badge-err">disconnected</span>'} ${a.transport === "polling" ? '<span class="badge badge-info">polling</span>' : a.webhookSet ? '<span class="badge badge-ok">webhook</span>' : '<span class="badge badge-muted">not receiving</span>'}</div>
          <div class="meter-row"><span class="lbl">Bot</span><span class="val mono">${esc(a.botUsername || a.botId || "—")}</span></div>
          <div class="meter-row"><span class="lbl">AccountId</span><span class="val mono">${esc(a.accountId || "—")}</span></div>
          <div class="meter-row"><span class="lbl">Chat</span><span class="val mono">${esc(a.chatId || "—")}${a.paired ? "" : ' <span class="badge badge-warn">not linked</span>'}</span></div>
          ${a.pairCode ? `<div class="field-hint">Send <span class="mono">/pair ${esc(a.pairCode)}</span> to your bot to link this chat. <button class="btn btn-ghost" style="padding:1px 6px;font-size:10px" onclick="navigator.clipboard&&navigator.clipboard.writeText('/pair ${esc(a.pairCode)}');toast('Copied','Paste it in Telegram','ok')">copy</button></div>` : ""}
          <div class="meter-row"><span class="lbl">Token</span><span class="val mono">${esc(a.tokenMasked || "—")}</span></div>
          <div class="meter-row"><span class="lbl">Last check</span><span class="val mono">${esc(a.lastCheckedAt || "—")}</span></div>
          ${a.lastError ? `<div class="field-hint ${a.webhookSet || a.pollingActive ? "" : "err"}">${esc(a.lastError)}</div>` : ""}
          <div class="provider-actions">
            <button class="btn" onclick="telegramConnect('${esc(a.id)}')">↻ Reconnect</button>
            <button class="btn" onclick="telegramAccountPoll('${esc(a.id)}', ${a.pollingActive ? "false" : "true"})">${a.pollingActive ? "⏹ Stop polling" : "📡 Poll for me"}</button>
            <button class="btn btn-ghost" onclick="openTelegramAccount('${esc(a.id)}')">Edit</button>
            <button class="btn btn-ghost" onclick="telegramRepair('${esc(a.id)}')">🔗 Link another chat</button>
            <button class="btn btn-danger" onclick="telegramDelete('${esc(a.id)}')">Delete</button>
          </div>
        </div>`).join("")}</div>` : emptyState("📱", "No bot connected", "Enter your Telegram bot token (from @BotFather) to connect a real account for this user.")}
      </div>`;
    const renderPreview = (r) => {
      const reply = r && r.reply;
      const kb = (reply && reply.keyboard) || [];
      $("#tg-out").innerHTML = r && r.error
        ? `<div class="error-state"><h4>Bot error</h4><p style="font-size:12px">${esc(r.error)}</p></div>`
        : reply
          ? `<div style="padding:8px 10px"><div style="white-space:pre-wrap;font-size:12px">${esc(String(reply.text || "").replace(/[*`]/g, ""))}</div>
             ${kb.length ? `<div class="flex" style="flex-wrap:wrap;gap:6px;margin-top:10px">${kb.map((row) => row.map((btn) => `<button class="btn btn-ghost" style="font-size:11px" onclick="telegramPreviewButton('${esc(btn.callback_data || "")}')">${esc(btn.text)}</button>`).join("")).join("")}</div>` : ""}</div>`
          : `<div class="field-hint">${esc(r && r.delivered ? "Sent to your Telegram chat." : "That update has no reply — send /start or type a request.")}</div>`;
    };
    window.telegramPreviewButton = async (data) => {
      if (!data) return;
      try { renderPreview(await api("/integrations/telegram/command", { method: "POST", body: { callbackData: data } })); }
      catch (e) { toast("Preview failed", e.message, "err"); }
    };
    $("#tg-send").onclick = async () => {
      try { renderPreview(await api("/integrations/telegram/command", { method: "POST", body: { text: $("#tg-msg").value } })); }
      catch (e) { toast("Preview failed", e.message, "err"); }
    };
    renderPreview(await api("/integrations/telegram/command", { method: "POST", body: { text: "/start" } }));
  });
  /**
   * "Each user brings their own bot": the token is typed here, never in an env
   * var. Until a chat is paired the bot answers nobody, so a token that leaks in
   * a group or a screenshot cannot be used to read someone's projects.
   */
  window.renderTelegramSettings = async () => {
    const host = $("#tg-settings");
    if (!host) return;
    let st;
    try { st = await api("/integrations/telegram/status"); } catch (e) { host.innerHTML = ""; return; }
    const accounts = st.accounts || [];
    const rows = accounts.length
      ? accounts.map((a) => `<div class="card card-body" style="margin-bottom:8px">
          <div class="card-title">${esc(a.name || a.botUsername || "Bot")}
            ${a.connected ? '<span class="badge badge-ok">token ok</span>' : '<span class="badge badge-err">token rejected</span>'}
            ${a.paired ? '<span class="badge badge-ok">linked</span>' : '<span class="badge badge-warn">not linked</span>'}
            <span class="badge badge-muted">${esc(a.transport || "off")}</span></div>
          <div class="meter-row"><span class="lbl">Bot</span><span class="val mono">${esc(a.botUsername ? "@" + a.botUsername : "—")} · ${esc(a.tokenMasked || "")}</span></div>
          <div class="meter-row"><span class="lbl">Answers chat</span><span class="val mono">${esc(a.chatId || "nobody yet")}</span></div>
          ${a.pairCode ? `<div class="meter-row"><span class="lbl">Pairing code</span><span class="val mono" style="font-size:14px;letter-spacing:2px">${esc(a.pairCode)}</span></div>
            <div class="field-hint">Send <span class="mono">/pair ${esc(a.pairCode)}</span> to your bot on Telegram — that chat becomes the only one it answers.</div>` : ""}
          ${a.lastError ? `<div class="field-hint err">${esc(a.lastError)}</div>` : ""}
          <div class="provider-actions" style="margin-top:8px">
            <button class="btn" onclick="openTelegramAccount('${esc(a.id)}')">✏️ Edit</button>
            <button class="btn btn-ghost" onclick="telegramAccountPoll('${esc(a.id)}', ${a.pollingActive ? "false" : "true"})">${a.pollingActive ? "⏹ Stop polling" : "📡 Poll for me"}</button>
            <button class="btn btn-ghost" onclick="telegramRepair('${esc(a.id)}')">🔗 Link another chat</button>
            <button class="btn btn-ghost" onclick="telegramConnect('${esc(a.id)}')">🔄 Re-check</button>
            <button class="btn btn-ghost" onclick="telegramDelete('${esc(a.id)}')">🗑</button>
          </div>
        </div>`).join("")
      : `<div class="field-hint">No bot connected yet. Each person here can use their own Telegram bot — create one with <span class="mono">@BotFather → /newbot</span> and paste the token below. No server variable, no webhook, no tunnel needed.</div>`;
    host.innerHTML = `<div class="card card-body mt"><div class="card-title">Your Telegram bot ${st.realApi === false ? '<span class="badge badge-err">not Telegram (TELEGRAM_API_BASE)</span>' : ""}</div>
        ${rows}
        <div class="provider-actions" style="margin-top:6px">
          <button class="btn btn-primary" onclick="openTelegramAccount()">＋ Connect a bot</button>
          <button class="btn btn-ghost" onclick="telegramTest()">🧪 Run connection test</button>
          <a class="btn btn-ghost" href="#/telegram">Full Telegram console →</a>
        </div>
      </div>`;
  };

  window.telegramRepair = async (id) => {
    try {
      await api(`/integrations/telegram/accounts/${id}`, { method: "PATCH", body: { pair: true } });
      toast("New pairing code issued", "Send /pair <code> to your bot to link a chat.", "ok");
      refreshCurrent();
    } catch (e) { toast("Could not re-pair", e.message, "err"); }
  };

  window.telegramTest = async () => {
    const btn = document.activeElement;
    if (btn) btn.disabled = true;
    try {
      const t = await api("/integrations/telegram/test");
      const icon = (st) => st === "pass" ? "✅" : st === "fail" ? "❌" : "⏭️";
      const rows = (t.steps || []).map((st) => `<div class="card card-body" style="margin-bottom:8px;padding:8px 10px">
          <div class="card-title" style="font-size:12px">${icon(st.status)} ${esc(st.label)}</div>
          ${st.detail ? `<div class="field-hint" style="font-size:11px">${esc(st.detail)}</div>` : ""}
          ${st.action ? `<div style="margin-top:6px;font-size:11.5px;color:var(--text)">👉 ${esc(st.action)}</div>` : ""}
        </div>`).join("");
      const verdictBadge = t.verdict === "ready" ? '<span class="badge badge-ok">ready</span>' : t.verdict === "degraded" ? '<span class="badge badge-warn">needs attention</span>' : '<span class="badge badge-err">blocked</span>';
      openModal(`Telegram connection test ${verdictBadge}`, `
        <p style="font-size:12px;color:var(--text-muted)">${esc(t.summary)} · transport: <span class="mono">${esc(t.transport)}</span> (mode ${esc(t.mode)})</p>
        <div style="max-height:56vh;overflow:auto">${rows}</div>
        <div class="provider-actions">
          <button class="btn" onclick="telegramTransport('polling')">📡 Switch to long polling</button>
          <button class="btn" onclick="telegramTransport('webhook')">🔗 Re-register webhook</button>
          <button class="btn btn-ghost" onclick="telegramTest()">↻ Run again</button>
        </div>`);
    } catch (e) { toast("Connection test failed", e.message, "err"); }
    finally { if (btn) btn.disabled = false; }
  };
  window.telegramTransport = async (mode) => {
    try {
      const r = await api("/integrations/telegram/transport", { method: "POST", body: { mode } });
      // A requested mode that could not come up is a warning with the reason, not a success.
      toast(r.ok ? "Telegram transport updated" : "Could not switch transport", r.message || `now ${r.transport}`, r.ok ? (r.transport === "off" ? "warn" : "ok") : "err");
      refreshCurrent();
    } catch (e) { toast("Could not change transport", e.message, "err"); }
  };
  window.telegramDiagnostics = async () => {
    try {
      const d = await api("/integrations/telegram/diagnostics");
      openModal("Telegram diagnostics", `<pre style="white-space:pre-wrap;font-size:11px;max-height:60vh;overflow:auto">${esc(JSON.stringify(d, null, 2))}</pre>
        <div class="field-hint">Live from Telegram: getMe + getWebhookInfo + the local poller state.</div>`);
    } catch (e) { toast("Diagnostics failed", e.message, "err"); }
  };
  window.telegramAccountPoll = async (id, active) => {
    try {
      await api(`/integrations/telegram/accounts/${id}/transport`, { method: "POST", body: { transport: active ? "polling" : "webhook" } });
      toast(active ? "Long polling started" : "Switched back to webhook", "", "ok");
      refreshCurrent();
    } catch (e) { toast("Could not change the account transport", e.message, "err"); }
  };
  window.openTelegramAccount = async (editId) => {
    const existing = editId ? (await api("/integrations/telegram/accounts")).find((a) => a.id === editId) : null;
    openModal(editId ? "Edit Telegram bot" : "Connect Telegram bot", `
      <div class="field"><label>Bot token <span class="select-count">from @BotFather — stored encrypted</span></label><input class="input mono" id="ta-token" type="password" placeholder="123456:ABC-DEF..." value=""/></div>
      <div class="field"><label>AccountId <span class="select-count">your Telegram numeric id (e.g. 123456789)</span></label><input class="input mono" id="ta-account" value="${esc(existing?.accountId || "")}" placeholder="123456789"/></div>
      <div class="field"><label>ChatId <span class="select-count">optional — defaults to AccountId</span></label><input class="input mono" id="ta-chat" value="${esc(existing?.chatId || "")}" placeholder="(optional)"/></div>
      <div class="field"><label>Label <span class="select-count">optional</span></label><input class="input" id="ta-name" value="${esc(existing?.name || "")}" placeholder="My bot"/></div>
      <div class="field-hint">Connect checks the token with Telegram’s real <span class="mono">getMe</span> API and registers the platform webhook.</div>
      <div class="flex"><button class="btn btn-primary" id="ta-go">${editId ? "Save & connect" : "Connect"}</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    $("#ta-go").onclick = async () => {
      const token = $("#ta-token").value.trim();
      if (!token && !editId) { toast("Bot token required", "", "err"); return; }
      const body = { token, accountId: $("#ta-account").value.trim(), chatId: $("#ta-chat").value.trim(), name: $("#ta-name").value.trim() };
      try {
        const r = editId ? await api(`/integrations/telegram/accounts/${editId}`, { method: "PATCH", body }) : await api("/integrations/telegram/accounts", { method: "POST", body });
        if (r && r.warning) toast("Bot connected — but note", r.warning, "warn");
        if (r && r.pairing) toast("Now link your chat", r.pairing.howto, "warn");
        closeModal(); toast(editId ? "Bot updated" : "Bot connected", (r.account?.botUsername || r.botUsername || "Telegram bot") + (r.account?.webhookSet ? " · webhook set" : ""), r.account?.connected || r.connected ? "ok" : "warn"); refreshCurrent();
      } catch (e) { toast("Connection failed", e.message, "err"); }
    };
  };
  window.telegramConnect = async (id) => {
    try { await api(`/integrations/telegram/accounts/${id}/connect`, { method: "POST" }); toast("Bot connection refreshed", "", "ok"); refreshCurrent(); }
    catch (e) { toast("Connect failed", e.message, "err"); }
  };
  window.telegramDelete = async (id) => {
    if (!confirm("Delete this Telegram bot account?")) return;
    try { await api(`/integrations/telegram/accounts/${id}`, { method: "DELETE" }); toast("Bot deleted", "", "ok"); refreshCurrent(); }
    catch (e) { toast("Delete failed", e.message, "err"); }
  };

  /* SETTINGS */
  on("/settings", async () => {
    const s = await api("/settings");
    const policy = await api("/settings/approval").catch(() => ({ autoApprove: true, timeoutMs: 900000, pending: 0 }));
    $("#content").innerHTML = `<div class="overview"><div><h1>Settings</h1><p>Import / Export / Backup — secrets are never exported</p></div></div>
      <div class="grid-2">
        <div class="card card-body"><div class="card-title">Platform</div>
          <div class="meter-row"><span class="lbl">Environment</span><span class="val">${esc(s.environment)}</span></div>
          <div class="meter-row"><span class="lbl">Simulation</span><span class="val">${s.simulationMode}</span></div>
          <div class="meter-row"><span class="lbl">GitHub</span><span class="val">${s.githubConnected}</span></div>
          <div class="meter-row"><span class="lbl">Telegram</span><span class="val">${s.telegramConnected}</span></div>
          <div class="card-title mt">Approval policy</div>
          <label class="flex" style="gap:8px;align-items:center"><input type="checkbox" id="pol-auto" ${policy.autoApprove ? "checked" : ""}/> Auto-approve dangerous steps (dev / simulation)</label>
          <div class="field mt"><label>Wait for a human up to (minutes)</label><input class="input" id="pol-timeout" type="number" min="1" value="${Math.round((policy.timeoutMs || 900000) / 60000)}"/></div>
          <div class="flex"><button class="btn btn-primary" id="pol-save">Save policy</button><a class="btn" href="#/approvals">🛑 Approvals (${policy.pending || 0} pending)</a></div>
          <p style="color:var(--text-muted);font-size:12px">وقتی Auto-approve خاموش باشد، مرحله‌های خطرناک (Merge، Deploy، Migration…) متوقف می‌شوند و در وب و تلگرام دکمه Approve/Reject می‌گیرید.</p>
        </div>
        <div class="card card-body"><div class="card-title">Backup & Import/Export</div>
          <div class="flex"><button class="btn" onclick="downloadBackup()">⬇ System Backup</button><button class="btn" id="restore-btn">⬆ Restore Backup</button><button class="btn" onclick="refreshCurrent()">Refresh</button><button class="btn btn-primary" onclick="location.hash='#/admin'">🛡️ Admin → System Backup</button></div>
          <input type="file" id="restore-file" accept="application/json,.json" style="display:none"/>
          <p style="color:var(--text-muted);font-size:12px">این فایل فقط تنظیمات GitHub Login را نگه می‌دارد. بکاپ کامل و زمان‌بندی‌شده (پروژه‌ها، مدل‌ها، پرووایدرها، ایجنت‌ها، کاربران و…) در <strong>Admin → System Backup</strong> است — با کلیدهای رمزنگاری‌شده (هرگز plaintext).</p>
          <p style="color:var(--text-muted);font-size:11px">💡 در Railway، قبل از Redeploy از Admin یک بکاپ کامل بگیرید و بعد از دیپلی (که دیتابیس موقت پاک می‌شود) Restore کنید تا همه‌چیز برگردد — یا Volume را طبق راهنمای Admin متصل کنید.</p>
        </div>
      </div>
      <div id="tg-settings"></div>`;
    renderTelegramSettings();
    $("#pol-save").onclick = async () => {
      const next = await api("/settings/approval", { method: "POST", body: { autoApprove: $("#pol-auto").checked, timeoutMs: Math.max(1, Number($("#pol-timeout").value || 15)) * 60000 } });
      toast("Approval policy saved", next.autoApprove ? "auto-approve" : "human approval required", "ok");
    };
    const restoreBtn = $("#restore-btn");
    const restoreFile = $("#restore-file");
    if (restoreBtn && restoreFile) {
      restoreBtn.onclick = () => restoreFile.click();
      restoreFile.onchange = async () => {
        const f = restoreFile.files?.[0];
        restoreFile.value = "";
        if (!f) return;
        try {
          const data = JSON.parse(await f.text());
          if (!data.adminSettings || typeof data.adminSettings !== "object") {
            throw new Error("فایل Backup بخش adminSettings ندارد — از نسخه جدیدتر بکاپ بگیرید");
          }
          await api("/settings/restore", { method: "POST", body: { adminSettings: data.adminSettings } });
          toast("Backup restored", "GitHub login settings were restored.", "ok");
          refreshCurrent();
        } catch (e) {
          toast("Restore failed", e.message, "err");
        }
      };
    }
  });
  window.downloadBackup = async () => {
    const b = await api("/settings/backup");
    const blob = new Blob([JSON.stringify(b, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "codevia-backup.json"; a.click();
  };

  /* ADMIN */
  on("/admin", async () => {
    const h = await api("/admin/health");
    const usage = await api("/admin/usage");
    const adm = await api("/admin/settings").catch((e) => ({ _forbidden: e.message }));
    const users = await api("/admin/users").catch(() => null);
    const bak = await api("/admin/backup").catch(() => null);
    const diag = adm.github?.diagnostics || {};
    // Ephemeral-storage warning: when the DB is on container-local storage the
    // admin GitHub settings (and users/data) are wiped on every deploy — the
    // reason the user has to "fix the GitHub settings again" each time.
    const st = h.storage || {};
    const recipe = [
      "GITHUB_CLIENT_ID=" + (adm.github?.stored?.clientId || ""),
      "GITHUB_CLIENT_SECRET=<your OAuth App client secret>",
      "GITHUB_OAUTH_CALLBACK_URL=" + (adm.github?.redirectUri || ""),
      "PUBLIC_WEB_BASE_URL=" + String(adm.github?.redirectUri || "").replace(/\/auth\/github\/callback$/, ""),
      "AUTH_SECRET=<keep the SAME random 32+ chars you already set>",
      "REQUIRE_AUTH=" + (adm.github?.requireAuth ? "true" : "false"),
    ].join("\n");
    const bakS = bak?.settings || {};
    const bakEff = bak?.effective || {};
    const lastBadge = !bakS.lastRunStatus ? '<span class="badge badge-muted">never</span>'
      : bakS.lastRunStatus === "success" ? '<span class="badge badge-ok">success</span>'
      : bakS.lastRunStatus === "failed" ? '<span class="badge badge-err">failed</span>'
      : '<span class="badge badge-warn">running</span>';
    const bakCard = bak ? `<div class="card card-body mt" id="bak-config">
        <div class="card-title">🛡️ System Backup <span class="sub">ادمین فقط — پشتیبان کامل Railway به GitHub</span></div>
        <p style="font-size:11px;color:var(--text-muted);margin:6px 0">هر دور، کل دیتابیس (پروژه‌ها، مدل‌ها، پرووایدرها، ایجنت‌ها، اسکیل‌ها، ورک‌فلوها، تسک‌ها/ران‌ها، کانورسیشن‌ها، مموری، کاربران، تلگرام، تنظیمات و…) را به‌صورت فایل JSON داخل ریپازیتوری GitHub دلخواه push می‌کند. کلیدهای رمزنگاری‌شده مثل قبل stored می‌مانند و هرگز plaintext نمی‌شوند.</p>
        ${bak.github?.kind !== "real" ? `<div class="field-hint warn">⚠ ${esc(bak.github?.hint || "GitHub is not connected — backups will not reach a real repository.")}</div>` : ""}
        <div class="grid-2">
          <div>
            <div class="field"><label class="flex" style="align-items:center;gap:8px"><input type="checkbox" id="bak-enabled" ${bakS.enabled ? "checked" : ""}/> Enable scheduled backup</label></div>
            <div class="field"><label>GitHub repository (owner/name)</label><input class="input mono" id="bak-repo" placeholder="your-org/codevia-backups" value="${esc(bakS.repo || "")}"/></div>
            <div class="field"><label>Branch</label><input class="input mono" id="bak-branch" value="${esc(bakS.branch || "main")}"/></div>
            <div class="field"><label>Path in repo</label><input class="input mono" id="bak-path" value="${esc(bakS.path || ".codevia/backups")}"/></div>
          </div>
          <div>
            <div class="field"><label>Schedule preset</label><select class="select" id="bak-preset">
              <option value="">custom (cron below)</option>
              <option value="* * * * *">Every minute</option>
              <option value="*/5 * * * *">Every 5 minutes</option>
              <option value="0 * * * *">Every hour</option>
              <option value="0 0 * * *">Every day at 00:00</option>
              <option value="0 */12 * * *">Every 12 hours</option>
              <option value="0 0 * * 0">Weekly (Sunday)</option>
            </select></div>
            <div class="field"><label>Cron (minute hour day month weekday)</label><input class="input mono" id="bak-schedule" value="${esc(bakS.schedule || bakEff.schedule || "0 * * * *")}"/><div class="field-hint">مثال ساعتی: <span class="mono">0 * * * *</span> · روزانه ساعت ۰۳:۳۰ صبح: <span class="mono">30 3 * * *</span></div></div>
            <div class="field"><label>Keep listed snapshots</label><input class="input" id="bak-retain" type="number" min="1" max="500" value="${esc(String(bakS.retain || bakEff.retain || 30))}"/></div>
            <div class="meter-row"><span class="lbl">Next run</span><span class="val mono">${esc(bak.schedule?.nextRunAt || "—")}</span></div>
            <div class="meter-row"><span class="lbl">Last run</span><span class="val">${lastBadge} ${esc(bakS.lastRunAt || "")}</span></div>
            ${bakS.lastRunError ? `<div class="field-hint err">${esc(bakS.lastRunError)}</div>` : ""}
          </div>
        </div>
        <div class="flex mt" style="flex-wrap:wrap;gap:8px">
          <button class="btn btn-primary" id="bak-save">Save settings</button>
          <button class="btn" id="bak-run">▶ Run backup now</button>
          <button class="btn" id="bak-list">📋 List backups</button>
          <button class="btn" id="bak-export">⬇ Export JSON</button>
          <button class="btn btn-danger" id="bak-restore">↺ Restore latest</button>
        </div>
        <p style="font-size:11px;color:var(--text-muted);margin-top:8px">💡 برای بازیابی بعد از هر دیپلی Railway: یک سرویس تازه با همان <span class="mono">GITHUB_TOKEN</span> وصل کنید، در همین صفحه Save و Restore کنید. تنظیمات فقط توسط Owner/Admin دیده و تغییر می‌کند.</p>
        <div id="bak-result" style="margin-top:10px"></div>
      </div>` : `<div class="card card-body mt"><div class="card-title">System Backup</div><p style="color:var(--text-muted);font-size:12px">Admin backup settings are unavailable — the API returned no config.</p></div>`;
    const stepsHtml = adm.github?.setupSteps ? `<ol style="font-size:12px;color:var(--text-muted);margin:8px 0 0 18px;text-align:left">${adm.github.setupSteps.map(s=>`<li>${esc(s)}</li>`).join("")}</ol>` : "";
    const mismatchWarn = diag.callbackUrlMismatchRisk ? `<p style="color:var(--warn, #d97706);font-size:11px">⚠️ Callback URL mismatch risk — check GitHub OAuth App settings.</p>` : "";
    /** Bind the GitHub-login modal controls (save / test / diagnose). */
    function wireAdminGithub() {
      const ghSave = document.getElementById("adm-gh-save");
      if (ghSave) ghSave.onclick = async () => {
        const btn = ghSave; btn.disabled = true; btn.textContent = "Saving…";
        try {
          const res = await api("/admin/settings/github", { method: "PUT", body: {
            clientId: document.getElementById("adm-gh-client").value,
            callbackUrl: document.getElementById("adm-gh-callback").value,
            scope: document.getElementById("adm-gh-scope").value,
            requireAuth: document.getElementById("adm-gh-require").checked,
          }});
          toast("GitHub login settings saved", res.effective?.configured ? "✓ Configured — now set env secrets if missing and redeploy" : (res.effective?.setupHint || ""), res.effective?.configured ? "ok" : "warn");
          const diagEl = document.getElementById("adm-gh-result");
          if (diagEl) {
            if (res.effective?.configured) {
              diagEl.innerHTML = `<div class="notice ok"><strong style="color:var(--ok)">✓ Saved and configured</strong><p style="font-size:11px;margin:6px 0 0">Callback: <span class="mono">${esc(res.effective.redirectUri||"")}</span></p><p style="font-size:11px;margin:4px 0 0">اگر Client Secret یا AUTH_SECRET هنوز missing است، آنها را در env تنظیم و Redeploy کنید.</p><a class="btn btn-primary" href="/auth/github/login" style="margin-top:8px;text-decoration:none">Test login now</a></div>`;
            } else {
              diagEl.innerHTML = `<div class="notice err"><strong style="color:var(--err)">Saved but still not configured</strong><p style="font-size:11px;margin:6px 0 0">${esc(res.effective?.setupHint||"")}</p>${res.effective?.setupSteps ? `<ol style="font-size:11px;margin:6px 0 0 16px">${res.effective.setupSteps.map(s=>`<li>${esc(s)}</li>`).join("")}</ol>` : ""}</div>`;
            }
          }
          setTimeout(refreshCurrent, 1500);
        } catch (e) {
          const diagEl = document.getElementById("adm-gh-result");
          if (diagEl) diagEl.innerHTML = `<div class="notice err">${esc(e.message||"Save failed")}${e.body?.setupSteps ? `<ol style="margin:6px 0 0 16px">${e.body.setupSteps.map(s=>`<li>${esc(s)}</li>`).join("")}</ol>` : ""}</div>`;
          toast("Save failed", e.message, "err");
        } finally { btn.disabled = false; btn.textContent = "Save"; }
      };
      const testBtn = document.getElementById("adm-gh-test");
      if (testBtn) testBtn.onclick = async () => {
        const el = document.getElementById("adm-gh-result");
        if (el) el.innerHTML = "Testing…";
        const r = await apiRaw("/auth/github/login?format=json");
        if (el) {
          if (r.ok) {
            el.innerHTML = `<div class="notice ok"><strong style="color:var(--ok)">✓ Ready — GitHub login URL works</strong><p style="font-size:11px;margin:6px 0 0;word-break:break-all" class="mono">${esc(r.body?.url||"")}</p><a class="btn btn-primary" href="${esc(r.body?.url||"/auth/github/login")}" style="margin-top:8px;text-decoration:none">Go to GitHub login</a></div>`;
          } else {
            const b = r.body || {};
            el.innerHTML = `<div class="notice err"><strong style="color:var(--err)">${esc(b.error||"Not configured")}</strong><p style="font-size:11px;margin:6px 0 0">${esc(b.hint||"")}</p>${b.setupSteps ? `<ol style="font-size:11px;margin:6px 0 0 16px">${b.setupSteps.map(s=>`<li>${esc(s)}</li>`).join("")}</ol>` : ""}${b.diagnostics ? `<pre style="margin-top:6px;font-size:10px;white-space:pre-wrap;background:var(--glass);padding:6px;border-radius:6px">${esc(JSON.stringify(b.diagnostics,null,2))}</pre>` : ""}</div>`;
          }
        }
      };
      const diagBtn = document.getElementById("adm-gh-diag");
      if (diagBtn) diagBtn.onclick = async () => {
        const el = document.getElementById("adm-gh-result");
        if (!el) return;
        el.innerHTML = "Loading diagnostics…";
        const s = await api("/auth/github/status").catch(()=>null);
        const a = await api("/admin/settings").catch(()=>null);
        if (el) el.innerHTML = `<pre style="white-space:pre-wrap;font-size:11px;background:var(--glass);padding:10px;border-radius:8px;border:1px solid var(--border)">${esc(JSON.stringify({ status:s, admin:a?.github }, null, 2))}</pre>`;
      };
    }
    /** Bind the per-user role save buttons in the Users modal. */
    function wireAdminUsers() {
      $$("[data-save-role]").forEach((btn) => btn.addEventListener("click", async () => {
        const id = btn.dataset.saveRole;
        const role = document.querySelector(`[data-role-for="${id}"]`).value;
        try {
          await api(`/admin/users/${id}/role`, { method: "PATCH", body: { role } });
          toast("Role updated", role, "ok"); refreshCurrent();
        } catch (e) { toast("Update failed", e.message, "err"); }
      }));
    }
    /** Bind the "copy env variables" button in the Storage modal. */
    function wireAdminEnvCopy() {
      const envCopy = document.getElementById("env-copy-btn");
      if (envCopy) envCopy.onclick = async () => {
        const txt = document.getElementById("env-recipe")?.textContent || "";
        try {
          await navigator.clipboard.writeText(txt);
          toast("Copied", "Paste the variables into Railway → Variables.", "ok");
        } catch (_) {
          toast("Copy failed", "Select and copy the text manually.", "err");
        }
      };
      // ---- System Backup admin controls ----
    }
    /** Bind every control in the Backup & restore modal. */
    function wireAdminBackup() {
      const bakResult = (html) => {
        const el = document.getElementById("bak-result");
        if (el) el.innerHTML = html || "";
      };
      const bakPreset = document.getElementById("bak-preset");
      if (bakPreset) bakPreset.onchange = () => {
        if (bakPreset.value) {
          const s = document.getElementById("bak-schedule");
          if (s) s.value = bakPreset.value;
        }
      };
      const bakSave = document.getElementById("bak-save");
      if (bakSave) bakSave.onclick = async () => {
        const btn = bakSave; btn.disabled = true; btn.textContent = "Saving…";
        try {
          const r = await api("/admin/backup", { method: "PUT", body: {
            enabled: document.getElementById("bak-enabled").checked,
            repo: document.getElementById("bak-repo").value.trim(),
            branch: document.getElementById("bak-branch").value.trim() || "main",
            path: document.getElementById("bak-path").value.trim(),
            schedule: document.getElementById("bak-schedule").value.trim(),
            retain: Number(document.getElementById("bak-retain").value) || 30,
          }});
          toast("Backup settings saved", r.effective?.repo ? "Scheduled and ready." : "Backup repository not set yet.", "ok");
          bakResult(`<div class="field-hint ok">✓ ${esc(r.effective?.repo || "Configured")} · branch ${esc(r.effective?.branch || "")} · cron ${esc(r.effective?.schedule || "")}</div>`);
          setTimeout(refreshCurrent, 800);
        } catch (e) {
          bakResult(`<div class="field-hint err">${esc(e.message)}</div>`);
          toast("Save failed", e.message, "err");
        } finally { btn.disabled = false; btn.textContent = "Save settings"; }
      };
      const bakRun = document.getElementById("bak-run");
      if (bakRun) bakRun.onclick = async () => {
        const btn = bakRun; btn.disabled = true; btn.textContent = "Backing up…";
        bakResult(`<div class="field-hint">Backing up to GitHub…</div>`);
        try {
          const r = await api("/admin/backup/run", { method: "POST", body: {} });
          if (r.ok) {
            bakResult(`<div class="field-hint ok">✓ Backup pushed · commit ${esc(r.commit || "")} · ${esc(r.files || 0)} files · ${esc(String(r.bytes || 0))} bytes\n${r.warning ? esc(r.warning) : ""}</div>`);
            toast("Backup complete", r.commit || "", "ok");
          } else {
            bakResult(`<div class="field-hint err">${esc(r.error || r.warning || "Backup failed")}</div>`);
            toast("Backup failed", r.error || r.warning || "", "err");
          }
        } catch (e) { bakResult(`<div class="field-hint err">${esc(e.message)}</div>`); toast("Backup failed", e.message, "err"); }
        finally { btn.disabled = false; btn.textContent = "▶ Run backup now"; }
      };
      const bakList = document.getElementById("bak-list");
      if (bakList) bakList.onclick = async () => {
        const btn = bakList; btn.disabled = true; btn.textContent = "Loading…";
        try {
          const r = await api("/admin/backup/list");
          const rows = (r.backups || []).map((b) => `<tr><td>${b.latest ? '<span class="badge badge-ok">latest</span>' : ""} <span class="mono">${esc(b.id)}</span></td><td class="mono">${esc(b.createdAt)}</td><td>${b.records}</td><td>${b.jobs}</td><td>${b.kv}</td><td><button class="btn btn-ghost" data-backup-snapshot="${esc(b.id)}">Restore</button></td></tr>`).join("");
          bakResult(rows ? `<div class="table-wrap"><table><thead><tr><th>Snapshot</th><th>Created</th><th>Records</th><th>Jobs</th><th>KV</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="field-hint">No backups found in ${esc(r.configured ? "the configured repository" : "a configured repository")}.</div>`);
          document.querySelectorAll("[data-backup-snapshot]").forEach((b) => b.onclick = async () => {
            const id = b.dataset.backupSnapshot;
            if (!confirm(`Restore snapshot ${id}? This replaces the full runtime state.`)) return;
            try {
              const res = await api("/admin/backup/restore", { method: "POST", body: { snapshot: id, replace: true } });
              if (res.ok) { toast("Backup restored", `${res.records} records restored`, "ok"); refreshCurrent(); }
              else toast("Restore failed", res.error || "", "err");
            } catch (e) { toast("Restore failed", e.message, "err"); }
          });
        } catch (e) { bakResult(`<div class="field-hint err">${esc(e.message)}</div>`); toast("List failed", e.message, "err"); }
        finally { btn.disabled = false; btn.textContent = "📋 List backups"; }
      };
      const bakExport = document.getElementById("bak-export");
      if (bakExport) bakExport.onclick = async () => {
        try {
          const b = await api("/admin/backup/export");
          const blob = new Blob([JSON.stringify(b, null, 2)], { type: "application/json" });
          const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "codevia-full-backup.json"; a.click();
        } catch (e) { toast("Export failed", e.message, "err"); }
      };
      const bakRestore = document.getElementById("bak-restore");
      if (bakRestore) bakRestore.onclick = async () => {
        if (!confirm("Restore the latest backup from GitHub? This replaces the full runtime database.")) return;
        const btn = bakRestore; btn.disabled = true; btn.textContent = "Restoring…";
        try {
          const res = await api("/admin/backup/restore", { method: "POST", body: { replace: true } });
          if (res.ok) { toast("Backup restored", `${res.records} records, ${res.jobs} jobs, ${res.kv} kv restored`, "ok"); refreshCurrent(); }
          else toast("Restore failed", res.error || "", "err");
        } catch (e) { toast("Restore failed", e.message, "err"); }
        finally { btn.disabled = false; btn.textContent = "↺ Restore latest"; }
      };
    }

    // ---- derived health signals for the admin console ----
    const comps = [
      { key: "API", ok: true, detail: h.api.status },
      { key: "Database", ok: h.database.status === "healthy", detail: h.database.status },
      { key: "Queue", ok: h.queue.status !== "down", detail: h.queue.status },
      { key: "GitHub", ok: h.github.status === "connected", detail: h.github.status },
      { key: "Telegram", ok: h.telegram.status === "connected", detail: h.telegram.status },
      { key: "Storage", ok: !st.warning, detail: st.warning ? "ephemeral" : "persistent" },
    ];
    const healthScore = Math.round((comps.filter((c) => c.ok).length / comps.length) * 100);
    const queueSegments = Object.entries(h.queue)
      .filter(([k, v]) => typeof v === "number")
      .map(([label, value], i) => ({ label, value, color: ["#60a5fa", "#34d399", "#fbbf24", "#fb7185", "#8990b5"][i % 5] }));
    const adminTile = (id, icon, title, desc, foot) => `<button class="admin-tile" onclick="adminOpen('${id}')">
      <span class="tile-ico">${icon}</span><strong>${esc(title)}</strong><p>${esc(desc)}</p><div class="tile-foot">${foot || ""}</div></button>`;

    $("#content").innerHTML = `<div class="overview">
        <div><h1>Admin Console</h1><p>System health, usage, access control and disaster recovery — everything operational in one place.</p></div>
        <div class="action-row">
          <button class="btn" onclick="refreshCurrent()">↻ Refresh</button>
          <button class="btn btn-primary" onclick="adminOpen('backup')">🛡️ Backup &amp; restore</button>
        </div>
      </div>

      <div class="admin-hero">
        <div class="card card-body">
          <div class="card-title">System health <span class="sub">${comps.filter((c) => c.ok).length}/${comps.length} components healthy</span></div>
          <div class="health-ring-row">
            ${gaugeRing(healthScore, { label: healthScore === 100 ? "all good" : "degraded" })}
            <div class="health-ring-info">
              <div class="status-grid">
                ${comps.map((c) => `<div class="status-item"><span class="status-dot ${c.ok ? "healthy" : "warn"}"></span>${esc(c.key)}<div class="mono" style="font-size:10px;color:var(--text-muted)">${esc(String(c.detail))}</div></div>`).join("")}
              </div>
            </div>
          </div>
        </div>
        <div class="card card-body">
          <div class="card-title">Queue depth</div>
          ${donutChart(queueSegments, { centerValue: queueSegments.reduce((s, x) => s + x.value, 0), centerLabel: "jobs", size: 150 })}
        </div>
      </div>

      ${st.warning ? `<div class="notice warn">
        <h4>⚠️ Ephemeral storage — settings are wiped on every redeploy</h4>
        <p>The database lives on the container filesystem (<span class="mono">${esc(st.dir || h.database.path)}</span>). Attach a persistent volume, or store the variables below in your host's environment.</p>
        <div class="flex mt"><button class="btn" onclick="adminOpen('storage')">Show the fix</button></div>
      </div>` : ""}

      <div class="section-title">Platform totals</div>
      <div class="stat-grid">
        <div class="card stat"><span class="stat-icon">📁</span><div class="stat-label">Projects</div><div class="stat-value">${usage.projects}</div><div class="stat-sub">${usage.agents} agents</div></div>
        <div class="card stat"><span class="stat-icon">🧠</span><div class="stat-label">Models</div><div class="stat-value">${usage.models}</div><div class="stat-sub">${h.providers.length} providers</div></div>
        <div class="card stat"><span class="stat-icon">▶️</span><div class="stat-label">Runs</div><div class="stat-value">${usage.runs}</div><div class="stat-sub">${usage.tasks} tasks</div></div>
        <div class="card stat"><span class="stat-icon">💰</span><div class="stat-label">Spend</div><div class="stat-value">${money(usage.costs.costUsd)}</div><div class="stat-sub">${usage.costs.calls} calls · ${(usage.costs.tokens / 1000).toFixed(1)}k tokens</div></div>
      </div>

      <div class="section-title">Administration</div>
      <div class="admin-tile-grid">
        ${adminTile("health", "💚", "Health & diagnostics", "Component status, queue breakdown and raw health payload.", `<span class="badge badge-${healthScore === 100 ? "ok" : "warn"}">${healthScore}% healthy</span>`)}
        ${adminTile("usage", "📊", "Usage & cost", "Token spend, call volume and platform inventory.", `<span class="badge badge-muted">${money(usage.costs.costUsd)}</span>`)}
        ${adminTile("auth", "🔐", "GitHub login", "OAuth client, callback URL, scopes and the strict-auth switch.", adm.github ? (adm.github.configured ? '<span class="badge badge-ok">configured</span>' : '<span class="badge badge-err">not configured</span>') : '<span class="badge badge-muted">restricted</span>')}
        ${adminTile("users", "👥", "Users & roles", "Grant owner, admin, developer, reviewer or viewer access.", users ? `<span class="badge badge-muted">${users.length} user(s)</span>` : '<span class="badge badge-muted">restricted</span>')}
        ${adminTile("backup", "🛡️", "Backup & restore", "Scheduled GitHub snapshots of the whole runtime state.", bak ? (bakS.enabled ? '<span class="badge badge-ok">scheduled</span>' : '<span class="badge badge-muted">off</span>') : '<span class="badge badge-muted">unavailable</span>')}
        ${adminTile("storage", "💾", "Storage", "Where the database lives and how to make it durable.", st.warning ? '<span class="badge badge-warn">ephemeral</span>' : '<span class="badge badge-ok">persistent</span>')}
      </div>`;

    /* Every admin area opens in a modal so the console stays a clean overview.
       The inner markup keeps the original element ids, so the handlers wired
       further below bind exactly as before. */
    window.adminOpen = (which) => {
      if (which === "health") {
        openModal("💚 Health & diagnostics", tabsHtml("admh", [
          { id: "comp", label: "Components", html: `<div class="card card-body"><div class="status-grid">
              ${comps.map((c) => `<div class="status-item"><span class="status-dot ${c.ok ? "healthy" : "warn"}"></span>${esc(c.key)}<div class="mono" style="font-size:10px;color:var(--text-muted)">${esc(String(c.detail))}</div></div>`).join("")}
            </div></div>` },
          { id: "queue", label: "Queue", html: `<div class="card card-body">${donutChart(queueSegments, { centerLabel: "jobs" })}
            ${Object.entries(h.queue).map(([k, v]) => `<div class="meter-row"><span class="lbl">${esc(k)}</span><span class="val">${esc(String(v))}</span></div>`).join("")}</div>` },
          { id: "raw", label: "Raw", html: `<pre style="max-height:50vh;overflow:auto">${esc(JSON.stringify(h, null, 2))}</pre>` },
        ]), { wide: true });
        return;
      }
      if (which === "usage") {
        openModal("📊 Usage & cost", `<div class="card card-body">
            <div class="kpi-row">
              <div class="kpi"><b>${usage.projects}</b><span>projects</span></div>
              <div class="kpi"><b>${usage.agents}</b><span>agents</span></div>
              <div class="kpi"><b>${usage.models}</b><span>models</span></div>
              <div class="kpi"><b>${usage.skills}</b><span>skills</span></div>
              <div class="kpi"><b>${usage.tasks}</b><span>tasks</span></div>
              <div class="kpi"><b>${usage.runs}</b><span>runs</span></div>
            </div>
          </div>
          <div class="card card-body mt"><div class="card-title">Inventory</div>
            ${barChart([
              { label: "projects", value: usage.projects }, { label: "agents", value: usage.agents },
              { label: "models", value: usage.models }, { label: "skills", value: usage.skills },
              { label: "tasks", value: usage.tasks }, { label: "runs", value: usage.runs },
            ], { width: 620 })}
          </div>
          <div class="card card-body mt"><div class="card-title">Model spend</div>
            <div class="meter-row"><span class="lbl">Calls</span><span class="val">${usage.costs.calls}</span></div>
            <div class="meter-row"><span class="lbl">Tokens</span><span class="val">${usage.costs.tokens.toLocaleString()}</span></div>
            <div class="meter-row"><span class="lbl">Cost</span><span class="val">${money(usage.costs.costUsd)}</span></div>
          </div>`, { wide: true });
        return;
      }
      if (which === "auth") {
        openModal("🔐 GitHub login", `<div class="admin-modal-body">
        <div class="card card-body"><div class="card-title">GitHub Login ${adm.github ? (adm.github.configured ? '<span class="badge badge-ok">configured ✓</span>' : '<span class="badge badge-warn">not configured ✗</span>') : ''}</div>
          ${adm._forbidden ? `<p style="color:var(--text-muted);font-size:12px">Login settings are visible to owners/admins only (${esc(adm._forbidden)}).</p>` : `
          ${adm.github?.configured ? `<div class="notice ok"><strong style="color:var(--ok)">✓ GitHub login is configured</strong><p style="font-size:11px;color:var(--text-muted);margin:4px 0 0">Callback: <span class="mono">${esc(adm.github.redirectUri||"")}</span></p></div>` : `<div class="notice err"><strong style="color:var(--err)">✗ GitHub login not ready</strong>${adm.github?.setupHint ? `<p style="font-size:12px;color:var(--err);margin:6px 0 0">${esc(adm.github.setupHint)}</p>` : ""}${stepsHtml}${mismatchWarn}</div>`}
          <div class="field"><label>OAuth Client ID ${adm.github?.clientIdSource === "env" ? '<span class="badge badge-muted">env</span>' : adm.github?.clientIdSource === "admin" ? '<span class="badge badge-info">admin</span>' : ""}</label>
            <input class="input mono" id="adm-gh-client" placeholder="Iv1.… / Ov23.…" value="${esc(adm.github?.stored?.clientId || "")}" ${adm.github?.envOverrides?.clientId ? "disabled" : ""}/>
            ${adm.github?.envOverrides?.clientId ? `<p style="color:var(--text-muted);font-size:11px">Set via GITHUB_CLIENT_ID env — effective: <span class="mono">${esc(adm.github.clientId || "")}</span></p>` : adm.github?.clientId ? `<p style="color:var(--text-muted);font-size:11px">Effective: <span class="mono">${esc(adm.github.clientId)}</span> <span class="badge badge-muted">${esc(adm.github.clientIdSource||"")}</span></p>` : `<p style="color:var(--warn, #d97706);font-size:11px">⚠️ خالی است — Client ID را از GitHub OAuth App کپی کنید (مثال: Ov23liXXXXXXXX)</p>`}</div>
          <div class="field"><label>Callback URL (optional) ${adm.github?.redirectUriSource === "env" ? '<span class="badge badge-muted">env</span>' : adm.github?.redirectUriSource === "admin" ? '<span class="badge badge-info">admin</span>' : ""}</label>
            <input class="input mono" id="adm-gh-callback" placeholder="(auto) ${esc(adm.github?.redirectUri || "")}" value="${esc(adm.github?.stored?.callbackUrl || "")}" ${adm.github?.envOverrides?.callbackUrl ? "disabled" : ""}/>
            <p style="color:var(--text-muted);font-size:11px">باید دقیقا با <span class="mono">Authorization callback URL</span> در GitHub OAuth App برابر باشد: <span class="mono">${esc(adm.github?.redirectUri || "")}</span></p></div>
          <div class="field"><label>Scope ${adm.github?.scopeSource === "env" ? '<span class="badge badge-muted">env</span>' : adm.github?.scopeSource === "admin" ? '<span class="badge badge-info">admin</span>' : ""}</label>
            <input class="input mono" id="adm-gh-scope" value="${esc(adm.github?.stored?.scope || adm.github?.scope || "")}" placeholder="repo read:user user:email"/></div>
          <div class="field"><label class="flex" style="align-items:center;gap:8px"><input type="checkbox" id="adm-gh-require" ${adm.github?.requireAuth ? "checked" : ""}/> Require GitHub login for API ${adm.github?.requireAuthSource === "env" ? '<span class="badge badge-muted">env</span>' : '<span class="badge badge-info">admin</span>'}</label>
            <p style="color:var(--text-muted);font-size:11px">اگر روشن باشد، همه APIها بدون لاگین 401 می‌دهند. فقط وقتی لاگین سالم شد روشن کنید.</p></div>
          <div style="background:var(--glass);border:1px solid var(--border);border-radius:8px;padding:10px;margin:10px 0">
            <div class="meter-row"><span class="lbl">Client ID</span><span class="val">${adm.github?.clientId ? '<span class="badge badge-ok">set</span>' : '<span class="badge badge-err">missing</span>'}</span></div>
            <div class="meter-row"><span class="lbl">Client Secret</span><span class="val">${adm.github?.clientSecretConfigured ? '<span class="badge badge-ok">set (env)</span>' : '<span class="badge badge-err">missing — set GITHUB_CLIENT_SECRET in env</span>'}</span></div>
            <div class="meter-row"><span class="lbl">Session Secret</span><span class="val">${adm.github?.secrets?.authSecret ? '<span class="badge badge-ok">set</span>' : '<span class="badge badge-err">missing — set AUTH_SECRET</span>'}</span></div>
            <div class="meter-row"><span class="lbl">GitHub Token</span><span class="val">${adm.github?.secrets?.githubToken ? '<span class="badge badge-ok">set</span>' : '<span class="badge badge-muted">not set (optional)</span>'}</span></div>
            <div class="meter-row"><span class="lbl">Webhook Secret</span><span class="val">${adm.github?.secrets?.githubWebhookSecret ? '<span class="badge badge-ok">set</span>' : '<span class="badge badge-muted">not set</span>'}</span></div>
          </div>
          ${adm.github && !adm.github.configured ? `<div class="notice warn"><p style="font-size:12px;margin:0"><strong>چرا بعد از ذخیره هنوز خطا می‌دهد؟</strong></p><p style="font-size:11px;color:var(--text-muted);margin:6px 0 0">ذخیره Client ID فقط نیمی از کار است. باید <span class="mono">GITHUB_CLIENT_SECRET</span> و <span class="mono">AUTH_SECRET</span> را هم در محیط (Railway Variables یا .env) تنظیم کنید و سرویس را <strong>Redeploy / Restart</strong> کنید. این مقادیر هرگز در دیتابیس ذخیره نمی‌شوند و فقط از env خوانده می‌شوند.</p><p style="font-size:11px;margin:6px 0 0"><strong>Railway:</strong> Service → Variables → New Variable → GITHUB_CLIENT_SECRET=… , AUTH_SECRET=… (مثال: <span class="mono">openssl rand -hex 32</span>) → Redeploy</p><p style="font-size:11px;margin:6px 0 0"><strong>Local:</strong> در <span class="mono">.env</span> اضافه کنید سپس <span class="mono">docker compose up --build</span> یا <span class="mono">npm run dev</span></p></div>` : ""}
          <p style="color:var(--text-muted);font-size:11px">Secrets live in environment variables only and are never stored here. Empty fields follow env/defaults.</p>
          <div class="flex mt" style="gap:8px;flex-wrap:wrap"><button class="btn btn-primary" id="adm-gh-save">Save</button><button class="btn" id="adm-gh-test">Test login</button><button class="btn btn-ghost" id="adm-gh-diag">Diagnose</button></div>
          <div id="adm-gh-result" style="margin-top:10px"></div>`}
        </div>
        </div>`, { wide: true });
        wireAdminGithub();
        return;
      }
      if (which === "users") {
        openModal("👥 Users & roles", `
        <div class="card card-body"><div class="card-title">Users ${users ? `(${users.length})` : ""}</div>
          ${users ? `<div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th></th></tr></thead><tbody>
            ${users.map((u) => `<tr><td>${u.avatarUrl ? `<img src="${esc(u.avatarUrl)}" alt="" style="width:20px;height:20px;border-radius:50%;vertical-align:-5px;margin-right:6px"/>` : ""}<strong>${esc(u.name)}</strong><div class="mono" style="color:var(--text-muted);font-size:11px">${esc(u.email || "")} · ${esc(u.externalId)}</div></td>
            <td><select class="select" data-role-for="${u.id}" style="max-width:130px">${["owner", "admin", "developer", "reviewer", "viewer"].map((r) => `<option value="${r}" ${u.role === r ? "selected" : ""}>${r}</option>`).join("")}</select></td>
            <td><button class="btn btn-ghost" data-save-role="${u.id}">Save</button></td></tr>`).join("")}
          </tbody></table></div>` : `<p style="color:var(--text-muted);font-size:12px">User management is visible to owners/admins only.</p>`}
        </div>
        `, { wide: true });
        wireAdminUsers();
        return;
      }
      if (which === "storage") {
        openModal("💾 Storage", `
          <div class="notice ${st.warning ? "warn" : "ok"}">
            <h4>${st.warning ? "⚠️ Ephemeral storage" : "✓ Persistent storage"}</h4>
            <p>Database path: <span class="mono">${esc(st.dir || h.database.path || "")}</span></p>
            ${st.warning ? `<p>Every redeploy starts a fresh container, so GitHub login settings, users and data are lost. Attach a volume mounted at <span class="mono">${esc(st.dir || "/app/data")}</span>, or set these variables in your host environment:</p>
            <pre id="env-recipe">${esc(recipe)}</pre>
            <div class="flex"><button class="btn" id="env-copy-btn">📋 Copy variables</button></div>` : `<p>Data survives restarts and redeploys.</p>`}
          </div>`, { wide: true });
        wireAdminEnvCopy();
        return;
      }
      if (which === "backup") {
        openModal("🛡️ Backup & restore", bakCard, { wide: true });
        wireAdminBackup();
      }
    };
  });

  /* SEARCH */
  on("/search", async () => {
    $("#content").innerHTML = `<div class="overview"><div><h1>Search</h1><p>Search everything — projects, agents, tasks, memory, skills</p></div></div>
      <div class="card card-body"><div class="field"><label>Query</label><input class="input" id="q-input" placeholder="login, accounting, bug…"/></div>
      <div id="q-results"></div></div>`;
    $("#q-input").addEventListener("input", async (e) => {
      const q = e.target.value.trim();
      if (q.length < 2) { $("#q-results").innerHTML = ""; return; }
      const r = await api("/search?q=" + encodeURIComponent(q));
      $("#q-results").innerHTML = r.results.length ? `<div class="table-wrap"><table><thead><tr><th>Type</th><th>Title</th><th>Snippet</th></tr></thead><tbody>${r.results.map((x) => `<tr><td><span class="badge badge-info">${esc(x.type)}</span></td><td><strong>${esc(x.title)}</strong></td><td>${esc(x.snippet)}</td></tr>`).join("")}</tbody></table></div>` : `<p style="color:var(--text-muted)">No results for "${esc(q)}".</p>`;
    });
  });

  /* ---------- boot ---------- */
  window.addEventListener("hashchange", route);
  renderNav();
  connectSocket();
  // route() primes session state before the first render. Calling
  // refreshAuthState() here as well used to issue two /auth/me requests on
  // every page load and could race the route gate.
  route();
})();
