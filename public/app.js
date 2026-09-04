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
      try {
        const j = await res.json();
        msg = j.message || j.error || msg;
      } catch (_) { /* ignore */ }
      throw new Error(msg);
    }
    return res.status === 204 ? null : res.json();
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
  function connectSocket() {
    if (typeof io === "undefined") return;
    socket = io();
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
    const hash = location.hash.replace(/^#/, "") || "/dashboard";
    renderNav();
    const [pathKey, ...rest] = hash.split("/").filter(Boolean);
    const key = "/" + (pathKey || "dashboard");
    const full = "/" + [pathKey, ...rest].join("/");
    const matched = matchRoute(full) || matchRoute(key) || matchRoute("/dashboard");
    const handler = matched.handler;
    const params = matched.params || {};
    const title = $("#topbar-title");
    try {
      await handler(rest, params);
    } catch (err) {
      renderError(err);
      toast("Error", err.message, "err");
    } finally {
      const shown = titleMap[matched.pattern] || titleMap[full] || titleMap[key] || "Dashboard";
      title.textContent = document.title = shown;
      $("nav").setAttribute("aria-current", "true");
      $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.href === key));
      setLangDir();
    }
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
  async function renderUserSlot() {
    const slot = $("#user-slot");
    if (!slot) return;
    try {
      const me = await api("/auth/me");
      if (me.authenticated && me.user && me.user.externalId !== "demo") {
        const avatar = me.user.avatarUrl ? `<img src="${esc(me.user.avatarUrl)}" alt="" style="width:22px;height:22px;border-radius:50%;vertical-align:-6px;margin-right:6px"/>` : "👤 ";
        slot.innerHTML = `<span class="pill" title="${esc(me.user.email || "")} (${esc(me.user.role)})">${avatar}${esc(me.user.name)}</span> <button class="btn btn-ghost" id="logout-btn" style="padding:4px 10px">Logout</button>`;
        $("#logout-btn").onclick = async () => {
          await api("/auth/logout", { method: "POST" }).catch(() => {});
          try { localStorage.removeItem("cv_token"); } catch (_) {}
          toast("Logged out", "Signed out of GitHub.", "ok");
          renderUserSlot(); refreshCurrent();
        };
      } else {
        const st = await api("/auth/github/status").catch(() => ({ configured: false }));
        slot.innerHTML = st.configured
          ? `<a class="btn btn-primary" href="/auth/github/login" style="padding:6px 12px;text-decoration:none">🐙 Login with GitHub</a>`
          : `<a class="btn btn-ghost" href="#/github" title="GitHub OAuth not configured" style="padding:6px 12px;text-decoration:none">👤 Demo mode</a>`;
      }
    } catch (_) { /* leave slot empty when API unreachable */ }
  }
  on("/github", async () => {
    const status = await api("/integrations/github/status");
    const repos = await api("/github/repositories").catch(() => []);
    const me = await api("/auth/me").catch(() => ({ authenticated: false, user: null }));
    const q = new URLSearchParams((location.hash.split("?")[1] || ""));
    if (q.get("login") === "success" && !sessionStorage.getItem("cv-welcomed")) {
      sessionStorage.setItem("cv-welcomed", "1");
      toast("GitHub login successful", me.user ? me.user.name : "", "ok");
      renderUserSlot();
    }
    if (q.get("login") === "error") {
      toast("GitHub login failed", q.get("reason") || "Please try again.", "err");
    }
    const loginCard = me.authenticated && me.user && me.user.externalId !== "demo"
      ? `<div class="card card-body"><div class="card-title">GitHub Login</div>
          <div class="status-grid"><div class="status-item"><span class="status-dot healthy"></span>Logged in</div></div>
          <p>${me.user.avatarUrl ? `<img src="${esc(me.user.avatarUrl)}" alt="" style="width:28px;height:28px;border-radius:50%;vertical-align:-8px;margin-right:8px"/>` : ""}<strong>${esc(me.user.name)}</strong></p>
          <p class="mono" style="color:var(--text-muted);font-size:12px">${esc(me.user.email || "")} · role: ${esc(me.user.role)}</p>
          <button class="btn" id="gh-logout">Logout</button></div>`
      : status.oauthConfigured
        ? `<div class="card card-body"><div class="card-title">GitHub Login</div>
          <div class="status-grid"><div class="status-item"><span class="status-dot warn"></span>Not logged in</div></div>
          <p style="color:var(--text-muted);font-size:12px">Sign in with your GitHub account. The first user to log in becomes <strong>owner</strong>.</p>
          <a class="btn btn-primary" href="/auth/github/login" style="text-decoration:none">🐙 Login with GitHub</a></div>`
        : `<div class="card card-body"><div class="card-title">GitHub Login</div>
          <div class="status-grid"><div class="status-item"><span class="status-dot warn"></span>Not configured</div></div>
          <p style="color:var(--text-muted);font-size:12px">Set <span class="mono">GITHUB_CLIENT_ID</span> + <span class="mono">GITHUB_CLIENT_SECRET</span> and restart — see <span class="mono">docs/GITHUB_SETUP.md</span>. Local dev continues in demo mode.</p></div>`;
    $("#content").innerHTML = `
      <div class="overview"><div><h1>GitHub Integration</h1><p>GitHub is the source of truth for persistent project data</p></div>
        <button class="btn" onclick="refreshCurrent()">Refresh</button></div>
      <div class="grid-3">
        <div class="card card-body"><div class="card-title">Connection</div>
          <div class="status-grid"><div class="status-item"><span class="status-dot ${status.connected?'healthy':'warn'}"></span>${status.connected?'Connected':'Mock (dev)'}</div></div>
          <p style="color:var(--text-muted);font-size:12px">Kind: ${esc(status.kind)} · Source of truth: ${status.sourceOfTruth}</p>
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
      </div>`;
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
  renderUserSlot();
  route();
})();
