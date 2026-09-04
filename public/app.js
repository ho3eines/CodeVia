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
    $("#content").innerHTML = `<div class="card card-body" style="max-width:560px;margin:40px auto;text-align:center">
      <div class="empty-emoji" style="font-size:44px">🔐</div>
      <h2 style="margin:12px 0 6px">Sign in required</h2>
      <p style="color:var(--text-muted)">This CodeVia instance requires a GitHub login for API access.</p>
      ${st.configured
        ? `<div class="flex mt" style="justify-content:center"><a class="btn btn-primary" href="/auth/github/login?next=${next}" style="text-decoration:none">🐙 Login with GitHub</a></div>`
        : `<div class="error-state mt" style="text-align:left"><h4>GitHub login is not configured</h4>
            <p style="font-size:12px;color:var(--text-muted)">${esc(st.setupHint || "Strict mode is on, but there is no way to sign in yet.")}</p>
            ${stepsHtml}
            <p style="font-size:11px;color:var(--text-muted);margin-top:8px">یا <span class="mono">REQUIRE_AUTH=false</span> را تنظیم کنید و سرویس را ری‌استارت کنید تا بدون ورود کار کند — <span class="mono">docs/GITHUB_SETUP.md</span> را ببینید.</p></div>`}
    </div>`;
  }
  function emptyState(emoji, title, text) {
    return `<div class="empty"><div class="empty-emoji">${emoji}</div><h3>${esc(title)}</h3><p>${esc(text || "")}</p></div>`;
  }
  const badge = (s) => {
    const map = { succeeded: "ok", running: "info", pending: "muted", failed: "err", waiting_for_approval: "warn", dead: "err", cancelled: "muted" };
    return `<span class="badge badge-${map[s] || "muted"}">${esc(s)}</span>`;
  };

  /* ---------- modal ---------- */
  function openModal(title, bodyHtml) {
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = bodyHtml;
    $("#modal-backdrop").hidden = false;
  }
  function closeModal() { $("#modal-backdrop").hidden = true; }

  /* ---------- realtime ---------- */
  let socket = null;
  function setLivePill(online) {
    const pill = $("#live-pill");
    if (!pill) return;
    pill.classList.toggle("offline", !online);
    const label = pill.querySelector("span:last-child") || pill;
    if (label && label !== pill) label.textContent = online ? " Live" : " Offline";
    pill.title = online ? "Realtime connected" : "Realtime disconnected — retrying automatically";
  }
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
    ["#/memory", "🗂️", "Memory", "GitHub-backed memory"],
    ["#/github", "🐙", "GitHub", "source of truth"],
    ["#/telegram", "📱", "Telegram", "bot interface"],
    ["#/settings", "⚙️", "Settings", "import/export/backup"],
    ["#/admin", "🛡️", "Admin", "system health"],
  ];
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
    $$("#palette-list li").forEach((li) => li.addEventListener("click", () => { location.hash = paletteItems[+li.dataset.i][0]; closePalette(); }));
  }
  function closePalette() { $("#palette-backdrop").hidden = true; paletteIdx = -1; }
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
    if (e.key === "Escape") { closePalette(); closeModal(); }
    if (!$("#palette-backdrop").hidden) {
      const inp = $("#palette-input");
      if (e.key === "ArrowDown") { e.preventDefault(); paletteIdx = Math.min(paletteIdx + 1, paletteItems.length - 1); renderPalette(); }
      if (e.key === "ArrowUp") { e.preventDefault(); paletteIdx = Math.max(paletteIdx - 1, 0); renderPalette(); }
      if (e.key === "Enter") { e.preventDefault(); if (paletteItems[paletteIdx]) location.hash = paletteItems[paletteIdx][0]; closePalette(); }
    }
  });
  $("#palette-input")?.addEventListener("input", renderPalette);
  $("#palette-backdrop")?.addEventListener("click", (e) => { if (e.target.id === "palette-backdrop") closePalette(); });
  $("#modal-close")?.addEventListener("click", closeModal);
  $("#modal-backdrop")?.addEventListener("click", (e) => { if (e.target.id === "modal-backdrop") closeModal(); });

  /* ---------- theme ---------- */
  $("#theme-toggle")?.addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme") || "light";
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("cv-theme", next);
  });
  const savedTheme = localStorage.getItem("cv-theme");
  if (savedTheme) document.documentElement.setAttribute("data-theme", savedTheme);

  /* ---------- Views ---------- */

  /* DASHBOARD */
  on("/dashboard", async () => {
    const d = await api("/dashboard");
    $("#content").innerHTML = `
      <div class="overview"><div><h1>Dashboard</h1><p>AI Engineering Organization overview</p></div>
        <div class="action-row">
          <button class="btn btn-primary" onclick="location.hash='#/projects'">＋ New Project</button>
          <button class="btn" onclick="location.hash='#/runs'">View Runs</button>
        </div></div>
      <div class="stat-grid">
        <div class="card stat"><div class="stat-label">Projects</div><div class="stat-value">${d.totalProjects}</div></div>
        <div class="card stat"><div class="stat-label">Active Agents</div><div class="stat-value">${d.activeAgents}</div></div>
        <div class="card stat"><div class="stat-label">Running Tasks</div><div class="stat-value">${d.runningTasks}</div></div>
        <div class="card stat"><div class="stat-label">Pending Approvals</div><div class="stat-value">${d.pendingApprovals}</div><div class="stat-sub">${d.failedTasks} failed</div></div>
      </div>
      <div class="grid-2">
        <div class="card card-body">
          <div class="card-title">Model Usage <span class="sub">${d.modelUsage.calls} calls · ${d.modelUsage.tokens.toLocaleString()} tokens</span></div>
          <div class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
            <div class="card stat"><div class="stat-label">Cost</div><div class="stat-value">${money(d.modelUsage.costUsd)}</div></div>
            <div class="card stat"><div class="stat-label">Total Runs</div><div class="stat-value">${d.totalRuns}</div></div>
          </div>
          <div class="card-title mt">Queue</div>
          <div class="meter-row"><span class="lbl">pending</span><div class="bar"><span style="width:${(d.queue.pending||0) * 20}%"></span></div><span class="val">${d.queue.pending||0}</span></div>
          <div class="meter-row"><span class="lbl">running</span><div class="bar"><span style="width:${(d.queue.running||0) * 20}%"></span></div><span class="val">${d.queue.running||0}</span></div>
        </div>
        <div class="card card-body">
          <div class="card-title">Recent Activity</div>
          ${d.recentActivity.length ? `<div class="steps">${d.recentActivity.map((r) => `<div class="step"><div class="step-ico">${r.status === "succeeded" ? "✓" : r.status === "failed" ? "✗" : "▶"}</div><div><div class="step-label">${esc(r.agentType)}</div><div class="step-detail">${timeAgo(r.createdAt)} · ${esc(r.status)}</div></div></div>`).join("")}</div>` : emptyState("📭", "No activity yet", "Run a task or a workflow to see agent activity.")}
        </div>
      </div>`;
  });

  /* PROJECTS */
  on("/projects", async () => {
    const list = await api("/projects");
    $("#content").innerHTML = `
      <div class="overview"><div><h1>Projects</h1><p>Multi-project AI engineering workspaces</p></div>
        <button class="btn btn-primary" onclick="openProjectModal()">＋ Create Project</button></div>
      ${list.length ? `<div class="card card-body"><div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Repo</th><th>Branch</th><th>Framework</th><th>Status</th><th>Created</th><th></th></tr></thead>
        <tbody>${list.map((p) => `<tr>
          <td><a href="#/projects/${p.id}"><strong>${esc(p.name)}</strong></a><div class="mono" style="color:var(--text-muted)">${esc(p.slug)}</div></td>
          <td class="mono">${esc(p.configRepo)}</td>
          <td class="mono">${esc(p.branch)}</td>
          <td>${esc(((p.capabilities?.frameworks || []).join(", ") || p.framework || "—"))}</td>
          <td>${p.active ? '<span class="badge badge-ok">active</span>' : '<span class="badge badge-muted">inactive</span>'}</td>
          <td>${timeAgo(p.createdAt)}</td>
          <td><button class="btn btn-ghost" onclick="location.hash='#/projects/${p.id}'">Open</button></td>
        </tr>`).join("")}</tbody></table></div></div>` :
        `<div class="card card-body">${emptyState("📁", "No projects yet", "Create your first project and the platform will auto-generate agents, skills, and a workflow.")}</div>`}`;
  });

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
      <div class="overview"><div><h1>Agents</h1><p>Agent registry — search, categorize, enable/disable</p></div>
        <input class="input" style="max-width:280px" id="agent-filter" placeholder="Filter agents…"/></div>
      <div class="card card-body"><div class="table-wrap"><table><thead><tr><th>Type</th><th>Name</th><th>Role</th><th>Model</th><th>Status</th><th>Project</th></tr></thead>
      <tbody id="agent-tbody">${agentRows(list)}</tbody></table></div></div>`;
    $("#agent-filter").addEventListener("input", (e) => {
      const q = e.target.value.toLowerCase();
      $("#agent-tbody").innerHTML = agentRows(list.filter((a) => (a.name + a.type + a.role).toLowerCase().includes(q)));
    });
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
          <pre style="white-space:pre-wrap;background:var(--bg);padding:12px;border-radius:8px;border:1px solid var(--border)">${esc(a.systemPrompt)}</pre>
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
  });
  window.editPrompt = async (id) => {
    const a = await api("/agents/" + id);
    openModal("Edit System Prompt", `<div class="field"><label>System Prompt</label><textarea class="textarea" id="prompt-text" style="min-height:220px">${esc(a.systemPrompt)}</textarea></div><div class="field"><label>Save as</label><input class="input" id="prompt-version" value="v${a.version+1}" readonly/></div><button class="btn btn-primary" id="prompt-save">Save (new version)</button>`);
    $("#prompt-save").onclick = async () => {
      await api("/agents/" + id, { method: "PATCH", body: { systemPrompt: $("#prompt-text").value } });
      closeModal(); toast("Prompt saved", "New version", "ok"); refreshCurrent();
    };
  };

  /* MODELS */
  on("/models", async () => {
    const [list, providers] = await Promise.all([api("/models"), api("/providers").catch(() => [])]);
    const provName = (id) => providers.find((p) => p.id === id)?.name || id;
    $("#content").innerHTML = `<div class="overview"><div><h1>Models</h1><p>Model Registry — routing candidates for agents</p></div><button class="btn btn-primary" onclick="openModel()">＋ Add Model</button></div>
      <div class="card card-body"><div class="table-wrap"><table><thead><tr><th>Display Name</th><th>Model ID</th><th>Provider</th><th>Context</th><th>Caps</th><th>Active</th><th></th></tr></thead><tbody>
      ${list.map((m) => `<tr><td><strong>${esc(m.displayName)}</strong></td><td class="mono">${esc(m.modelId)}</td><td>${esc(provName(m.providerId))}</td><td>${Number(m.contextWindow || 0).toLocaleString()}</td><td>${[m.capabilities?.code&&'code',m.capabilities?.reasoning&&'reasoning',m.capabilities?.vision&&'vision',m.capabilities?.tools&&'tools'].filter(Boolean).map((x)=>`<span class="badge badge-muted">${x}</span>`).join(" ")}</td><td>${m.active?'<span class="badge badge-ok">active</span>':'<span class="badge badge-muted">inactive</span>'}</td>
        <td style="white-space:nowrap;text-align:right"><button class="btn btn-ghost" onclick="modelToggle('${m.id}', ${m.active ? "false" : "true"})">${m.active ? "Deactivate" : "Activate"}</button><button class="btn btn-ghost" onclick="modelDelete('${m.id}')">🗑</button></td></tr>`).join("") || `<tr><td colspan="7">${emptyState("🧠", "No models", "Add a model and attach it to a provider.")}</td></tr>`}
      </tbody></table></div></div>`;
  });
  window.openModel = async () => {
    const providers = await api("/providers").catch(() => []);
    openModal("Add Model", `
      <div class="field"><label>Provider</label><select class="select" id="m-prov">${providers.map((p) => `<option value="${esc(p.id)}" ${p.active ? "" : "disabled"}>${esc(p.name)}${p.active ? "" : " (inactive)"}</option>`).join("")}</select></div>
      <div class="field"><label>Model ID <span class="select-count">provider's model name</span></label><input class="input mono" id="m-id" placeholder="gpt-4o-mini / claude-sonnet-4-5 / gemini-2.5-pro"/></div>
      <div class="field"><label>Display name</label><input class="input" id="m-name" placeholder="GPT-4o mini"/></div>
      <div class="grid-2"><div class="field"><label>Context window</label><input class="input" id="m-ctx" value="128000"/></div><div class="field"><label>Priority (lower = preferred)</label><input class="input" id="m-prio" value="100"/></div></div>
      <div class="field"><label>Capabilities</label><div class="chip-group" id="m-caps">${["code","tools","reasoning","vision","structuredOutput","streaming"].map((c) => `<span class="chip ${["code","tools","streaming"].includes(c) ? "on" : ""}" data-id="${c}">${c}</span>`).join("")}</div></div>
      <div class="flex"><button class="btn btn-primary" id="m-go">Save</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    $("#m-caps").addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (c) c.classList.toggle("on"); });
    $("#m-go").onclick = async () => {
      const modelId = $("#m-id").value.trim();
      if (!modelId) { toast("Model ID required", "", "err"); return; }
      const on = new Set($$("#m-caps .chip.on").map((c) => c.dataset.id));
      try {
        await api("/models", { method: "POST", body: {
          providerId: $("#m-prov").value, modelId, displayName: $("#m-name").value.trim() || modelId,
          contextWindow: Number($("#m-ctx").value) || 128000, priority: Number($("#m-prio").value) || 100,
          capabilities: { vision: on.has("vision"), tools: on.has("tools"), structuredOutput: on.has("structuredOutput"), code: on.has("code"), reasoning: on.has("reasoning"), streaming: on.has("streaming") },
        }});
        closeModal(); toast("Model added", modelId, "ok"); refreshCurrent();
      } catch (e) { toast("Error", e.message, "err"); }
    };
  };
  window.modelToggle = async (id, active) => {
    try { await api(`/models/${id}/${active ? "activate" : "deactivate"}`, { method: "POST" }); toast(active ? "Model activated" : "Model deactivated", "", "ok"); refreshCurrent(); }
    catch (e) { toast("Error", e.message, "err"); }
  };
  window.modelDelete = async (id) => {
    if (!confirm("Delete this model?")) return;
    try { await api(`/models/${id}`, { method: "DELETE" }); toast("Model deleted", "", "ok"); refreshCurrent(); }
    catch (e) { toast("Error", e.message, "err"); }
  };

  /* PROVIDERS */
  on("/providers", async () => {
    const list = await api("/providers");
    $("#content").innerHTML = `<div class="overview"><div><h1>Providers</h1><p>Provider-agnostic model providers. Use an env-var reference or paste the key (stored encrypted).</p></div><button class="btn btn-primary" onclick="openProvider()">＋ Add Provider</button></div>
      <div class="grid-3">${list.map((p) => {
        const ready = p.readiness?.ready !== false;
        return `<div class="card card-body" id="prov-${esc(p.id)}">
        <div class="card-title">${esc(p.name)} ${p.active ? '<span class="badge badge-ok">active</span>' : '<span class="badge badge-muted">inactive</span>'}</div>
        <div class="meter-row"><span class="lbl">Type</span><span class="val">${esc(p.type)}</span></div>
        <div class="meter-row"><span class="lbl">Format</span><span class="val">${esc(p.apiFormat)}</span></div>
        <div class="meter-row"><span class="lbl">Secret</span><span class="val mono">${esc(p.secretRef || "—")} ${p.keyPresent ? '<span class="badge badge-ok">set</span>' : '<span class="badge badge-err">missing</span>'}${p.secretValuePresent ? ` <span class="badge badge-info">${esc(p.secretMasked || "stored")}</span>` : ""}</span></div>
        <div class="meter-row"><span class="lbl">Base URL</span><span class="val mono" style="font-size:10px">${esc(p.baseUrl || "—")}</span></div>
        <div class="meter-row"><span class="lbl">Timeout</span><span class="val">${p.timeoutMs}ms</span></div>
        ${ready ? "" : `<div class="field-hint warn">⚠ ${esc(p.readiness.reason)}${p.readiness.hint ? " — " + esc(p.readiness.hint) : ""}</div>`}
        <div class="provider-actions">
          ${p.active ? `<button class="btn" onclick="providerToggle('${p.id}', false)">Deactivate</button>` : `<button class="btn btn-primary" onclick="providerToggle('${p.id}', true)">✓ Activate</button>`}
          <button class="btn" onclick="providerTest('${p.id}')">Test connection</button>
          <button class="btn" onclick="openProvider('${p.id}')">Edit</button>
          ${p.type === "mock" ? "" : `<button class="btn btn-danger" onclick="providerDelete('${p.id}')">Delete</button>`}
        </div>
        <div id="prov-test-${esc(p.id)}"></div>
      </div>`; }).join("")}</div>`;
  });
  window.providerToggle = async (id, active, force = false) => {
    try {
      await api(`/providers/${id}/${active ? "activate" : "deactivate"}${force ? "?force=true" : ""}`, { method: "POST" });
      toast(active ? "Provider activated" : "Provider deactivated", "", "ok"); refreshCurrent();
    } catch (e) {
      if (active && e.status === 422) {
        const hint = e.body?.hint ? "\n\n" + e.body.hint : "";
        if (confirm(`Cannot activate: ${e.message}${hint}\n\nActivate anyway (it will fail until the key is set)?`)) return window.providerToggle(id, true, true);
        return;
      }
      toast("Error", e.message, "err");
    }
  };
  window.providerTest = async (id) => {
    const el = document.getElementById("prov-test-" + id);
    if (el) el.innerHTML = `<div class="test-result">Testing…</div>`;
    try {
      const r = await api(`/providers/${id}/test`, { method: "POST" });
      const models = r.models?.length ? `\nModels: ${r.models.slice(0, 8).join(", ")}${r.models.length > 8 ? "…" : ""}` : "";
      if (el) el.innerHTML = `<div class="test-result ${r.ok ? "ok" : "err"}">${r.ok ? "✓" : "✗"} ${esc(r.message)}${r.hint ? "\n" + esc(r.hint) : ""}${esc(models)}</div>`;
      toast(r.ok ? "Provider OK" : "Provider test failed", r.message, r.ok ? "ok" : "err");
    } catch (e) { if (el) el.innerHTML = `<div class="test-result err">✗ ${esc(e.message)}</div>`; toast("Error", e.message, "err"); }
  };
  window.providerDelete = async (id) => {
    if (!confirm("Delete this provider? Its models will be deleted too.")) return;
    try { await api(`/providers/${id}?cascade=true`, { method: "DELETE" }); toast("Provider deleted", "", "ok"); refreshCurrent(); }
    catch (e) { toast("Error", e.message, "err"); }
  };
  window.openProvider = async (editId) => {
    const [meta, existing] = await Promise.all([api("/providers/presets").catch(() => ({ types: [], presets: {}, authTypes: ["bearer","api-key","none"], apiFormats: ["openai","anthropic","gemini","ollama","custom"] })), editId ? api("/providers/" + editId) : Promise.resolve(null)]);
    const types = meta.types?.length ? meta.types : ["openai","anthropic","gemini","openrouter","azure-openai","ollama","openai-compatible","custom-http","mock"];
    const cur = existing || { type: "openai", ...(meta.presets?.openai || {}), name: "" };
    openModal(editId ? "Edit Provider" : "Add Provider", `
      <div class="field"><label>Type</label><select class="select" id="pv-type">${types.map((t) => `<option value="${t}" ${t === cur.type ? "selected" : ""}>${esc(meta.presets?.[t]?.label || t)}</option>`).join("")}</select></div>
      <div class="field"><label>Name</label><input class="input" id="pv-name" value="${esc(cur.name || "")}" placeholder="OpenAI (prod)"/></div>
      <div class="field"><label>Base URL</label><input class="input mono" id="pv-base" value="${esc(cur.baseUrl || "")}"/></div>
      <div class="field"><label>Secret Ref <span class="select-count">optional env var name, e.g. OPENAI_API_KEY</span></label><input class="input mono" id="pv-secret" value="${esc(cur.secretRef || "")}" placeholder="OPENAI_API_KEY"/><div class="field-hint" id="pv-secret-hint"></div></div>
      <div class="field"><label>API key <span class="select-count">optional — paste the key here to store it encrypted (outlives env vars)</span></label><input class="input mono" id="pv-value" type="password" placeholder="sk-..." value=""/><div class="field-hint">${cur.secretValuePresent ? `A key is already stored (${esc(cur.secretMasked || "••••")}).` : "If you leave this empty the provider uses the Secret Ref env var above."}</div></div>
      <div class="grid-2">
        <div class="field"><label>Auth</label><select class="select" id="pv-auth">${(meta.authTypes || ["bearer","api-key","none"]).map((a) => `<option ${a === cur.authType ? "selected" : ""}>${a}</option>`).join("")}</select></div>
        <div class="field"><label>API format</label><select class="select" id="pv-format">${(meta.apiFormats || ["openai","anthropic","gemini","ollama","custom"]).map((a) => `<option ${a === cur.apiFormat ? "selected" : ""}>${a}</option>`).join("")}</select></div>
      </div>
      <div class="grid-2">
        <div class="field"><label>Timeout (ms)</label><input class="input" id="pv-timeout" value="${cur.timeoutMs || 60000}"/></div>
        <div class="field"><label>Max tokens default</label><input class="input" id="pv-maxtok" value="${cur.maxTokensDefault || 4096}"/></div>
      </div>
      <div class="flex"><button class="btn btn-primary" id="pv-go">${editId ? "Save" : "Create"}</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    const applyPreset = () => {
      const pr = meta.presets?.[$("#pv-type").value]; if (!pr) return;
      if (!editId) { $("#pv-base").value = pr.baseUrl || ""; $("#pv-secret").value = pr.secretRef || ""; if (!$("#pv-name").value) $("#pv-name").placeholder = pr.label; }
      $("#pv-auth").value = pr.authType; $("#pv-format").value = pr.apiFormat;
    };
    $("#pv-type").addEventListener("change", applyPreset);
    $("#pv-secret").addEventListener("input", () => {
      const v = $("#pv-secret").value.trim();
      const h = $("#pv-secret-hint");
      if (v && !/^[A-Z][A-Z0-9_]*$/i.test(v)) { h.className = "field-hint err"; h.textContent = "This must be an environment variable NAME like OPENAI_API_KEY (not the key value)."; }
      else { h.className = "field-hint"; h.textContent = v ? `The server reads process.env.${v}` : ""; }
    });
    $("#pv-go").onclick = async () => {
      const body = {
        name: $("#pv-name").value.trim(), type: $("#pv-type").value, baseUrl: $("#pv-base").value.trim(), secretRef: $("#pv-secret").value.trim(),
        secretValue: $("#pv-value").value.trim(),
        authType: $("#pv-auth").value, apiFormat: $("#pv-format").value, timeoutMs: Number($("#pv-timeout").value) || 60000, maxTokensDefault: Number($("#pv-maxtok").value) || 4096,
      };
      try {
        const p = editId ? await api("/providers/" + editId, { method: "PATCH", body }) : await api("/providers", { method: "POST", body });
        closeModal();
        if (p.readiness && p.readiness.ready === false) toast("Provider saved (inactive)", p.readiness.reason + (p.readiness.hint ? " — " + p.readiness.hint : ""), "warn");
        else toast(editId ? "Provider updated" : "Provider created", p.name + (p.active ? " · active" : ""), "ok");
        refreshCurrent();
      } catch (e) { toast("Error", e.message, "err"); }
    };
  };

  /* SKILLS */
  on("/skills", async () => {
    const list = await api("/skills");
    $("#content").innerHTML = `<div class="overview"><div><h1>Skills</h1><p>Skill Marketplace</p></div><input class="input" style="max-width:260px" id="skill-filter" placeholder="Search skills…"/></div><div class="grid-3" id="skill-grid">${skillCards(list)}</div>`;
    $("#skill-filter").addEventListener("input", (e) => {
      const q = e.target.value.toLowerCase();
      $("#skill-grid").innerHTML = skillCards(list.filter((s) => (s.name+s.description+s.category).toLowerCase().includes(q)));
    });
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
      <div class="card card-body"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Slug</th><th>Nodes</th><th>Version</th><th>Enabled</th><th>Project</th></tr></thead><tbody>
      ${list.map((w) => `<tr><td><a href="#/workflows/${w.id}"><strong>${esc(w.name)}</strong></a></td><td class="mono">${esc(w.slug)}</td><td>${w.nodes.length}</td><td>v${w.version}</td><td>${w.enabled?'<span class="badge badge-ok">enabled</span>':'<span class="badge badge-muted">disabled</span>'}</td><td class="mono">${(w.projectId||"—").slice(0,12)}</td></tr>`).join("")}
      </tbody></table></div></div>`;
  });
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
          nodes: [{ id: "start", type: "agent", label: "Orchestrate", agentType: "orchestrator" }], edges: [] } });
        closeModal(); toast("Workflow created", w.name, "ok"); location.hash = "#/workflows/" + w.id;
      } catch (e) { toast("Error", e.message, "err"); }
    };
  };

  /* TASKS */
  on("/tasks", async () => {
    const list = await api("/tasks");
    $("#content").innerHTML = `<div class="overview"><div><h1>Tasks</h1><p>Task queue & execution</p></div></div>
      <div class="card card-body"><div class="table-wrap"><table><thead><tr><th>Title</th><th>Status</th><th>Agent</th><th>Project</th><th>Created</th><th></th></tr></thead><tbody>
      ${list.map((t) => `<tr><td><strong>${esc(t.title)}</strong></td><td>${badge(t.status)}</td><td>${esc(t.agentType||"—")}</td><td class="mono">${(t.projectId||"—").slice(0,12)}</td><td>${timeAgo(t.createdAt)}</td><td><button class="btn btn-ghost" onclick="runTask('${t.id}')">Run</button></td></tr>`).join("")}
      </tbody></table></div></div>`;
  });
  window.runTask = async (id) => { await api(`/tasks/${id}/run`, { method: "POST" }); toast("Task queued", id.slice(0,8), "ok"); refreshCurrent(); };

  /* RUNS */
  on("/runs", async () => {
    const list = await api("/runs");
    $("#content").innerHTML = `<div class="overview"><div><h1>AI Run Console</h1><p>Observable agent executions (status, steps, results — never chain-of-thought)</p></div></div>
      <div class="card card-body"><div class="table-wrap"><table><thead><tr><th>Run</th><th>Agent</th><th>Status</th><th>Tokens</th><th>Cost</th><th>Duration</th><th></th></tr></thead><tbody>
      ${list.map((r) => `<tr><td class="mono">${r.id.slice(0,8)}</td><td>${esc(r.agentType)}</td><td>${badge(r.status)}</td><td>${r.totalTokens}</td><td>${money(r.costUsd)}</td><td>${r.durationMs}ms</td><td><a class="btn btn-ghost" href="#/runs/${r.id}/console">Console</a></td></tr>`).join("")}
      </tbody></table></div></div>`;
  });
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

  /* CONVERSATIONS */
  on("/conversations", async () => {
    const list = await api("/conversations");
    $("#content").innerHTML = `<div class="overview"><div><h1>Conversations</h1><p>Project-aware conversations with auto-summarization</p></div></div>
      <div class="card card-body"><div class="table-wrap"><table><thead><tr><th>Title</th><th>Project</th><th>Source</th><th>Messages</th><th>Updated</th></tr></thead><tbody>
      ${list.map((c) => `<tr><td><a href="#/conversations/${c.id}"><strong>${esc(c.title)}</strong></a></td><td class="mono">${(c.projectId||"—").slice(0,12)}</td><td>${esc(c.source)}</td><td>${c.messages.length}</td><td>${timeAgo(c.updatedAt)}</td></tr>`).join("")}
      </tbody></table></div></div>`;
  });

  /* MEMORY */
  on("/memory", async () => {
    const list = await api("/memory");
    $("#content").innerHTML = `<div class="overview"><div><h1>Memory</h1><p>GitHub-backed multi-level memory (project, agent, task, decisions, bugs, knowledge)</p></div>
      <button class="btn btn-primary" onclick="addMemory()">＋ Add Entry</button></div>
      <div class="card card-body"><div class="table-wrap"><table><thead><tr><th>Type</th><th>Scope</th><th>Key</th><th>Project</th><th>Tags</th></tr></thead><tbody>
      ${list.map((m) => `<tr><td><span class="badge badge-info">${esc(m.type)}</span></td><td>${esc(m.scope)}</td><td>${esc(m.key)}</td><td class="mono">${(m.projectId||"—").slice(0,12)}</td><td>${(m.tags||[]).map(t=>`<span class="badge badge-muted">${esc(t)}</span>`).join(" ")}</td></tr>`).join("")}
      </tbody></table></div></div>`;
  });
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
        const avatar = u.avatarUrl ? `<img src="${esc(u.avatarUrl)}" alt="" style="width:22px;height:22px;border-radius:50%;vertical-align:-6px;margin-right:6px"/>` : "👤 ";
        slot.innerHTML = `<span class="pill" title="${esc(u.email || "")} (${esc(u.role)})">${avatar}${esc(u.name)}</span> <button class="btn btn-ghost" id="logout-btn" style="padding:4px 10px">Logout</button>`;
        $("#logout-btn").onclick = async () => {
          await api("/auth/logout", { method: "POST" }).catch(() => {});
          try { localStorage.removeItem("cv_token"); } catch (_) {}
          toast("Logged out", "Signed out of GitHub.", "ok");
          await refreshAuthState();
          renderUserSlot(); refreshCurrent();
        };
      } else {
        slot.innerHTML = authState.loginConfigured
          ? `<a class="btn btn-primary" href="/auth/github/login" style="padding:6px 12px;text-decoration:none">🐙 Login with GitHub</a>`
          : `<a class="btn btn-ghost" href="#/github" title="GitHub OAuth not configured" style="padding:6px 12px;text-decoration:none">👤 Demo mode</a>`;
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
          <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;margin:8px 0;text-align:left">
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
        el.innerHTML = `<div style="color:var(--error, #dc2626);border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--bg);text-align:left">`+
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
    $("#content").innerHTML = `<div class="overview"><div><h1>Telegram Integration</h1><p>Per-user Telegram bots — each user connects their own token & AccountId and gets a real bot.</p></div>
        <button class="btn btn-primary" onclick="openTelegramAccount()">＋ Connect a bot</button></div>
      <div class="grid-2">
        <div class="card card-body"><div class="card-title">Platform connection</div>
          <div class="status-grid"><div class="status-item"><span class="status-dot ${status.globalConnected?'healthy':'warn'}"></span>${status.globalConnected?'Global bot (TELEGRAM_BOT_TOKEN)':'No global bot token — connect your own bot below'}</div></div>
          <div class="meter-row"><span class="lbl">Webhook URL</span><span class="val mono" style="font-size:10px;word-break:break-all">${esc(status.webhookUrl || "—")}</span></div>
          <p style="color:var(--text-muted);font-size:11px">After connecting a bot, set its webhook to the URL above (or use “Connect” which attempts it automatically). Commands: /start /projects /agents /task /run /status /tests /issues /pr /memory /skills</p>
        </div>
        <div class="card card-body"><div class="card-title">Preview</div>
          <div class="field"><label>Message</label><input class="input" id="tg-msg" placeholder="/start"/></div>
          <button class="btn btn-primary" id="tg-send">Send</button>
          <div class="card mt"><div class="card-body" id="tg-out" style="background:var(--bg);min-height:80px"></div></div>
        </div>
      </div>
      <div class="card card-body mt"><div class="card-title">Your bots (${accounts.length})</div>
        ${accounts.length ? `<div class="grid-2">${accounts.map((a) => `<div class="card card-body">
          <div class="card-title">${esc(a.name || a.botUsername || a.botId || a.accountId || "Bot account")} ${a.connected ? '<span class="badge badge-ok">connected</span>' : '<span class="badge badge-err">disconnected</span>'}</div>
          <div class="meter-row"><span class="lbl">Bot</span><span class="val mono">${esc(a.botUsername || a.botId || "—")}</span></div>
          <div class="meter-row"><span class="lbl">AccountId</span><span class="val mono">${esc(a.accountId || "—")}</span></div>
          <div class="meter-row"><span class="lbl">Chat</span><span class="val mono">${esc(a.chatId || "—")}</span></div>
          <div class="meter-row"><span class="lbl">Token</span><span class="val mono">${esc(a.tokenMasked || "—")}</span></div>
          <div class="meter-row"><span class="lbl">Webhook</span><span class="val">${a.webhookSet ? '<span class="badge badge-ok">set</span>' : '<span class="badge badge-muted">not set</span>'}</span></div>
          ${a.lastError ? `<div class="field-hint err">${esc(a.lastError)}</div>` : ""}
          <div class="provider-actions">
            <button class="btn" onclick="telegramConnect('${esc(a.id)}')">↻ Connect</button>
            <button class="btn btn-ghost" onclick="openTelegramAccount('${esc(a.id)}')">Edit</button>
            <button class="btn btn-danger" onclick="telegramDelete('${esc(a.id)}')">Delete</button>
          </div>
        </div>`).join("")}</div>` : emptyState("📱", "No bot connected", "Enter your Telegram bot token + AccountId to connect a real account for this user.")}
      </div>`;
    $("#tg-send").onclick = async () => {
      const r = await api("/integrations/telegram/command", { method: "POST", body: { text: $("#tg-msg").value } });
      $("#tg-out").innerHTML = `<pre style="white-space:pre-wrap">${esc(JSON.stringify(r, null, 2))}</pre>`;
    };
  });
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
    $("#content").innerHTML = `<div class="overview"><div><h1>Settings</h1><p>Import / Export / Backup — secrets are never exported</p></div></div>
      <div class="grid-2">
        <div class="card card-body"><div class="card-title">Platform</div>
          <div class="meter-row"><span class="lbl">Environment</span><span class="val">${esc(s.environment)}</span></div>
          <div class="meter-row"><span class="lbl">Simulation</span><span class="val">${s.simulationMode}</span></div>
          <div class="meter-row"><span class="lbl">GitHub</span><span class="val">${s.githubConnected}</span></div>
          <div class="meter-row"><span class="lbl">Telegram</span><span class="val">${s.telegramConnected}</span></div>
        </div>
        <div class="card card-body"><div class="card-title">Backup & Import/Export</div>
          <div class="flex"><button class="btn" onclick="downloadBackup()">⬇ System Backup</button><button class="btn" id="restore-btn">⬆ Restore Backup</button><button class="btn" onclick="refreshCurrent()">Refresh</button></div>
          <input type="file" id="restore-file" accept="application/json,.json" style="display:none"/>
          <p style="color:var(--text-muted);font-size:12px">Secrets are stored as references (e.g. OPENAI_API_KEY) and are never included in exports.</p>
          <p style="color:var(--text-muted);font-size:11px">💡 بکاپ شامل تنظیمات GitHub Login (بدون secrets) است. در Railway، قبل از Redeploy بکاپ بگیرید و بعد از دیپلی (که دیتابیس موقت پاک می‌شود) Restore کنید تا تنظیمات برگردند — یا Volume را طبق راهنمای Admin متصل کنید تا دیگر نیازی به این نباشد.</p>
        </div>
      </div>`;
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
    const storageWarnHtml = st.warning ? `
      <div class="card card-body" style="border:1px solid #f59e0b;background:#fffbeb">
        <div class="card-title" style="color:#92400e">⚠️ ذخیره‌سازی موقت — تنظیمات بعد از هر Redeploy پاک می‌شوند</div>
        <p style="font-size:12px;color:#92400e;margin:4px 0">دیتابیس روی فایل‌سیستم موقت کانتینر است (<span class="mono">${esc(st.dir || h.database.path)}</span>). در Railway هر Redeploy یک کانتینر تازه می‌سازد و همه‌چیز — تنظیمات GitHub Login، کاربران و داده‌ها — پاک می‌شود. به همین دلیل هر بار باید تنظیمات را دوباره وارد کنید.</p>
        <p style="font-size:12px;color:#92400e;margin:8px 0 4px"><strong>راه‌حل دائمی (فقط یک‌بار):</strong> در Railway → سرویس CodeVia → Settings → <strong>Storage</strong> → <strong>Add Volume</strong> → Mount Path را بگذارید <span class="mono">${esc(st.dir || "/app/data")}</span> → سپس یک Redeploy. از این به بعد تنظیمات و داده‌ها بین دیپلی‌ها ماندگار می‌شود.</p>
        <p style="font-size:12px;color:#92400e;margin:8px 0 4px"><strong>یا</strong> همین مقادیر را یک‌بار در <strong>Railway → Variables</strong> ثبت کنید تا تنظیمات لاگین بدون Volume هم دائمی باشد (env ارجحیت بالاتر از پنل Admin دارد):</p>
        <pre id="env-recipe" style="background:#fff;border:1px solid #fde68a;border-radius:8px;padding:10px;font-size:11px;white-space:pre-wrap;direction:ltr;margin:6px 0">${esc(recipe)}</pre>
        <div class="flex" style="gap:8px"><button class="btn" id="env-copy-btn">📋 Copy Variables</button></div>
      </div>` : "";
    const stepsHtml = adm.github?.setupSteps ? `<ol style="font-size:12px;color:var(--text-muted);margin:8px 0 0 18px;text-align:left">${adm.github.setupSteps.map(s=>`<li>${esc(s)}</li>`).join("")}</ol>` : "";
    const mismatchWarn = diag.callbackUrlMismatchRisk ? `<p style="color:var(--warn, #d97706);font-size:11px">⚠️ Callback URL mismatch risk — check GitHub OAuth App settings.</p>` : "";
    $("#content").innerHTML = `<div class="overview"><div><h1>Admin</h1><p>System health & usage</p></div></div>
      <div class="stat-grid">
        <div class="card stat"><div class="stat-label">API</div><div class="stat-value" style="font-size:18px">${h.api.status}</div></div>
        <div class="card stat"><div class="stat-label">Database</div><div class="stat-value" style="font-size:18px">${h.database.status}</div></div>
        <div class="card stat"><div class="stat-label">Queue</div><div class="stat-value" style="font-size:18px">${h.queue.status}</div></div>
        <div class="card stat"><div class="stat-label">Providers</div><div class="stat-value" style="font-size:18px">${h.providers.length}</div></div>
      </div>
      ${storageWarnHtml}
      <div class="grid-2">
        <div class="card card-body"><div class="card-title">Component Health</div>
          <div class="status-grid"><div class="status-item"><span class="status-dot ${h.database.status==='healthy'?'healthy':'down'}"></span>Database</div><div class="status-item"><span class="status-dot ${h.github.status==='connected'?'healthy':'warn'}"></span>GitHub</div><div class="status-item"><span class="status-dot ${h.telegram.status==='connected'?'healthy':'warn'}"></span>Telegram</div><div class="status-item"><span class="status-dot healthy"></span>API</div></div>
          <div class="card-title mt">Queue</div>
          <div class="status-grid">${Object.entries(h.queue).map(([k,v])=>`<div class="status-item"><div style="font-size:22px;font-weight:800">${v}</div><div class="mono" style="color:var(--text-muted)">${esc(k)}</div></div>`).join("")}</div>
        </div>
        <div class="card card-body"><div class="card-title">Usage</div>
          <div class="meter-row"><span class="lbl">Projects</span><span class="val">${usage.projects}</span></div>
          <div class="meter-row"><span class="lbl">Agents</span><span class="val">${usage.agents}</span></div>
          <div class="meter-row"><span class="lbl">Tasks</span><span class="val">${usage.tasks}</span></div>
          <div class="meter-row"><span class="lbl">Runs</span><span class="val">${usage.runs}</span></div>
          <div class="meter-row"><span class="lbl">Cost</span><span class="val">${money(usage.costs.costUsd)}</span></div>
        </div>
      </div>
      <div class="grid-2 mt">
        <div class="card card-body"><div class="card-title">GitHub Login ${adm.github ? (adm.github.configured ? '<span class="badge badge-ok">configured ✓</span>' : '<span class="badge badge-warn">not configured ✗</span>') : ''}</div>
          ${adm._forbidden ? `<p style="color:var(--text-muted);font-size:12px">Login settings are visible to owners/admins only (${esc(adm._forbidden)}).</p>` : `
          ${adm.github?.configured ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px;margin-bottom:12px"><strong style="color:#16a34a">✓ GitHub login is configured</strong><p style="font-size:11px;color:var(--text-muted);margin:4px 0 0">Callback: <span class="mono">${esc(adm.github.redirectUri||"")}</span></p></div>` : `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px;margin-bottom:12px"><strong style="color:#dc2626">✗ GitHub login not ready</strong>${adm.github?.setupHint ? `<p style="font-size:12px;color:#991b1b;margin:6px 0 0">${esc(adm.github.setupHint)}</p>` : ""}${stepsHtml}${mismatchWarn}</div>`}
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
          <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;margin:10px 0">
            <div class="meter-row"><span class="lbl">Client ID</span><span class="val">${adm.github?.clientId ? '<span class="badge badge-ok">set</span>' : '<span class="badge badge-err">missing</span>'}</span></div>
            <div class="meter-row"><span class="lbl">Client Secret</span><span class="val">${adm.github?.clientSecretConfigured ? '<span class="badge badge-ok">set (env)</span>' : '<span class="badge badge-err">missing — set GITHUB_CLIENT_SECRET in env</span>'}</span></div>
            <div class="meter-row"><span class="lbl">Session Secret</span><span class="val">${adm.github?.secrets?.authSecret ? '<span class="badge badge-ok">set</span>' : '<span class="badge badge-err">missing — set AUTH_SECRET</span>'}</span></div>
            <div class="meter-row"><span class="lbl">GitHub Token</span><span class="val">${adm.github?.secrets?.githubToken ? '<span class="badge badge-ok">set</span>' : '<span class="badge badge-muted">not set (optional)</span>'}</span></div>
            <div class="meter-row"><span class="lbl">Webhook Secret</span><span class="val">${adm.github?.secrets?.githubWebhookSecret ? '<span class="badge badge-ok">set</span>' : '<span class="badge badge-muted">not set</span>'}</span></div>
          </div>
          ${adm.github && !adm.github.configured ? `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px;margin:8px 0"><p style="font-size:12px;margin:0"><strong>چرا بعد از ذخیره هنوز خطا می‌دهد؟</strong></p><p style="font-size:11px;color:var(--text-muted);margin:6px 0 0">ذخیره Client ID فقط نیمی از کار است. باید <span class="mono">GITHUB_CLIENT_SECRET</span> و <span class="mono">AUTH_SECRET</span> را هم در محیط (Railway Variables یا .env) تنظیم کنید و سرویس را <strong>Redeploy / Restart</strong> کنید. این مقادیر هرگز در دیتابیس ذخیره نمی‌شوند و فقط از env خوانده می‌شوند.</p><p style="font-size:11px;margin:6px 0 0"><strong>Railway:</strong> Service → Variables → New Variable → GITHUB_CLIENT_SECRET=… , AUTH_SECRET=… (مثال: <span class="mono">openssl rand -hex 32</span>) → Redeploy</p><p style="font-size:11px;margin:6px 0 0"><strong>Local:</strong> در <span class="mono">.env</span> اضافه کنید سپس <span class="mono">docker compose up --build</span> یا <span class="mono">npm run dev</span></p></div>` : ""}
          <p style="color:var(--text-muted);font-size:11px">Secrets live in environment variables only and are never stored here. Empty fields follow env/defaults.</p>
          <div class="flex mt" style="gap:8px;flex-wrap:wrap"><button class="btn btn-primary" id="adm-gh-save">Save</button><button class="btn" id="adm-gh-test">Test login</button><button class="btn btn-ghost" id="adm-gh-diag">Diagnose</button></div>
          <div id="adm-gh-result" style="margin-top:10px"></div>`}
        </div>
        <div class="card card-body"><div class="card-title">Users ${users ? `(${users.length})` : ""}</div>
          ${users ? `<div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th></th></tr></thead><tbody>
            ${users.map((u) => `<tr><td>${u.avatarUrl ? `<img src="${esc(u.avatarUrl)}" alt="" style="width:20px;height:20px;border-radius:50%;vertical-align:-5px;margin-right:6px"/>` : ""}<strong>${esc(u.name)}</strong><div class="mono" style="color:var(--text-muted);font-size:11px">${esc(u.email || "")} · ${esc(u.externalId)}</div></td>
            <td><select class="select" data-role-for="${u.id}" style="max-width:130px">${["owner", "admin", "developer", "reviewer", "viewer"].map((r) => `<option value="${r}" ${u.role === r ? "selected" : ""}>${r}</option>`).join("")}</select></td>
            <td><button class="btn btn-ghost" data-save-role="${u.id}">Save</button></td></tr>`).join("")}
          </tbody></table></div>` : `<p style="color:var(--text-muted);font-size:12px">User management is visible to owners/admins only.</p>`}
        </div>
      </div>`;
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
            diagEl.innerHTML = `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px"><strong style="color:#16a34a">✓ Saved and configured</strong><p style="font-size:11px;margin:6px 0 0">Callback: <span class="mono">${esc(res.effective.redirectUri||"")}</span></p><p style="font-size:11px;margin:4px 0 0">اگر Client Secret یا AUTH_SECRET هنوز missing است، آنها را در env تنظیم و Redeploy کنید.</p><a class="btn btn-primary" href="/auth/github/login" style="margin-top:8px;text-decoration:none">Test login now</a></div>`;
          } else {
            diagEl.innerHTML = `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px"><strong style="color:#dc2626">Saved but still not configured</strong><p style="font-size:11px;margin:6px 0 0">${esc(res.effective?.setupHint||"")}</p>${res.effective?.setupSteps ? `<ol style="font-size:11px;margin:6px 0 0 16px">${res.effective.setupSteps.map(s=>`<li>${esc(s)}</li>`).join("")}</ol>` : ""}</div>`;
          }
        }
        setTimeout(refreshCurrent, 1500);
      } catch (e) {
        const diagEl = document.getElementById("adm-gh-result");
        if (diagEl) diagEl.innerHTML = `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px;color:#991b1b;font-size:12px">${esc(e.message||"Save failed")}${e.body?.setupSteps ? `<ol style="margin:6px 0 0 16px">${e.body.setupSteps.map(s=>`<li>${esc(s)}</li>`).join("")}</ol>` : ""}</div>`;
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
          el.innerHTML = `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px"><strong style="color:#16a34a">✓ Ready — GitHub login URL works</strong><p style="font-size:11px;margin:6px 0 0;word-break:break-all" class="mono">${esc(r.body?.url||"")}</p><a class="btn btn-primary" href="${esc(r.body?.url||"/auth/github/login")}" style="margin-top:8px;text-decoration:none">Go to GitHub login</a></div>`;
        } else {
          const b = r.body || {};
          el.innerHTML = `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px;text-align:left"><strong style="color:#dc2626">${esc(b.error||"Not configured")}</strong><p style="font-size:11px;margin:6px 0 0">${esc(b.hint||"")}</p>${b.setupSteps ? `<ol style="font-size:11px;margin:6px 0 0 16px">${b.setupSteps.map(s=>`<li>${esc(s)}</li>`).join("")}</ol>` : ""}${b.diagnostics ? `<pre style="margin-top:6px;font-size:10px;white-space:pre-wrap;background:var(--bg);padding:6px;border-radius:6px">${esc(JSON.stringify(b.diagnostics,null,2))}</pre>` : ""}</div>`;
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
      if (el) el.innerHTML = `<pre style="white-space:pre-wrap;font-size:11px;background:var(--bg);padding:10px;border-radius:8px;border:1px solid var(--border)">${esc(JSON.stringify({ status:s, admin:a?.github }, null, 2))}</pre>`;
    };
    $$("[data-save-role]").forEach((btn) => btn.addEventListener("click", async () => {
      const id = btn.dataset.saveRole;
      const role = document.querySelector(`[data-role-for="${id}"]`).value;
      try {
        await api(`/admin/users/${id}/role`, { method: "PATCH", body: { role } });
        toast("Role updated", role, "ok"); refreshCurrent();
      } catch (e) { toast("Update failed", e.message, "err"); }
    }));
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
