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
      window.socket = socket;
    } catch (_) { return; }
    socket.on("connect", () => {
      setLivePill(true);
      // Server routes events into per-project rooms; ask for every project this
      // account may access (re-subscribe on every reconnect). Unsubscribed or
      // foreign projects are never delivered.
      try { socket.emit("subscribe_all", {}, () => {}); } catch (_) { /* noop */ }
    });
    socket.on("disconnect", () => setLivePill(false));
    // Swallow handshake/upgrade errors: the client keeps retrying in the
    // background and the pill shows the state. Never throws into route().
    // Realtime events can burst (step.updated streams once per token batch), so
    // coalesce same-page refreshes: at most one silent refresh per 400ms keeps
    // the page live without re-rendering on every event.
    let realtimeRefreshTimer = null;
    const realtimeRefresh = () => {
      if (realtimeRefreshTimer) return;
      realtimeRefreshTimer = setTimeout(() => {
        realtimeRefreshTimer = null;
        refreshCurrent();
      }, 400);
    };
    // Live home page: the top-level Chat page re-renders its open message thread
    // in place (throttled) whenever an event arrives for its current project, so
    // replies posted by a run/task/approval appear without a manual refresh. The
    // Project overview page just does a silent same-page refresh instead.
    let homeRefreshTimer = null;
    const refreshHome = () => {
      const homeChat = /^#\/chat(?:\?|$)/.test(location.hash) || location.hash === "" || location.hash === "#";
      if (homeChat && typeof window._projectChatRefresh === "function") {
        if (homeRefreshTimer) return;
        homeRefreshTimer = setTimeout(() => { homeRefreshTimer = null; if (window._projectChatRefresh) window._projectChatRefresh(); }, 300);
        return;
      }
      // Top-level Project overview only — a project's *detail* page already
      // streams through its own chat/socket wiring, so don't silently re-render
      // the whole sub-page on every event.
      if (/^#\/project(?:\?|$)/.test(location.hash)) realtimeRefresh();
    };
    const forCurrentProject = (ev) => !!ev && !!ev.projectId && window._projectChatProject && ev.projectId === window._projectChatProject;
    socket.on("connect_error", () => setLivePill(false));
    socket.on("run.updated", (ev) => {
      if (ev.runId && (location.hash.startsWith("#/runs") || /^#\/projects\/[^/]+\/(runs|tests)$/.test(location.hash))) realtimeRefresh();
      if (forCurrentProject(ev)) refreshHome();
      if (ev.data && ev.data.status === "succeeded") toast("Run completed", ev.runId, "ok");
    });
    socket.on("step.updated", (ev) => {
      if (ev.runId && location.hash.includes("/console")) realtimeRefresh();
      if (forCurrentProject(ev)) refreshHome();
    });
    socket.on("task.updated", (ev) => {
      if (ev.taskId && (location.hash.startsWith("#/tasks") || /^#\/projects\/[^/]+\/tasks$/.test(location.hash))) realtimeRefresh();
      if (forCurrentProject(ev)) refreshHome();
    });
    socket.on("notification", (ev) => {
      const kind = ev && ev.data && ev.data.kind;
      if (kind === "approval.required") toast("Approval required", ev.data.action || "", "warn");
      if (kind && kind.startsWith("approval.") && (location.hash.startsWith("#/approvals") || location.hash.startsWith("#/dashboard"))) refreshCurrent();
      if (forCurrentProject(ev)) refreshHome();
      refreshBell();
    });
  }

  function skillAssignmentsHtml(list) {
    if (!Array.isArray(list) || !list.length) return "";
    const skills = list.filter((s) => s && typeof s.slug === "string");
    if (!skills.length) return "";
    return `<div class="card card-body mt task-skills"><div class="card-title">🧩 Task-scoped skills <span class="sub">${skills.length} including prerequisites</span></div><p class="sub">Guidance is adapted for this task only. Shared skill definitions, tools and permissions are unchanged.</p>${skills.map((s) => `<details class="mt"><summary><strong>${esc(s.name || s.slug)}</strong> <span class="badge badge-muted">${esc(s.slug)}</span> <span class="sub">v${esc(s.version || "—")} · ${esc(s.source || "task")}</span></summary><div class="field mt"><label>Base instructions</label><pre class="mini-pre" dir="auto">${esc(s.instructions || "")}</pre></div>${s.guidance ? `<div class="field"><label>Task application</label><pre class="mini-pre" dir="auto">${esc(s.guidance)}</pre></div>` : ""}</details>`).join("")}</div>`;
  }

  function verificationBadge(value) {
    const states = { passed: ["ok", "CI passed"], failed: ["err", "CI failed"], unverified: ["warn", "Not verified"], simulated: ["warn", "Simulation · tests not executed"] };
    const state = states[value];
    return state ? `<span class="badge badge-${state[0]}">${state[1]}</span>` : "";
  }

  /* ---------- router ---------- */
  const routes = {};
  function on(path, fn) { routes[path] = fn; }
  // Alias a route so deep links like /projects/:id/settings still hit the same
  // handler (our simple matchRoute requires exact segment count so suffixes
  // don't fall through automatically).
  function onWithSub(path, fn) {
    routes[path] = fn;
    // Also register the single-sub-path variant for this handler so top-level
    // tab URLs like /projects/:id/project resolve here instead of 404ing to the
    // projects list.
    routes[path + "/:sub"] = fn;
  }
  // A few list endpoints can (on some deployments / after the repo re-org)
  // resolve to a paginated `{ items: [...] }` object or even `undefined`
  // instead of a bare array. Normalise before `.filter`/`.map` so a page can
  // never blow up with "X.filter is not a function" — the bug class seen on the
  // project page with `runs.filter`.
  const asArray = (v) => (Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray(v.items) ? v.items : v && typeof v === "object" && Array.isArray(v.data) ? v.data : []);

  /* ---------- current project context (top-level Chat / Project pages) ----------
     The home surface is project-centric: the top-level Chat and Project pages
     render the *current* project. Which project that is gets remembered locally
     so the UI opens on the project you were last working in. */
  const CV_PROJECT_KEY = "cv_project";
  function rememberedProjectId() { try { return localStorage.getItem(CV_PROJECT_KEY) || ""; } catch (_) { return ""; } }
  function rememberProject(id) { try { if (id) localStorage.setItem(CV_PROJECT_KEY, id); } catch (_) {} }
  function pickCurrentProject(projects) {
    const arr = asArray(projects);
    const stored = rememberedProjectId();
    if (stored && arr.some((p) => p && p.id === stored)) return stored;
    const first = (arr.find((p) => p && p.id) || {}).id || "";
    if (first) rememberProject(first);
    return first;
  }
  function workspaceHeaderHtml(p, projects, active) {
    const opts = asArray(projects).map((x) => `<option value="${esc(x.id)}" ${x.id === p.id ? "selected" : ""}>${esc(x.name)}</option>`).join("");
    return `<div class="card card-body workspace-head">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <span style="font-size:22px">${active === "chat" ? "💬" : "📁"}</span>
        <div style="flex:1;min-width:180px">
          <div class="sub" style="margin-bottom:2px">${active === "chat" ? "Chat · current project" : "Project · current project"}</div>
          <select class="select mono" id="ws-project-switch" title="Switch current project">${opts}</select>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <a class="btn btn-ghost" href="#/projects/${esc(p.id)}">Open project page →</a>
          <a class="btn btn-ghost" href="#/projects">All projects</a>
          <a class="btn" href="#/settings">⚙️ Settings</a>
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;font-size:12px;color:var(--text-muted)">
        <span>${p.active ? '<span class="badge badge-ok">active</span>' : '<span class="badge badge-muted">inactive</span>'}</span>
        <span class="mono">${esc(p.configRepo || "")} @ ${esc(p.branch || "main")}</span>
      </div>
    </div>`;
  }
  function workspaceEmptyState() {
    return `<div class="card card-body"><div class="empty"><div class="empty-emoji">📁</div>
      <h3>No project yet</h3><p>Create a project first — then this page becomes a live chat + overview for it.</p>
      <div class="flex mt" style="justify-content:center"><button class="btn btn-primary" onclick="openProjectModal()">＋ Create Project</button><a class="btn" href="#/projects">Browse / manage projects</a></div>
    </div></div>`;
  }
  function renderNav() {
    // Deliberately minimal: the user drives the platform from a project's
    // Chat / Project / Settings. Every deeper management section lives behind
    // the Settings hub (still its own route for deep links).
    const groups = [
      ["Workspace", [
        ["#/chat", "💬", "Chat"],
        ["#/project", "📁", "Project"],
        ["#/settings", "⚙️", "Settings"],
      ]],
    ];
    $("#nav").innerHTML = groups.map(([label, items]) =>
      `<div class="nav-group">${label}</div>` +
      items.map(([href, icon, text]) => `<a href="${href}" data-href="${href.replace(/^#/, "")}"><span class="nav-icon">${icon}</span>${text}</a>`).join("")
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

  /**
   * Render the current hash route. `{ silent: true }` (used by refreshCurrent)
   * keeps the current DOM visible while data re-fetches and swaps in — no
   * skeleton flash, no visual "reload" — so actions and realtime updates stay
   * smooth. A full navigation (hashchange) still shows the skeleton.
   */
  async function route(opts = {}) {
    if (!opts.silent) showSkeleton();
    // Tear down any live chat session from the previous page before routing
    // (stops polling and detaches socket listeners so they don't accumulate).
    if (typeof window._projectChatCleanup === "function") {
      try { window._projectChatCleanup(); } catch(_) {}
      window._projectChatCleanup = null;
    }
    // Strip the query part ("#/github?login=success") before matching routes.
    const hash = (location.hash.replace(/^#/, "").split("?")[0]) || "/chat";
    renderNav();
    const [pathKey, ...rest] = hash.split("/").filter(Boolean);
    const key = "/" + (pathKey || "chat");
    const full = "/" + [pathKey, ...rest].join("/");
    const matched = matchRoute(full) || matchRoute(key) || matchRoute("/chat");
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
      const shown = titleMap[matched.pattern] || titleMap[full] || titleMap[key] || "Chat";
      title.textContent = document.title = shown;
      $("nav").setAttribute("aria-current", "true");
      $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.href === key));
      setLangDir();
    }
    // Keep the top-bar login/user slot in sync with the refreshed state.
    renderUserSlot();
    refreshBell();
  }
  async function refreshBell() {
    const btn = $("#bell-btn"), count = $("#bell-count");
    if (!btn || !count) return;
    try {
      const [notes, approvals] = await Promise.all([
        api("/notifications").catch(() => []),
        api("/approvals").catch(() => []),
      ]);
      const unread = notes.filter((n) => !n.read).length;
      const pending = approvals.filter((a) => a.status === "pending").length;
      const total = unread + pending;
      count.hidden = total === 0;
      count.textContent = total > 99 ? "99+" : String(total);
      btn.title = `${unread} unread notification(s) · ${pending} pending approval(s)`;
    } catch (_) { /* offline — leave the bell as is */ }
  }
  window.openBell = async () => {
    openModal("Notifications & Approvals", `<div class="repo-empty">Loading…</div>`, { wide: true });
    const [notes, approvals] = await Promise.all([
      api("/notifications").catch(() => []),
      api("/approvals").catch(() => []),
    ]);
    const pending = approvals.filter((a) => a.status === "pending");
    const sevIcon = (s) => s === "error" ? "🔴" : s === "warning" ? "🟠" : s === "success" ? "🟢" : "🔵";
    $("#modal-body").innerHTML = `
      <div class="card-title">Pending approvals <span class="sub">${pending.length}</span></div>
      ${pending.length ? pending.slice(0, 8).map((a) => `<div class="list-row"><span>🛑</span><div><strong>${esc(a.action)}</strong><div class="sub mono">${esc(a.id)}${a.projectId ? " · " + esc(String(a.projectId).slice(0, 12)) : ""} · ${timeAgo(a.requestedAt)}</div></div><span class="spacer"></span><button class="btn btn-primary" onclick="bellDecide(${esc(JSON.stringify(a.id))}, 'approve')">Approve</button><button class="btn" onclick="bellDecide(${esc(JSON.stringify(a.id))}, 'reject')">Reject</button></div>`).join("") : emptyState("✅", "Nothing waiting", "Dangerous steps pause here when auto-approve is off.")}
      <div class="card-title mt">Notifications <span class="sub">${notes.filter((n) => !n.read).length} unread</span></div>
      ${notes.length ? notes.slice(0, 20).map((n) => `<div class="list-row" style="${n.read ? "opacity:.65" : ""}"><span>${sevIcon(n.severity)}</span><div><strong>${esc(n.title)}</strong><div style="font-size:12px">${esc(n.message || "")}</div><div class="sub">${timeAgo(n.createdAt)}</div></div><span class="spacer"></span>${n.read ? "" : `<button class="btn btn-ghost" onclick="bellMarkRead(${esc(JSON.stringify(n.id))})">Mark read</button>`}</div>`).join("") : emptyState("🔔", "No notifications", "")}
      <div class="flex mt"><a class="btn" href="#/approvals" onclick="closeModal()">All approvals</a><a class="btn" href="#/logs" onclick="closeModal()">All logs</a><button class="btn" onclick="closeModal()">Close</button></div>`;
  };
  window.bellMarkRead = async (nid) => {
    try { await api(`/notifications/${nid}/read`, { method: "POST", body: {} }); } catch (_) {}
    openBell(); refreshBell();
  };
  window.bellDecide = async (aid, decision) => {
    try { await api(`/approvals/${aid}/${decision}`, { method: "POST", body: {} }); toast(decision === "approve" ? "Approved" : "Rejected", aid, decision === "approve" ? "ok" : "warn"); }
    catch (e) { toast("Failed", e.message, "err"); }
    openBell(); refreshBell(); refreshCurrent();
  };
  const titleMap = {
    "/chat": "Chat", "/project": "Project", "/dashboard": "Dashboard", "/projects": "Projects", "/agents": "Agents", "/models": "Models",
    "/providers": "Providers", "/skills": "Skills", "/workflows": "Workflows", "/tasks": "Tasks",
    "/runs": "Runs", "/conversations": "Conversations", "/memory": "Memory", "/github": "GitHub",
    "/telegram": "Telegram", "/settings": "Settings", "/admin": "Admin", "/search": "Search",
    "/projects/:id": "Project", "/projects/:id/agents": "Project Agents", "/projects/:id/memory": "Project Memory",
    "/projects/:id/skills": "Project Skills", "/projects/:id/repositories": "Project Repositories", "/projects/:id/workflows": "Project Workflows",
    "/projects/:id/tasks": "Project Tasks", "/projects/:id/runs": "Project Runs", "/projects/:id/tests": "Project Tests",
    "/projects/:id/issues": "Project Issues", "/projects/:id/pull-requests": "Project Pull Requests",
    "/projects/:id/commits": "Project Commits", "/projects/:id/conversations": "Project Conversations",
    "/agents/:id": "Agent", "/workflows/:id": "Workflow",
    "/runs/:id/console": "Run Console", "/conversations/:id": "Conversation",
  };
  function setLangDir() {
    const pref = localStorage.getItem("cv-dir") || "ltr";
    document.documentElement.setAttribute("dir", pref);
  }
  /**
   * Same-page refresh without the skeleton flash. Re-fetches the route's data
   * and swaps it in place, preserving scroll position (and focus is left to
   * the page's own state), so the UI never "reloads" on an action.
   */
  function refreshCurrent() {
    const scrollY = window.scrollY;
    const { hash } = location;
    return route({ silent: true }).then(() => {
      // Only restore the scroll when we did not navigate away mid-refresh.
      if (location.hash === hash) window.scrollTo(0, Math.min(scrollY, document.body.scrollHeight));
    });
  }

  /**
   * Drop module-level caches after a full backup restore replaced the entire
   * database, so the next render re-fetches everything instead of showing
   * pre-restore data. (A full page reload used to do this implicitly.)
   */
  function resetClientCaches() {
    authState.authenticated = false;
    authState.user = null;
    authState.requireAuth = false;
    authState.loginConfigured = false;
    authState.githubToken = null;
    optionCatalogCache = null;
    modelsCache = [];
    providersCache = [];
    modelVisibleCache = [];
    modelSearchQuery = "";
    modelSelection.clear();
    modelsTab = "models";
    modelsPage = 1;
    benchPage = 1;
    benchQuery = "";
    benchStatsCache = null;
    benchStopPolling();
    unrespPage = 1;
    unrespCache = null;
    providersPageCache = [];
    providersVisibleCache = [];
    providerSummary = null;
    providerQuery = "";
    providerFilter = "all";
    providerSort = "name";
    providerSelection.clear();
    wfDraft = null;
  }
  window.resetClientCaches = resetClientCaches;
  // Views are rendered with inline handlers in the generated HTML. Functions
  // declared inside this IIFE are not visible to inline `onclick` attributes,
  // so expose the refresh action explicitly for those handlers and realtime
  // callbacks.
  window.refreshCurrent = refreshCurrent;
  $("#cmd-palette-btn")?.addEventListener("click", () => openPalette());
  $("#bell-btn")?.addEventListener("click", () => openBell());

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

