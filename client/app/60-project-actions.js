  /* ---------- project sub-resource actions ---------- */
  window.projectCreateAgent = async (id) => {
    openModal("New Agent", `<div class="repo-empty">Loading agent types…</div>`, { wide: true });
    const [types, models] = await Promise.all([api("/agents/types").catch(() => []), api("/models").catch(() => [])]);
    $("#modal-body").innerHTML = `<div class="field"><label>Agent type</label><select class="select" id="nca-type">${types.map((t) => `<option value="${esc(t.type)}">${esc(t.role)} (${esc(t.type)})</option>`).join("")}</select><div class="field-hint" id="nca-mission"></div></div>
      <div class="grid-2"><div class="field"><label>Name <span class="sub">optional — defaults to the role</span></label><input class="input" id="nca-name" placeholder=""/></div><div class="field"><label>Primary model <span class="sub">optional — project default otherwise</span></label><select class="select" id="nca-model"><option value="">Project default</option>${models.filter((m)=>m.active).map((m) => `<option value="${esc(m.id)}">${esc(m.displayName || m.modelId)} · ${esc(m.providerId)}</option>`).join("")}</select></div></div>
      <div class="field"><label>Role <span class="sub">optional</span></label><input class="input" id="nca-role" placeholder=""/></div>
      <div class="field"><label>Description <span class="sub">optional</span></label><textarea class="textarea" id="nca-desc" placeholder=""></textarea></div>
      <div class="field"><label>System prompt <span class="sub">optional — auto-generated from the project stack when empty</span></label><textarea class="textarea mono" id="nca-prompt" style="min-height:140px" placeholder="Leave empty for the generated default…"></textarea></div>
      <div class="flex"><button class="btn btn-primary" id="nca-go">Create agent</button><button class="btn" onclick="closeModal()">Cancel</button></div>`;
    const syncMission = () => { const t = types.find((x) => x.type === $("#nca-type").value); $("#nca-mission").textContent = t ? t.mission : ""; };
    $("#nca-type").onchange = syncMission; syncMission();
    $("#nca-go").onclick = async () => {
      const body = { projectId: id, type: $("#nca-type").value };
      const name = $("#nca-name").value.trim(); if (name) body.name = name;
      const role = $("#nca-role").value.trim(); if (role) body.role = role;
      const desc = $("#nca-desc").value.trim(); if (desc) body.description = desc;
      const prompt = $("#nca-prompt").value.trim(); if (prompt) body.systemPrompt = prompt;
      const model = $("#nca-model").value; if (model) body.models = { primary: model, fallbacks: [], specialized: {} };
      try { const a = await api("/agents", { method: "POST", body }); closeModal(); toast("Agent created", a.name, "ok"); refreshCurrent(); }
      catch (e) { toast("Create failed", e.message, "err"); }
    };
  };
  window.projectDeleteAgent = async (projectId, agentId) => {
    if (!confirm("Delete this agent? Its run history is kept, but it will no longer run.")) return;
    try { await api(`/agents/${agentId}`, { method: "DELETE" }); toast("Agent deleted", "", "ok"); refreshCurrent(); }
    catch (e) { toast("Delete failed", e.message, "err"); }
  };
  window.projectMemoryFilter = (value) => {
    document.querySelectorAll("#mem-tbody tr").forEach((tr) => {
      tr.style.display = value === "all" || tr.dataset.mtype === value ? "" : "none";
    });
  };
  window.projectMemoryNew = (id) => {
    openModal("New Memory Entry", `<div class="field"><label>Type</label><select class="select" id="pmn-type">${["architecture","business","technical","decision","bug","knowledge","lesson","conversation"].map((t)=>`<option ${t === "knowledge" ? "selected" : ""}>${t}</option>`).join("")}</select></div><div class="field"><label>Key</label><input class="input mono" id="pmn-key" placeholder="auth.session-strategy"/></div><div class="field"><label>Content</label><textarea class="textarea" id="pmn-content"></textarea></div><div class="field"><label>Tags (comma separated)</label><input class="input" id="pmn-tags"/></div><div class="flex"><button class="btn btn-primary" id="pmn-go">Save</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    $("#pmn-go").onclick = async () => {
      const key = $("#pmn-key").value.trim(); const content = $("#pmn-content").value.trim();
      if (!key || !content) { toast("Key and content are required", "", "err"); return; }
      try {
        await api("/memory", { method: "POST", body: { projectId: id, scope: "project", type: $("#pmn-type").value, key, content, tags: $("#pmn-tags").value.split(",").map((t) => t.trim()).filter(Boolean) } });
        closeModal(); toast("Memory saved", key, "ok"); refreshCurrent();
      } catch (e) { toast("Error", e.message, "err"); }
    };
  };
  window.projectMemoryEdit = async (entryId) => {
    const m = await api(`/memory/${entryId}`);
    openModal("Edit Memory Entry", `<div class="field"><label>Type</label><select class="select" id="pme-type">${["architecture","business","technical","decision","bug","knowledge","lesson","conversation"].map((t)=>`<option ${t === m.type ? "selected" : ""}>${t}</option>`).join("")}</select></div><div class="field"><label>Key</label><input class="input mono" id="pme-key" value="${esc(m.key)}"/></div><div class="field"><label>Content</label><textarea class="textarea" id="pme-content">${esc(m.content)}</textarea></div><div class="field"><label>Tags (comma separated)</label><input class="input" id="pme-tags" value="${esc((m.tags||[]).join(", "))}"/></div><div class="flex"><button class="btn btn-primary" id="pme-go">Save (v${m.version + 1})</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    $("#pme-go").onclick = async () => {
      try {
        await api(`/memory/${entryId}`, { method: "PATCH", body: { type: $("#pme-type").value, key: $("#pme-key").value.trim(), content: $("#pme-content").value, tags: $("#pme-tags").value.split(",").map((t) => t.trim()).filter(Boolean) } });
        closeModal(); toast("Memory updated", "", "ok"); refreshCurrent();
      } catch (e) { toast("Error", e.message, "err"); }
    };
  };
  window.projectMemoryDelete = async (entryId) => {
    if (!confirm("Delete this memory entry?")) return;
    try { await api(`/memory/${entryId}`, { method: "DELETE" }); toast("Memory deleted", "", "ok"); refreshCurrent(); }
    catch (e) { toast("Delete failed", e.message, "err"); }
  };
  window.projectSkillEditor = async (projectId, skillId) => {
    try {
      const skill = skillId ? await api(`/skills/${encodeURIComponent(skillId)}`) : {};
      openModal(skillId ? "Edit repository skill" : "New repository skill", `
        <p class="sub">Saved in CodeVia/skills/. Existing instructions are never regenerated. New skills with no instructions use the configured AI model (simulation in Mock mode).</p>
        <div class="field"><label>Slug</label><input class="input" id="ps-slug" value="${esc(skill.slug || "")}" ${skillId ? "disabled" : ""} placeholder="session-contract"/></div>
        <div class="field"><label>Name</label><input class="input" id="ps-name" value="${esc(skill.name || "")}"/></div>
        <div class="field"><label>Description</label><textarea class="textarea" id="ps-desc">${esc(skill.description || "")}</textarea></div>
        <div class="field"><label>Instructions (Markdown)</label><textarea class="textarea mono" id="ps-instructions" style="min-height:200px">${esc(skill.instructions || "")}</textarea></div>
        <div class="field"><label>Dependencies (comma-separated slugs)</label><input class="input" id="ps-deps" value="${esc((skill.dependencies || []).join(", "))}"/></div>
        <label class="check"><input type="checkbox" id="ps-enabled" ${skill.enabled !== false ? "checked" : ""}/> Enabled (does not grant tools or permissions)</label>
        <div class="flex mt"><button class="btn btn-primary" id="ps-save">${skillId ? "Save definition" : "Create definition"}</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
      $("#ps-save").onclick = async () => {
        const button = $("#ps-save"); button.disabled = true;
        try {
          const instructions = $("#ps-instructions").value;
          const payload = { projectId, slug: $("#ps-slug").value.trim(), name: $("#ps-name").value.trim(), description: $("#ps-desc").value, dependencies: $("#ps-deps").value.split(",").map((v) => v.trim()).filter(Boolean), enabled: $("#ps-enabled").checked };
          if (skillId || instructions.trim()) payload.instructions = instructions;
          await api(skillId ? `/skills/${encodeURIComponent(skillId)}` : "/skills", { method: skillId ? "PATCH" : "POST", body: payload });
          closeModal(); toast("Skill saved in CodeVia", "", "ok"); refreshCurrent();
        } catch (e) { toast("Skill not saved", e.message, "err"); button.disabled = false; }
      };
    } catch (e) { toast("Cannot read skill", e.message, "err"); }
  };
  window.projectSkillAttach = async (id, selectedSlug) => {
    const slug = selectedSlug || $("#skill-attach-sel")?.value;
    if (!slug) { toast("Nothing to attach", "", "err"); return; }
    try { await api(`/projects/${id}/skills`, { method: "POST", body: { slug } }); toast("Skill attached", slug, "ok"); refreshCurrent(); }
    catch (e) { toast("Attach failed", e.message, "err"); }
  };
  window.projectSkillDetach = async (id, slug) => {
    try { await api(`/projects/${id}/skills/${encodeURIComponent(slug)}`, { method: "DELETE" }); toast("Skill detached", slug, "ok"); refreshCurrent(); }
    catch (e) { toast("Detach failed", e.message, "err"); }
  };
  window.projectWorkflowNew = async (id) => {
    const agents = await api(`/projects/${id}/agents`).catch(() => []);
    const enabled = agents.filter((a) => a.enabled);
    openModal("New Workflow", `<div class="field"><label>Name</label><input class="input" id="pwn-name" placeholder="My agent pipeline"/></div><div class="field"><label>Description</label><input class="input" id="pwn-desc" placeholder="What does this workflow do?"/></div><div class="field"><label>Agents in order <span class="sub">checked agents run top → bottom</span></label><div style="display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px">${enabled.map((a) => `<label class="check"><input type="checkbox" data-agent="${esc(a.type)}" checked/> <span class="mono">${esc(a.type)}</span> — ${esc(a.name)}</label>`).join("") || '<span class="sub">No enabled agents</span>'}</div></div><label class="check"><input type="checkbox" id="pwn-approval" checked/> Require human approval at the end (merge / deploy / sensitive steps)</label><div class="flex mt"><button class="btn btn-primary" id="pwn-go">Create workflow</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    $("#pwn-go").onclick = async () => {
      const name = $("#pwn-name").value.trim();
      if (!name) { toast("Name required", "", "err"); return; }
      const picked = [...document.querySelectorAll("[data-agent]:checked")].map((c) => c.dataset.agent);
      if (!picked.length) { toast("Pick at least one agent", "", "err"); return; }
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `workflow-${Date.now()}`;
      const nodes = picked.map((t, i) => ({ id: `${slug}-${i + 1}-${t}`, type: "agent", name: t, config: { agentType: t }, retries: 1 }));
      if ($("#pwn-approval").checked) nodes.push({ id: `${slug}-approval`, type: "approval", name: "Human approval before PR / merge / deploy", config: { message: "Review the agent result before any merge, deployment, migration, or other sensitive operation." }, retries: 0 });
      const edges = nodes.slice(0, -1).map((n, i) => ({ from: n.id, to: nodes[i + 1].id }));
      try {
        await api("/workflows", { method: "POST", body: { projectId: id, name, slug, description: $("#pwn-desc").value.trim(), nodes, edges, enabled: true } });
        closeModal(); toast("Workflow created", name, "ok"); refreshCurrent();
      } catch (e) { toast("Create failed", e.message, "err"); }
    };
  };
  window.projectWorkflowToggle = async (projectId, workflowId, enable) => {
    try { await api(`/workflows/${workflowId}`, { method: "PATCH", body: { enabled: enable } }); toast(enable ? "Workflow enabled" : "Workflow disabled", "", "ok"); refreshCurrent(); }
    catch (e) { toast("Error", e.message, "err"); }
  };
  window.projectWorkflowDelete = async (projectId, workflowId) => {
    if (!confirm("Delete this workflow? Queued tasks that reference it will fail.")) return;
    try { await api(`/workflows/${workflowId}`, { method: "DELETE" }); toast("Workflow deleted", "", "ok"); refreshCurrent(); }
    catch (e) { toast("Delete failed", e.message, "err"); }
  };
  window.projectTaskEdit = async (taskId) => {
    const t = await api(`/tasks/${taskId}`);
    const agents = await api(`/projects/${t.projectId}/agents`).catch(() => []);
    openModal("Edit Task", `<div class="field"><label>Title</label><input class="input" id="pte-title" value="${esc(t.title)}"/></div><div class="field"><label>Description</label><textarea class="textarea" id="pte-desc">${esc(t.description || "")}</textarea></div><div class="grid-2"><div class="field"><label>Priority</label><select class="select" id="pte-prio">${["low","medium","high","critical"].map((x) => `<option ${x === (t.priority || "medium") ? "selected" : ""}>${x}</option>`).join("")}</select></div><div class="field"><label>Agent</label><select class="select" id="pte-agent"><option value="">Auto / workflow</option>${agents.map((a) => `<option value="${esc(a.type)}" ${a.type === t.agentType ? "selected" : ""}>${esc(a.name)} (${esc(a.type)})</option>`).join("")}</select></div></div><div class="flex"><button class="btn btn-primary" id="pte-go">Save</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    $("#pte-go").onclick = async () => {
      try {
        await api(`/tasks/${taskId}`, { method: "PATCH", body: { title: $("#pte-title").value.trim(), description: $("#pte-desc").value, priority: $("#pte-prio").value, agentType: $("#pte-agent").value || undefined } });
        closeModal(); toast("Task updated", "", "ok"); refreshCurrent();
      } catch (e) { toast("Error", e.message, "err"); }
    };
  };
  window.projectTaskDelete = async (taskId) => {
    if (!confirm("Delete this task? Its run history is kept.")) return;
    try { await api(`/tasks/${taskId}`, { method: "DELETE" }); toast("Task deleted", "", "ok"); refreshCurrent(); }
    catch (e) { toast("Delete failed", e.message, "err"); }
  };
  window.projectIssueNew = async (id) => {
    const p = await api(`/projects/${id}`);
    const repos = p.repositories || [];
    openModal("New Issue", `<div class="field"><label>Repository</label><select class="select" id="pin-repo">${repos.map((r) => `<option value="${esc(r.repo)}" ${r.isConfigRepo ? "selected" : ""}>${esc(r.repo)}</option>`).join("")}</select></div><div class="field"><label>Title</label><input class="input" id="pin-title"/></div><div class="field"><label>Body</label><textarea class="textarea" id="pin-body" placeholder="Describe the issue…"></textarea></div><div class="flex"><button class="btn btn-primary" id="pin-go">Create issue</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    $("#pin-go").onclick = async () => {
      const title = $("#pin-title").value.trim();
      if (!title) { toast("Title required", "", "err"); return; }
      try { const issue = await api(`/projects/${id}/issues`, { method: "POST", body: { repo: $("#pin-repo").value, title, body: $("#pin-body").value } }); closeModal(); toast("Issue created", `#${issue.number}`, "ok"); refreshCurrent(); }
      catch (e) { toast("Create failed", e.message, "err"); }
    };
  };
  window.projectPRNew = async (id) => {
    const p = await api(`/projects/${id}`);
    const repos = p.repositories || [];
    openModal("New Pull Request", `<div class="field"><label>Repository</label><select class="select" id="ppr-repo">${repos.map((r) => `<option value="${esc(r.repo)}" ${r.isConfigRepo ? "selected" : ""}>${esc(r.repo)}</option>`).join("")}</select></div><div class="grid-2"><div class="field"><label>Head (from)</label><select class="select" id="ppr-head"><option>main</option></select></div><div class="field"><label>Base (into)</label><select class="select" id="ppr-base"><option>main</option></select></div></div><div class="field"><label>Title</label><input class="input" id="ppr-title"/></div><div class="field"><label>Body</label><textarea class="textarea" id="ppr-body" placeholder="Summary · changes · tests · risks"></textarea></div><div class="flex"><button class="btn btn-primary" id="ppr-go">Create PR</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    const loadBranches = async () => {
      const repo = $("#ppr-repo").value;
      const branches = await api(`/projects/${id}/branches?repo=${encodeURIComponent(repo)}`).catch(() => [{ name: "main" }]);
      const opts = (branches.length ? branches : [{ name: "main" }]).map((b) => `<option>${esc(b.name)}</option>`).join("");
      $("#ppr-head").innerHTML = opts; $("#ppr-base").innerHTML = opts;
      const current = (repos.find((r) => r.repo === repo) || {}).branch || "main";
      $("#ppr-base").value = current;
    };
    $("#ppr-repo").onchange = loadBranches;
    await loadBranches();
    $("#ppr-go").onclick = async () => {
      const title = $("#ppr-title").value.trim();
      if (!title) { toast("Title required", "", "err"); return; }
      try { const pr = await api(`/projects/${id}/pull-requests`, { method: "POST", body: { repo: $("#ppr-repo").value, title, body: $("#ppr-body").value, head: $("#ppr-head").value, base: $("#ppr-base").value } }); closeModal(); toast("PR created", `#${pr.number}`, "ok"); refreshCurrent(); }
      catch (e) { toast("Create failed", e.message, "err"); }
    };
  };
  window.projectPRMerge = async (id, repo, number) => {
    openModal(`Merge PR #${number}`, `<p class="sub">Merge <span class="mono">${esc(repo)}</span> PR #${number} into its base branch. This brings the agent's code onto the base branch.</p><div class="field"><label>Method</label><select class="input" id="pmg-method"><option value="squash">squash</option><option value="merge">merge</option><option value="rebase">rebase</option></select></div><div class="flex"><button class="btn btn-primary" id="pmg-go">Merge</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    $("#pmg-go").onclick = async () => {
      try { const res = await api(`/projects/${id}/pull-requests/${number}/merge`, { method: "POST", body: { repo, method: $("#pmg-method").value } }); closeModal(); toast("PR merged", `#${res.number} → ${res.sha ? res.sha.slice(0, 7) : "done"}`, "ok"); refreshCurrent(); }
      catch (e) { toast("Merge failed", e.message, "err"); }
    };
  };
  window.projectConversationNew = async (id) => {
    openModal("New Conversation", `<div class="field"><label>Title</label><input class="input" id="pcn-title" placeholder="e.g. Login debugging session"/></div><div class="flex"><button class="btn btn-primary" id="pcn-go">Start</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    $("#pcn-go").onclick = async () => {
      const title = $("#pcn-title").value.trim() || "Conversation";
      try { const c = await api("/conversations", { method: "POST", body: { projectId: id, title, source: "web" } }); closeModal(); toast("Conversation started", title, "ok"); projectConversationOpen(c.id); }
      catch (e) { toast("Create failed", e.message, "err"); }
    };
  };
  window.projectConversationOpen = async (convId) => {
    const render = async () => {
      const c = await api(`/conversations/${convId}`);
      openModal(c.title, `<div style="display:flex;flex-direction:column;gap:8px;max-height:50vh;overflow:auto;margin-bottom:10px">${(c.messages || []).length ? c.messages.map((m) => `<div class="list-row"><span>${m.role === "user" ? "🧑" : "🤖"}</span><div><div class="sub">${esc(m.role)} · ${timeAgo(m.createdAt)}</div><p>${esc(m.content)}</p></div></div>`).join("") : emptyState("💬", "No messages yet", "Write the first message below.")}</div>${c.summary ? `<div class="field"><label>Summary</label><pre class="mini-pre">${esc(c.summary)}</pre></div>` : ""}<div class="field"><label>Message</label><textarea class="textarea" id="pcv-msg" dir="auto" placeholder="Ask about this project…"></textarea></div><div class="flex"><button class="btn btn-primary" id="pcv-send">Send</button><button class="btn" id="pcv-sum">Summarize</button><button class="btn" onclick="closeModal()">Close</button></div>`, { wide: true });
      $("#pcv-send").onclick = async () => {
        const content = $("#pcv-msg").value.trim();
        if (!content) return;
        const btn = $("#pcv-send");
        btn.disabled = true;
        btn.textContent = "Sending…";
        try { await api(`/conversations/${convId}/messages`, { method: "POST", body: { role: "user", content } }); render(); }
        catch (e) { toast("Send failed", e.message, "err"); btn.disabled = false; btn.textContent = "Send"; }
      };
      $("#pcv-msg").addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#pcv-send").click(); }
      });
      $("#pcv-sum").onclick = async () => {
        try { const s = await api(`/conversations/${convId}/summarize`, { method: "POST", body: {} }); toast("Summary updated", s.method || "", "ok"); render(); }
        catch (e) { toast("Summarize failed", e.message, "err"); }
      };
    };
    await render();
  };
  window.projectConversationDelete = async (convId) => {
    if (!confirm("Delete this conversation?")) return;
    try { await api(`/conversations/${convId}`, { method: "DELETE" }); toast("Conversation deleted", "", "ok"); refreshCurrent(); }
    catch (e) { toast("Delete failed", e.message, "err"); }
  };
  window.projectDebugRun = async (runId) => {
    try {
      const r = await api(`/runs/${runId}`);
      const failed = (r.steps || []).filter((s) => s.status === "failed");
      const desc = `Investigate failed run ${String(runId).slice(0, 8)} (${r.agentType}).\nError: ${r.error || failed.map((s) => `${s.label}: ${s.detail || ""}`).join("; ") || "unknown"}\nFailed steps: ${failed.map((s) => s.label).join(", ") || "—"}\nDiagnose the root cause; do not change code blindly.`;
      const t = await api("/tasks", { method: "POST", body: { projectId: r.projectId, title: `Debug failed ${r.agentType} run`, description: desc, priority: "high", agentType: "debugging" } });
      await api(`/tasks/${t.id}/run`, { method: "POST", body: {} });
      closeModal(); toast("Debugging agent dispatched", `task ${t.id.slice(0, 8)}`, "ok"); refreshCurrent();
    } catch (e) { toast("Error", e.message, "err"); }
  };

