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
  window.agentDelete = async (agentId, projectId) => {
    if (!confirm("Delete this agent? Its run history is kept, but it will no longer run.")) return;
    try { await api(`/agents/${agentId}`, { method: "DELETE" }); toast("Agent deleted", "", "ok"); location.hash = projectId ? `#/projects/${projectId}/agents` : "#/agents"; }
    catch (e) { toast("Delete failed", e.message, "err"); }
  };
  on("/agents/:id", async (rest) => {
    const id = rest[0];
    const a = await api("/agents/" + id);
    $("#content").innerHTML = `
      <div class="field-hint"><a href="#/agents">Agents</a> / <a href="#/projects/${esc(a.projectId)}/agents">${esc(a.projectId.slice(0,12))}</a> / ${esc(a.type)}</div>
      <div class="overview"><div><h1>${esc(a.name)}</h1><p>${esc(a.role)} — ${esc(a.type)}</p></div>
        <div class="action-row">
          <a class="btn" href="#/projects/${esc(a.projectId)}/agents">← Project</a>
          <button class="btn btn-primary" onclick="projectRunAgentType(${esc(JSON.stringify(a.projectId))}, ${esc(JSON.stringify(a.type))})">▶ Run</button>
          ${a.enabled ? `<button class="btn" id="toggle-agent">Disable</button>` : `<button class="btn btn-primary" id="toggle-agent">Enable</button>`}
          <button class="btn" onclick="editPrompt('${a.id}')">✏️ Edit Prompt</button>
          <button class="btn btn-danger" onclick="agentDelete(${esc(JSON.stringify(a.id))}, ${esc(JSON.stringify(a.projectId))})">🗑 Delete</button>
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
    // Observability: per-agent stats + recent runs + cost.
    const [statsRows, agentRuns, agentCosts] = await Promise.all([
      api(`/observability/agents?agentId=${id}`).catch(() => []),
      api(`/runs?agentId=${id}`).catch(() => []),
      api(`/costs?agentId=${id}`).catch(() => []),
    ]);
    const st = statsRows[0] || { totalRuns: 0, success: 0, failure: 0, avgDuration: 0, tokens: 0, costUsd: 0, errorRate: 0 };
    const costTotal = agentCosts.reduce((s, c) => s + (c.estimatedCostUsd || 0), 0);
    const statsPanel = document.createElement("div");
    statsPanel.className = "card card-body mt";
    statsPanel.innerHTML = `<div class="card-title">Performance <span class="sub">observability · last ${agentRuns.length} runs</span></div>
      <div class="stat-grid">
        <div class="card stat"><div class="stat-label">Runs</div><div class="stat-value">${st.totalRuns}</div><div class="stat-sub">${st.success} ok · ${st.failure} failed</div></div>
        <div class="card stat"><div class="stat-label">Error rate</div><div class="stat-value">${st.errorRate}%</div></div>
        <div class="card stat"><div class="stat-label">Avg duration</div><div class="stat-value">${st.avgDuration}ms</div></div>
        <div class="card stat"><div class="stat-label">Tokens</div><div class="stat-value">${Number(st.tokens || 0).toLocaleString()}</div></div>
        <div class="card stat"><div class="stat-label">Est. cost</div><div class="stat-value">${money(costTotal || st.costUsd)}</div><div class="stat-sub">${agentCosts.length} model calls</div></div>
      </div>
      ${agentRuns.length ? `<div class="table-wrap mt"><table><thead><tr><th>Run</th><th>Status</th><th>Tokens</th><th>Cost</th><th>When</th><th></th></tr></thead><tbody>${agentRuns.slice(0, 8).map((r) => `<tr><td class="mono">${esc(r.id.slice(0, 8))}</td><td>${badge(r.status)} ${verificationBadge(r.verification)}</td><td>${esc(r.totalTokens)}</td><td>${money(r.costUsd)}</td><td>${timeAgo(r.createdAt)}</td><td><a class="btn btn-ghost" href="#/runs/${esc(r.id)}/console">Console</a></td></tr>`).join("")}</tbody></table></div>` : emptyState("▶️", "No runs yet", "Run this agent from its project page.")}`;
    $("#content").appendChild(statsPanel);
    // Agent Builder: models / skills / tools / permissions / limits.
    const [allModels, allSkills, allTools] = await Promise.all([
      api("/models").catch(() => []),
      api(`/skills?projectId=${encodeURIComponent(a.projectId)}`),
      api("/tools").catch(() => []),
    ]);
    const AGENT_PERMS = ["github.read","github.write","repository.read","repository.write","memory.read","memory.write","project.read","project.write","deployment.read","deployment.write"];
    const builder = document.createElement("div");
    builder.className = "card card-body mt";
    builder.innerHTML = `<div class="card-title">Agent Builder <span class="sub">models · skills · tools · permissions · limits</span></div>
      <div class="field"><label>Allowed models <span class="sub">when non-empty, this agent ONLY uses these models (best-performing chosen by smart router). Leave empty to allow all active models.</span></label>
        <div style="display:flex;flex-wrap:wrap;gap:6px;max-height:140px;overflow:auto;padding:8px;border:1px dashed var(--border);border-radius:8px">
          ${allModels.filter((m) => m.active).map((m) => `<label class="check"><input type="checkbox" data-am="${esc(m.id)}" ${((a.models?.allowedModels) || []).includes(m.id) ? "checked" : ""}/> ${esc(m.displayName || m.modelId)} <span class="sub mono">${esc(m.providerId.replace("provider-",""))}</span></label>`).join("") || '<span class="sub">No active models</span>'}
        </div>
        <div class="field-hint">🧠 Tip: run a benchmark from the Models page first so the router has real latency/accuracy data to pick the best one automatically.</div>
      </div>
      <div class="grid-2">
        <div class="field"><label>Primary model <span class="sub">overrides smart routing when set</span></label><select class="select" id="ab-model"><option value="">Router default (auto-pick best)</option>${allModels.filter((m) => m.active).map((m) => `<option value="${esc(m.id)}" ${m.id === (a.models?.primary || "") ? "selected" : ""}>${esc(m.displayName || m.modelId)} · ${esc(m.providerId)}</option>`).join("")}</select></div>
        <div class="field"><label>Fallback models <span class="sub">tried A → B → C on failure (after auto-fallbacks by score)</span></label><div style="display:flex;flex-wrap:wrap;gap:6px;max-height:120px;overflow:auto">${allModels.filter((m) => m.active).map((m) => `<label class="check"><input type="checkbox" data-fb="${esc(m.id)}" ${(a.models?.fallbacks || []).includes(m.id) ? "checked" : ""}/> ${esc(m.displayName || m.modelId)}</label>`).join("")}</div></div>
      </div>
      <div class="field"><label>Skills</label><div style="display:flex;flex-wrap:wrap;gap:6px">${allSkills.map((s) => `<label class="check"><input type="checkbox" data-sk="${esc(s.slug)}" ${(a.skills || []).includes(s.slug) ? "checked" : ""}/> ${esc(s.name)}</label>`).join("") || '<span class="sub">No skills in catalog</span>'}</div></div>
      <div class="field"><label>Tools</label><div style="display:flex;flex-wrap:wrap;gap:6px">${allTools.map((t) => `<label class="check" title="${esc(t.description || "")}"><input type="checkbox" data-tl="${esc(t.name)}" ${(a.tools || []).includes(t.name) ? "checked" : ""}/> <span class="mono">${esc(t.name)}</span>${t.dangerous ? ' <span class="badge badge-warn">dangerous</span>' : ""}</label>`).join("") || '<span class="sub">No tools registered</span>'}</div><div class="field-hint">Dangerous tools (write / merge / deploy / migrate) are approval-gated at runtime.</div></div>
      <div class="field"><label>Permissions</label><div style="display:flex;flex-wrap:wrap;gap:6px">${AGENT_PERMS.map((pm) => `<label class="check"><input type="checkbox" data-pm="${pm}" ${(a.permissions || []).includes(pm) ? "checked" : ""}/> <span class="mono">${pm}</span></label>`).join("")}</div></div>
      <div class="grid-2">
        <div class="field"><label>Max iterations</label><input class="input" type="number" id="ab-iter" value="${esc(a.maxIterations ?? 5)}"/></div>
        <div class="field"><label>Timeout (ms)</label><input class="input" type="number" id="ab-timeout" value="${esc(a.timeoutMs ?? 120000)}"/></div>
        <div class="field"><label>Token budget</label><input class="input" type="number" id="ab-budget" value="${esc(a.tokenBudget ?? 20000)}"/></div>
        <div class="field"><label>Memory sources (comma separated)</label><input class="input" id="ab-mem" value="${esc((a.memorySources || []).join(", "))}"/></div>
      </div>
      <div class="flex mt"><button class="btn btn-primary" id="ab-save">Save agent</button><span class="sub">Prompt edits keep version history; config saves bump v${a.version} → v${a.version + 1}.</span></div>`;
    $("#content").appendChild(builder);
    $("#ab-save").onclick = async () => {
      const pick = (sel, attr) => [...document.querySelectorAll(sel)].filter((c) => c.checked).map((c) => c.getAttribute(attr));
      try {
        await api(`/agents/${id}`, { method: "PATCH", body: {
          models: { primary: $("#ab-model").value, fallbacks: pick("[data-fb]", "data-fb"), allowedModels: pick("[data-am]", "data-am"), specialized: a.models?.specialized || {} },
          skills: pick("[data-sk]", "data-sk"),
          tools: pick("[data-tl]", "data-tl"),
          permissions: pick("[data-pm]", "data-pm"),
          maxIterations: Number($("#ab-iter").value) || 5,
          timeoutMs: Number($("#ab-timeout").value) || 120000,
          tokenBudget: Number($("#ab-budget").value) || 20000,
          memorySources: $("#ab-mem").value.split(",").map((x) => x.trim()).filter(Boolean),
        } });
        toast("Agent saved", a.name, "ok"); refreshCurrent();
      } catch (e) { toast("Save failed", e.message, "err"); }
    };
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

