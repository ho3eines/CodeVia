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
      <div class="overview" style="margin-top:12px"><div><h1>Settings</h1><p>Import / Export / Backup — یک فایل کامل از کل سیستم، همراه با کلیدهای API</p></div></div>
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
          <div class="flex">${backupAdmin ? '<button class="btn btn-primary" onclick="downloadFullBackup()">⬇ Full system backup (JSON)</button>' : ''}<button class="btn" onclick="downloadBackup()">⬇ Login settings only</button><button class="btn" id="restore-btn">⬆ Restore backup file(s)</button><button class="btn" onclick="refreshCurrent()">Refresh</button><button class="btn btn-primary" onclick="location.hash='#/admin'">🛡️ Admin → System Backup</button></div>
          <input type="file" id="restore-file" accept="application/json,.json" multiple style="display:none"/>
          ${backupAdmin?.secrets ? `<div class="field-hint ${backupAdmin.secrets.includeSecrets ? (backupAdmin.secrets.storedEncrypted ? "ok" : "warn") : ""}" style="margin-top:8px">🔑 ${esc(backupAdmin.secrets.hint || "")}</div>` : ""}
          ${backupAdmin?.local?.enabled ? `<div class="meter-row"><span class="lbl">Local copies</span><span class="val mono">${esc(backupAdmin.local.dir || "")}</span></div>` : ""}
          <p style="color:var(--text-muted);font-size:12px"><strong>Full system backup</strong> یک فایل JSON می‌سازد و دانلود می‌کند که <em>همه‌چیز</em> در آن است: پروژه‌ها، ایجنت‌ها، مدل‌ها و پرووایدرها، ورک‌فلوها، تسک/ران‌ها، کانورسیشن‌ها، مموری، کاربران، تلگرام، لاگ‌ها و تمام تنظیمات — به‌علاوهٔ <strong>کلیدهای API و توکن‌ها</strong> و کل متغیرهای محیطی. همان فایل را روی سرور دیگر با <strong>Restore backup file(s)</strong> آپلود کنید تا سیستم بدون هیچ تنظیم دستی بالا بیاید.</p>
          <p style="color:var(--text-muted);font-size:11px">💡 موقع ریستور، کلیدها با <span class="mono">AUTH_SECRET</span> همان سرور دوباره رمز می‌شوند و متغیرهای محیطی در <span class="mono">&lt;مسیر دیتابیس&gt;/.env</span> نوشته می‌شوند، پس بعد از restart هم باقی می‌مانند. ریستور از همهٔ فایل‌های JSON یک پوشهٔ بکاپ (manifest، records، jobs، kv و secrets) هم پشتیبانی می‌کند — همه را با هم انتخاب کنید. فایل «Login settings only» فقط تنظیمات ورود GitHub را دارد.</p>
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
            if (!confirm("ریستور کامل، داده‌های فعلی runtime را جایگزین می‌کند. قبل از ادامه مطمئن شوید همهٔ فایل‌های JSON همین snapshot (از جمله secrets.json) را انتخاب کرده‌اید.")) return;
            const snapshotFiles = await Promise.all(files.map(async (file) => ({ path: file.webkitRelativePath || file.name, content: await file.text() })));
            body = { snapshotFiles, replace: true };
            if (snapshotFiles.some((file) => /secrets\.enc\.json$/i.test(file.path))) {
              const passphrase = prompt("این بکاپ کلیدها را رمزنگاری‌شده نگه می‌دارد. BACKUP_PASSPHRASE زمان ساخت را وارد کنید:");
              if (!passphrase) return;
              body.passphrase = passphrase;
            }
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
            const carriesKeys = !!(data?.environment?.dbSecrets?.length || Object.keys(data?.environment?.env || {}).length || data?.environmentEnc);
            if (!confirm(`ریستور کامل، داده‌های فعلی runtime را جایگزین می‌کند${carriesKeys ? " و کلیدهای API/توکن‌های داخل فایل را روی این سرور فعال می‌کند" : ""}. ادامه می‌دهید؟`)) return;
            body = { snapshotData: data, replace: true };
            if (data?.environmentEnc) {
              const passphrase = prompt("این بکاپ کلیدها را رمزنگاری‌شده نگه می‌دارد. BACKUP_PASSPHRASE زمان ساخت را وارد کنید:");
              if (!passphrase) return;
              body.passphrase = passphrase;
            }
          }
          const res = await api("/admin/backup/restore", { method: "POST", body });
          if (!res.ok) throw new Error(res.error || "Full restore failed");
          const envNote = res.environment
            ? ` · 🔑 ${(res.environment.providers || 0) + (res.environment.telegramAccounts || 0) + (res.environment.githubTokens || 0)} credential(s), ${(res.environment.envApplied || []).length} env value(s) restored`
            : "";
          toast("Full backup restored", `${res.records} records, ${res.jobs} jobs, ${res.kv} kv restored${envNote}${res.warning ? ` · ${res.warning}` : ""}`, res.warning ? "warn" : "ok");
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
  /**
   * Download the complete installation as one JSON file — every runtime row plus
   * the environment and credentials, so the same file brings the platform up on
   * another server. `btn`/`label` are optional (the admin console passes them so
   * the button can show progress).
   */
  window.downloadFullBackup = async (btn, label) => {
    if (btn) { btn.disabled = true; btn.textContent = "Preparing…"; }
    try {
      const snapshot = await api("/admin/backup/download");
      const stamp = String(snapshot.createdAt || new Date().toISOString()).replace(/[:.]/g, "-");
      saveJsonBlob(snapshot, `codevia-full-backup-${stamp}.json`);
      const env = snapshot.environment || {};
      const keys = (env.dbSecrets || []).length;
      const envKeys = Object.keys(env.env || {}).length;
      toast(
        "Full system backup downloaded",
        `${snapshot.records?.length || 0} records, ${snapshot.jobs?.length || 0} jobs, ${snapshot.kv?.length || 0} kv` +
          (keys || envKeys ? ` · 🔑 ${keys} credential(s), ${envKeys} env value(s)` : " · no credentials included"),
        keys || envKeys ? "warn" : "ok",
      );
    } catch (e) {
      toast("Backup export failed", e.message, "err");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label || "⬇ Download"; }
    }
  };
  /** Download one snapshot that is stored on this server's volume. */
  window.downloadBackupSnapshot = async (id) => {
    try {
      const snapshot = await api(`/admin/backup/local/${encodeURIComponent(id)}/download`);
      saveJsonBlob(snapshot, `codevia-backup-${id}.json`);
      toast("Snapshot downloaded", id, "ok");
    } catch (e) {
      toast("Download failed", e.message, "err");
    }
  };
  /** Trigger a browser download for one JSON document. */
  function saveJsonBlob(document_, filename) {
    const blob = new Blob([JSON.stringify(document_, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

