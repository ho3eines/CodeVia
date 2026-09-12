  /* SKILLS */
  on("/skills", async () => {
    const list = await api("/skills");
    $("#content").innerHTML = `<div class="overview"><div><h1>Skills</h1><p>Global templates — each project owns its definitions in CodeVia/skills/.</p></div></div>
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
  const WF_AGENT_TYPES = ["orchestrator","project-manager","business-analyst","research","system-architect","backend-developer","frontend-developer","uiux","database","devops","qa-test","security","code-reviewer","documentation","debugging","refactoring","performance","release"];
  let wfDraft = null;
  function wfNodeConfigHelp(type) {
    return { agent: "agentType, input {…}; upstream deliverables are included", tool: "tool (name), input {…}; use {{ outputs.node.data.value }} references", condition: 'data-only expression, e.g. outputs.qa.status === "succeeded" (no eval)', approval: "message", parallel: "fan-out via outgoing edges; joins wait for all selected predecessors", trigger: "event", webhook: "url", telegram: "chatId, text" }[type] || "";
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
    const myTasks = asArray(tasks).filter((t) => t.workflowId === id).slice(0, 8);
    const myRunsAll = asArray(runs);
    const taskIds = new Set(myTasks.map((t) => t.id));
    const myRuns = myRunsAll.filter((r) => taskIds.has(r.taskId)).slice(0, 8);
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

