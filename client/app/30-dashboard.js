  /* ---------- Views ---------- */

  /* DASHBOARD */
  on("/dashboard", async () => {
    // The dashboard aggregates a few endpoints; each is optional so a partial
    // outage degrades one widget instead of blanking the whole page.
    const [d, runsRaw, usage, providers, ghStatus, tgStatus] = await Promise.all([
      api("/dashboard"),
      api("/runs").catch(() => []),
      api("/admin/usage").catch(() => null),
      api("/providers").catch(() => []),
      api("/integrations/github/status").catch(() => null),
      api("/integrations/telegram/status").catch(() => null),
    ]);
    const runs = Array.isArray(runsRaw) ? runsRaw : (runsRaw?.items || []);
    const q = d.queue || {};

    // ---- derived series ----
    const trend = bucketByDay(runs, 7);
    const statusCounts = runs.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
    const statusSegments = [
      { label: "succeeded", value: statusCounts.succeeded || 0, color: "#34d399" },
      { label: "running", value: statusCounts.running || 0, color: "#60a5fa" },
      { label: "pending", value: statusCounts.pending || 0, color: "#8990b5" },
      { label: "failed", value: statusCounts.failed || 0, color: "#fb7185" },
    ];
    const done = (statusCounts.succeeded || 0);
    const attempted = done + (statusCounts.failed || 0);
    const successRate = attempted ? Math.round((done / attempted) * 100) : 100;
    const agentCounts = Object.entries(runs.reduce((acc, r) => { acc[r.agentType] = (acc[r.agentType] || 0) + 1; return acc; }, {}))
      .sort((a, b) => b[1] - a[1]).slice(0, 6).map(([label, value]) => ({ label, value }));
    const readyProviders = providers.filter((p) => p.readiness?.ready !== false && p.active).length;
    const ghOk = !!(ghStatus && (ghStatus.connected || ghStatus.source === "user-oauth"));
    const tgOk = !!(tgStatus && (tgStatus.ready || tgStatus.connected || tgStatus.configured));
    const provOk = providers.filter((p) => p.active).length > 0;
    const projOk = d.totalProjects > 0;
    const checkItem = (ok, icon, title, sub, link) => `<a class="list-row" href="${link}"><span>${ok ? "✅" : "○"}</span><div><strong>${icon} ${title}</strong><div class="sub">${sub}</div></div><span class="spacer"></span>${ok ? '<span class="badge badge-ok">done</span>' : '<span class="badge badge-warn">setup</span>'}</a>`;

    const statCard = (label, value, sub, icon, spark) => `<div class="card stat">
      <span class="stat-icon">${icon}</span>
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${esc(String(value))}</div>
      <div class="stat-sub">${sub}</div>
      ${spark || ""}
    </div>`;

    $("#content").innerHTML = `
      <div class="overview">
        <div><h1>Dashboard</h1><p>Live overview of your AI engineering organization — runs, agents, spend and system health.</p></div>
        <div class="action-row">
          <button class="btn" onclick="openDashboardDetails()">📈 Analytics</button>
          <button class="btn btn-primary" onclick="location.hash='#/projects'">＋ New Project</button>
        </div>
      </div>

      <div class="stat-grid">
        ${statCard("Projects", d.totalProjects, `${d.activeAgents} active agents`, "📁", "")}
        ${statCard("Runs", d.totalRuns, `${successRate}% success rate`, "▶️", sparkline(trend.map((t) => t.value)))}
        ${statCard("Running now", d.runningTasks, `${q.pending || 0} queued · ${d.failedTasks} failed`, "⚡", "")}
        <a class="card stat" href="#/approvals" style="color:inherit">
          <span class="stat-icon">🛑</span>
          <div class="stat-label">Approvals</div>
          <div class="stat-value">${d.pendingApprovals}</div>
          <div class="stat-sub">${d.pendingApprovals ? "waiting for your review" : "nothing to review"}</div>
        </a>
      </div>

      ${(!ghOk || !tgOk || !provOk || !projOk) ? `<div class="card card-body mt"><div class="card-title">Setup checklist <span class="sub">get the platform fully operational</span></div>
        ${checkItem(ghOk, "🐙", "Connect GitHub", ghStatus ? `${ghStatus.repoCount || 0} repos visible · ${esc(ghStatus.source || "mock")}` : "GitHub is the source of truth for projects", "#/github")}
        ${checkItem(tgOk, "📱", "Connect Telegram", tgStatus ? `transport: ${esc(tgStatus.transport || tgStatus.mode || "off")}` : "Approvals and control from chat", "#/telegram")}
        ${checkItem(provOk, "🧠", "Configure AI providers", `${providers.filter((p) => p.active).length} active · mock works offline`, "#/providers")}
        ${checkItem(projOk, "📁", "Create your first project", "Auto-generates agents, skills and workflows", "#/projects")}
      </div>` : ""}
      <div class="grid-2 mt">
        <div class="card card-body">
          <div class="card-title">Run activity <span class="sub">last 7 days · ${trend.reduce((s, t) => s + t.value, 0)} runs</span></div>
          ${lineChart(trend.map((t) => t.value), { labels: trend.map((t) => t.label), color: "#7c6cff" })}
        </div>
        <div class="card card-body">
          <div class="card-title">Run outcomes</div>
          ${donutChart(statusSegments, { centerValue: runs.length, centerLabel: "total runs" })}
        </div>
      </div>

      <div class="grid-2 mt">
        <div class="card card-body">
          <div class="card-title">Busiest agents <span class="sub">runs per agent type</span></div>
          ${barChart(agentCounts)}
        </div>
        <div class="card card-body">
          <div class="card-title">Recent activity <span class="sub">${d.recentActivity.length} events</span></div>
          ${d.recentActivity.length ? `<div class="activity-feed">${d.recentActivity.map((r) => {
            const color = r.status === "succeeded" ? "var(--ok)" : r.status === "failed" ? "var(--err)" : r.status === "running" ? "var(--info)" : "var(--text-muted)";
            return `<div class="activity-item">
              <span class="activity-dot" style="background:${color};box-shadow:0 0 10px ${color}"></span>
              <div class="activity-body"><strong>${esc(r.agentType)}</strong><span>${timeAgo(r.createdAt)} · ${esc(r.status)}${r.durationMs ? ` · ${Math.round(r.durationMs / 1000)}s` : ""}</span></div>
              <button class="btn btn-ghost" onclick="location.hash='#/runs/${esc(r.runId)}/console'">Open</button>
            </div>`;
          }).join("")}</div>` : emptyState("📭", "No activity yet", "Run a task or a workflow to see agent activity here.")}
        </div>
      </div>

      <div class="grid-2 mt">
        <div class="card card-body">
          <div class="card-title">Queue &amp; spend</div>
          <div class="kpi-row">
            <div class="kpi"><b>${q.pending || 0}</b><span>pending</span></div>
            <div class="kpi"><b>${q.running || 0}</b><span>running</span></div>
            <div class="kpi"><b>${d.modelUsage.calls}</b><span>calls</span></div>
            <div class="kpi"><b>${(d.modelUsage.tokens / 1000).toFixed(1)}k</b><span>tokens</span></div>
            <div class="kpi"><b>${money(d.modelUsage.costUsd)}</b><span>cost</span></div>
          </div>
          <div class="meter-row mt"><span class="lbl">Providers ready</span><div class="bar"><span style="width:${providers.length ? (readyProviders / providers.length) * 100 : 0}%"></span></div><span class="val">${readyProviders}/${providers.length}</span></div>
          <div class="meter-row"><span class="lbl">Success rate</span><div class="bar"><span style="width:${successRate}%"></span></div><span class="val">${successRate}%</span></div>
        </div>
        <div class="card card-body">
          <div class="card-title">Quick actions</div>
          <div class="quick-grid">
            <a class="quick-btn" href="#/projects"><span class="q-ico">📁</span>Projects</a>
            <a class="quick-btn" href="#/models"><span class="q-ico">🧠</span>Models</a>
            <a class="quick-btn" href="#/providers"><span class="q-ico">🔌</span>Providers</a>
            <a class="quick-btn" href="#/runs"><span class="q-ico">▶️</span>Runs</a>
            <a class="quick-btn" href="#/approvals"><span class="q-ico">🛑</span>Approvals</a>
            <a class="quick-btn" href="#/admin"><span class="q-ico">🛡️</span>Admin</a>
          </div>
        </div>
      </div>`;

    // Deeper analytics live in a modal so the page itself stays uncluttered.
    window.openDashboardDetails = () => {
      openModal("📈 Analytics", tabsHtml("dashx", [
        { id: "trend", label: "Trends", html: `
          <div class="card card-body"><div class="card-title">Runs per day <span class="sub">7 days</span></div>${lineChart(trend.map((t) => t.value), { labels: trend.map((t) => t.label), width: 640 })}</div>
          <div class="card card-body mt"><div class="card-title">Runs by agent</div>${barChart(agentCounts, { width: 640 })}</div>` },
        { id: "outcomes", label: "Outcomes", badge: runs.length, html: `
          <div class="card card-body">${donutChart(statusSegments, { centerValue: `${successRate}%`, centerLabel: "success" })}</div>
          <div class="card card-body mt"><div class="card-title">Breakdown</div>
            ${statusSegments.map((s) => `<div class="meter-row"><span class="lbl">${esc(s.label)}</span><div class="bar"><span style="width:${runs.length ? (s.value / runs.length) * 100 : 0}%;background:${s.color}"></span></div><span class="val">${s.value}</span></div>`).join("")}
          </div>` },
        { id: "usage", label: "Usage", html: usage ? `
          <div class="card card-body"><div class="card-title">Platform totals</div>
            <div class="kpi-row">
              <div class="kpi"><b>${usage.projects}</b><span>projects</span></div>
              <div class="kpi"><b>${usage.agents}</b><span>agents</span></div>
              <div class="kpi"><b>${usage.models}</b><span>models</span></div>
              <div class="kpi"><b>${usage.skills}</b><span>skills</span></div>
              <div class="kpi"><b>${usage.tasks}</b><span>tasks</span></div>
              <div class="kpi"><b>${usage.runs}</b><span>runs</span></div>
            </div>
            <div class="card-title mt">Model spend</div>
            <div class="meter-row"><span class="lbl">Calls</span><span class="val">${usage.costs.calls}</span></div>
            <div class="meter-row"><span class="lbl">Tokens</span><span class="val">${usage.costs.tokens.toLocaleString()}</span></div>
            <div class="meter-row"><span class="lbl">Cost</span><span class="val">${money(usage.costs.costUsd)}</span></div>
          </div>` : `<div class="card card-body">${emptyState("🔒", "Usage unavailable", "The usage endpoint is restricted or offline.")}</div>` },
      ]), { wide: true });
    };
  });

