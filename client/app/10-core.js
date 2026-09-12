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
  const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
  function isRtlText(text) {
    const s = String(text || "");
    if (!s.trim()) return false;
    const rtl = (s.match(/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g) || []).length;
    const ltr = (s.match(/[A-Za-z0-9]/g) || []).length;
    // Direction follows the FIRST strong character — the same rule the browser
    // uses with unicode-bidi: plaintext. Mixed messages then lay out naturally:
    // a mostly-English reply that echoes a Persian phrase (e.g. "[Mock Assistant]
    // Received: متن تست test میباشد …") stays LTR and reads in order, while
    // Persian prose with an embedded English term ("مدل gpt-4o") stays RTL.
    // Digits are weak in bidi, so a leading number does not decide direction.
    const firstStrong = s.match(/^[\s\p{P}\p{S}\d]*([\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]|[A-Za-z])/u);
    if (firstStrong) return RTL_CHAR.test(firstStrong[1]);
    return rtl >= ltr;
  }
  const dirForText = (text) => (isRtlText(text) ? "rtl" : "ltr");
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
    $("#content").innerHTML = `<div class="error-state"><h4>Something went wrong</h4><pre>${esc(err && (err.message || err))}</pre><div class="flex mt"><button class="btn btn-primary" onclick="refreshCurrent()">Retry</button></div></div>`;
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
        <button class="btn btn-primary" onclick="closeVerdict()">Done</button>
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

