  /* SETTINGS */
  // Settings doubles as the hub for every section that is NOT in the primary
  // nav (which is intentionally minimal: Chat / Project / Settings). Each entry
  // is a normal link to its own page — the pages themselves are unchanged.
  function settingsHubHtml() {
    const groups = [
      ["Workspace", [
        ["#/projects", "📁", "All projects", "Create, manage and open every project"],
        ["#/dashboard", "📊", "Dashboard", "Global run / spend / health overview"],
      ]],
      ["AI & agents", [
        ["#/agents", "🤖", "Agents", "Agent registry, prompts and per-agent models"],
        ["#/models", "🧠", "Models", "Model catalog, benchmarks and visibility"],
        ["#/providers", "🔌", "Providers", "Provider connections and keys"],
        ["#/skills", "🛠️", "Skills", "Skill templates"],
        ["#/workflows", "🔀", "Workflows", "Multi-step workflow engine"],
        ["#/memory", "🗂️", "Memory", "GitHub-backed memory entries"],
      ]],
      ["Execution & review", [
        ["#/tasks", "🧩", "Tasks", "Task queue and manual dispatch"],
        ["#/runs", "▶️", "Runs", "Run console — status, steps, evidence"],
        ["#/approvals", "🛑", "Approvals", "Approve / reject gated steps"],
        ["#/logs", "📜", "Logs", "Errors, audit trail and notifications"],
        ["#/conversations", "💬", "Conversations", "Conversation history list"],
      ]],
      ["Integrations & system", [
        ["#/github", "🐙", "GitHub", "GitHub OAuth and repositories"],
        ["#/telegram", "📱", "Telegram", "Telegram bots and pairing"],
        ["#/admin", "🛡️", "Admin", "Health, users, backup, storage"],
        ["#/search", "🔍", "Search", "Search across the whole platform"],
      ]],
    ];
    return `<div class="card card-body"><div class="card-title">All sections <span class="sub">everything that is not in the top menu lives here</span></div>
      <div class="settings-hub">${groups.map(([g, items]) => `<div class="settings-hub-group">
        <div class="settings-hub-label">${esc(g)}</div>
        <div class="settings-hub-grid">${items.map(([href, icon, label, hint]) =>
          `<a class="settings-hub-tile" href="${esc(href)}"><span class="sh-ico">${icon}</span><div><strong>${esc(label)}</strong><div class="sub">${esc(hint)}</div></div></a>`).join("")}
        </div>
      </div>`).join("")}</div></div>`;
  }
  on("/settings", async () => {
    const s = await api("/settings");
    const policy = await api("/settings/approval").catch(() => ({ autoApprove: true, timeoutMs: 900000, pending: 0 }));
    const backupAdmin = await api("/admin/backup").catch(() => null);
    $("#content").innerHTML = `${settingsHubHtml()}
      <div class="overview" style="margin-top:12px"><div><h1>Settings</h1><p>Import / Export / Backup — secrets are never exported in the settings-only file</p></div></div>
      <div class="grid-2">
        <div class="card card-body"><div class="card-title">Platform</div>
          <div class="meter-row"><span class="lbl">Environment</span><span class="val">${esc(s.environment)}</span></div>
          <div class="meter-row"><span class="lbl">Simulation</span><span class="val">${s.simulationMode}</span></div>
          <div class="meter-row"><span class="lbl">GitHub</span><span class="val">${s.githubConnected}</span></div>
          <div class="meter-row"><span class="lbl">Telegram</span><span class="val">${s.telegramConnected}</span></div>
          <div class="card-title mt">Approval policy</div>
          <label class="flex" style="gap:8px;align-items:center"><input type="checkbox" id="pol-auto" ${policy.autoApprove ? "checked" : ""}/> Auto-approve dangerous steps (dev / simulation)</label>
          <div class="field mt"><label>Wait for a human up to (minutes)</label><input class="input" id="pol-timeout" type="number" min="1" value="${Math.round((policy.timeoutMs || 900000) / 60000)}"/></div>
          <div class="flex"><button class="btn btn-primary" id="pol-save">Save policy</button><a class="btn" href="#/approvals">🛑 Approvals (${policy.pending || 0} pending)</a></div>
          <p style="color:var(--text-muted);font-size:12px">وقتی Auto-approve خاموش باشد، مرحله‌های خطرناک (Merge، Deploy، Migration…) متوقف می‌شوند و در وب و تلگرام دکمه Approve/Reject می‌گیرید.</p>
        </div>
        <div class="card card-body"><div class="card-title">Backup & Import/Export</div>
          <div class="flex">${backupAdmin ? '<button class="btn btn-primary" onclick="downloadFullBackup()">⬇ Full system backup</button>' : ''}<button class="btn" onclick="downloadBackup()">⬇ Login settings only</button><button class="btn" id="restore-btn">⬆ Restore backup file(s)</button><button class="btn" onclick="refreshCurrent()">Refresh</button><button class="btn btn-primary" onclick="location.hash='#/admin'">🛡️ Admin → System Backup</button></div>
          <input type="file" id="restore-file" accept="application/json,.json" multiple style="display:none"/>
          <p style="color:var(--text-muted);font-size:12px">ادمین می‌تواند از <strong>Full system backup</strong> یک فایل کامل بگیرد. ریستور از فایل کامل یا از همهٔ فایل‌های JSON یک پوشهٔ بکاپ (manifest، records، jobs و kv) پشتیبانی می‌کند؛ همهٔ فایل‌های یک snapshot را با هم انتخاب کنید. فایل «Login settings only» فقط تنظیمات ورود GitHub را دارد و بکاپ کامل داده‌های پروژه نیست.</p>
          <p style="color:var(--text-muted);font-size:11px">💡 بعد از ریستور کامل، تمام جدول‌های runtime جایگزین می‌شوند. مقادیر رمزنگاری‌شده فقط با همان <span class="mono">AUTH_SECRET</span> قابل‌خواندن‌اند. در Railway می‌توانید به‌جای ریستور مداوم، Volume پایدار هم وصل کنید.</p>
        </div>
      </div>
      <div id="tg-settings"></div>`;
    renderTelegramSettings();
    $("#pol-save").onclick = async () => {
      const next = await api("/settings/approval", { method: "POST", body: { autoApprove: $("#pol-auto").checked, timeoutMs: Math.max(1, Number($("#pol-timeout").value || 15)) * 60000 } });
      toast("Approval policy saved", next.autoApprove ? "auto-approve" : "human approval required", "ok");
    };
    const restoreBtn = $("#restore-btn");
    const restoreFile = $("#restore-file");
    if (restoreBtn && restoreFile) {
      restoreBtn.onclick = () => restoreFile.click();
      restoreFile.onchange = async () => {
        const files = [...(restoreFile.files || [])].filter((f) => /\.json$/i.test(f.name));
        restoreFile.value = "";
        if (!files.length) return;
        try {
          let body;
          if (files.length > 1 || /^(manifest|records(?:-\d+)?|jobs(?:-\d+)?|kv(?:-\d+)?)\.json$/i.test(files[0].name)) {
            if (!confirm("ریستور کامل، داده‌های فعلی runtime را جایگزین می‌کند. قبل از ادامه مطمئن شوید همهٔ فایل‌های JSON همین snapshot را انتخاب کرده‌اید.")) return;
            const snapshotFiles = await Promise.all(files.map(async (file) => ({ path: file.webkitRelativePath || file.name, content: await file.text() })));
            body = { snapshotFiles, replace: true };
          } else {
            const data = JSON.parse(await files[0].text());
            const fullSnapshot = data?.type === "codevia-runtime-backup" ||
              (Array.isArray(data?.records) && Array.isArray(data?.jobs) && Array.isArray(data?.kv)) ||
              (data?.snapshot && Array.isArray(data.snapshot.records));
            if (!fullSnapshot && data?.adminSettings && typeof data.adminSettings === "object") {
              if (!confirm("این فایل فقط تنظیمات ورود GitHub را جایگزین می‌کند و داده‌های پروژه را بازیابی نمی‌کند. ادامه می‌دهید؟")) return;
              await api("/settings/restore", { method: "POST", body: { adminSettings: data.adminSettings } });
              toast("Login settings restored", "این فایل تنظیمات ورود را برگرداند؛ داده‌های پروژه و تاریخچه در این نوع بکاپ وجود ندارد.", "ok");
              refreshCurrent();
              return;
            }
            if (!confirm("ریستور کامل، داده‌های فعلی runtime را جایگزین می‌کند. قبل از ادامه مطمئن شوید فایل بکاپ درست را انتخاب کرده‌اید.")) return;
            body = { snapshotData: data, replace: true };
          }
          const res = await api("/admin/backup/restore", { method: "POST", body });
          if (!res.ok) throw new Error(res.error || "Full restore failed");
          toast("Full backup restored", `${res.records} records, ${res.jobs} jobs, ${res.kv} kv restored${res.warning ? ` · ${res.warning}` : ""}`, res.warning ? "warn" : "ok");
          // The restore replaced the whole database — drop client caches and
          // re-render in place so nothing stale lingers (no page reload).
          setTimeout(() => { resetClientCaches(); refreshCurrent(); }, 700);
        } catch (e) {
          toast("Restore failed", e.message, "err");
        }
      };
    }
  });
  window.downloadBackup = async () => {
    const b = await api("/settings/backup");
    const blob = new Blob([JSON.stringify(b, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "codevia-login-settings-backup.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  window.downloadFullBackup = async () => {
    try {
      const snapshot = await api("/admin/backup/export");
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = "codevia-full-backup.json"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("Full system backup downloaded", `${snapshot.records?.length || 0} records, ${snapshot.jobs?.length || 0} jobs, ${snapshot.kv?.length || 0} kv`, "ok");
    } catch (e) {
      toast("Backup export failed", e.message, "err");
    }
  };

