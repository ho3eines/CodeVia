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

