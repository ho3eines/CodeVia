  /* TASKS */
  on("/tasks", async () => {
    const list = asArray(await api("/tasks"));
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
    const list = asArray(await api("/runs"));
    $("#content").innerHTML = `<div class="overview"><div><h1>AI Run Console</h1><p>Observable agent executions (status, steps, results — never chain-of-thought)</p></div></div>
      ${searchPanelHtml("run-search", "Search runs by id, agent, status, model, task, project or correlation id…")}
      <div class="card card-body"><div class="table-wrap"><table><thead><tr><th>Run</th><th>Agent</th><th>Status</th><th>Tokens</th><th>Cost</th><th>Duration</th><th></th></tr></thead><tbody id="run-tbody"></tbody></table></div></div>`;
    bindSearchPanel("run-search", list, runRows, "#run-tbody", "run", { emptyHtml: () => `<tr><td colspan="7">${emptyState("🔎", "No matching runs", "Try searching by run id, agent, model, status or correlation id.")}</td></tr>` });
  });
  function runRows(list) {
    return list.map((r) => `<tr><td class="mono">${r.id.slice(0,8)}</td><td>${esc(r.agentType)}</td><td>${badge(r.status)} ${verificationBadge(r.verification)}</td><td>${r.totalTokens}</td><td>${money(r.costUsd)}</td><td>${r.durationMs}ms</td><td><a class="btn btn-ghost" href="#/runs/${r.id}/console">Console</a></td></tr>`).join("");
  }
  on("/runs/:id/console", async (rest) => {
    const id = rest[0];
    const c = await api(`/runs/${id}/console`);
    $("#content").innerHTML = `
      <div class="overview"><div><h1>Run Console</h1><p class="mono">${esc(c.runId)}</p></div>
        <div class="action-row">${badge(c.status)} ${verificationBadge(c.verification)}<span class="pill">Model: ${esc(c.modelId || "—")}</span><a class="btn" href="#/projects/${esc(c.projectId)}/runs">← Project runs</a><button class="btn" onclick="projectRunTask(${esc(JSON.stringify(c.taskId))})">↻ Retry task</button>${c.status === "failed" || c.error ? `<button class="btn btn-primary" onclick="projectDebugRun(${esc(JSON.stringify(c.runId))})">🐞 Send to debugging agent</button>` : ""}</div></div>
      <div class="stat-grid">
        <div class="card stat"><div class="stat-label">Agent</div><div class="stat-value" style="font-size:16px">${esc(c.agent)}</div></div>
        <div class="card stat"><div class="stat-label">Tokens</div><div class="stat-value">${c.tokens.total}</div><div class="stat-sub">in ${c.tokens.input} · out ${c.tokens.output}</div></div>
        <div class="card stat"><div class="stat-label">Cost</div><div class="stat-value">${money(c.costUsd)}</div></div>
        <div class="card stat"><div class="stat-label">Duration</div><div class="stat-value">${c.durationMs}ms</div></div>
      </div>
      ${skillAssignmentsHtml(c.skills)}
      ${c.summary ? `<div class="card card-body"><div class="card-title">Deliverable / evidence</div><pre style="white-space:pre-wrap">${esc(c.summary)}</pre></div>` : ""}
      <div class="card card-body"><div class="card-title">Execution Steps</div>
        <div class="steps">${(c.steps||[]).map((s) => `<div class="step ${s.status}">
          <div class="step-ico">${s.status==="succeeded"?"✓":s.status==="failed"?"✗":s.status==="running"?"▶":s.status==="skipped"?"⏭":"○"}</div>
          <div><div class="step-label">${s.index+1}. ${esc(s.label)}</div>${s.detail?`<div class="step-detail">${esc(s.detail)}</div>`:""}${s.tool?`<div class="step-detail mono">tool: ${esc(s.tool)}</div>`:""}</div>
        </div>`).join("") || "No steps yet"}</div>
        ${(c.error || (c.steps || []).some((s) => s.status === "failed")) ? `<div class="error-state mt"><h4>What happened</h4><pre>${esc(c.error || "One or more steps failed — see below.")}</pre>${(c.steps || []).filter((s) => s.status === "failed").map((s) => `<div class="meter-row"><span class="lbl">${esc(s.label)}</span><span class="mono">${esc(s.tool || "step")}</span></div>${s.detail ? `<pre>${esc(s.detail)}</pre>` : ""}`).join("")}<div class="field-hint">Suggested: retry once — if it fails again, send the run to the debugging agent for root-cause analysis.</div><div class="flex mt"><button class="btn" onclick="projectRunTask(${esc(JSON.stringify(c.taskId))})">↻ Retry</button><button class="btn btn-primary" onclick="projectDebugRun(${esc(JSON.stringify(c.runId))})">🐞 Send to agent</button></div></div>` : ""}
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
    const [runsRaw, auditRaw, notesRaw] = await Promise.all([api("/runs"), api("/audit").catch(() => []), api("/notifications").catch(() => [])]);
    const runs = asArray(runsRaw);
    const audit = asArray(auditRaw);
    const notes = asArray(notesRaw);
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

