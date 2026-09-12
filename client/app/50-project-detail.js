  /* PROJECT DETAIL */
  const capLabel = (catalog, key, id) => ((catalog && catalog[key]) || []).find((o) => (o.value ?? o.id) === id)?.label || id;
  const PROJECT_SECTIONS = [
    ["chat", "💬 Chat", "#/projects/"],
    ["project", "📁 Project", "/project"],
    ["settings", "⚙️ Settings", "/settings"],
  ];
  function projectSectionNav(id, active = "chat") {
    // Normalise legacy section names (agents/tasks/...) to top-level tabs so
    // deep links still highlight the right tab.
    const SETTINGS_SUB = new Set(["agents","memory","skills","repositories","workflows","tasks","runs","tests","issues","pull-requests","commits","conversations","rules","telegram"]);
    let top = active;
    if (active === "overview") top = "chat";
    else if (SETTINGS_SUB.has(active)) top = "settings";
    return `<div class="tabs project-tabs">${PROJECT_SECTIONS.map(([key, label, suffix]) => {
      const href = `#/projects/${id}${suffix}`;
      return `<a class="tab ${top === key ? "active" : ""}" href="${esc(href)}">${esc(label)}</a>`;
    }).join("")}</div>`;
  }
  function repoPath(repo) {
    const [owner, ...rest] = String(repo || "").split("/");
    return `${encodeURIComponent(owner || "")}/${encodeURIComponent(rest.join("/") || "")}`;
  }
  function projectCrumbs(p, active) {
    return `<div class="field-hint"><a href="#/projects">Projects</a> / <a href="#/projects/${esc(p.id)}">${esc(p.name)}</a>${active && active !== "overview" ? " / " + esc(active) : ""}</div>`;
  }
  const projectActionBar = (p) => `<div class="action-row">
    <button class="btn btn-primary" onclick="projectAsk(${esc(JSON.stringify(p.id))})">❓ Ask AI</button>
    <button class="btn" onclick="projectRun(${esc(JSON.stringify(p.id))})">▶ Run Agent</button>
    <button class="btn" onclick="projectTask(${esc(JSON.stringify(p.id))})">＋ Create Task</button>
    <button class="btn" onclick="projectWorkflow(${esc(JSON.stringify(p.id))})">🔀 Run Workflow</button>
    <button class="btn" onclick="projectDryRun(${esc(JSON.stringify(p.id))})">🧪 Dry Run</button>
    <button class="btn" onclick="projectRules(${esc(JSON.stringify(p.id))})">📏 Rules</button>
    <button class="btn" onclick="projectReonboard(${esc(JSON.stringify(p.id))})">↻ Load / fill missing</button>
    <button class="btn" title="Restore agents, tasks, memory and skills from the CodeVia/ folder in git" onclick="projectPull(${esc(JSON.stringify(p.id))})">⬇ Pull from GitHub</button>
    <button class="btn" onclick="projectConfigureTelegram(${esc(JSON.stringify(p.id))})">📱 Telegram</button>
    <button class="btn" onclick="projectExport(${esc(JSON.stringify(p.id))})">⇩ Export</button>
    <button class="btn" onclick="projectImport(${esc(JSON.stringify(p.id))})">⇧ Import</button>
    <button class="btn" onclick="projectToggleActive(${esc(JSON.stringify(p.id))}, ${esc(JSON.stringify(!p.active))})">${p.active ? "⏸ Deactivate" : "▶ Activate"}</button>
    <button class="btn" onclick="projectEdit(${esc(JSON.stringify(p.id))})">⚙ Edit</button>
  </div>`;
  function miniJson(v) { return `<pre class="mini-pre">${esc(JSON.stringify(v ?? {}, null, 2))}</pre>`; }

  /* ---------- Project-level helpers ---------- */
  async function getProjectChatConv(projectId) {
    // Use (or create) a conversation named "Project Chat" scoped to this project
    // so the Chat tab is ready instantly and survives reloads.
    const list = asArray(await api(`/conversations?projectId=${encodeURIComponent(projectId)}`).catch(() => []));
    const KEEP_TITLE = "Project Chat";
    let c = list.find((x) => x.title === KEEP_TITLE && x.source === "web");
    if (!c) c = await api("/conversations", { method: "POST", body: { projectId, title: KEEP_TITLE, source: "web" } });
    return c;
  }

  async function readFileAsAttachment(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === "string" ? reader.result : undefined;
        // Only include inline data for images <1MB and small text files; anything
        // else is just metadata so we don't blow up the model context window.
        const inline = file.size < 1_000_000 && (file.type.startsWith("image/") || file.type.startsWith("text/") || file.type === "application/json");
        resolve({
          name: file.name,
          contentType: file.type || "application/octet-stream",
          size: file.size,
          dataUrl: inline ? dataUrl : undefined,
          preview: file.size > 1_000_000 ? `(large file, ${(file.size/1024).toFixed(0)}KB – filename only)` : undefined,
        });
      };
      reader.readAsDataURL(file);
    });
  }

  /* ---------- Project Chat Tab ---------- */
  function projectChatTabHtml(conv) {
    const msgs = asArray(conv && conv.messages);
    return `<div class="p-chat-wrap" style="display:flex;flex-direction:column;gap:10px">
      <div class="card card-body p-chat-card" style="flex:1;display:flex;flex-direction:column;padding:0;overflow:hidden">
        <div id="p-chat-msgs" class="p-chat-msgs">
          ${msgs.length ? msgs.map(msgBubble).join("") : `<div class="p-chat-empty">💬 Start chatting with your project AI. Ask a question, attach a screenshot, or dispatch an autonomous task.</div>`}
        </div>
        <div class="p-chat-composer">
          <div id="p-chat-attachments" class="p-chat-att"></div>
          <div style="display:flex;gap:8px;align-items:flex-end">
            <label class="btn btn-ghost p-chat-btn-icon" for="p-chat-file" title="Attach file">📎</label>
            <input id="p-chat-file" type="file" multiple style="display:none" onchange="projectChatAttach(this)"/>
            <textarea id="p-chat-input" class="textarea p-chat-input" dir="auto" placeholder="Ask anything… or switch mode to dispatch a task"></textarea>
            <button class="btn btn-primary p-chat-send" id="p-chat-send">↑</button>
          </div>
          <div class="p-chat-controls">
            <label class="p-field"><span>Model</span><select class="select" id="p-chat-model"></select></label>
            <label class="p-field"><span>Mode</span><select class="select" id="p-chat-mode">
              <option value="chat">Chat</option>
              <option value="autonomous">🚀 Autonomous</option>
              <option value="agent">▶ Agent</option>
              <option value="simulation">🧪 Dry-run</option>
            </select></label>
            <label class="p-field" id="p-chat-agent-wrap" style="display:none"><span>Agent</span><select class="select" id="p-chat-agent"></select></label>
            <label class="p-field"><span>Temp</span><input type="number" id="p-chat-temp" min="0" max="2" step="0.1" value="0.3" class="input"/></label>
          </div>
        </div>
      </div>
    </div>`;
  }

  async function mountProjectChat(projectId, convId) {
    // Cleanup registry: when the user navigates away, tear down polling &
    // socket listeners so we don't leak handlers or refresh a dead view.
    const _projectChatCleanup = [];
    const cleanup = () => {
      // Drop the live-refresh handles along with the pollers/listeners so a
      // torn-down chat never reacts to stale socket events.
      window._projectChatCleanup = null;
      window._projectChatRefresh = null;
      window._projectChatProject = null;
      for (const fn of _projectChatCleanup.splice(0)) { try { fn(); } catch(_) {} }
    };
    window._projectChatCleanup = cleanup;
    window._projectChatProject = projectId;
    let activeTaskIds = new Set();
    let lastMsgCount = 0;
    const paintConv = (conv) => {
      const msgs = asArray(conv && conv.messages);
      const box = $("#p-chat-msgs");
      if (box) {
        box.innerHTML = msgs.length ? msgs.map(msgBubble).join("") : `<div class="p-chat-empty">💬 Start chatting with your project AI. Ask a question, attach a screenshot, or dispatch an autonomous task.</div>`;
        box.scrollTop = box.scrollHeight;
      }
      for (const m of msgs) {
        const tid = m.metadata?.dispatchedTaskId;
        if (tid && !activeTaskIds.has(tid)) activeTaskIds.add(tid);
      }
      lastMsgCount = msgs.length;
    };
    const refreshMessages = async () => {
      try {
        const conv = await api(`/conversations/${convId}`);
        paintConv(conv);
        return conv;
      } catch (e) { return null; }
    };
    // Live-refresh seam for the top-level Chat page: socket events for this
    // project nudge the open message thread in place (no full re-render, so the
    // composer / scroll aren't disturbed while a task is streaming).
    window._projectChatRefresh = refreshMessages;
    const refreshModelsAgents = async () => {
      const [allModelsRaw, agentsRaw, benchResp] = await Promise.all([
        api("/models").catch(() => []),
        api(`/projects/${projectId}/agents`).catch(() => []),
        api("/models/benchmark/stats").catch(() => ({ stats: [] })),
      ]);
      const allModels = asArray(allModelsRaw);
      const agents = asArray(agentsRaw);
      const stats = new Map(asArray(benchResp && benchResp.stats).map((s) => [s.modelId, s]));
      const active = allModels.filter((m) => m.active);
      const sel = $("#p-chat-model");
      if (sel && !sel.dataset.touched) {
        const prev = sel.value;
        sel.innerHTML = `<option value="">Auto (best per benchmark)</option>` + active.map((m) => {
          const s = stats.get(m.id);
          const score = s && typeof s.score === "number" ? s.score.toFixed(2) : "—";
          const tag = s ? `score ${score} · ${s.p95LatencyMs||s.avgLatencyMs||"?"}ms` : "no data";
          return `<option value="${m.id}" ${prev===m.id?"selected":""}>${esc(m.displayName)} · ${esc(String(m.providerId || "").replace("provider-",""))} · ${tag}</option>`;
        }).join("");
      }
      const ag = $("#p-chat-agent");
      if (ag) {
        ag.innerHTML = `<option value="">Auto-route from prompt</option>` + agents.filter((a)=>a.enabled).map((a) => `<option value="${esc(a.type)}">${esc(a.name)} (${esc(a.type)})</option>`).join("");
      }
    };
    const refresh = async () => { await refreshModelsAgents(); return await refreshMessages(); };
    await refresh();

    // --- (F4) Live progress: poll active tasks + runs every 3s while a
    // dispatched task is in flight, and show a live status line + append a
    // final status message when the task succeeds/fails. Also listen on the
    // existing socket.io channel for immediate nudges.
    let pollTimer = null;
    let finishedTasks = new Set();
    const pollProgress = async () => {
      if (!activeTaskIds.size) { pollTimer = null; return; }
      let anyRunning = false;
      let newStatus = null;
      for (const tid of activeTaskIds) {
        if (finishedTasks.has(tid)) continue;
        try {
          const task = await api(`/tasks/${tid}`).catch(() => null);
          if (!task) continue;
          if (task.status === "running" || task.status === "queued" || task.status === "created") { anyRunning = true; }
          else if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") {
            finishedTasks.add(tid);
            newStatus = { tid, status: task.status };
          }
        } catch {}
      }
      // Refresh messages so any new assistant posts (from sync'd runs) are visible.
      await refreshMessages();
      if (newStatus) {
        const box = $("#p-chat-msgs");
        if (box) {
          const chip = document.createElement("div");
          chip.style.cssText = "text-align:center;font-size:12px;color:var(--text-muted);margin:6px 0";
          chip.innerHTML = newStatus.status === "succeeded"
            ? `✅ Task <code>${newStatus.tid.slice(0,8)}</code> completed. <a href="#/projects/${esc(projectId)}/runs">View runs →</a>`
            : `⚠️ Task <code>${newStatus.tid.slice(0,8)}</code> ${esc(newStatus.status)}. <a href="#/projects/${esc(projectId)}/runs">Inspect →</a>`;
          box.appendChild(chip);
          box.scrollTop = box.scrollHeight;
        }
      }
      pollTimer = anyRunning ? setTimeout(pollProgress, 3000) : null;
    };
    // Hook into global socket for immediate nudges too.
    const onRealtime = (ev) => {
      if (!ev || !ev.projectId || ev.projectId !== projectId) return;
      if (ev.type === "task.updated" || ev.type === "run.updated" || ev.type === "step.updated") {
        if (activeTaskIds.size && !pollTimer) pollProgress();
      }
    };
    if (window.socket && window.socket.on) {
      window.socket.on("task.updated", onRealtime);
      window.socket.on("run.updated", onRealtime);
      window.socket.on("step.updated", onRealtime);
    } else {
      // socket may connect later — retry once after 1.5s.
      const retryTimer = setTimeout(() => {
        if (window.socket && window.socket.on) {
          window.socket.on("task.updated", onRealtime);
          window.socket.on("run.updated", onRealtime);
          window.socket.on("step.updated", onRealtime);
        }
      }, 1500);
      _projectChatCleanup.push(() => clearTimeout(retryTimer));
    }
    _projectChatCleanup.push(() => {
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
      if (window.socket && window.socket.off) {
        window.socket.off("task.updated", onRealtime);
        window.socket.off("run.updated", onRealtime);
        window.socket.off("step.updated", onRealtime);
      }
    });

    const sendBtn = $("#p-chat-send");
    const input = $("#p-chat-input");
    const modeSel = $("#p-chat-mode");
    const agentWrap = $("#p-chat-agent-wrap");
    if (modeSel) modeSel.onchange = () => { if (agentWrap) agentWrap.style.display = (modeSel.value === "agent") ? "flex" : "none"; };
    let pending = [];
    window.projectChatAttach = async (inp) => {
      for (const f of inp.files || []) pending.push(await readFileAsAttachment(f));
      inp.value = "";
      renderChatAttachments();
    };
    function renderChatAttachments() {
      const box = $("#p-chat-attachments");
      if (!box) return;
      box.innerHTML = pending.map((a,i) => `<span class="badge badge-info" style="display:inline-flex;gap:4px;align-items:center">📎 ${esc(a.name)} (${Math.round(a.size/1024)}KB) <button class="btn btn-ghost" style="padding:0 4px;font-size:12px" onclick="projectChatRemove(${i})">✕</button></span>`).join("");
    }
    window.projectChatRemove = (i) => { pending.splice(i,1); renderChatAttachments(); };
    let chatSending = false;
    let chatStreamAbort = null;
    const setChatSendBtn = (streaming) => {
      if (!sendBtn) return;
      if (streaming) { sendBtn.disabled = false; sendBtn.textContent = "■"; sendBtn.title = "Stop generating"; }
      else { sendBtn.disabled = false; sendBtn.textContent = "↑"; sendBtn.title = ""; }
    };
    const kickTaskPolling = (mode) => {
      if ((mode === "autonomous" || mode === "agent") && !pollTimer) pollTimer = setTimeout(pollProgress, 1500);
    };
    const send = async () => {
      // While a reply streams, the send button doubles as a Stop button.
      if (chatSending) { if (chatStreamAbort) chatStreamAbort.abort(); return; }
      const content = input.value.trim();
      if (!content && !pending.length) return;
      const box = $("#p-chat-msgs");
      chatSending = true;
      setChatSendBtn(true);
      input.value = "";
      const attachments = pending.slice(); pending = []; renderChatAttachments();
      const body = {
        role: "user", content: content || "(attachment)",
        modelId: $("#p-chat-model")?.value || undefined,
        executionMode: $("#p-chat-mode")?.value || "chat",
        agentType: $("#p-chat-agent")?.value || undefined,
        temperature: Number($("#p-chat-temp")?.value) || 0.3,
        attachments,
      };
      // 1) The user's own message appears instantly — no waiting on the model.
      if (box && box.querySelector(".p-chat-empty")) box.innerHTML = "";
      if (box) {
        box.insertAdjacentHTML("beforeend", msgBubble({
          role: "user", content: body.content, createdAt: new Date().toISOString(),
          metadata: attachments.length ? { attachments } : undefined,
        }));
        box.scrollTop = box.scrollHeight;
      }
      // 2) Typing placeholder while the reply streams in token by token.
      const uid = "pc-live-" + Date.now();
      const isTaskMode = body.executionMode === "autonomous" || body.executionMode === "agent" || body.executionMode === "simulation";
      if (box) {
        box.insertAdjacentHTML("beforeend", streamingBubbleHtml(uid, isTaskMode ? "working…" : "thinking…"));
        box.scrollTop = box.scrollHeight;
      }
      let finalConv = null;
      let gotEvent = false;
      chatStreamAbort = new AbortController();
      try {
        await streamConversationSend(convId, body, {
          onUser: () => { gotEvent = true; },
          onMeta: (ev) => {
            gotEvent = true;
            const s = document.getElementById(uid + "-status"); if (s) s.textContent = "typing…";
            const mt = document.getElementById(uid + "-meta");
            if (mt && ev.displayName) mt.innerHTML = `<span class="badge" style="background:rgba(255,255,255,.1);padding:1px 6px;border-radius:4px">${esc(ev.displayName)}</span>`;
          },
          onRetry: (ev) => { const s = document.getElementById(uid + "-status"); if (s) s.textContent = ev.message || "trying fallback…"; },
          onDelta: (ev) => {
            gotEvent = true;
            const t = document.getElementById(uid + "-text");
            if (t) {
              const prev = t.dataset.acc || "";
              const acc = prev + (ev.text || "");
              t.dataset.acc = acc;
              t.innerHTML = `${esc(acc)}<span class="chat-cursor">▍</span>`;
              t.setAttribute("dir", dirForText(acc));
            }
            if (box) box.scrollTop = box.scrollHeight;
          },
          onMessage: (ev) => { gotEvent = true; if (ev.conversation) finalConv = ev.conversation; },
          onDone: (ev) => { gotEvent = true; if (ev.conversation) finalConv = ev.conversation; },
          onError: (ev) => { gotEvent = true; if (ev.conversation) finalConv = ev.conversation; },
        }, { signal: chatStreamAbort.signal });
        // Authoritative re-paint from the stored conversation (replaces the
        // optimistic bubble and picks up the persisted assistant reply).
        if (finalConv && finalConv.id) paintConv(finalConv);
        else await refreshMessages();
        kickTaskPolling(body.executionMode);
      } catch (e) {
        if (e && e.name === "AbortError") {
          // Stopped by the user: the server kept the partial reply — show it.
          await refreshMessages();
          kickTaskPolling(body.executionMode);
        } else if (!gotEvent) {
          // The stream never started (older server / proxy buffering SSE) —
          // fall back to the classic request/response send.
          try {
            const updated = await api(`/conversations/${convId}/messages`, { method: "POST", body });
            if (updated && (updated.id || asArray(updated.messages).length)) paintConv(updated);
            else await refreshMessages();
            kickTaskPolling(body.executionMode);
          } catch (e2) { toast("Send failed", e2.message, "err"); await refreshMessages(); }
        } else {
          toast("Connection interrupted", "Showing what was saved — send “continue” if the reply cut off.", "warn");
          await refreshMessages();
        }
      } finally {
        chatSending = false; chatStreamAbort = null;
        setChatSendBtn(false);
        if (input) input.focus();
      }
    };
    if (sendBtn) sendBtn.onclick = send;
    if (input) {
      input.focus();
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
      });
    }
  }

  /* ---------- Project overview tab (info + quick ask + activity) ---------- */
  function projectInfoTabHtml(p, stats) {
    const repos = p.repositories || [];
    return `<div class="grid-2">
      <div class="card card-body">
        <div class="card-title">Project overview</div>
        <p>${esc(p.description || "No description yet.")}</p>
        <div class="meter-row"><span class="lbl">Config repo</span><span class="mono">${esc(p.configRepo)} @ ${esc(p.branch)}</span></div>
        <div class="meter-row"><span class="lbl">Repositories</span><span>${repos.length} linked</span></div>
        <div class="meter-row"><span class="lbl">GitHub</span><span class="mono">${esc(p.githubConnection?.kind || "mock/demo")}</span></div>
        <div class="meter-row"><span class="lbl">Environment</span><span class="badge badge-muted">${esc(p.settings?.environment || "development")}</span></div>
        <div class="card-title mt">Quick actions</div>
        <div class="flex" style="flex-wrap:wrap;gap:6px">
          <button class="btn btn-primary" onclick="projectAsk(${esc(JSON.stringify(p.id))})">❓ Ask AI</button>
          <button class="btn" onclick="projectDryRun(${esc(JSON.stringify(p.id))})">🧪 Dry-run</button>
          <button class="btn" onclick="projectRun(${esc(JSON.stringify(p.id))})">▶ Run agent</button>
          <button class="btn" onclick="projectEdit(${esc(JSON.stringify(p.id))})">⚙ Edit</button>
        </div>
      </div>
      <div class="card card-body">
        <div class="card-title">📊 Stats</div>
        <div class="stat-grid" style="grid-template-columns:repeat(2,1fr)">
          <div class="card stat"><div class="stat-label">Agents</div><div class="stat-value">${stats.counts?.agentsEnabled || 0}<span class="stat-sub">/${stats.counts?.agents||0}</span></div></div>
          <div class="card stat"><div class="stat-label">Tasks</div><div class="stat-value">${stats.counts?.tasks||0}</div><div class="stat-sub">${stats.counts?.tasksRunning||0} running</div></div>
          <div class="card stat"><div class="stat-label">Runs</div><div class="stat-value">${stats.counts?.runs||0}</div><div class="stat-sub">${stats.counts?.runsFailed||0} failed</div></div>
          <div class="card stat"><div class="stat-label">Spend</div><div class="stat-value">${money(stats.cost?.costUsd||0)}</div></div>
        </div>
        <div class="card-title mt">Recent activity</div>
        ${(stats.activity||[]).length ? `<div class="activity-feed">${stats.activity.slice(0,6).map((a) => `<a class="activity-item" href="#/projects/${esc(p.id)}/tasks"><span class="activity-dot"></span><div class="activity-body"><strong>${esc(a.title)}</strong><span>${timeAgo(a.at)} · ${esc(a.status)}</span></div></a>`).join("")}</div>` : emptyState("⚡","No activity yet")}
      </div>
      <div class="card card-body">
        <div class="card-title">Recent tasks / runs <a class="sub" href="#/projects/${esc(p.id)}/runs">all →</a></div>
        ${(stats.recentRuns||[]).length ? `<div class="table-wrap"><table><thead><tr><th>Run</th><th>Agent</th><th>Status</th><th>Cost</th><th></th></tr></thead><tbody>${stats.recentRuns.slice(0,6).map((r)=>`<tr><td class="mono">${r.id.slice(0,8)}</td><td>${esc(r.agentType)}</td><td>${badge(r.status)}</td><td>${money(r.costUsd)}</td><td><a class="btn btn-ghost" href="#/runs/${esc(r.id)}/console">Console</a></td></tr>`).join("")}</tbody></table></div>` : emptyState("▶️","No runs yet")}
      </div>
      <div class="card card-body">
        <div class="card-title">Recent errors</div>
        ${(stats.recentErrors||[]).length ? stats.recentErrors.slice(0,4).map((r)=>`<div class="list-row"><span>🔴</span><div><strong>${esc(r.agentType)}</strong><div class="sub">${esc((r.error||"").slice(0,100))}</div></div><a class="btn btn-ghost" href="#/runs/${esc(r.runId)}/console">Inspect</a></div>`).join("") : emptyState("✅","No errors")}
      </div>
    </div>`;
  }

  function projectSettingsTabHtml(p) {
    const items = [
      ["agents", "🤖 Agents", "Manage AI agents, prompts and per-agent allowed models"],
      ["skills", "🛠️ Skills", "Attach/detach skills for this project"],
      ["memory", "🗂️ Memory", "Project memory entries, decisions and lessons learned"],
      ["repositories", "🐙 Repositories", "Link/unlink GitHub repositories and branches"],
      ["workflows", "🔀 Workflows", "Multi-step agent workflows"],
      ["tasks", "🧩 Tasks", "Task queue and manual task creation"],
      ["runs", "▶️ Runs", "All agent executions and live consoles"],
      ["tests", "🧪 Tests", "QA test runs"],
      ["issues", "⭕ Issues", "GitHub issues across linked repos"],
      ["pull-requests", "⑂ Pull Requests", "Open PRs and merges"],
      ["commits", "📝 Commits", "Recent commit history"],
      ["conversations", "💬 All Conversations", "Conversation history list"],
    ];
    const extra = [
      ["Rules", "📏 Rules", "Project rules injected into every agent prompt", "projectRules"],
      ["Telegram", "📱 Telegram", "Link a Telegram chat for notifications & control", "projectConfigureTelegram"],
      ["Pull from GitHub", "⬇ Pull", "Restore agents/tasks/memory from CodeVia/ folder", "projectPull"],
      ["Re-onboard", "↻ Load", "Re-detect project structure and fill missing agents", "projectReonboard"],
      ["Export/Import", "⇩⇧ Export", "Backup / restore project state", "projectExport"],
    ];
    return `<div class="grid-2">
      <div class="card card-body"><div class="card-title">Project resources</div>
        ${items.map(([key, label, hint]) => `<a class="list-row" href="#/projects/${esc(p.id)}/${key}"><span style="font-size:20px">${label.split(" ")[0]}</span><div><strong>${label.split(" ").slice(1).join(" ")}</strong><div class="sub">${hint}</div></div><span class="spacer"></span><span class="badge badge-muted">→</span></a>`).join("")}
      </div>
      <div class="card card-body"><div class="card-title">Actions</div>
        ${extra.map(([,label,hint,fn]) => `<button class="list-row" style="width:100%;text-align:left;border:0;background:transparent;cursor:pointer;color:inherit;font:inherit" onclick="${fn}(${esc(JSON.stringify(p.id))})"><span style="font-size:20px">${label.split(" ")[0]}</span><div><strong>${label.split(" ").slice(1).join(" ")}</strong><div class="sub">${hint}</div></div></button>`).join("")}
        <div class="card-title mt">Danger zone</div>
        <div class="flex" style="gap:8px;flex-wrap:wrap">
          <button class="btn" onclick="projectToggleActive(${esc(JSON.stringify(p.id))}, ${esc(JSON.stringify(!p.active))})">${p.active?"⏸ Deactivate":"▶ Activate"}</button>
          <button class="btn" onclick="projectEdit(${esc(JSON.stringify(p.id))})">⚙ Edit project</button>
        </div>
      </div>
    </div>`;
  }

  /* ---------- Top-level workspace: Chat (home) & Project ----------
     The home page is the current project's live chat; the Project page is its
     overview. Both carry a project switcher and auto-refresh over Socket.io so
     changes that happen in chat or on a project appear live (see connectSocket). */
  function bindWorkspaceSwitcher() {
    const sel = document.getElementById("ws-project-switch");
    if (!sel) return;
    sel.addEventListener("change", () => {
      rememberProject(sel.value);
      // Re-route in place; route() tears down the old chat session first.
      route({ silent: true });
    });
  }
  function projectWorkspaceOverviewHtml(p, ov) {
    const stats = {
      counts: ov.counts || { agents: 0, agentsEnabled: 0, tasks: 0, tasksRunning: 0, runs: 0, runsFailed: 0 },
      activity: ov.activity || [],
      recentRuns: ov.recentRuns || [],
      recentErrors: ov.recentErrors || [],
      cost: ov.cost || { costUsd: 0 },
    };
    const commits = asArray(ov.recentCommits).slice(0, 5);
    const openPRs = asArray(ov.openPRs).slice(0, 5);
    const openIssues = asArray(ov.openIssues).slice(0, 5);
    return `<div style="display:flex;flex-direction:column;gap:10px">
      ${projectInfoTabHtml(p, stats)}
      <div class="grid-2">
        <div class="card card-body">
          <div class="card-title">Recent commits <a class="sub" href="#/projects/${esc(p.id)}/commits">all →</a></div>
          ${commits.length ? commits.map((c) => `<div class="list-row"><span>📝</span><div><strong>${esc(String(c.message || "").split("\n")[0]).slice(0,90)}</strong><div class="sub mono">${esc(String(c.sha || "").slice(0,7))} · ${esc(c.author || "—")}</div></div><span class="spacer"></span><span style="color:var(--text-muted);font-size:11px">${timeAgo(c.date)}</span></div>`).join("") : emptyState("📝", "No commits yet", "")}
        </div>
        <div class="card card-body">
          <div class="card-title">Open pull requests <a class="sub" href="#/projects/${esc(p.id)}/pull-requests">all →</a></div>
          ${openPRs.length ? openPRs.map((x) => `<div class="list-row"><span>⑂</span><div><strong>${esc(x.title)}</strong><div class="sub mono">#${esc(String(x.number || ""))}</div></div><span class="spacer"></span>${x.htmlUrl ? `<a class="btn btn-ghost" href="${esc(x.htmlUrl)}" target="_blank" rel="noopener">Open</a>` : ""}</div>`).join("") : emptyState("⑂", "No open PRs", "")}
          <div class="card-title mt">Open issues <a class="sub" href="#/projects/${esc(p.id)}/issues">all →</a></div>
          ${openIssues.length ? openIssues.map((x) => `<div class="list-row"><span>⭕</span><div><strong>${esc(x.title)}</strong><div class="sub mono">#${esc(String(x.number || ""))}</div></div></div>`).join("") : emptyState("⭕", "No open issues", "")}
        </div>
      </div>
    </div>`;
  }
  on("/chat", async () => {
    // Standalone AI chat — deliberately NOT project-bound. No project picker,
    // no execution modes: just ask anything. Project-connected chat lives in
    // the project section (#/projects/:id → Chat tab).
    const KEY = "codevia.standaloneChatId";
    const rememberChat = (id) => { try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch (_) { /* ignore */ } };
    let convId = null;
    try { convId = localStorage.getItem(KEY) || null; } catch (_) { /* ignore */ }
    let conv = convId ? await api(`/conversations/${encodeURIComponent(convId)}`).catch(() => null) : null;
    // Never show a project-connected conversation on this page.
    if (conv && conv.projectId) conv = null;
    if (!conv || !conv.id) { conv = null; convId = null; }
    let msgs = conv ? asArray(conv.messages) : [];
    const emptyHtml = `<div style="padding:60px 20px;text-align:center;color:var(--text-muted)">💬 Ask anything — no project needed.</div>`;
    $("#content").innerHTML = `
      <div class="overview">
        <div><h1>💬 Chat</h1><p>Simple AI chat — ask anything, no project needed</p></div>
        <div class="action-row">
          <button class="btn btn-ghost" id="chat-history">🕘 History</button>
          <button class="btn" id="chat-new">＋ New chat</button>
        </div>
      </div>
      <div class="card card-body mt" style="padding:0">
        <div id="chat-messages" style="display:flex;flex-direction:column;gap:10px;padding:16px;max-height:65vh;overflow-y:auto;background:var(--bg,#0b0d17)">
          ${msgs.length ? msgs.map(msgBubble).join("") : emptyHtml}
        </div>
        <div style="padding:12px 16px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:flex-end">
          <textarea id="chat-input" class="textarea" dir="auto" placeholder="Ask anything…" style="flex:1;min-height:46px;max-height:200px;resize:vertical;margin:0"></textarea>
          <button class="btn btn-primary" id="chat-send" style="height:46px">Send ↵</button>
        </div>
        <div class="field-hint" style="padding:0 16px 12px">Enter sends · Shift+Enter for newline</div>
      </div>`;
    const box = $("#chat-messages");
    const input = $("#chat-input");
    const sendBtn = $("#chat-send");
    const paintMessages = (list) => {
      msgs = asArray(list);
      if (box) {
        box.innerHTML = msgs.length ? msgs.map(msgBubble).join("") : emptyHtml;
        box.scrollTop = box.scrollHeight;
      }
    };
    setTimeout(() => { if (box) box.scrollTop = box.scrollHeight; }, 30);
    input.focus();
    let sending = false;
    let streamAbort = null;
    const setSendBtn = (streaming) => {
      if (streaming) { sendBtn.disabled = false; sendBtn.innerHTML = "■ Stop"; sendBtn.title = "Stop generating"; }
      else { sendBtn.disabled = false; sendBtn.textContent = "Send ↵"; sendBtn.title = ""; }
    };
    const doSend = async () => {
      // While a reply streams, activating send stops the generation instead.
      if (sending) { if (streamAbort) streamAbort.abort(); return; }
      const content = input.value.trim();
      if (!content) return;
      sending = true;
      setSendBtn(true);
      input.value = "";
      // Lazily create the conversation on first send so abandoned visits don't
      // pile up empty chats; title it from the first question.
      if (!convId) {
        try {
          const created = await api("/conversations", { method: "POST", body: { title: content.slice(0, 60), source: "web" } });
          convId = created.id;
          rememberChat(convId);
        } catch (e) {
          toast("Could not start chat", e.message, "err");
          sending = false; setSendBtn(false); input.value = content;
          return;
        }
      }
      // The user's own message appears instantly — no waiting on the model.
      if (box && msgs.length === 0) box.innerHTML = "";
      if (box) {
        box.insertAdjacentHTML("beforeend", msgBubble({ role: "user", content, createdAt: new Date().toISOString() }));
        box.scrollTop = box.scrollHeight;
      }
      // Typing placeholder while the reply streams in token by token.
      const uid = "chat-live-" + Date.now();
      if (box) {
        box.insertAdjacentHTML("beforeend", streamingBubbleHtml(uid));
        box.scrollTop = box.scrollHeight;
      }
      const live = liveChatHandlers(uid, box);
      streamAbort = new AbortController();
      try {
        await streamConversationSend(convId, { role: "user", content }, live.handlers, { signal: streamAbort.signal });
        // Authoritative re-paint from stored state (replaces optimistic bubbles).
        const fresh = live.finalConv && live.finalConv.id ? live.finalConv : await api(`/conversations/${convId}`).catch(() => null);
        if (fresh && fresh.id) { conv = fresh; paintMessages(fresh.messages); }
        else document.getElementById(uid)?.remove();
      } catch (e) {
        if (e && e.name === "AbortError") {
          // Stopped by the user: the server kept the partial reply — show it.
          const fresh = await api(`/conversations/${convId}`).catch(() => null);
          if (fresh && fresh.id) { conv = fresh; paintMessages(fresh.messages); }
        } else if (!live.gotEvent) {
          // The stream never started — fall back to the classic send.
          try {
            const updated = await api(`/conversations/${convId}/messages`, { method: "POST", body: { role: "user", content } });
            conv = updated; paintMessages(updated && updated.messages);
          } catch (e2) {
            toast("Send failed", e2.message, "err");
            document.getElementById(uid)?.remove();
            input.value = content;
          }
        } else {
          toast("Connection interrupted", "Showing what was saved — send “continue” if the reply cut off.", "warn");
          const fresh = await api(`/conversations/${convId}`).catch(() => null);
          if (fresh && fresh.id) { conv = fresh; paintMessages(fresh.messages); }
        }
      } finally {
        sending = false; streamAbort = null;
        if (document.getElementById("chat-send") === sendBtn) setSendBtn(false);
      }
    };
    sendBtn.onclick = doSend;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    $("#chat-new").onclick = () => { rememberChat(null); refreshCurrent(); };
    $("#chat-history").onclick = () => { location.hash = "#/conversations"; };
  });
  on("/project", async () => {
    const projects = asArray(await api("/projects").catch(() => []));
    const pid = pickCurrentProject(projects);
    if (!pid) { $("#content").innerHTML = workspaceEmptyState(); return; }
    rememberProject(pid);
    const ov = await api(`/projects/${pid}/overview`).catch(() => null);
    const p = ov && ov.project ? ov.project : await api("/projects/" + pid).catch(() => null);
    if (!p) { $("#content").innerHTML = workspaceEmptyState(); return; }
    // Track the current project so the realtime layer (connectSocket) knows an
    // event belongs to the page being shown and can refresh the overview live.
    window._projectChatProject = pid;
    $("#content").innerHTML = workspaceHeaderHtml(p, projects, "project")
      + (ov ? projectWorkspaceOverviewHtml(p, ov) : emptyState("📁", "Could not load project overview", ""));
    bindWorkspaceSwitcher();
  });

  onWithSub("/projects/:id", async (rest) => {
    const id = rest[0];
    const sub = (rest[1] || "").replace(/^\//, "");
    // Determine active tab (default = chat)
    let active = "chat";
    const legacyMap = {
      "":"chat","overview":"chat","agents":"settings","memory":"settings",
      "skills":"settings","repositories":"settings","workflows":"settings",
      "tasks":"settings","runs":"settings","tests":"settings","issues":"settings",
      "pull-requests":"settings","commits":"settings","conversations":"settings",
      "chat":"chat","project":"project","settings":"settings"
    };
    active = legacyMap[sub] || "chat";
    const p = await api("/projects/" + id);
    // Visiting a project makes it the "current" one the top-level Chat/Project
    // pages operate on.
    rememberProject(id);
    // Normalise every list with asArray(): a list endpoint that (for whatever
    // reason) resolves to an object/undefined instead of an array previously
    // crashed the whole project page with "runs.filter is not a function".
    const [agentsRaw, tasksRaw, runsRaw, memRaw] = await Promise.all([
      api(`/projects/${id}/agents`).catch(() => []),
      api(`/projects/${id}/tasks`).catch(() => []),
      api(`/projects/${id}/runs`).catch(() => []),
      api(`/memory?projectId=${id}`).catch(() => []),
    ]);
    const agents = asArray(agentsRaw);
    const tasks = asArray(tasksRaw);
    const runs = asArray(runsRaw);
    const memEntries = asArray(memRaw);
    const failedRuns = runs.filter((r) => r.status === "failed" || r.error).slice(0, 4);
    const activity = [
      ...runs.slice(0, 10).map((r) => ({ kind: "▶ run", title: `${r.agentType}`, status: r.status, at: r.createdAt, link: `#/runs/${r.id}/console` })),
      ...tasks.slice(0, 10).map((t) => ({ kind: "🧩 task", title: t.title, status: t.status, at: t.updatedAt, link: `#/projects/${id}/tasks` })),
    ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 10);
    const stats = {
      counts: {
        agents: agents.length, agentsEnabled: agents.filter((a)=>a.enabled).length,
        tasks: tasks.length, tasksRunning: tasks.filter((t)=>t.status==="running").length,
        runs: runs.length, runsFailed: failedRuns.length,
      },
      cost: { costUsd: 0 },
      activity, recentRuns: runs.slice(0,6), recentErrors: failedRuns,
    };

    $("#content").innerHTML = `
      ${projectCrumbs(p, "overview")}
      <div class="overview"><div><h1>${esc(p.name)} ${p.active ? '<span class="badge badge-ok">active</span>' : '<span class="badge badge-muted">inactive</span>'}</h1><p>${esc(p.description || "")}</p></div>${projectActionBar(p)}</div>
      ${projectSectionNav(p.id, active)}
      <div id="p-tab-body"></div>
    `;
    const body = $("#p-tab-body");
    if (active === "chat") {
      const conv = await getProjectChatConv(id);
      body.innerHTML = projectChatTabHtml(conv);
      await mountProjectChat(id, conv.id);
    } else if (active === "project") {
      body.innerHTML = projectInfoTabHtml(p, stats);
    } else {
      body.innerHTML = projectSettingsTabHtml(p);
    }
  });

  // Autonomous-loop subtasks (research/build/verify/fix) render grouped under their parent.
  function orderTasks(tasks) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const roots = tasks.filter((t) => !t.parentTaskId || !byId.has(t.parentTaskId));
    const kids = new Map();
    for (const t of tasks) {
      if (t.parentTaskId && byId.has(t.parentTaskId)) {
        if (!kids.has(t.parentTaskId)) kids.set(t.parentTaskId, []);
        kids.get(t.parentTaskId).push(t);
      }
    }
    const out = [];
    for (const r of roots) {
      out.push(r);
      for (const k of (kids.get(r.id) || []).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) out.push(k);
    }
    return out;
  }

  async function renderProjectResource(id, section) {
    const p = await api("/projects/" + id);
    const data = asArray(section === "conversations"
      ? await api(`/conversations?projectId=${id}`)
      : await api(`/projects/${id}/${section}`));
    const skillCatalog = section === "skills" ? asArray(await api(`/skills?projectId=${encodeURIComponent(id)}`)) : [];
    const skillTemplates = section === "skills" ? asArray(await api("/skills")) : [];
    const title = PROJECT_SECTIONS.find((x) => x[0] === section)?.[1] || section;
    let html = "";
    if (section === "agents") html = `<div class="flex" style="margin-bottom:10px"><span class="sub">${data.filter((a)=>a.enabled).length} enabled · ${data.length} total</span><span class="spacer"></span><button class="btn btn-primary" onclick="projectCreateAgent(${esc(JSON.stringify(p.id))})">＋ New Agent</button></div>` + (data.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Model</th><th>Skills</th><th>Status</th><th></th></tr></thead><tbody>${data.map((a) => `<tr><td><a href="#/agents/${esc(a.id)}"><strong>${esc(a.name)}</strong></a><div class="sub">${esc(a.role)}</div></td><td class="mono">${esc(a.type)}</td><td class="mono">${esc(a.models?.primary || "—")}</td><td>${(a.skills || []).slice(0,4).map((s)=>`<span class="badge badge-muted">${esc(s)}</span>`).join(" ")}</td><td>${a.enabled ? '<span class="badge badge-ok">enabled</span>' : '<span class="badge badge-muted">disabled</span>'}</td><td style="white-space:nowrap"><button class="btn btn-ghost" onclick="projectToggleAgent(${esc(JSON.stringify(p.id))}, ${esc(JSON.stringify(a.id))}, ${esc(JSON.stringify(!a.enabled))})">${a.enabled ? "Disable" : "Enable"}</button><button class="btn btn-ghost" onclick="projectRunAgentType(${esc(JSON.stringify(p.id))}, ${esc(JSON.stringify(a.type))})">Run</button><button class="btn btn-ghost" title="Delete agent" onclick="projectDeleteAgent(${esc(JSON.stringify(p.id))}, ${esc(JSON.stringify(a.id))})">🗑</button></td></tr>`).join("")}</tbody></table></div>` : emptyState("🤖", "No agents", "Initialize missing CodeVia definitions to add agents."));
    else if (section === "repositories") html = data.length ? `<div class="table-wrap"><table><thead><tr><th>Repository</th><th>Branch</th><th>Role</th><th>Config</th><th></th></tr></thead><tbody>${data.map((r) => `<tr><td class="mono">${r.htmlUrl ? `<a href="${esc(r.htmlUrl)}" target="_blank" rel="noopener">${esc(r.repo)}</a>` : esc(r.repo)}</td><td class="mono">${esc(r.branch)}</td><td>${esc(r.role)}</td><td>${r.isConfigRepo ? '<span class="badge badge-ok">yes</span>' : '<span class="badge badge-muted">no</span>'}</td><td><button class="btn btn-ghost" onclick="projectEditRepo(${esc(JSON.stringify(p.id))}, ${esc(JSON.stringify(r.repo))})">Edit</button>${data.length > 1 ? `<button class="btn btn-ghost" onclick="projectUnlinkRepo(${esc(JSON.stringify(p.id))}, ${esc(JSON.stringify(r.repo))})">Unlink</button>` : ""}</td></tr>`).join("")}</tbody></table></div><div class="flex mt"><button class="btn btn-primary" onclick="projectAddRepo(${esc(JSON.stringify(p.id))})">＋ Link repository</button></div>` : emptyState("🐙", "No repositories", "Link a repository to use GitHub as the source of truth.");
    else if (section === "tasks") html = `<div class="flex" style="margin-bottom:10px"><span class="sub">${data.filter((t)=>t.status==="running"||t.status==="queued").length} active · ${data.length} total</span><span class="spacer"></span><button class="btn btn-primary" onclick="projectTask(${esc(JSON.stringify(p.id))})">＋ New Task</button></div>` + (data.length ? `<div class="table-wrap"><table><thead><tr><th>Task</th><th>Agent</th><th>Priority</th><th>Status</th><th>Correlation</th><th>Updated</th><th></th></tr></thead><tbody>${orderTasks(data).map((t) => `<tr><td>${t.parentTaskId ? '<span class="badge badge-muted">↳ sub</span> ' : ""}${t.input?.executionMode === "autonomous" ? '<span class="badge badge-ok">autonomous</span> ' : ""}<strong>${esc(t.title)}</strong><div class="sub">${esc((t.description || "").slice(0, 100))}</div></td><td class="mono">${esc(t.agentType || (t.workflowId ? "workflow" : "auto"))}</td><td>${t.priority ? `<span class="badge ${t.priority === "critical" ? "badge-err" : t.priority === "high" ? "badge-warn" : "badge-muted"}">${esc(t.priority)}</span>` : "—"}</td><td>${badge(t.status)}</td><td class="mono">${esc((t.correlationId || "").slice(0,12))}</td><td>${timeAgo(t.updatedAt)}</td><td style="white-space:nowrap"><button class="btn btn-ghost" onclick="projectViewTask(${esc(JSON.stringify(t.id))})">View</button><button class="btn btn-ghost" onclick="projectTaskEdit(${esc(JSON.stringify(t.id))})">Edit</button><button class="btn btn-ghost" onclick="projectRunTask(${esc(JSON.stringify(t.id))})">Run</button><button class="btn btn-ghost" onclick="projectCancelTask(${esc(JSON.stringify(t.id))})">Cancel</button><button class="btn btn-ghost" title="Delete task" onclick="projectTaskDelete(${esc(JSON.stringify(t.id))})">🗑</button></td></tr>`).join("")}</tbody></table></div>` : emptyState("🧩", "No tasks", "Create a task or ask AI to queue work."));
    else if (section === "runs" || section === "tests") html = data.length ? `<div class="table-wrap"><table><thead><tr><th>Run</th><th>Agent</th><th>Status</th><th>Model</th><th>Tokens</th><th>Cost</th><th>When</th><th></th></tr></thead><tbody>${data.map((r) => `<tr><td class="mono">${esc(r.id.slice(0,8))}</td><td>${esc(r.agentType)}</td><td>${badge(r.status)} ${verificationBadge(r.verification)}</td><td class="mono">${esc(r.modelId || "—")}</td><td>${esc(r.totalTokens)}</td><td>${money(r.costUsd)}</td><td>${timeAgo(r.createdAt)}</td><td style="white-space:nowrap"><a class="btn btn-ghost" href="#/runs/${esc(r.id)}/console">Console</a><button class="btn btn-ghost" title="Queue the parent task again" onclick="projectRunTask(${esc(JSON.stringify(r.taskId))})">↻ Re-run</button>${r.status === "failed" || r.error ? `<button class="btn btn-ghost" title="Ask the debugging agent to investigate" onclick="projectDebugRun(${esc(JSON.stringify(r.id))})">🐞 Debug</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : emptyState("▶️", section === "tests" ? "No QA runs" : "No runs", "Start an agent or workflow to create executions.");
    else if (section === "workflows") html = `<div class="flex" style="margin-bottom:10px"><span class="sub">${data.filter((w)=>w.enabled).length} enabled · ${data.length} total</span><span class="spacer"></span><button class="btn btn-primary" onclick="projectWorkflowNew(${esc(JSON.stringify(p.id))})">＋ New Workflow</button></div>` + (data.length ? data.map((w) => `<div class="list-row"><span>🔀</span><div><strong><a href="#/workflows/${esc(w.id)}">${esc(w.name)}</a></strong><div class="mono" style="color:var(--text-muted)">${esc(w.slug)} · ${w.nodes?.length || 0} nodes · v${w.version}</div></div><span class="spacer"></span>${w.enabled ? '<span class="badge badge-ok">enabled</span>' : '<span class="badge badge-muted">disabled</span>'}<button class="btn btn-ghost" onclick="projectRunWorkflowId(${esc(JSON.stringify(p.id))}, ${esc(JSON.stringify(w.id))})">Run</button><button class="btn btn-ghost" onclick="projectWorkflowToggle(${esc(JSON.stringify(p.id))}, ${esc(JSON.stringify(w.id))}, ${esc(JSON.stringify(!w.enabled))})">${w.enabled ? "Disable" : "Enable"}</button><button class="btn btn-ghost" title="Delete workflow" onclick="projectWorkflowDelete(${esc(JSON.stringify(p.id))}, ${esc(JSON.stringify(w.id))})">🗑</button></div>`).join("") : emptyState("🔀", "No workflows", "Re-onboard the project to generate a default workflow."));
    else if (section === "skills") {
      const attached = new Set(data);
      const visible = [...new Set([...data, ...skillCatalog.map((s) => s.slug)])];
      const attachCatalog = [...new Map([...skillTemplates, ...skillCatalog].map((s) => [s.slug, s])).values()];
      const available = attachCatalog.filter((s) => s.enabled && !attached.has(s.slug));
      html = `<div class="flex" style="margin-bottom:10px"><span class="sub">${data.length} attached · ${skillCatalog.length} definitions in CodeVia/skills/</span><span class="spacer"></span><button class="btn btn-primary" onclick="projectSkillEditor(${esc(JSON.stringify(p.id))})">＋ New skill</button><a class="btn" href="#/skills">Templates</a><button class="btn" onclick="projectEdit(${esc(JSON.stringify(p.id))})">Edit Stack</button></div>`
        + (visible.length ? `<div class="table-wrap"><table><thead><tr><th>Skill</th><th>Category</th><th>Version</th><th></th></tr></thead><tbody>${visible.map((slug) => { const s = skillCatalog.find((x) => x.slug === slug); return `<tr><td><strong>${esc(s?.name || slug)}</strong> ${s && !s.enabled ? '<span class="badge badge-muted">disabled</span>' : ""}<div class="sub mono">${esc(slug)} · ${attached.has(slug) ? "attached" : "available"}</div></td><td>${esc(s?.category || "—")}</td><td class="mono">${esc(s?.version || "—")}</td><td style="text-align:right">${s ? `<button class="btn btn-ghost" onclick="projectSkillEditor(${esc(JSON.stringify(p.id))}, ${esc(JSON.stringify(s.id))})">Edit definition</button>` : ""}${attached.has(slug) ? `<button class="btn btn-ghost" onclick="projectSkillDetach(${esc(JSON.stringify(p.id))}, ${esc(JSON.stringify(slug))})">Detach</button>` : s?.enabled ? `<button class="btn btn-ghost" onclick="projectSkillAttach(${esc(JSON.stringify(p.id))}, ${esc(JSON.stringify(slug))})">Attach</button>` : ""}</td></tr>`; }).join("")}</tbody></table></div>` : emptyState("🛠️", "No skills attached", "Attach skills below or re-run onboarding."))
        + `<div class="card-title mt">Attach a skill</div><div class="flex"><select class="select" id="skill-attach-sel" style="flex:1">${available.map((s) => `<option value="${esc(s.slug)}">${esc(s.name)} (${esc(s.slug)})${s.projectId ? "" : " — copy template"}</option>`).join("") || '<option value="">(everything is already attached)</option>'}</select><button class="btn btn-primary" onclick="projectSkillAttach(${esc(JSON.stringify(p.id))})">Attach</button></div>`;
    }
    else if (section === "memory") {
      const types = ["all","architecture","business","technical","decision","bug","knowledge","lesson","conversation"];
      html = `<div class="flex" style="margin-bottom:10px"><select class="select" id="mem-filter" onchange="projectMemoryFilter(this.value)">${types.map((t) => `<option value="${t}">${t === "all" ? "All types" : t}</option>`).join("")}</select><span class="sub">${data.length} entries</span><span class="spacer"></span><button class="btn btn-primary" onclick="projectMemoryNew(${esc(JSON.stringify(p.id))})">＋ New Entry</button></div>`
        + (data.length ? `<div class="table-wrap"><table><thead><tr><th>Key</th><th>Type</th><th>Content</th><th>Tags</th><th></th></tr></thead><tbody id="mem-tbody">${data.map((m) => `<tr data-mtype="${esc(m.type)}"><td><strong>${esc(m.key)}</strong><div class="sub">v${esc(m.version)} · ${esc(m.scope)}</div></td><td><span class="badge badge-info">${esc(m.type)}</span></td><td style="max-width:340px">${esc((m.content || "").slice(0,160))}${(m.content||"").length > 160 ? "…" : ""}</td><td>${(m.tags||[]).map((t)=>`<span class="badge badge-muted">${esc(t)}</span>`).join(" ")}</td><td style="white-space:nowrap"><button class="btn btn-ghost" onclick="projectMemoryEdit(${esc(JSON.stringify(m.id))})">Edit</button><button class="btn btn-ghost" title="Delete entry" onclick="projectMemoryDelete(${esc(JSON.stringify(m.id))})">🗑</button></td></tr>`).join("")}</tbody></table></div>` : emptyState("🗂️", "No memory yet", "Agent summaries and decisions will appear here."));
    }
    else if (section === "issues") html = `<div class="flex" style="margin-bottom:10px"><span class="sub">${data.length} issues across linked repos</span><span class="spacer"></span><button class="btn btn-primary" onclick="projectIssueNew(${esc(JSON.stringify(p.id))})">＋ New Issue</button></div>` + (data.length ? `<div class="table-wrap"><table><thead><tr><th>Repo</th><th>#</th><th>Title</th><th>Status</th><th></th></tr></thead><tbody>${data.map((x) => `<tr><td class="mono">${esc(x.repo)}</td><td class="mono">#${esc(x.number)}</td><td>${esc(x.title)}</td><td>${badge(x.state || x.status || "open")}</td><td>${x.htmlUrl ? `<a class="btn btn-ghost" href="${esc(x.htmlUrl)}" target="_blank" rel="noopener">Open</a>` : ""}</td></tr>`).join("")}</tbody></table></div>` : emptyState("⭕", "No open issues", "GitHub data is loaded per linked repository."));
    else if (section === "pull-requests") html = `<div class="flex" style="margin-bottom:10px"><span class="sub">${data.length} pull requests across linked repos</span><span class="spacer"></span><button class="btn btn-primary" onclick="projectPRNew(${esc(JSON.stringify(p.id))})">＋ New PR</button></div>` + (data.length ? `<div class="table-wrap"><table><thead><tr><th>Repo</th><th>#</th><th>Title</th><th>Status</th><th>Branch</th><th></th></tr></thead><tbody>${data.map((x) => `<tr><td class="mono">${esc(x.repo)}</td><td class="mono">#${esc(x.number)}</td><td>${esc(x.title)}</td><td>${badge(x.state || x.status || "open")}</td><td class="mono">${esc(x.head || "")}${x.base ? " → " + esc(x.base) : ""}</td><td style="white-space:nowrap">${(x.state || x.status || "open") === "open" ? `<button class="btn btn-primary" onclick="projectPRMerge(${esc(JSON.stringify(p.id))}, ${esc(JSON.stringify(x.repo))}, ${x.number})">Merge</button> ` : ""}${x.htmlUrl ? `<a class="btn btn-ghost" href="${esc(x.htmlUrl)}" target="_blank" rel="noopener">Open</a>` : ""}</td></tr>`).join("")}</tbody></table></div>` : emptyState("⑂", "No open pull requests", "Agent pull requests will show up here."));
    else if (section === "commits") html = `<div class="flex" style="margin-bottom:10px"><span class="sub">${data.length} recent commits across linked repos</span></div>` + (data.length ? `<div class="table-wrap"><table><thead><tr><th>Repo</th><th>SHA</th><th>Message</th><th>Author</th><th>Date</th></tr></thead><tbody>${data.map((c) => `<tr><td class="mono">${esc(c.repo)}</td><td class="mono">${esc(String(c.sha||"").slice(0,7))}</td><td>${esc(String(c.message||"").split("\n")[0])}</td><td>${esc(c.author || "—")}</td><td>${timeAgo(c.date)}</td></tr>`).join("")}</tbody></table></div>` : emptyState("📝", "No commits found", "Commits appear once the linked repositories have history."));
    else if (section === "conversations") html = `<div class="flex" style="margin-bottom:10px"><span class="sub">${data.length} project conversations</span><span class="spacer"></span><button class="btn btn-primary" onclick="projectConversationNew(${esc(JSON.stringify(p.id))})">＋ New Conversation</button></div>` + (data.length ? `<div class="table-wrap"><table><thead><tr><th>Title</th><th>Source</th><th>Messages</th><th>Updated</th><th></th></tr></thead><tbody>${data.map((c) => `<tr><td><strong>${esc(c.title)}</strong>${c.summary ? `<div class="sub">${esc(c.summary.slice(0,100))}</div>` : ""}</td><td>${esc(c.source)}</td><td>${(c.messages||[]).length}</td><td>${timeAgo(c.updatedAt)}</td><td style="white-space:nowrap"><button class="btn btn-ghost" onclick="projectConversationOpen(${esc(JSON.stringify(c.id))})">Open</button><button class="btn btn-ghost" title="Delete conversation" onclick="projectConversationDelete(${esc(JSON.stringify(c.id))})">🗑</button></td></tr>`).join("")}</tbody></table></div>` : emptyState("💬", "No conversations yet", "Start a project-aware conversation."));
    else html = miniJson(data);
    $("#content").innerHTML = `${projectCrumbs(p, section)}<div class="overview"><div><h1>${esc(p.name)} / ${esc(title)}</h1><p>${esc(p.description || "")}</p></div>${projectActionBar(p)}</div>${projectSectionNav(p.id, section)}<div class="card card-body">${html}</div>`;
  }
  ["agents","memory","skills","repositories","workflows","tasks","runs","tests","issues","pull-requests","commits","conversations"].forEach((section) => on(`/projects/:id/${section}`, (rest) => renderProjectResource(rest[0], section)));

  window.projectDryRun = (id) => {
    openModal("Dry Run — preview without changing anything", `<div class="field"><label>What should the agent do?</label><textarea class="textarea" id="dry-text" placeholder="Fix the login bug after the last commit"></textarea></div><div class="flex"><button class="btn btn-primary" id="dry-go">Preview plan</button><button class="btn" onclick="closeModal()">Close</button></div><div id="dry-out" class="mt"></div>`);
    $("#dry-go").onclick = async () => {
      const text = $("#dry-text").value.trim();
      if (!text) return;
      const r = await api(`/projects/${id}/dry-run`, { method: "POST", body: { title: text.slice(0, 80), description: text } });
      $("#dry-out").innerHTML = `<div class="card card-body"><div class="card-title">${esc(r.agent.name)} <span class="sub">${esc(r.agent.type)} · model ${esc(r.model.primary || "auto")} · ${r.approvalsNeeded} approval(s) needed · context ≈ ${r.context ? r.context.tokens : "?"} tokens</span></div>
        <div class="steps">${r.plan.map((s) => `<div class="step pending"><div class="step-ico">${s.requiresApproval ? "🛑" : "○"}</div><div><div class="step-label">${s.index + 1}. ${esc(s.label)}</div>${s.tool ? `<div class="step-detail mono">tool: ${esc(s.tool)}</div>` : ""}</div></div>`).join("")}</div>
        ${r.writes.length ? `<p class="mt"><strong>Would write to the repository via:</strong> ${r.writes.map((w) => `<span class="badge badge-warn">${esc(w.tool)}</span>`).join(" ")}</p>` : `<p class="mt">No repository writes.</p>`}
        <p style="color:var(--text-muted);font-size:12px">Budget: ${r.budget.maxTokensPerRun} tokens · $${r.budget.maxCostUsdPerRun} · ${r.budget.maxDurationMs}ms per run</p></div>`;
    };
  };
  window.projectRules = async (id) => {
    let rules;
    try { rules = await api(`/projects/${id}/rules`); }
    catch (e) { toast("Rules unavailable", e.message, "err"); return; }
    const manual = rules.filter((r) => !r.discovered);
    const discovered = rules.filter((r) => r.discovered);
    openModal("Project Rules — injected into every agent prompt", `
      <div class="field"><label>Your rules (one block per line; Markdown ok)</label><textarea class="textarea" id="rules-text" style="min-height:160px">${esc(manual.map((r) => r.text).join("\n"))}</textarea></div>
      <div class="flex"><button class="btn btn-primary" id="rules-save">Save</button><button class="btn" id="rules-rediscover">🔎 Re-discover from repository</button><button class="btn" onclick="closeModal()">Close</button></div>
      <div class="card-title mt">Discovered automatically <span class="sub">${discovered.length} block(s) from README / CONTRIBUTING / CODEOWNERS / .editorconfig / build files / CI</span></div>
      ${discovered.length ? discovered.map((r) => `<pre style="white-space:pre-wrap;background:var(--glass);padding:10px;border-radius:8px;border:1px solid var(--border);font-size:12px">${esc(r.text)}</pre>`).join("") : emptyState("📏", "Nothing discovered yet", "Run Detect & Agent.md to scan the repository.")}`);
    $("#rules-save").onclick = async () => {
      const lines = $("#rules-text").value.split("\n").map((l) => l.trim()).filter(Boolean);
      await api(`/projects/${id}/rules`, { method: "PUT", body: { rules: lines } });
      toast("Rules saved", `${lines.length} rule(s)`, "ok"); closeModal();
    };
    $("#rules-rediscover").onclick = async () => {
      await api(`/projects/${id}/onboard`, { method: "POST", body: {} });
      toast("Rules re-discovered", "", "ok"); closeModal(); window.projectRules(id);
    };
  };
  window.projectAsk = (id) => {
    openModal("Project Assistant — طبق پرامپ پروژه", `<div class="field"><label>درخواست</label><textarea class="textarea" id="ask-prompt" dir="auto" placeholder="مثلاً: پروژه را بررسی کن، بعد از آخرین Commit تست کامل Login را اجرا کن؛ اگر Backend بود درست کن و در نهایت PR بساز."></textarea><div class="field-hint">در حالت Autonomous، ریسرچ درخواست را با تنظیمات و قوانین پروژه دقیق می‌کند؛ سپس تسک‌ها با ایجنت مسئول، معیار پذیرش، وابستگی و اسکیل‌های اختصاصی ساخته و اجرا می‌شوند. دستور اسکیل برای همان تسک تطبیق پیدا می‌کند؛ اسکیل مشترک تغییر نمی‌کند و عملیات حساس نیاز به Approval دارد. بک‌اند و فرانت‌اند روی شاخهٔ مشترک تسک کار می‌کنند؛ تست واقعی از GitHub CI تأیید می‌شود. Mock فقط شبیه‌سازی است.</div></div><div class="grid-2"><div class="field"><label>Execution mode</label><select class="select" id="ask-mode"><option value="autonomous" selected>Autonomous task loop (research → build → test → fix)</option><option value="workflow">Autonomous workflow loop</option><option value="agent">Smart single-agent routing</option><option value="simulation">Simulation / dry-run only</option></select></div><div class="field"><label>Agent hint</label><select class="select" id="ask-agent"><option value="">Auto-detect</option><option value="backend-developer">Backend</option><option value="frontend-developer">Frontend</option><option value="uiux">UI/UX</option><option value="qa-test">QA/Test</option><option value="debugging">Debugging</option><option value="database">Database</option><option value="security">Security</option><option value="devops">DevOps</option><option value="system-architect">Architect</option><option value="research">Research</option><option value="code-reviewer">Code Reviewer</option><option value="documentation">Documentation</option></select></div></div><div class="flex"><button class="btn btn-primary" id="ask-go">Start</button><button class="btn" onclick="closeModal()">Cancel</button></div><div id="ask-result" class="mt"></div>`);
    const inp = $("#ask-prompt");
    inp.addEventListener("input", () => applyTextDirection(inp, inp.value));
    $("#ask-go").onclick = async () => {
      const prompt = $("#ask-prompt").value.trim();
      if (!prompt) { toast("Prompt required", "", "err"); return; }
      const btn = $("#ask-go"); btn.disabled = true; btn.textContent = "Routing…";
      try {
        const body = { title: prompt.slice(0, 80), description: prompt, executionMode: $("#ask-mode").value };
        const hint = $("#ask-agent").value;
        if (hint) body.agentType = hint;
        const r = await api(`/projects/${id}/ask`, { method: "POST", body });
        if (r.simulation) {
          $("#ask-result").innerHTML = `<div class="card card-body"><div class="card-title">Simulation plan <span class="badge badge-info">${esc(r.routedAgentType)}</span></div>${(r.plan || []).map((s, i) => `<div class="meter-row"><span class="lbl">${i + 1}. ${esc(s.label)}</span><span>${s.tool ? `<span class="badge badge-muted">${esc(s.tool)}</span>` : ""} ${s.requiresApproval ? '<span class="badge badge-warn">approval</span>' : ""}</span></div>`).join("")}</div>`;
          toast("Simulation ready", r.routedAgentType || "auto", "ok");
        } else {
          closeModal(); toast("Project request queued", `Task ${r.task.id.slice(0, 8)} · ${r.executionMode === "autonomous" ? "research → specialist tasks → QA" : r.workflowId ? "workflow" : r.routedAgentType}`, "ok"); location.hash = `#/projects/${id}/runs`;
        }
      } catch (e) { toast("Error", e.message, "err"); }
      finally { btn.disabled = false; btn.textContent = "Start"; }
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
        const r = await api(`/projects/${id}/ask`, { method: "POST", body: { title, description: $("#pa-desc").value.trim() || title, agentType, executionMode: "agent" } });
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
  window.projectEditRepo = async (id, repo) => {
    const repos = await api(`/projects/${id}/repositories`).catch(() => []);
    const r = repos.find((x) => String(x.repo).toLowerCase() === String(repo).toLowerCase());
    if (!r) { toast("Repository not found", repo, "err"); return; }
    openModal("Edit repository link", `
      <div class="field"><label>Repository</label><input class="input mono" id="per-repo" value="${esc(r.repo)}" disabled/></div>
      <div class="grid-2"><div class="field"><label>Branch</label><input class="input mono" id="per-branch" value="${esc(r.branch || "main")}"/></div>
      <div class="field"><label>Role</label><select class="select" id="per-role">${["primary","frontend","backend","mobile","infra","docs","library","other"].map((x)=>`<option value="${x}" ${x === r.role ? "selected" : ""}>${x}</option>`).join("")}</select></div></div>
      <label class="check"><input type="checkbox" id="per-config" ${r.isConfigRepo ? "checked" : ""}/> Use this repository as the .ai-engineering configuration source of truth</label>
      <div class="flex mt"><button class="btn btn-primary" id="per-save">Save repository</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    $("#per-save").onclick = async () => {
      try {
        await api(`/projects/${id}/repositories/${repoPath(repo)}`, { method: "PATCH", body: { branch: $("#per-branch").value.trim() || "main", role: $("#per-role").value, isConfigRepo: $("#per-config").checked } });
        closeModal(); toast("Repository updated", repo, "ok"); refreshCurrent();
      } catch (e) { toast("Error", e.message, "err"); }
    };
  };
  window.projectUnlinkRepo = async (id, repo) => {
    if (!confirm(`Unlink ${repo} from this project?`)) return;
    try { await api(`/projects/${id}/repositories/${repoPath(repo)}`, { method: "DELETE" }); toast("Repository unlinked", repo, "ok"); refreshCurrent(); }
    catch (e) { toast("Error", e.message, "err"); }
  };
  window.projectReonboard = async (id) => {
    openModal("Loading repository state", `<div class="repo-empty">Reading CodeVia/ and creating only missing definitions. Existing files and disabled choices are preserved. AI generation may use the project budget.</div>`);
    try {
      const r = await api(`/projects/${id}/onboard`, { method: "POST", body: {} });
      closeModal(); toast("Repository state ready", `Agents: ${r.agents} · Skills: ${r.skills} — existing definitions reused`, "ok"); refreshCurrent();
    } catch (e) { closeModal(); toast("Initialization failed", e.message, "err"); }
  };
  window.projectPull = async (id) => {
    openModal("Pulling from GitHub", `<div class="repo-empty">Restoring agents, tasks, memory and skills from the CodeVia/ folder…</div>`);
    try {
      const r = await api(`/projects/${id}/pull`, { method: "POST", body: {} });
      closeModal();
      toast("Pulled from GitHub", `Agents: ${r.agents} · Tasks: ${r.tasks} · Memory: ${r.memory} · Skills: ${(r.skills || []).length}`, "ok");
      refreshCurrent();
    } catch (e) { closeModal(); toast("Pull failed", e.message, "err"); }
  };
  window.projectToggleActive = async (id, active) => {
    try {
      await api(`/projects/${id}/${active ? "activate" : "deactivate"}`, { method: "POST", body: {} });
      toast(active ? "Project activated" : "Project deactivated", "", "ok"); refreshCurrent();
    } catch (e) { toast("Error", e.message, "err"); }
  };
  window.projectOpenGitHub = async (id) => {
    const p = await api(`/projects/${id}`).catch(() => null);
    const repo = (p?.repositories || []).find((r) => r.isConfigRepo) || (p?.repositories || [])[0];
    if (repo?.htmlUrl) window.open(repo.htmlUrl, "_blank", "noopener");
    else if (repo?.repo) window.open(`https://github.com/${repo.repo}`, "_blank", "noopener");
    else location.hash = "#/github";
  };
  window.projectRunAgentType = async (id, agentType) => {
    openModal("Run Agent", `<div class="field"><label>Task title</label><input class="input" id="prat-title" value="${esc(agentType)} task"/></div><div class="field"><label>Instructions</label><textarea class="textarea" id="prat-desc" placeholder="What should this agent do?"></textarea></div><div class="flex"><button class="btn btn-primary" id="prat-go">Run ${esc(agentType)}</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    $("#prat-go").onclick = async () => {
      const title = $("#prat-title").value.trim() || `${agentType} task`;
      try {
        const r = await api(`/projects/${id}/ask`, { method: "POST", body: { title, description: $("#prat-desc").value.trim() || title, agentType, executionMode: "agent" } });
        closeModal(); toast("Agent queued", `${agentType} · task ${r.task.id.slice(0, 8)}`, "ok"); refreshCurrent();
      } catch (e) { toast("Error", e.message, "err"); }
    };
  };
  window.projectRunWorkflowId = async (id, workflowId) => {
    try {
      await api(`/workflows/${workflowId}/run`, { method: "POST", body: { projectId: id, title: "Run workflow", description: "Started from project page" } });
      toast("Workflow started", workflowId.slice(0, 8), "ok"); refreshCurrent();
    } catch (e) { toast("Error", e.message, "err"); }
  };
  window.projectToggleAgent = async (projectId, agentId, enable) => {
    try {
      await api(`/agents/${agentId}/${enable ? "enable" : "disable"}`, { method: "POST", body: {} });
      toast(enable ? "Agent enabled" : "Agent disabled", "", "ok"); refreshCurrent();
    } catch (e) { toast("Error", e.message, "err"); }
  };
  window.projectRunTask = async (taskId) => {
    try { const r = await api(`/tasks/${taskId}/run`, { method: "POST", body: {} }); toast(r.taskId && r.taskId !== taskId ? "Owning task queued — preserving the shared workflow" : "Task queued", r.taskId || taskId, "ok"); refreshCurrent(); }
    catch (e) { toast("Error", e.message, "err"); }
  };
  window.projectCancelTask = async (taskId) => {
    if (!confirm("Cancel this task?")) return;
    try { await api(`/tasks/${taskId}/cancel`, { method: "POST", body: {} }); toast("Task cancelled", taskId.slice(0,8), "ok"); refreshCurrent(); }
    catch (e) { toast("Error", e.message, "err"); }
  };
  window.projectViewTask = async (taskId) => {
    const t = await api(`/tasks/${taskId}`);
    const siblings = t.projectId ? await api(`/projects/${t.projectId}/tasks`).catch(() => []) : [];
    const kids = (siblings || []).filter((k) => k.parentTaskId === t.id).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const brief = t.input?.researchBrief ? `<div class="field"><label>🔎 Research brief <span class="sub">built by the research unit — every subtask works from this</span></label><pre class="mini-pre" dir="auto">${esc(t.input.researchBrief)}</pre></div>` : "";
    const criteria = Array.isArray(t.input?.acceptanceCriteria) && t.input.acceptanceCriteria.length ? `<div class="field task-criteria"><label>Acceptance criteria</label><ul>${t.input.acceptanceCriteria.map((c) => `<li dir="auto">${esc(c)}</li>`).join("")}</ul></div>` : "";
    const depends = Array.isArray(t.input?.dependsOn) && t.input.dependsOn.length ? `<div class="field"><label>Depends on</label>${t.input.dependsOn.map((id) => `<div class="meter-row"><span>${esc(siblings.find((k) => k.id === id)?.title || id)}</span><button class="btn btn-ghost" onclick="projectViewTask(${esc(JSON.stringify(id))})">View</button></div>`).join("")}</div>` : "";
    const assignments = skillAssignmentsHtml(t.result?.skills || t.input?.skillAssignments);
    const kidsHtml = kids.length ? `<div class="field mt"><label>🧩 Subtasks <span class="sub">${kids.filter((k) => k.status === "succeeded").length}/${kids.length} done</span></label><div class="table-wrap"><table><thead><tr><th>Task</th><th>Owner</th><th>Skills</th><th>Status</th><th></th></tr></thead><tbody>${kids.map((k) => `<tr><td><strong>${esc(k.title)}</strong></td><td class="mono">${esc(k.agentType || "auto")}</td><td>${(Array.isArray(k.input?.skills) ? k.input.skills : []).map((slug) => `<span class="badge badge-muted">${esc(slug)}</span>`).join(" ") || "—"}</td><td>${badge(k.status)}</td><td><button class="btn btn-ghost" onclick="projectViewTask(${esc(JSON.stringify(k.id))})">View</button></td></tr>`).join("")}</tbody></table></div></div>` : "";
    const plan = Array.isArray(t.input?.breakdown) ? t.input.breakdown.filter((item) => item && typeof item === "object") : [];
    const planHtml = plan.length ? `<details class="mt task-plan"><summary>Execution plan · ${plan.length} specialist tasks</summary>${plan.map((item) => `<div class="card card-body mt"><strong dir="auto">${esc(item.title)}</strong><div class="sub mono">${esc(item.id || "")} · ${esc(item.agentType)} · ${esc(item.repository || "")}</div><p dir="auto">${esc(item.description || "")}</p><div class="sub">Files: ${esc((Array.isArray(item.files) ? item.files : []).join(", "))}</div><div class="sub">Skills: ${esc((Array.isArray(item.skills) ? item.skills : []).join(", "))}</div><div class="sub">Depends on: ${esc((Array.isArray(item.dependsOn) ? item.dependsOn : []).join(", ") || "Independent")}</div><ul>${(Array.isArray(item.acceptanceCriteria) ? item.acceptanceCriteria : []).map((c) => `<li dir="auto">${esc(c)}</li>`).join("")}</ul></div>`).join("")}</details>` : "";
    const { skills: _skills, ...result } = t.result || {};
    openModal("Task details", `<div class="meter-row"><span class="lbl">Title</span><strong dir="auto">${esc(t.title)}</strong></div><div class="meter-row"><span class="lbl">Status</span>${badge(t.status)} ${verificationBadge(t.result?.verification)}</div><div class="meter-row"><span class="lbl">Agent</span><span class="mono">${esc(t.agentType || "auto")}${t.assignedAgentId ? ` · <a href="#/agents/${esc(t.assignedAgentId)}">${esc(t.assignedAgentId)}</a>` : ""}</span></div><div class="meter-row"><span class="lbl">Correlation</span><span class="mono">${esc(t.correlationId)}</span></div><div class="field"><label>Description</label><pre class="mini-pre" dir="auto">${esc(t.description || "")}</pre></div>${criteria}${depends}${assignments}${brief}${planHtml}${kidsHtml}${Object.keys(result).length ? `<div class="field mt"><label>Result</label>${miniJson(result)}</div>` : ""}${t.error ? `<div class="error-state"><h4>Task error</h4><pre>${esc(t.error)}</pre></div>` : ""}<div class="flex mt"><button class="btn btn-primary" onclick="projectRunTask('${esc(t.id)}')">Run</button><button class="btn" onclick="projectCancelTask('${esc(t.id)}')">Cancel</button><button class="btn" onclick="closeModal()">Close</button></div>`, { wide: true });
  };
  window.projectConfigureTelegram = async (id) => {
    let p;
    try { p = await api(`/projects/${id}`); }
    catch (e) { toast("Telegram settings unavailable", e.message, "err"); return; }
    const notes = p.settings?.notifications || [];
    openModal("Project Telegram", `<div class="field-hint">در این نسخه اعلان‌های تلگرام از طریق حساب بات متصل در صفحهٔ Telegram ارسال می‌شوند و نیازی به چت‌آیدی در سطح پروژه نیست.</div><label class="check"><input type="checkbox" id="ptg-notify" ${notes.includes("telegram") ? "checked" : ""}/> ارسال اعلان‌های پروژه به تلگرام</label><div class="flex mt"><button class="btn btn-primary" id="ptg-save">ذخیره</button><a class="btn" href="#/telegram">باز کردن صفحه تلگرام</a><button class="btn" onclick="closeModal()">انصراف</button></div>`);
    $("#ptg-save").onclick = async () => {
      const notify = $("#ptg-notify").checked;
      const notifications = Array.from(new Set([...(notes || []).filter((n)=>n !== "telegram"), ...(notify ? ["telegram"] : [])]));
      try { await api(`/projects/${id}`, { method: "PATCH", body: { settings: { notifications } } }); closeModal(); toast("تنظیمات تلگرام ذخیره شد", "", "ok"); refreshCurrent(); }
      catch (e) { toast("Error", e.message, "err"); }
    };
  };
  window.projectExport = async (id) => {
    try {
      const [project, agents, workflows, memory, skills] = await Promise.all([api(`/projects/${id}`), api(`/projects/${id}/agents`).catch(()=>[]), api(`/projects/${id}/workflows`).catch(()=>[]), api(`/projects/${id}/memory`).catch(()=>[]), api(`/projects/${id}/skills`).catch(()=>[])]);
      const snapshot = { kind: "codevia.project.export", version: 1, exportedAt: new Date().toISOString(), project, agents, workflows, memoryMetadata: memory.map((m)=>({ id:m.id, key:m.key, type:m.type, tags:m.tags, refs:m.refs, source:m.source, version:m.version })), skills, secretPolicy: "No secret values are exported; only secret references in configuration metadata may appear." };
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${(project.slug || project.name || "project").replace(/[^a-z0-9._-]+/gi, "-")}-codevia-export.json`; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
      toast("Project exported", "JSON snapshot prepared", "ok");
    } catch (e) { toast("Export failed", e.message, "err"); }
  };
  window.projectImport = async (id) => {
    openModal("Import project settings", `<div class="field"><label>Paste a CodeVia project export JSON</label><textarea class="textarea" id="pim-json" placeholder='{"kind":"codevia.project.export",...}'></textarea><div class="field-hint">Import updates safe project metadata only: name, description, repositories, capabilities, Telegram chat id, default model and settings. Secrets are never imported as values.</div></div><label class="check"><input type="checkbox" id="pim-reonboard" checked/> Load repository and initialize missing definitions after import</label><div class="flex"><button class="btn btn-primary" id="pim-go">Validate & Import</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    $("#pim-go").onclick = async () => {
      try {
        const parsed = JSON.parse($("#pim-json").value || "{}");
        const pr = parsed.project || parsed;
        if (!pr || !pr.name) throw new Error("Invalid project export: missing project.name");
        await api(`/projects/${id}`, { method: "PATCH", body: { name: pr.name, description: pr.description || "", repositories: pr.repositories, capabilities: pr.capabilities, defaultModelId: pr.defaultModelId, telegramChatId: pr.telegramChatId, settings: pr.settings || {}, reonboard: $("#pim-reonboard").checked } });
        closeModal(); toast("Project imported", "Configuration restored from JSON", "ok"); refreshCurrent();
      } catch (e) { toast("Import failed", e.message, "err"); }
    };
  };
  const PROJECT_PERMISSION_GROUPS = [["project","Project"],["agent","Agent"],["workflow","Workflow"],["model","Model"],["provider","Provider"],["skill","Skill"],["memory","Memory"],["repository","Repository"],["deployment","Deployment"],["secret","Secrets"],["telegram","Telegram"],["admin","Admin"]];
  window.projectEdit = async (id) => {
    openModal("Edit project", `<div class="repo-empty">Loading…</div>`, { wide: true });
    let p, catalog, models, agents;
    try {
      [p, catalog, models, agents] = await Promise.all([api("/projects/" + id), loadOptionCatalog(), api("/models").catch(() => []), api(`/projects/${id}/agents`).catch(() => [])]);
    } catch (e) { closeModal(); toast("Edit unavailable", e.message, "err"); return; }
    const caps = p.capabilities || {};
    const b = p.settings?.budget || {};
    const selectedModel = p.defaultModelId || "";
    const selectedAgent = p.defaultAgentId || "";
    const perms = p.settings?.permissions || {};
    const permTab = `<div class="field-hint" style="margin-bottom:8px">Project-level permission matrix — gates what this project's members, agents and workflows may touch.</div><div class="grid-2">${PROJECT_PERMISSION_GROUPS.map(([g, label]) => `<div class="field"><label>${esc(label)}</label><label class="check"><input type="checkbox" data-perm="${g}.read" ${perms[`${g}.read`] !== false ? "checked" : ""}/> read</label><label class="check"><input type="checkbox" data-perm="${g}.write" ${perms[`${g}.write`] !== false ? "checked" : ""}/> write</label></div>`).join("")}</div>`;
    const reposTab = `<div class="table-wrap"><table><thead><tr><th>Repository</th><th>Branch</th><th>Role</th><th>Config</th><th></th></tr></thead><tbody>${(p.repositories || []).map((r) => `<tr><td class="mono">${esc(r.repo)}</td><td class="mono">${esc(r.branch)}</td><td>${esc(r.role)}</td><td>${r.isConfigRepo ? '<span class="badge badge-ok">yes</span>' : '<span class="badge badge-muted">no</span>'}</td><td><button class="btn btn-ghost pe-unlink" data-repo="${esc(r.repo)}">Unlink</button></td></tr>`).join("")}</tbody></table></div><div class="flex mt"><button class="btn btn-primary" id="pe-link-repo">＋ Link repository</button></div><div class="field-hint">Branch, role and config-repo switches live in the edit dialog of each repository link.</div>`;
    $("#modal-body").innerHTML = `
      ${tabsHtml("pe", [
        { id: "identity", label: "Identity", html: `<div class="field"><label>Name</label><input class="input" id="pe-name" value="${esc(p.name)}"/></div><div class="field"><label>Description</label><textarea class="textarea" id="pe-desc">${esc(p.description || "")}</textarea></div><div class="grid-2"><div class="field"><label>Status</label><select class="select" id="pe-active"><option value="true" ${p.active ? "selected" : ""}>Active</option><option value="false" ${!p.active ? "selected" : ""}>Inactive</option></select></div><div class="field"><label>Environment</label><select class="select" id="pe-env">${["development","staging","production"].map((x)=>`<option value="${x}" ${x === (p.settings?.environment || "development") ? "selected" : ""}>${x}</option>`).join("")}</select></div></div><div class="grid-2"><div class="field"><label>Default model</label><select class="select" id="pe-model"><option value="">Project router default</option>${models.map((m)=>`<option value="${esc(m.id)}" ${m.id === selectedModel ? "selected" : ""}>${esc(m.displayName || m.modelId)} · ${esc(m.providerId)}</option>`).join("")}</select></div></div><div class="grid-2"><div class="field"><label>Default agent</label><select class="select" id="pe-agent"><option value="">Auto (router decides)</option>${agents.map((a)=>`<option value="${esc(a.id)}" ${a.id === selectedAgent ? "selected" : ""}>${esc(a.name)} (${esc(a.type)})</option>`).join("")}</select></div><div class="field"><label>Memory repository</label><select class="select" id="pe-memrepo"><option value="">Config repo (.ai-engineering)</option>${(p.repositories || []).map((r)=>`<option value="${esc(r.repo)}" ${r.repo === (p.memoryRepo || "") ? "selected" : ""}>${esc(r.repo)}</option>`).join("")}</select><div class="field-hint">Where versioned memory snapshots live.</div></div></div>` },
        { id: "capabilities", label: "Capabilities", html: `${CAPABILITY_GROUPS.map(([k, label, ph]) => chipGroupHtml(k, label, catalog[k] || [], caps[k] || [], { placeholder: ph, single: new Set(catalog.singleSelectKeys || ["databases"]).has(k) })).join("")}${chipGroupHtml("agentTypes", "Agents to generate", catalog.agentTypes || [], caps.agentTypes || [], { core: catalog.coreAgentTypes || [], allowCustom: false, hint: "Saving reads CodeVia and creates only missing definitions. Existing prompts and enabled/disabled choices are preserved." })}` },
        { id: "permissions", label: "Permissions", html: permTab },
        { id: "repositories", label: "Repositories", html: reposTab },
        { id: "operations", label: "Operations", html: `<div class="grid-2"><div class="field"><label>Max tokens per run</label><input class="input" type="number" id="pe-b-tokens" value="${esc(b.maxTokensPerRun ?? 20000)}"/></div><div class="field"><label>Max calls per run</label><input class="input" type="number" id="pe-b-calls" value="${esc(b.maxCallsPerRun ?? 20)}"/></div><div class="field"><label>Max cost per run (USD)</label><input class="input" type="number" step="0.01" id="pe-b-cost" value="${esc(b.maxCostUsdPerRun ?? 5)}"/></div><div class="field"><label>Max duration (ms)</label><input class="input" type="number" id="pe-b-ms" value="${esc(b.maxDurationMs ?? 300000)}"/></div></div><div class="grid-2"><div class="field"><label>Max QA↔Fix loops</label><input class="input" type="number" id="pe-fixloops" min="0" max="6" value="${esc(p.settings?.maxFixLoops ?? 2)}"/><div class="field-hint">How many diagnosis/fix rounds after a failing QA run before giving up.</div></div><div class="field"><label>Diagnose via research before fixing</label><select class="select" id="pe-researchfix"><option value="true" ${p.settings?.researchBeforeFix !== false ? "selected" : ""}>On (recommended)</option><option value="false" ${p.settings?.researchBeforeFix === false ? "selected" : ""}>Off (direct fix)</option></select></div><div class="field"><label>Cache GitHub context in memory</label><select class="select" id="pe-cachectx"><option value="true" ${p.settings?.cacheContextInMemory !== false ? "selected" : ""}>On</option><option value="false" ${p.settings?.cacheContextInMemory === false ? "selected" : ""}>Off (rescan every run)</option></select></div></div><div class="field"><label>Notifications</label><input class="input" id="pe-notifications" value="${esc((p.settings?.notifications || []).join(", "))}" placeholder="web, telegram"/></div><div class="field"><label>Metadata (JSON)</label><textarea class="textarea mono" id="pe-meta">${esc(JSON.stringify(p.settings?.metadata || {}, null, 2))}</textarea></div>` },
      ])}
      <div class="flex mt"><button class="btn btn-primary" id="pe-save">Save & re-onboard</button><button class="btn" id="pe-save-lite">Save without onboarding</button><button class="btn btn-danger" id="pe-delete">Delete project</button><button class="btn" onclick="closeModal()">Cancel</button></div>`;
    bindChipGroups($("#modal-body"));
    $("#pe-link-repo").onclick = () => { closeModal(); projectAddRepo(id); };
    $$(".pe-unlink", $("#modal-body")).forEach((btn) => { btn.onclick = () => { const repo = btn.dataset.repo; closeModal(); projectUnlinkRepo(id, repo); }; });
    const saveProject = async (reonboard) => {
      const metadataText = $("#pe-meta")?.value || "{}";
      let metadata = {};
      try { metadata = JSON.parse(metadataText); } catch (_) { toast("Invalid metadata JSON", "Fix the Operations tab metadata field", "err"); return; }
      const permissions = {};
      $$("[data-perm]", $("#modal-body")).forEach((c) => { permissions[c.dataset.perm] = c.checked; });
      try {
        await api("/projects/" + id, { method: "PATCH", body: {
          name: $("#pe-name").value.trim(), description: $("#pe-desc").value,
          active: $("#pe-active").value === "true", defaultModelId: $("#pe-model").value, defaultAgentId: $("#pe-agent").value, memoryRepo: $("#pe-memrepo").value, 
          capabilities: readChipGroups($("#modal-body")), reonboard,
          settings: {
            environment: $("#pe-env").value,
            notifications: ($("#pe-notifications").value || "").split(",").map((x)=>x.trim()).filter(Boolean),
            metadata,
            permissions,
            budget: { maxTokensPerRun: Number($("#pe-b-tokens").value) || 0, maxCallsPerRun: Number($("#pe-b-calls").value) || 0, maxCostUsdPerRun: Number($("#pe-b-cost").value) || 0, maxDurationMs: Number($("#pe-b-ms").value) || 0 },
            maxFixLoops: Math.max(0, Math.min(6, Number($("#pe-fixloops").value) || 0)),
            researchBeforeFix: $("#pe-researchfix").value === "true",
            cacheContextInMemory: $("#pe-cachectx").value === "true",
          },
        } });
        closeModal(); toast("Project updated", reonboard ? "Repository loaded; missing definitions initialized" : "Settings saved", "ok"); refreshCurrent();
      } catch (e) { toast("Error", e.message, "err"); }
    };
    $("#pe-save").onclick = () => saveProject(true);
    $("#pe-save-lite").onclick = () => saveProject(false);
    $("#pe-delete").onclick = async () => {
      if (!confirm(`Delete project ${p.name}? This removes runtime records from CodeVia but does not delete GitHub repositories.`)) return;
      try { await api(`/projects/${id}`, { method: "DELETE" }); closeModal(); toast("Project deleted", p.name, "ok"); location.hash = "#/projects"; }
      catch (e) { toast("Delete failed", e.message, "err"); }
    };
  };

