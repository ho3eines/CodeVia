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
    } catch (_) {
      // Network/server unreachable: leave last-known state; route handler
      // errors surface normally.
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
    route();
  }
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
          <td>${esc(p.framework || "—")}</td>
          <td>${p.active ? '<span class="badge badge-ok">active</span>' : '<span class="badge badge-muted">inactive</span>'}</td>
          <td>${timeAgo(p.createdAt)}</td>
          <td><button class="btn btn-ghost" onclick="location.hash='#/projects/${p.id}'">Open</button></td>
        </tr>`).join("")}</tbody></table></div></div>` :
        `<div class="card card-body">${emptyState("📁", "No projects yet", "Create your first project and the platform will auto-generate agents, skills, and a workflow.")}</div>`}`;
  });

  function openProjectModal() {
    const providers = [];
    api("/providers").then((ps) => {}).catch(() => {});
    openModal("Create Project", `
      <div class="field"><label>Name</label><input class="input" id="pj-name" placeholder="Accounting System"/></div>
      <div class="field"><label>Description</label><textarea class="textarea" id="pj-desc" placeholder="A .NET + SQL Server accounting system…"></textarea></div>
      <div class="field"><label>GitHub Repository (owner/name)</label><input class="input" id="pj-repo" placeholder="acme/accounting"/></div>
      <div class="grid-2">
        <div class="field"><label>Framework</label><input class="input" id="pj-fw" placeholder=".NET, React, Spring…"/></div>
        <div class="field"><label>Database</label><input class="input" id="pj-db" placeholder="SQL Server, Postgres…"/></div>
      </div>
      <div class="field"><label>Branch</label><input class="input" id="pj-branch" value="main"/></div>
      <div class="flex mt"><button class="btn btn-primary" id="pj-submit">Create & Onboard</button><button class="btn" onclick="closeModal()">Cancel</button></div>
    `);
    $("#pj-submit").onclick = async () => {
      try {
        const p = await api("/projects", { method: "POST", body: {
          name: $("#pj-name").value, description: $("#pj-desc").value,
          configRepo: $("#pj-repo").value || "acme/demo", framework: $("#pj-fw").value,
          database: $("#pj-db").value, branch: $("#pj-branch").value,
        }});
        closeModal(); toast("Project created", `${p.name} (${p.agents ?? ""})`, "ok");
        location.hash = "#/projects/" + p.id;
      } catch (e) { toast("Error", e.message, "err"); }
    };
  }
  window.openProjectModal = openProjectModal;

  /* PROJECT DETAIL */
  on("/projects/:id", async (rest) => {
    const id = rest[0];
    const p = await api("/projects/" + id);
    const agents = await api(`/projects/${id}/agents`).catch(() => []);
    const tasks = await api(`/projects/${id}/tasks`).catch(() => []);
    const runs = await api(`/projects/${id}/runs`).catch(() => []);
    const workflows = await api(`/projects/${id}/workflows`).catch(() => []);
    const skills = await api(`/projects/${id}/skills`).catch(() => []);
    $("#content").innerHTML = `
      <div class="overview"><div><h1>${esc(p.name)}</h1><p>${esc(p.description)}</p></div>
        <div class="action-row">
          <button class="btn btn-primary" onclick="projectAsk(${JSON.stringify(p.id)})">❓ Ask AI</button>
          <button class="btn" onclick="projectRun(${JSON.stringify(p.id)})">▶ Run Agent</button>
          <button class="btn" onclick="projectTask(${JSON.stringify(p.id)})">＋ Create Task</button>
          <button class="btn" onclick="projectWorkflow(${JSON.stringify(p.id)})">🔀 Run Workflow</button>
        </div></div>
      <div class="stat-grid">
        <div class="card stat"><div class="stat-label">Repository</div><div class="stat-value" style="font-size:16px">${esc(p.configRepo)}</div><div class="stat-sub">${esc(p.branch)}</div></div>
        <div class="card stat"><div class="stat-label">Agents</div><div class="stat-value">${agents.length}</div></div>
        <div class="card stat"><div class="stat-label">Tasks</div><div class="stat-value">${tasks.length}</div></div>
        <div class="card stat"><div class="stat-label">Runs</div><div class="stat-value">${runs.length}</div></div>
      </div>
      <div class="grid-2">
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
        ${runs.length ? `<div class="table-wrap"><table><thead><tr><th>Run</th><th>Agent</th><th>Status</th><th>Tokens</th><th>Cost</th><th>Duration</th></tr></thead><tbody>
          ${runs.slice(0,10).map((r) => `<tr><td class="mono">${r.id.slice(0,8)}</td><td>${esc(r.agentType)}</td><td>${badge(r.status)}</td><td>${r.totalTokens}</td><td>${money(r.costUsd)}</td><td>${r.durationMs}ms</td></tr>`).join("")}
        </tbody></table></div>` : emptyState("▶️", "No runs yet", "Ask the AI or run an agent to see executions here.")}
      </div>`;
  });
  window.projectAsk = async (id) => openModal("Ask AI on Project", `<div class="field"><label>Prompt</label><textarea class="textarea" id="ask-prompt" placeholder="بررسی کن چرا Login بعد از آخرین Commit خراب شده"></textarea></div><div class="flex"><button class="btn btn-primary" id="ask-go">Submit</button></div>`);
  window.projectRun = (id) => openModal("Run Agent", `<div class="field"><label>Agent type</label><input class="input" id="pa-type" placeholder="backend-developer"/></div><div class="field"><label>Task title</label><input class="input" id="pa-title" value="Analyze project"/></div><button class="btn btn-primary" id="pa-go">Run</button>`);
  window.projectTask = (id) => openModal("Create Task", `<div class="field"><label>Title</label><input class="input" id="pt-title"/></div><div class="field"><label>Description</label><textarea class="textarea" id="pt-desc"></textarea></div><button class="btn btn-primary" id="pt-go">Create</button>`);
  window.projectWorkflow = (id) => openModal("Run Workflow", `<div class="field"><label>Description</label><textarea class="textarea" id="pw-desc" placeholder="Run QA on last commit"></textarea></div><button class="btn btn-primary" id="pw-go">Run</button>`);

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
    const list = await api("/models");
    $("#content").innerHTML = `<div class="overview"><div><h1>Models</h1><p>Model Registry</p></div><button class="btn btn-primary" onclick="openModel()">＋ Add Model</button></div>
      <div class="card card-body"><div class="table-wrap"><table><thead><tr><th>Display Name</th><th>Model ID</th><th>Provider</th><th>Context</th><th>Caps</th><th>Active</th></tr></thead><tbody>
      ${list.map((m) => `<tr><td><strong>${esc(m.displayName)}</strong></td><td class="mono">${esc(m.modelId)}</td><td class="mono">${esc(m.providerId)}</td><td>${m.contextWindow.toLocaleString()}</td><td>${[m.capabilities.code&&'code',m.capabilities.reasoning&&'reasoning',m.capabilities.vision&&'vision',m.capabilities.tools&&'tools'].filter(Boolean).map((x)=>`<span class="badge badge-muted">${x}</span>`).join(" ")}</td><td>${m.active?'<span class="badge badge-ok">active</span>':'<span class="badge badge-muted">inactive</span>'}</td></tr>`).join("")}
      </tbody></table></div></div>`;
  });
  window.openModel = () => openModal("Add Model", `<div class="field"><label>Display name</label><input class="input" id="m-name"/></div><div class="field"><label>Provider ID</label><input class="input" id="m-prov" value="provider-mock"/></div><div class="field"><label>Context window</label><input class="input" id="m-ctx" value="128000"/></div><button class="btn btn-primary" id="m-go">Save</button>`);

  /* PROVIDERS */
  on("/providers", async () => {
    const list = await api("/providers");
    $("#content").innerHTML = `<div class="overview"><div><h1>Providers</h1><p>Provider-agnostic model providers. Secrets are referenced, never stored.</p></div><button class="btn btn-primary" onclick="openProvider()">＋ Add Provider</button></div>
      <div class="grid-3">${list.map((p) => `<div class="card card-body">
        <div class="card-title">${esc(p.name)} ${p.active?'<span class="badge badge-ok">active</span>':'<span class="badge badge-muted">inactive</span>'}</div>
        <div class="meter-row"><span class="lbl">Type</span><span class="val">${esc(p.type)}</span></div>
        <div class="meter-row"><span class="lbl">Format</span><span class="val">${esc(p.apiFormat)}</span></div>
        <div class="meter-row"><span class="lbl">Secret</span><span class="val mono">${esc(p.secretRef || "none")}</span></div>
        <div class="meter-row"><span class="lbl">Base URL</span><span class="val mono" style="font-size:10px">${esc(p.baseUrl || "—")}</span></div>
        <div class="meter-row"><span class="lbl">Timeout</span><span class="val">${p.timeoutMs}ms</span></div>
      </div>`).join("")}</div>`;
  });
  window.openProvider = () => openModal("Add Provider", `<div class="field"><label>Name</label><input class="input" id="pv-name"/></div><div class="field"><label>Type</label><select class="select" id="pv-type">${["openai","anthropic","gemini","openrouter","azure-openai","ollama","openai-compatible","custom-http","mock"].map(t=>`<option>${t}</option>`).join("")}</select></div><div class="field"><label>Base URL</label><input class="input" id="pv-base"/></div><div class="field"><label>Secret Ref (env var name)</label><input class="input" id="pv-secret" placeholder="OPENAI_API_KEY"/></div><button class="btn btn-primary" id="pv-go">Save</button>`);

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
  window.openWorkflow = () => openModal("New Workflow", `<div class="field"><label>Name</label><input class="input" id="wf-name"/></div><div class="field"><label>Project ID</label><input class="input" id="wf-project"/></div><div class="field"><label>Description</label><textarea class="textarea" id="wf-desc"></textarea></div><button class="btn btn-primary" id="wf-go">Create</button>`);

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
  window.addMemory = () => openModal("Add Memory Entry", `<div class="field"><label>Type</label><select class="select" id="mm-type">${["architecture","business","technical","decision","bug","knowledge","lesson","conversation"].map(t=>`<option>${t}</option>`).join("")}</select></div><div class="field"><label>Key</label><input class="input" id="mm-key"/></div><div class="field"><label>Content</label><textarea class="textarea" id="mm-content"></textarea></div><button class="btn btn-primary" id="mm-go">Save</button>`);

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
      // Name comes from the authState refresh that route() performs next;
      // renderUserSlot() is called again there. Fire the toast immediately
      // and let route() re-render the slot with the authenticated user.
      api("/auth/me")
        .then((me) => toast("GitHub login successful", me && me.user ? me.user.name : "", "ok"))
        .catch(() => toast("GitHub login successful", "", "ok"));
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
    const repos = me.authenticated
      ? await api("/github/repositories").catch(() => [])
      : [];
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
        <button class="btn" onclick="refreshCurrent()">Refresh</button></div>
      <div class="grid-3">
        <div class="card card-body"><div class="card-title">Connection</div>
          <div class="status-grid"><div class="status-item"><span class="status-dot ${status.connected?'healthy':'warn'}"></span>${status.connected?'Connected':'Mock (dev)'}</div></div>
          <p style="color:var(--text-muted);font-size:12px">Kind: ${esc(status.kind)} · Source of truth: ${status.sourceOfTruth}</p>
          <p style="color:var(--text-muted);font-size:11px">OAuth configured: ${oauthStatus.configured ? '<span class="badge badge-ok">yes</span>' : '<span class="badge badge-err">no</span>'}</p>
        </div>
        ${loginCard}
        <div class="card card-body"><div class="card-title">Repositories (${Array.isArray(repos)?repos.length:0})</div>
          ${Array.isArray(repos) && repos.length ? `<div class="table-wrap"><table><thead><tr><th>Owner</th><th>Name</th></tr></thead><tbody>${repos.map((r)=>`<tr><td>${esc(r.owner)}</td><td class="mono">${esc(r.name)}</td></tr>`).join("")}</tbody></table></div>` : emptyState("🐙", "No repos", "Connect GitHub or use the mock provider for local development.")}
        </div>
      </div>`;
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

  /* TELEGRAM */
  on("/telegram", async () => {
    const status = await api("/integrations/telegram/status");
    $("#content").innerHTML = `<div class="overview"><div><h1>Telegram Integration</h1><p>Project-aware inline-keyboard bot — commands & natural language</p></div></div>
      <div class="grid-2">
        <div class="card card-body"><div class="card-title">Connection</div>
          <div class="status-grid"><div class="status-item"><span class="status-dot ${status.connected?'healthy':'warn'}"></span>${status.connected?'Connected':'Mock (dev)'}</div></div>
          <p style="color:var(--text-muted);font-size:12px">Commands: /start /projects /agents /task /run /status /tests /issues /pr /memory /skills</p>
        </div>
        <div class="card card-body"><div class="card-title">Preview</div>
          <div class="field"><label>Message</label><input class="input" id="tg-msg" placeholder="/start"/></div>
          <button class="btn btn-primary" id="tg-send">Send</button>
          <div class="card mt"><div class="card-body" id="tg-out" style="background:var(--bg);min-height:80px"></div></div>
        </div>
      </div>`;
    $("#tg-send").onclick = async () => {
      const r = await api("/integrations/telegram/command", { method: "POST", body: { text: $("#tg-msg").value } });
      $("#tg-out").innerHTML = `<pre style="white-space:pre-wrap">${esc(JSON.stringify(r, null, 2))}</pre>`;
    };
  });

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
          <div class="flex"><button class="btn" onclick="downloadBackup()">⬇ System Backup</button><button class="btn" onclick="refreshCurrent()">Refresh</button></div>
          <p style="color:var(--text-muted);font-size:12px">Secrets are stored as references (e.g. OPENAI_API_KEY) and are never included in exports.</p>
        </div>
      </div>`;
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
    const stepsHtml = adm.github?.setupSteps ? `<ol style="font-size:12px;color:var(--text-muted);margin:8px 0 0 18px;text-align:left">${adm.github.setupSteps.map(s=>`<li>${esc(s)}</li>`).join("")}</ol>` : "";
    const mismatchWarn = diag.callbackUrlMismatchRisk ? `<p style="color:var(--warn, #d97706);font-size:11px">⚠️ Callback URL mismatch risk — check GitHub OAuth App settings.</p>` : "";
    $("#content").innerHTML = `<div class="overview"><div><h1>Admin</h1><p>System health & usage</p></div></div>
      <div class="stat-grid">
        <div class="card stat"><div class="stat-label">API</div><div class="stat-value" style="font-size:18px">${h.api.status}</div></div>
        <div class="card stat"><div class="stat-label">Database</div><div class="stat-value" style="font-size:18px">${h.database.status}</div></div>
        <div class="card stat"><div class="stat-label">Queue</div><div class="stat-value" style="font-size:18px">${h.queue.status}</div></div>
        <div class="card stat"><div class="stat-label">Providers</div><div class="stat-value" style="font-size:18px">${h.providers.length}</div></div>
      </div>
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
            <input class="input mono" id="adm-gh-scope" value="${esc(adm.github?.stored?.scope || adm.github?.scope || "")}" placeholder="read:user user:email"/></div>
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
  // Prime session state before the first render so the user slot + route gate
  // have correct login status (no flash of "Demo mode", no early 401).
  refreshAuthState().then(() => {
    renderUserSlot();
    route();
  });
})();
