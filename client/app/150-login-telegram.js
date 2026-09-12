  /* Login result toasts — the OAuth callback can land on any hash route
     (?login=success|error). route() refreshes session state right after this,
     so on success we use the now-valid cookie via the refreshed authState. */
  function handleLoginResultParams() {
    const q = new URLSearchParams((location.hash.split("?")[1] || ""));
    if (q.get("login") === "success" && !sessionStorage.getItem("cv-welcomed")) {
      sessionStorage.setItem("cv-welcomed", "1");
      // route() refreshes authState immediately after this function returns
      // and re-renders the user slot. Do not call /auth/me here as well: that
      // created duplicate requests (and duplicate 401s on stale deployments).
      toast("GitHub login successful", "", "ok");
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
    // Repositories now come from the session's own GitHub token (or the server
    // token / demo data) — the API tells us which via `source`.
    const repoRes = await apiRaw("/github/repositories?limit=500").catch(() => null);
    const repoBody = repoRes && repoRes.ok ? (repoRes.body || {}) : {};
    const repos = Array.isArray(repoBody) ? repoBody : (repoBody.repositories || []);
    const repoErr = repoRes && !repoRes.ok ? ((repoRes.body && (repoRes.body.error || repoRes.body.message)) || `HTTP ${repoRes.status}`) : "";
    const repoHint = (repoRes && repoRes.body && repoRes.body.hint) || "";
    const sourceLabel = { "user-oauth": "your GitHub account", "server-token": "server GITHUB_TOKEN", mock: "demo / mock" }[repoBody.source || status.source] || (repoBody.source || status.source || "—");
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
          <a class="btn btn-primary" href="/auth/github/login">🐙 Login with GitHub</a>
          <button class="btn" id="gh-diag-btn" style="margin-left:6px">Diagnose</button>
          <div id="gh-diag" style="margin-top:8px;font-size:11px;color:var(--text-muted)"></div></div>`;
    } else {
      loginCard = `<div class="card card-body"><div class="card-title">GitHub Login — Not configured</div>
          <div class="status-grid"><div class="status-item"><span class="status-dot warn"></span>Not configured</div></div>
          ${oauthStatus.setupHint ? `<p style="color:var(--warn, #d97706);font-size:12px">${esc(oauthStatus.setupHint)}</p>` : `<p style="color:var(--text-muted);font-size:12px">Set <span class="mono">GITHUB_CLIENT_ID</span> + <span class="mono">GITHUB_CLIENT_SECRET</span> and restart — see <span class="mono">docs/GITHUB_SETUP.md</span>.</p>`}
          <div style="background:var(--glass);border:1px solid var(--border);border-radius:8px;padding:10px;margin:8px 0;text-align:left">
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
        <div class="action-row"><button class="btn btn-primary" onclick="openCreateRepo()">＋ Create repository</button><button class="btn" onclick="refreshCurrent()">Refresh</button></div></div>
      <div class="grid-3">
        <div class="card card-body"><div class="card-title">Connection</div>
          <div class="status-grid"><div class="status-item"><span class="status-dot ${status.connected?'healthy':'warn'}"></span>${status.connected?'Connected':'Mock (dev)'}</div></div>
          <p style="color:var(--text-muted);font-size:12px">Kind: ${esc(status.kind)} · Source of truth: ${status.sourceOfTruth}</p>
          <p style="color:var(--text-muted);font-size:11px">OAuth configured: ${oauthStatus.configured ? '<span class="badge badge-ok">yes</span>' : '<span class="badge badge-err">no</span>'}</p>
        </div>
        ${loginCard}
        <div class="card card-body"><div class="card-title">Repositories (${repos.length}) <span class="sub">source: ${esc(sourceLabel)}</span></div>
          ${status.viewer ? `<p class="mono" style="font-size:11px;color:var(--text-muted)">token: @${esc(status.viewer.login)}${status.viewer.scopes?.length ? " · scopes: " + esc(status.viewer.scopes.join(", ")) : ""}</p>` : ""}
          ${status.userToken && status.authenticated && !status.userToken.stored && oauthStatus.configured ? `<p class="field-hint warn">Your session has no GitHub token yet — <a href="/auth/github/login?next=%23%2Fgithub">log in again</a> to list your own repositories.</p>` : ""}
          ${status.userToken?.stored && status.userToken.canReadPrivateRepos === false ? `<p class="field-hint warn">Your token lacks the <span class="mono">repo</span> scope, so private repositories are hidden. Ask an admin to set the OAuth scope to <span class="mono">repo read:user user:email</span> and log in again.</p>` : ""}
          ${repoErr ? `<div class="error-state"><h4>Could not list repositories</h4><pre>${esc(repoErr)}</pre>${repoHint ? `<p style="font-size:12px">${esc(repoHint)}</p>` : ""}</div>` : ""}
          ${repos.length ? `<div class="repo-search"><input class="input" id="gh-repo-filter" placeholder="Filter…" style="max-width:260px;margin-bottom:8px"/></div><div class="table-wrap" style="max-height:420px;overflow:auto"><table><thead><tr><th>Repository</th><th>Visibility</th><th>Language</th><th>Default branch</th><th>Updated</th></tr></thead><tbody id="gh-repo-rows">${repos.map((r)=>`<tr data-full="${esc(r.fullName || (r.owner + "/" + r.name))}"><td class="mono">${r.htmlUrl ? `<a href="${esc(r.htmlUrl)}" target="_blank" rel="noopener">${esc(r.fullName || (r.owner + "/" + r.name))}</a>` : esc(r.fullName || (r.owner + "/" + r.name))}${r.description ? `<div style="color:var(--text-muted);font-size:11px;font-family:var(--font)">${esc(r.description)}</div>` : ""}</td><td>${r.private ? '<span class="badge badge-warn">private</span>' : '<span class="badge badge-muted">public</span>'}</td><td>${esc(r.language || "—")}</td><td class="mono">${esc(r.defaultBranch || "—")}</td><td>${timeAgo(r.updatedAt)}</td></tr>`).join("")}</tbody></table></div>` : (repoErr ? "" : emptyState("🐙", "No repositories", repoHint || "Log in with GitHub to list your repositories, or set GITHUB_TOKEN + GITHUB_ENABLED=true on the server."))}
          ${!repoErr && repoHint && repos.length ? `<p class="field-hint">${esc(repoHint)}</p>` : ""}
        </div>
      </div>`;
    const rf = document.getElementById("gh-repo-filter");
    if (rf) rf.addEventListener("input", () => { const q = rf.value.toLowerCase(); $$("#gh-repo-rows tr").forEach((tr) => { tr.style.display = tr.dataset.full.toLowerCase().includes(q) ? "" : "none"; }); });
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
        el.innerHTML = `<div style="color:var(--error, #dc2626);border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--glass);text-align:left">`+
          `<strong>${esc(b.error||"Not configured")}</strong><br/>${esc(b.hint||"")}`+
          (b.setupSteps ? `<ol style="margin:6px 0 0 16px;font-size:11px">${b.setupSteps.map(s=>`<li>${esc(s)}</li>`).join("")}</ol>` : "")+
          (b.diagnostics ? `<pre style="margin-top:6px;font-size:10px;white-space:pre-wrap">${esc(JSON.stringify(b.diagnostics,null,2))}</pre>` : "")+
          `</div>`;
      }
    };
    const b1 = document.getElementById("gh-diag-btn"); if (b1) b1.onclick = () => diagHandler("gh-diag");
    const b2 = document.getElementById("gh-diag-btn2"); if (b2) b2.onclick = () => diagHandler("gh-diag2");
  });

  /* Create a new GitHub repository from the UI (real API call). */
  window.openCreateRepo = async () => {
    openModal("Create GitHub repository", `
      <div class="field"><label>Repository name</label><input class="input mono" id="cr-name" placeholder="my-new-project"/></div>
      <div class="field"><label>Description (optional)</label><input class="input" id="cr-desc" placeholder="What is this project about?"/></div>
      <div class="field"><label class="flex" style="align-items:center;gap:8px"><input type="checkbox" id="cr-private"/> Private repository</label></div>
      <div class="flex"><button class="btn btn-primary" id="cr-go">Create</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    $("#cr-go").onclick = async () => {
      const name = $("#cr-name").value.trim();
      if (!name) { toast("Repository name required", "", "err"); $("#cr-name").focus(); return; }
      const btn = $("#cr-go"); btn.disabled = true;
      try {
        const r = await api("/github/repositories", { method: "POST", body: { name, description: $("#cr-desc").value.trim(), private: $("#cr-private").checked } });
        closeModal(); toast("Repository created", (r.repository || r).fullName, "ok"); refreshCurrent();
      } catch (e) { toast("Could not create repository", e.message, "err"); btn.disabled = false; }
    };
  };

  /* TELEGRAM */
  on("/telegram", async () => {
    const status = await api("/integrations/telegram/status");
    const accounts = status.accounts || [];
    const receiving = status.transport || "off";
    const recvBadge = receiving === "off"
      ? `<span class="badge badge-err">not receiving</span>`
      : status.ready && receiving === "polling"
        ? `<span class="badge badge-ok">long polling</span>`
        : status.ready && receiving === "webhook"
          ? `<span class="badge badge-ok">webhook</span>`
          : `<span class="badge badge-err">${esc(receiving)} — broken</span>`;
    const fixes = (status.fixes || []).length
      ? `<div class="field-hint err" style="margin-top:8px">${status.fixes.map((f) => `• ${esc(f)}`).join("<br/>")}</div>`
      : "";
    const poll = status.polling || {};
    $("#content").innerHTML = `<div class="overview"><div><h1>Telegram Integration</h1><p>Per-user Telegram bots — connect a token and the platform receives your messages, with or without a public URL.</p></div>
        <button class="btn btn-primary" onclick="openTelegramAccount()">＋ Connect a bot</button></div>
      <div class="grid-2">
        <div class="card card-body"><div class="card-title">Platform connection ${recvBadge}</div>
          <div class="status-grid"><div class="status-item"><span class="status-dot ${status.ready ? "healthy" : status.configured ? "warn" : "err"}"></span>${status.globalConnected ? `Global bot (TELEGRAM_BOT_TOKEN)${status.botUsername ? " · @" + esc(status.botUsername) : ""}` : status.configured ? `A token is set but Telegram rejected it${status.botUsername ? " · @" + esc(status.botUsername) : ""} — press 🧪 Run connection test` : "No global bot token — connect your own bot below"}</div></div>
          <div class="meter-row"><span class="lbl">Receiving mode</span><span class="val mono">${esc(status.mode || "auto")} → ${esc(receiving)}</span></div>
          <div class="meter-row"><span class="lbl">Bot API</span><span class="val mono">${esc(status.apiBase || "https://api.telegram.org")}${status.realApi === false ? ' <span class="badge badge-err">not Telegram</span>' : ""}</span></div>
          ${receiving === "polling"
            ? `<div class="meter-row"><span class="lbl">Poller</span><span class="val">${poll.running ? `✅ running · ${poll.updatesReceived || 0} update(s)` : "⏹ stopped"}</span></div>
               <div class="field-hint">No public URL needed — the bot asks Telegram for updates. Works on a laptop, a NAT'ed VPS, or a preview host.</div>`
            : `<div class="meter-row"><span class="lbl">Webhook URL</span><span class="val mono" style="font-size:10px;word-break:break-all">${esc(status.webhookUrl || "—")}</span></div>
               <div class="meter-row"><span class="lbl">Telegram sees</span><span class="val mono">${esc((status.webhookInfo && status.webhookInfo.url) || "no webhook yet")}</span></div>`}
          ${poll.lastError ? `<div class="field-hint err">${esc(poll.lastError)}</div>` : ""}
          ${fixes}
          <div class="provider-actions" style="margin-top:10px">
            <button class="btn" onclick="telegramTransport('polling')">📡 Use long polling</button>
            <button class="btn" onclick="telegramTransport('webhook')">🔗 Use webhook</button>
            <button class="btn btn-ghost" onclick="telegramTest()">🧪 Run connection test</button>
            <button class="btn btn-ghost" onclick="telegramDiagnostics()">🩺 Diagnostics</button>
            <button class="btn btn-ghost" onclick="telegramTransport('off')">⏹ Stop receiving</button>
          </div>
          <p style="color:var(--text-muted);font-size:11px;margin-top:8px">Commands: /start /projects /agents /task /run /status /tests /issues /pr /memory /skills /id /ping — or just write your request in Persian. Docs: <span class="mono">docs/TELEGRAM_SETUP.md</span></p>
        </div>
        <div class="card card-body"><div class="card-title">Preview (no bot needed)</div>
          <div class="field"><label>Message</label><input class="input" id="tg-msg" placeholder="/start" value="/start"/></div>
          <button class="btn btn-primary" id="tg-send">Show reply</button>
          <div class="card mt" id="tg-out" style="background:var(--glass);min-height:80px"></div>
        </div>
      </div>
      <div class="card card-body mt"><div class="card-title">Your bots (${accounts.length})</div>
        ${accounts.length ? `<div class="grid-2">${accounts.map((a) => `<div class="card card-body">
          <div class="card-title">${esc(a.name || a.botUsername || a.botId || a.accountId || "Bot account")} ${a.connected ? '<span class="badge badge-ok">connected</span>' : '<span class="badge badge-err">disconnected</span>'} ${a.transport === "polling" ? '<span class="badge badge-info">polling</span>' : a.webhookSet ? '<span class="badge badge-ok">webhook</span>' : '<span class="badge badge-muted">not receiving</span>'}</div>
          <div class="meter-row"><span class="lbl">Bot</span><span class="val mono">${esc(a.botUsername || a.botId || "—")}</span></div>
          <div class="meter-row"><span class="lbl">AccountId</span><span class="val mono">${esc(a.accountId || "—")}</span></div>
          <div class="meter-row"><span class="lbl">Chat</span><span class="val mono">${esc(a.chatId || "—")}${a.paired ? "" : ' <span class="badge badge-warn">not linked</span>'}</span></div>
          ${a.pairCode ? `<div class="field-hint">Send <span class="mono">/pair ${esc(a.pairCode)}</span> to your bot to link this chat. <button class="btn btn-ghost" style="padding:1px 6px;font-size:10px" onclick="navigator.clipboard&&navigator.clipboard.writeText('/pair ${esc(a.pairCode)}');toast('Copied','Paste it in Telegram','ok')">copy</button></div>` : ""}
          <div class="meter-row"><span class="lbl">Token</span><span class="val mono">${esc(a.tokenMasked || "—")}</span></div>
          <div class="meter-row"><span class="lbl">Last check</span><span class="val mono">${esc(a.lastCheckedAt || "—")}</span></div>
          ${a.lastError ? `<div class="field-hint ${a.webhookSet || a.pollingActive ? "" : "err"}">${esc(a.lastError)}</div>` : ""}
          <div class="provider-actions">
            <button class="btn" onclick="telegramConnect('${esc(a.id)}')">↻ Reconnect</button>
            <button class="btn" onclick="telegramAccountPoll('${esc(a.id)}', ${a.pollingActive ? "false" : "true"})">${a.pollingActive ? "⏹ Stop polling" : "📡 Poll for me"}</button>
            <button class="btn btn-ghost" onclick="openTelegramAccount('${esc(a.id)}')">Edit</button>
            <button class="btn btn-ghost" onclick="telegramRepair('${esc(a.id)}')">🔗 Link another chat</button>
            <button class="btn btn-danger" onclick="telegramDelete('${esc(a.id)}')">Delete</button>
          </div>
        </div>`).join("")}</div>` : emptyState("📱", "No bot connected", "Enter your Telegram bot token (from @BotFather) to connect a real account for this user.")}
      </div>`;
    const renderPreview = (r) => {
      const reply = r && r.reply;
      const kb = (reply && reply.keyboard) || [];
      $("#tg-out").innerHTML = r && r.error
        ? `<div class="error-state"><h4>Bot error</h4><p style="font-size:12px">${esc(r.error)}</p></div>`
        : reply
          ? `<div style="padding:8px 10px"><div style="white-space:pre-wrap;font-size:12px">${esc(String(reply.text || "").replace(/[*`]/g, ""))}</div>
             ${kb.length ? `<div class="flex" style="flex-wrap:wrap;gap:6px;margin-top:10px">${kb.map((row) => row.map((btn) => `<button class="btn btn-ghost" style="font-size:11px" onclick="telegramPreviewButton('${esc(btn.callback_data || "")}')">${esc(btn.text)}</button>`).join("")).join("")}</div>` : ""}</div>`
          : `<div class="field-hint">${esc(r && r.delivered ? "Sent to your Telegram chat." : "That update has no reply — send /start or type a request.")}</div>`;
    };
    window.telegramPreviewButton = async (data) => {
      if (!data) return;
      try { renderPreview(await api("/integrations/telegram/command", { method: "POST", body: { callbackData: data } })); }
      catch (e) { toast("Preview failed", e.message, "err"); }
    };
    $("#tg-send").onclick = async () => {
      try { renderPreview(await api("/integrations/telegram/command", { method: "POST", body: { text: $("#tg-msg").value } })); }
      catch (e) { toast("Preview failed", e.message, "err"); }
    };
    renderPreview(await api("/integrations/telegram/command", { method: "POST", body: { text: "/start" } }));
  });
  /**
   * "Each user brings their own bot": the token is typed here, never in an env
   * var. Until a chat is paired the bot answers nobody, so a token that leaks in
   * a group or a screenshot cannot be used to read someone's projects.
   */
  window.renderTelegramSettings = async () => {
    const host = $("#tg-settings");
    if (!host) return;
    let st;
    try { st = await api("/integrations/telegram/status"); } catch (e) { host.innerHTML = ""; return; }
    const accounts = st.accounts || [];
    const rows = accounts.length
      ? accounts.map((a) => `<div class="card card-body" style="margin-bottom:8px">
          <div class="card-title">${esc(a.name || a.botUsername || "Bot")}
            ${a.connected ? '<span class="badge badge-ok">token ok</span>' : '<span class="badge badge-err">token rejected</span>'}
            ${a.paired ? '<span class="badge badge-ok">linked</span>' : '<span class="badge badge-warn">not linked</span>'}
            <span class="badge badge-muted">${esc(a.transport || "off")}</span></div>
          <div class="meter-row"><span class="lbl">Bot</span><span class="val mono">${esc(a.botUsername ? "@" + a.botUsername : "—")} · ${esc(a.tokenMasked || "")}</span></div>
          <div class="meter-row"><span class="lbl">Answers chat</span><span class="val mono">${esc(a.chatId || "nobody yet")}</span></div>
          ${a.pairCode ? `<div class="meter-row"><span class="lbl">Pairing code</span><span class="val mono" style="font-size:14px;letter-spacing:2px">${esc(a.pairCode)}</span></div>
            <div class="field-hint">Send <span class="mono">/pair ${esc(a.pairCode)}</span> to your bot on Telegram — that chat becomes the only one it answers.</div>` : ""}
          ${a.lastError ? `<div class="field-hint err">${esc(a.lastError)}</div>` : ""}
          <div class="provider-actions" style="margin-top:8px">
            <button class="btn" onclick="openTelegramAccount('${esc(a.id)}')">✏️ Edit</button>
            <button class="btn btn-ghost" onclick="telegramAccountPoll('${esc(a.id)}', ${a.pollingActive ? "false" : "true"})">${a.pollingActive ? "⏹ Stop polling" : "📡 Poll for me"}</button>
            <button class="btn btn-ghost" onclick="telegramRepair('${esc(a.id)}')">🔗 Link another chat</button>
            <button class="btn btn-ghost" onclick="telegramConnect('${esc(a.id)}')">🔄 Re-check</button>
            <button class="btn btn-ghost" onclick="telegramDelete('${esc(a.id)}')">🗑</button>
          </div>
        </div>`).join("")
      : `<div class="field-hint">No bot connected yet. Each person here can use their own Telegram bot — create one with <span class="mono">@BotFather → /newbot</span> and paste the token below. No server variable, no webhook, no tunnel needed.</div>`;
    host.innerHTML = `<div class="card card-body mt"><div class="card-title">Your Telegram bot ${st.realApi === false ? '<span class="badge badge-err">not Telegram (TELEGRAM_API_BASE)</span>' : ""}</div>
        ${rows}
        <div class="provider-actions" style="margin-top:6px">
          <button class="btn btn-primary" onclick="openTelegramAccount()">＋ Connect a bot</button>
          <button class="btn btn-ghost" onclick="telegramTest()">🧪 Run connection test</button>
          <a class="btn btn-ghost" href="#/telegram">Full Telegram console →</a>
        </div>
      </div>`;
  };

  window.telegramRepair = async (id) => {
    try {
      await api(`/integrations/telegram/accounts/${id}`, { method: "PATCH", body: { pair: true } });
      toast("New pairing code issued", "Send /pair <code> to your bot to link a chat.", "ok");
      refreshCurrent();
    } catch (e) { toast("Could not re-pair", e.message, "err"); }
  };

  window.telegramTest = async () => {
    const btn = document.activeElement;
    if (btn) btn.disabled = true;
    try {
      const t = await api("/integrations/telegram/test");
      const icon = (st) => st === "pass" ? "✅" : st === "fail" ? "❌" : "⏭️";
      const rows = (t.steps || []).map((st) => `<div class="card card-body" style="margin-bottom:8px;padding:8px 10px">
          <div class="card-title" style="font-size:12px">${icon(st.status)} ${esc(st.label)}</div>
          ${st.detail ? `<div class="field-hint" style="font-size:11px">${esc(st.detail)}</div>` : ""}
          ${st.action ? `<div style="margin-top:6px;font-size:11.5px;color:var(--text)">👉 ${esc(st.action)}</div>` : ""}
        </div>`).join("");
      const verdictBadge = t.verdict === "ready" ? '<span class="badge badge-ok">ready</span>' : t.verdict === "degraded" ? '<span class="badge badge-warn">needs attention</span>' : '<span class="badge badge-err">blocked</span>';
      openModal(`Telegram connection test ${verdictBadge}`, `
        <p style="font-size:12px;color:var(--text-muted)">${esc(t.summary)} · transport: <span class="mono">${esc(t.transport)}</span> (mode ${esc(t.mode)})</p>
        <div style="max-height:56vh;overflow:auto">${rows}</div>
        <div class="provider-actions">
          <button class="btn" onclick="telegramTransport('polling')">📡 Switch to long polling</button>
          <button class="btn" onclick="telegramTransport('webhook')">🔗 Re-register webhook</button>
          <button class="btn btn-ghost" onclick="telegramTest()">↻ Run again</button>
        </div>`);
    } catch (e) { toast("Connection test failed", e.message, "err"); }
    finally { if (btn) btn.disabled = false; }
  };
  window.telegramTransport = async (mode) => {
    try {
      const r = await api("/integrations/telegram/transport", { method: "POST", body: { mode } });
      // A requested mode that could not come up is a warning with the reason, not a success.
      toast(r.ok ? "Telegram transport updated" : "Could not switch transport", r.message || `now ${r.transport}`, r.ok ? (r.transport === "off" ? "warn" : "ok") : "err");
      refreshCurrent();
    } catch (e) { toast("Could not change transport", e.message, "err"); }
  };
  window.telegramDiagnostics = async () => {
    try {
      const d = await api("/integrations/telegram/diagnostics");
      openModal("Telegram diagnostics", `<pre style="white-space:pre-wrap;font-size:11px;max-height:60vh;overflow:auto">${esc(JSON.stringify(d, null, 2))}</pre>
        <div class="field-hint">Live from Telegram: getMe + getWebhookInfo + the local poller state.</div>`);
    } catch (e) { toast("Diagnostics failed", e.message, "err"); }
  };
  window.telegramAccountPoll = async (id, active) => {
    try {
      await api(`/integrations/telegram/accounts/${id}/transport`, { method: "POST", body: { transport: active ? "polling" : "webhook" } });
      toast(active ? "Long polling started" : "Switched back to webhook", "", "ok");
      refreshCurrent();
    } catch (e) { toast("Could not change the account transport", e.message, "err"); }
  };
  window.openTelegramAccount = async (editId) => {
    const existing = editId ? (await api("/integrations/telegram/accounts")).find((a) => a.id === editId) : null;
    openModal(editId ? "Edit Telegram bot" : "Connect Telegram bot", `
      <div class="field"><label>Bot token <span class="select-count">از @BotFather — رمزنگاری‌شده ذخیره می‌شود</span></label><input class="input mono" id="ta-token" type="password" placeholder="123456:ABC-DEF..." value=""/></div>
      <div class="field"><label>User ID <span class="select-count">آیدی عددی تلگرام شما (مثلاً 123456789) — فقط همین یوزر اجازه‌ی چت با بات را دارد</span></label><input class="input mono" id="ta-account" value="${esc(existing?.accountId || "")}" placeholder="123456789"/></div>
      <div class="field"><label>Label <span class="select-count">اختیاری</span></label><input class="input" id="ta-name" value="${esc(existing?.name || "")}" placeholder="My bot"/></div>
      <div class="field-hint">چت آیدی دیگر لازم نیست — بات به‌طور خودکار از آیدی عددی شما استفاده می‌کند و تنها به پیام‌های شما پاسخ می‌دهد.</div>
      <div class="flex"><button class="btn btn-primary" id="ta-go">${editId ? "Save & connect" : "Connect"}</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    $("#ta-go").onclick = async () => {
      const token = $("#ta-token").value.trim();
      if (!token && !editId) { toast("Bot token required", "", "err"); return; }
      const body = { token, accountId: $("#ta-account").value.trim(), name: $("#ta-name").value.trim() };
      try {
        const r = editId ? await api(`/integrations/telegram/accounts/${editId}`, { method: "PATCH", body }) : await api("/integrations/telegram/accounts", { method: "POST", body });
        if (r && r.warning) toast("Bot connected — but note", r.warning, "warn");
        if (r && r.pairing) toast("Now link your chat", r.pairing.howto, "warn");
        closeModal(); toast(editId ? "Bot updated" : "Bot connected", (r.account?.botUsername || r.botUsername || "Telegram bot") + (r.account?.webhookSet ? " · webhook set" : ""), r.account?.connected || r.connected ? "ok" : "warn"); refreshCurrent();
      } catch (e) { toast("Connection failed", e.message, "err"); }
    };
  };
  window.telegramConnect = async (id) => {
    try { await api(`/integrations/telegram/accounts/${id}/connect`, { method: "POST" }); toast("Bot connection refreshed", "", "ok"); refreshCurrent(); }
    catch (e) { toast("Connect failed", e.message, "err"); }
  };
  window.telegramDelete = async (id) => {
    if (!confirm("Delete this Telegram bot account?")) return;
    try { await api(`/integrations/telegram/accounts/${id}`, { method: "DELETE" }); toast("Bot deleted", "", "ok"); refreshCurrent(); }
    catch (e) { toast("Delete failed", e.message, "err"); }
  };

