  /* ADMIN */
  on("/admin", async () => {
    const h = await api("/admin/health");
    const usage = await api("/admin/usage");
    const adm = await api("/admin/settings").catch((e) => ({ _forbidden: e.message }));
    const users = await api("/admin/users").catch(() => null);
    const bak = await api("/admin/backup").catch(() => null);
    const diag = adm.github?.diagnostics || {};
    // Ephemeral-storage warning: when the DB is on container-local storage the
    // admin GitHub settings (and users/data) are wiped on every deploy — the
    // reason the user has to "fix the GitHub settings again" each time.
    const st = h.storage || {};
    const recipe = [
      "GITHUB_CLIENT_ID=" + (adm.github?.stored?.clientId || ""),
      "GITHUB_CLIENT_SECRET=<your OAuth App client secret>",
      "GITHUB_OAUTH_CALLBACK_URL=" + (adm.github?.redirectUri || ""),
      "PUBLIC_WEB_BASE_URL=" + String(adm.github?.redirectUri || "").replace(/\/auth\/github\/callback$/, ""),
      "AUTH_SECRET=<keep the SAME random 32+ chars you already set>",
      "REQUIRE_AUTH=" + (adm.github?.requireAuth ? "true" : "false"),
    ].join("\n");
    const bakS = bak?.settings || {};
    const bakEff = bak?.effective || {};
    const lastBadge = !bakS.lastRunStatus ? '<span class="badge badge-muted">never</span>'
      : bakS.lastRunStatus === "success" ? '<span class="badge badge-ok">success</span>'
      : bakS.lastRunStatus === "failed" ? '<span class="badge badge-err">failed</span>'
      : '<span class="badge badge-warn">running</span>';
    const bakCard = bak ? `<div class="card card-body mt" id="bak-config">
        <div class="card-title">🛡️ System Backup <span class="sub">ادمین فقط — پشتیبان کامل Railway به GitHub</span></div>
        <p style="font-size:11px;color:var(--text-muted);margin:6px 0">هر دور، کل دیتابیس (پروژه‌ها، مدل‌ها، پرووایدرها، ایجنت‌ها، اسکیل‌ها، ورک‌فلوها، تسک‌ها/ران‌ها، کانورسیشن‌ها، مموری، کاربران، تلگرام، تنظیمات و…) را به‌صورت فایل JSON داخل ریپازیتوری GitHub دلخواه push می‌کند. کلیدهای رمزنگاری‌شده مثل قبل stored می‌مانند و هرگز plaintext نمی‌شوند.</p>
        ${bak.github?.kind !== "real" ? `<div class="field-hint warn">⚠ ${esc(bak.github?.hint || "GitHub is not connected — backups will not reach a real repository.")}</div>` : ""}
        <div class="grid-2">
          <div>
            <div class="field"><label class="flex" style="align-items:center;gap:8px"><input type="checkbox" id="bak-enabled" ${bakS.enabled ? "checked" : ""}/> Enable scheduled backup</label></div>
            <div class="field"><label>GitHub repository (owner/name)</label><input class="input mono" id="bak-repo" placeholder="your-org/codevia-backups" value="${esc(bakS.repo || "")}"/></div>
            <div class="field"><label>Branch</label><input class="input mono" id="bak-branch" value="${esc(bakS.branch || "main")}"/></div>
            <div class="field"><label>Path in repo</label><input class="input mono" id="bak-path" value="${esc(bakS.path || ".codevia/backups")}"/></div>
          </div>
          <div>
            <div class="field"><label>Schedule preset</label><select class="select" id="bak-preset">
              <option value="">custom (cron below)</option>
              <option value="* * * * *">Every minute</option>
              <option value="*/5 * * * *">Every 5 minutes</option>
              <option value="0 * * * *">Every hour</option>
              <option value="0 0 * * *">Every day at 00:00</option>
              <option value="0 */12 * * *">Every 12 hours</option>
              <option value="0 0 * * 0">Weekly (Sunday)</option>
            </select></div>
            <div class="field"><label>Cron (minute hour day month weekday)</label><input class="input mono" id="bak-schedule" value="${esc(bakS.schedule || bakEff.schedule || "0 * * * *")}"/><div class="field-hint">مثال ساعتی: <span class="mono">0 * * * *</span> · روزانه ساعت ۰۳:۳۰ صبح: <span class="mono">30 3 * * *</span></div></div>
            <div class="field"><label>Keep listed snapshots</label><input class="input" id="bak-retain" type="number" min="1" max="500" value="${esc(String(bakS.retain || bakEff.retain || 30))}"/></div>
            <div class="meter-row"><span class="lbl">Next run</span><span class="val mono">${esc(bak.schedule?.nextRunAt || "—")}</span></div>
            <div class="meter-row"><span class="lbl">Last run</span><span class="val">${lastBadge} ${esc(bakS.lastRunAt || "")}</span></div>
            ${bakS.lastRunError ? `<div class="field-hint err">${esc(bakS.lastRunError)}</div>` : ""}
          </div>
        </div>
        <div class="flex mt" style="flex-wrap:wrap;gap:8px">
          <button class="btn btn-primary" id="bak-save">Save settings</button>
          <button class="btn" id="bak-run">▶ Run backup now</button>
          <button class="btn" id="bak-list">📋 List backups</button>
          <button class="btn" id="bak-export">⬇ Export JSON</button>
          <button class="btn btn-danger" id="bak-restore">↺ Restore latest</button>
        </div>
        <p style="font-size:11px;color:var(--text-muted);margin-top:8px">💡 برای بازیابی بعد از هر دیپلی Railway: یک سرویس تازه با همان <span class="mono">GITHUB_TOKEN</span> وصل کنید، در همین صفحه Save و Restore کنید. تنظیمات فقط توسط Owner/Admin دیده و تغییر می‌کند.</p>
        <div id="bak-result" style="margin-top:10px"></div>
      </div>` : `<div class="card card-body mt"><div class="card-title">System Backup</div><p style="color:var(--text-muted);font-size:12px">Admin backup settings are unavailable — the API returned no config.</p></div>`;
    const stepsHtml = adm.github?.setupSteps ? `<ol style="font-size:12px;color:var(--text-muted);margin:8px 0 0 18px;text-align:left">${adm.github.setupSteps.map(s=>`<li>${esc(s)}</li>`).join("")}</ol>` : "";
    const mismatchWarn = diag.callbackUrlMismatchRisk ? `<p style="color:var(--warn, #d97706);font-size:11px">⚠️ Callback URL mismatch risk — check GitHub OAuth App settings.</p>` : "";
    /** Bind the GitHub-login modal controls (save / test / diagnose). */
    function wireAdminGithub() {
      const ghSave = document.getElementById("adm-gh-save");
      if (ghSave) ghSave.onclick = async () => {
        const btn = ghSave; btn.disabled = true; btn.textContent = "Saving…";
        try {
          const res = await api("/admin/settings/github", { method: "PUT", body: {
            clientId: document.getElementById("adm-gh-client").value,
            callbackUrl: document.getElementById("adm-gh-callback").value,
            scope: document.getElementById("adm-gh-scope").value,
            requireAuth: document.getElementById("adm-gh-require").checked,
          }});
          toast("GitHub login settings saved", res.effective?.configured ? "✓ Configured — now set env secrets if missing and redeploy" : (res.effective?.setupHint || ""), res.effective?.configured ? "ok" : "warn");
          const diagEl = document.getElementById("adm-gh-result");
          if (diagEl) {
            if (res.effective?.configured) {
              diagEl.innerHTML = `<div class="notice ok"><strong style="color:var(--ok)">✓ Saved and configured</strong><p style="font-size:11px;margin:6px 0 0">Callback: <span class="mono">${esc(res.effective.redirectUri||"")}</span></p><p style="font-size:11px;margin:4px 0 0">اگر Client Secret یا AUTH_SECRET هنوز missing است، آنها را در env تنظیم و Redeploy کنید.</p><a class="btn btn-primary" href="/auth/github/login" style="margin-top:8px">Test login now</a></div>`;
            } else {
              diagEl.innerHTML = `<div class="notice err"><strong style="color:var(--err)">Saved but still not configured</strong><p style="font-size:11px;margin:6px 0 0">${esc(res.effective?.setupHint||"")}</p>${res.effective?.setupSteps ? `<ol style="font-size:11px;margin:6px 0 0 16px">${res.effective.setupSteps.map(s=>`<li>${esc(s)}</li>`).join("")}</ol>` : ""}</div>`;
            }
          }
          setTimeout(refreshCurrent, 1500);
        } catch (e) {
          const diagEl = document.getElementById("adm-gh-result");
          if (diagEl) diagEl.innerHTML = `<div class="notice err">${esc(e.message||"Save failed")}${e.body?.setupSteps ? `<ol style="margin:6px 0 0 16px">${e.body.setupSteps.map(s=>`<li>${esc(s)}</li>`).join("")}</ol>` : ""}</div>`;
          toast("Save failed", e.message, "err");
        } finally { btn.disabled = false; btn.textContent = "Save"; }
      };
      const testBtn = document.getElementById("adm-gh-test");
      if (testBtn) testBtn.onclick = async () => {
        const el = document.getElementById("adm-gh-result");
        if (el) el.innerHTML = "Testing…";
        const r = await apiRaw("/auth/github/login?format=json");
        if (el) {
          if (r.ok) {
            el.innerHTML = `<div class="notice ok"><strong style="color:var(--ok)">✓ Ready — GitHub login URL works</strong><p style="font-size:11px;margin:6px 0 0;word-break:break-all" class="mono">${esc(r.body?.url||"")}</p><a class="btn btn-primary" href="${esc(r.body?.url||"/auth/github/login")}" style="margin-top:8px">Go to GitHub login</a></div>`;
          } else {
            const b = r.body || {};
            el.innerHTML = `<div class="notice err"><strong style="color:var(--err)">${esc(b.error||"Not configured")}</strong><p style="font-size:11px;margin:6px 0 0">${esc(b.hint||"")}</p>${b.setupSteps ? `<ol style="font-size:11px;margin:6px 0 0 16px">${b.setupSteps.map(s=>`<li>${esc(s)}</li>`).join("")}</ol>` : ""}${b.diagnostics ? `<pre style="margin-top:6px;font-size:10px;white-space:pre-wrap;background:var(--glass);padding:6px;border-radius:6px">${esc(JSON.stringify(b.diagnostics,null,2))}</pre>` : ""}</div>`;
          }
        }
      };
      const diagBtn = document.getElementById("adm-gh-diag");
      if (diagBtn) diagBtn.onclick = async () => {
        const el = document.getElementById("adm-gh-result");
        if (!el) return;
        el.innerHTML = "Loading diagnostics…";
        const s = await api("/auth/github/status").catch(()=>null);
        const a = await api("/admin/settings").catch(()=>null);
        if (el) el.innerHTML = `<pre style="white-space:pre-wrap;font-size:11px;background:var(--glass);padding:10px;border-radius:8px;border:1px solid var(--border)">${esc(JSON.stringify({ status:s, admin:a?.github }, null, 2))}</pre>`;
      };
    }
    /** Bind the per-user role save buttons in the Users modal. */
    function wireAdminUsers() {
      $$("[data-save-role]").forEach((btn) => btn.addEventListener("click", async () => {
        const id = btn.dataset.saveRole;
        const role = document.querySelector(`[data-role-for="${id}"]`).value;
        try {
          await api(`/admin/users/${id}/role`, { method: "PATCH", body: { role } });
          toast("Role updated", role, "ok"); refreshCurrent();
        } catch (e) { toast("Update failed", e.message, "err"); }
      }));
    }
    /** Bind the "copy env variables" button in the Storage modal. */
    function wireAdminEnvCopy() {
      const envCopy = document.getElementById("env-copy-btn");
      if (envCopy) envCopy.onclick = async () => {
        const txt = document.getElementById("env-recipe")?.textContent || "";
        try {
          await navigator.clipboard.writeText(txt);
          toast("Copied", "Paste the variables into Railway → Variables.", "ok");
        } catch (_) {
          toast("Copy failed", "Select and copy the text manually.", "err");
        }
      };
      // ---- System Backup admin controls ----
    }
    /** Bind every control in the Backup & restore modal. */
    function wireAdminBackup() {
      const bakResult = (html) => {
        const el = document.getElementById("bak-result");
        if (el) el.innerHTML = html || "";
      };
      const bakPreset = document.getElementById("bak-preset");
      if (bakPreset) bakPreset.onchange = () => {
        if (bakPreset.value) {
          const s = document.getElementById("bak-schedule");
          if (s) s.value = bakPreset.value;
        }
      };
      const bakSave = document.getElementById("bak-save");
      if (bakSave) bakSave.onclick = async () => {
        const btn = bakSave; btn.disabled = true; btn.textContent = "Saving…";
        try {
          const r = await api("/admin/backup", { method: "PUT", body: {
            enabled: document.getElementById("bak-enabled").checked,
            repo: document.getElementById("bak-repo").value.trim(),
            branch: document.getElementById("bak-branch").value.trim() || "main",
            path: document.getElementById("bak-path").value.trim(),
            schedule: document.getElementById("bak-schedule").value.trim(),
            retain: Number(document.getElementById("bak-retain").value) || 30,
          }});
          toast("Backup settings saved", r.effective?.repo ? "Scheduled and ready." : "Backup repository not set yet.", "ok");
          bakResult(`<div class="field-hint ok">✓ ${esc(r.effective?.repo || "Configured")} · branch ${esc(r.effective?.branch || "")} · cron ${esc(r.effective?.schedule || "")}</div>`);
          setTimeout(refreshCurrent, 800);
        } catch (e) {
          bakResult(`<div class="field-hint err">${esc(e.message)}</div>`);
          toast("Save failed", e.message, "err");
        } finally { btn.disabled = false; btn.textContent = "Save settings"; }
      };
      const bakRun = document.getElementById("bak-run");
      if (bakRun) bakRun.onclick = async () => {
        const btn = bakRun; btn.disabled = true; btn.textContent = "Backing up…";
        bakResult(`<div class="field-hint">Backing up to GitHub…</div>`);
        try {
          const r = await api("/admin/backup/run", { method: "POST", body: {} });
          if (r.ok) {
            bakResult(`<div class="field-hint ok">✓ Backup pushed · commit ${esc(r.commit || "")} · ${esc(r.files || 0)} files · ${esc(String(r.bytes || 0))} bytes\n${r.warning ? esc(r.warning) : ""}</div>`);
            toast("Backup complete", r.commit || "", "ok");
          } else {
            bakResult(`<div class="field-hint err">${esc(r.error || r.warning || "Backup failed")}</div>`);
            toast("Backup failed", r.error || r.warning || "", "err");
          }
        } catch (e) { bakResult(`<div class="field-hint err">${esc(e.message)}</div>`); toast("Backup failed", e.message, "err"); }
        finally { btn.disabled = false; btn.textContent = "▶ Run backup now"; }
      };
      const bakList = document.getElementById("bak-list");
      if (bakList) bakList.onclick = async () => {
        const btn = bakList; btn.disabled = true; btn.textContent = "Loading…";
        try {
          const r = await api("/admin/backup/list");
          const rows = (r.backups || []).map((b) => `<tr><td>${b.latest ? '<span class="badge badge-ok">latest</span>' : ""} <span class="mono">${esc(b.id)}</span></td><td class="mono">${esc(b.createdAt)}</td><td>${b.records}</td><td>${b.jobs}</td><td>${b.kv}</td><td><button class="btn btn-ghost" data-backup-snapshot="${esc(b.id)}">Restore</button></td></tr>`).join("");
          bakResult(rows ? `<div class="table-wrap"><table><thead><tr><th>Snapshot</th><th>Created</th><th>Records</th><th>Jobs</th><th>KV</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="field-hint">No backups found in ${esc(r.configured ? "the configured repository" : "a configured repository")}.</div>`);
          document.querySelectorAll("[data-backup-snapshot]").forEach((b) => b.onclick = async () => {
            const id = b.dataset.backupSnapshot;
            if (!confirm(`Restore snapshot ${id}? This replaces the full runtime state.`)) return;
            try {
              const res = await api("/admin/backup/restore", { method: "POST", body: { snapshot: id, replace: true } });
              if (res.ok) { toast("Backup restored", `${res.records} records restored`, "ok"); setTimeout(() => { resetClientCaches(); refreshCurrent(); }, 700); }
              else toast("Restore failed", res.error || "", "err");
            } catch (e) { toast("Restore failed", e.message, "err"); }
          });
        } catch (e) { bakResult(`<div class="field-hint err">${esc(e.message)}</div>`); toast("List failed", e.message, "err"); }
        finally { btn.disabled = false; btn.textContent = "📋 List backups"; }
      };
      const bakExport = document.getElementById("bak-export");
      if (bakExport) bakExport.onclick = async () => {
        try {
          const b = await api("/admin/backup/export");
          const blob = new Blob([JSON.stringify(b, null, 2)], { type: "application/json" });
          const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "codevia-full-backup.json"; a.click();
        } catch (e) { toast("Export failed", e.message, "err"); }
      };
      const bakRestore = document.getElementById("bak-restore");
      if (bakRestore) bakRestore.onclick = async () => {
        if (!confirm("Restore the latest backup from GitHub? This replaces the full runtime database.")) return;
        const btn = bakRestore; btn.disabled = true; btn.textContent = "Restoring…";
        try {
          const res = await api("/admin/backup/restore", { method: "POST", body: { replace: true } });
          if (res.ok) { toast("Backup restored", `${res.records} records, ${res.jobs} jobs, ${res.kv} kv restored`, "ok"); setTimeout(() => { resetClientCaches(); refreshCurrent(); }, 700); }
          else toast("Restore failed", res.error || "", "err");
        } catch (e) { toast("Restore failed", e.message, "err"); }
        finally { btn.disabled = false; btn.textContent = "↺ Restore latest"; }
      };
    }

    // ---- derived health signals for the admin console ----
    const comps = [
      { key: "API", ok: true, detail: h.api.status },
      { key: "Database", ok: h.database.status === "healthy", detail: h.database.status },
      { key: "Queue", ok: h.queue.status !== "down", detail: h.queue.status },
      { key: "GitHub", ok: h.github.status === "connected", detail: h.github.status },
      { key: "Telegram", ok: h.telegram.status === "connected", detail: h.telegram.status },
      { key: "Storage", ok: !st.warning, detail: st.warning ? "ephemeral" : "persistent" },
    ];
    const healthScore = Math.round((comps.filter((c) => c.ok).length / comps.length) * 100);
    const queueSegments = Object.entries(h.queue)
      .filter(([k, v]) => typeof v === "number")
      .map(([label, value], i) => ({ label, value, color: ["#60a5fa", "#34d399", "#fbbf24", "#fb7185", "#8990b5"][i % 5] }));
    const adminTile = (id, icon, title, desc, foot) => `<button class="admin-tile" onclick="adminOpen('${id}')">
      <span class="tile-ico">${icon}</span><strong>${esc(title)}</strong><p>${esc(desc)}</p><div class="tile-foot">${foot || ""}</div></button>`;

    $("#content").innerHTML = `<div class="overview">
        <div><h1>Admin Console</h1><p>System health, usage, access control and disaster recovery — everything operational in one place.</p></div>
        <div class="action-row">
          <button class="btn" onclick="refreshCurrent()">↻ Refresh</button>
          <button class="btn btn-primary" onclick="adminOpen('backup')">🛡️ Backup &amp; restore</button>
        </div>
      </div>

      <div class="admin-hero">
        <div class="card card-body">
          <div class="card-title">System health <span class="sub">${comps.filter((c) => c.ok).length}/${comps.length} components healthy</span></div>
          <div class="health-ring-row">
            ${gaugeRing(healthScore, { label: healthScore === 100 ? "all good" : "degraded" })}
            <div class="health-ring-info">
              <div class="status-grid">
                ${comps.map((c) => `<div class="status-item"><span class="status-dot ${c.ok ? "healthy" : "warn"}"></span>${esc(c.key)}<div class="mono" style="font-size:10px;color:var(--text-muted)">${esc(String(c.detail))}</div></div>`).join("")}
              </div>
            </div>
          </div>
        </div>
        <div class="card card-body">
          <div class="card-title">Queue depth</div>
          ${donutChart(queueSegments, { centerValue: queueSegments.reduce((s, x) => s + x.value, 0), centerLabel: "jobs", size: 150 })}
        </div>
      </div>

      ${st.warning ? `<div class="notice warn">
        <h4>⚠️ Ephemeral storage — settings are wiped on every redeploy</h4>
        <p>The database lives on the container filesystem (<span class="mono">${esc(st.dir || h.database.path)}</span>). Attach a persistent volume, or store the variables below in your host's environment.</p>
        <div class="flex mt"><button class="btn" onclick="adminOpen('storage')">Show the fix</button></div>
      </div>` : ""}

      <div class="section-title">Platform totals</div>
      <div class="stat-grid">
        <div class="card stat"><span class="stat-icon">📁</span><div class="stat-label">Projects</div><div class="stat-value">${usage.projects}</div><div class="stat-sub">${usage.agents} agents</div></div>
        <div class="card stat"><span class="stat-icon">🧠</span><div class="stat-label">Models</div><div class="stat-value">${usage.models}</div><div class="stat-sub">${h.providers.length} providers</div></div>
        <div class="card stat"><span class="stat-icon">▶️</span><div class="stat-label">Runs</div><div class="stat-value">${usage.runs}</div><div class="stat-sub">${usage.tasks} tasks</div></div>
        <div class="card stat"><span class="stat-icon">💰</span><div class="stat-label">Spend</div><div class="stat-value">${money(usage.costs.costUsd)}</div><div class="stat-sub">${usage.costs.calls} calls · ${(usage.costs.tokens / 1000).toFixed(1)}k tokens</div></div>
      </div>

      <div class="section-title">Administration</div>
      <div class="admin-tile-grid">
        ${adminTile("health", "💚", "Health & diagnostics", "Component status, queue breakdown and raw health payload.", `<span class="badge badge-${healthScore === 100 ? "ok" : "warn"}">${healthScore}% healthy</span>`)}
        ${adminTile("usage", "📊", "Usage & cost", "Token spend, call volume and platform inventory.", `<span class="badge badge-muted">${money(usage.costs.costUsd)}</span>`)}
        ${adminTile("auth", "🔐", "GitHub login", "OAuth client, callback URL, scopes and the strict-auth switch.", adm.github ? (adm.github.configured ? '<span class="badge badge-ok">configured</span>' : '<span class="badge badge-err">not configured</span>') : '<span class="badge badge-muted">restricted</span>')}
        ${adminTile("users", "👥", "Users & roles", "Grant owner, admin, developer, reviewer or viewer access.", users ? `<span class="badge badge-muted">${users.length} user(s)</span>` : '<span class="badge badge-muted">restricted</span>')}
        ${adminTile("backup", "🛡️", "Backup & restore", "Scheduled GitHub snapshots of the whole runtime state.", bak ? (bakS.enabled ? '<span class="badge badge-ok">scheduled</span>' : '<span class="badge badge-muted">off</span>') : '<span class="badge badge-muted">unavailable</span>')}
        ${adminTile("storage", "💾", "Storage", "Where the database lives and how to make it durable.", st.warning ? '<span class="badge badge-warn">ephemeral</span>' : '<span class="badge badge-ok">persistent</span>')}
      </div>`;

    /* Every admin area opens in a modal so the console stays a clean overview.
       The inner markup keeps the original element ids, so the handlers wired
       further below bind exactly as before. */
    window.adminOpen = (which) => {
      if (which === "health") {
        openModal("💚 Health & diagnostics", tabsHtml("admh", [
          { id: "comp", label: "Components", html: `<div class="card card-body"><div class="status-grid">
              ${comps.map((c) => `<div class="status-item"><span class="status-dot ${c.ok ? "healthy" : "warn"}"></span>${esc(c.key)}<div class="mono" style="font-size:10px;color:var(--text-muted)">${esc(String(c.detail))}</div></div>`).join("")}
            </div></div>` },
          { id: "queue", label: "Queue", html: `<div class="card card-body">${donutChart(queueSegments, { centerLabel: "jobs" })}
            ${Object.entries(h.queue).map(([k, v]) => `<div class="meter-row"><span class="lbl">${esc(k)}</span><span class="val">${esc(String(v))}</span></div>`).join("")}</div>` },
          { id: "raw", label: "Raw", html: `<pre style="max-height:50vh;overflow:auto">${esc(JSON.stringify(h, null, 2))}</pre>` },
        ]), { wide: true });
        return;
      }
      if (which === "usage") {
        openModal("📊 Usage & cost", `<div class="card card-body">
            <div class="kpi-row">
              <div class="kpi"><b>${usage.projects}</b><span>projects</span></div>
              <div class="kpi"><b>${usage.agents}</b><span>agents</span></div>
              <div class="kpi"><b>${usage.models}</b><span>models</span></div>
              <div class="kpi"><b>${usage.skills}</b><span>skills</span></div>
              <div class="kpi"><b>${usage.tasks}</b><span>tasks</span></div>
              <div class="kpi"><b>${usage.runs}</b><span>runs</span></div>
            </div>
          </div>
          <div class="card card-body mt"><div class="card-title">Inventory</div>
            ${barChart([
              { label: "projects", value: usage.projects }, { label: "agents", value: usage.agents },
              { label: "models", value: usage.models }, { label: "skills", value: usage.skills },
              { label: "tasks", value: usage.tasks }, { label: "runs", value: usage.runs },
            ], { width: 620 })}
          </div>
          <div class="card card-body mt"><div class="card-title">Model spend</div>
            <div class="meter-row"><span class="lbl">Calls</span><span class="val">${usage.costs.calls}</span></div>
            <div class="meter-row"><span class="lbl">Tokens</span><span class="val">${usage.costs.tokens.toLocaleString()}</span></div>
            <div class="meter-row"><span class="lbl">Cost</span><span class="val">${money(usage.costs.costUsd)}</span></div>
          </div>`, { wide: true });
        return;
      }
      if (which === "auth") {
        openModal("🔐 GitHub login", `<div class="admin-modal-body">
        <div class="card card-body"><div class="card-title">GitHub Login ${adm.github ? (adm.github.configured ? '<span class="badge badge-ok">configured ✓</span>' : '<span class="badge badge-warn">not configured ✗</span>') : ''}</div>
          ${adm._forbidden ? `<p style="color:var(--text-muted);font-size:12px">Login settings are visible to owners/admins only (${esc(adm._forbidden)}).</p>` : `
          ${adm.github?.configured ? `<div class="notice ok"><strong style="color:var(--ok)">✓ GitHub login is configured</strong><p style="font-size:11px;color:var(--text-muted);margin:4px 0 0">Callback: <span class="mono">${esc(adm.github.redirectUri||"")}</span></p></div>` : `<div class="notice err"><strong style="color:var(--err)">✗ GitHub login not ready</strong>${adm.github?.setupHint ? `<p style="font-size:12px;color:var(--err);margin:6px 0 0">${esc(adm.github.setupHint)}</p>` : ""}${stepsHtml}${mismatchWarn}</div>`}
          <div class="field"><label>OAuth Client ID ${adm.github?.clientIdSource === "env" ? '<span class="badge badge-muted">env</span>' : adm.github?.clientIdSource === "admin" ? '<span class="badge badge-info">admin</span>' : ""}</label>
            <input class="input mono" id="adm-gh-client" placeholder="Iv1.… / Ov23.…" value="${esc(adm.github?.stored?.clientId || "")}" ${adm.github?.envOverrides?.clientId ? "disabled" : ""}/>
            ${adm.github?.envOverrides?.clientId ? `<p style="color:var(--text-muted);font-size:11px">Set via GITHUB_CLIENT_ID env — effective: <span class="mono">${esc(adm.github.clientId || "")}</span></p>` : adm.github?.clientId ? `<p style="color:var(--text-muted);font-size:11px">Effective: <span class="mono">${esc(adm.github.clientId)}</span> <span class="badge badge-muted">${esc(adm.github.clientIdSource||"")}</span></p>` : `<p style="color:var(--warn, #d97706);font-size:11px">⚠️ خالی است — Client ID را از GitHub OAuth App کپی کنید (مثال: Ov23liXXXXXXXX)</p>`}</div>
          <div class="field"><label>Callback URL (optional) ${adm.github?.redirectUriSource === "env" ? '<span class="badge badge-muted">env</span>' : adm.github?.redirectUriSource === "admin" ? '<span class="badge badge-info">admin</span>' : ""}</label>
            <input class="input mono" id="adm-gh-callback" placeholder="(auto) ${esc(adm.github?.redirectUri || "")}" value="${esc(adm.github?.stored?.callbackUrl || "")}" ${adm.github?.envOverrides?.callbackUrl ? "disabled" : ""}/>
            <p style="color:var(--text-muted);font-size:11px">باید دقیقا با <span class="mono">Authorization callback URL</span> در GitHub OAuth App برابر باشد: <span class="mono">${esc(adm.github?.redirectUri || "")}</span></p></div>
          <div class="field"><label>Scope ${adm.github?.scopeSource === "env" ? '<span class="badge badge-muted">env</span>' : adm.github?.scopeSource === "admin" ? '<span class="badge badge-info">admin</span>' : ""}</label>
            <input class="input mono" id="adm-gh-scope" value="${esc(adm.github?.stored?.scope || adm.github?.scope || "")}" placeholder="repo read:user user:email"/></div>
          <div class="field"><label class="flex" style="align-items:center;gap:8px"><input type="checkbox" id="adm-gh-require" ${adm.github?.requireAuth ? "checked" : ""}/> Require GitHub login for API ${adm.github?.requireAuthSource === "env" ? '<span class="badge badge-muted">env</span>' : '<span class="badge badge-info">admin</span>'}</label>
            <p style="color:var(--text-muted);font-size:11px">اگر روشن باشد، همه APIها بدون لاگین 401 می‌دهند. فقط وقتی لاگین سالم شد روشن کنید.</p></div>
          <div style="background:var(--glass);border:1px solid var(--border);border-radius:8px;padding:10px;margin:10px 0">
            <div class="meter-row"><span class="lbl">Client ID</span><span class="val">${adm.github?.clientId ? '<span class="badge badge-ok">set</span>' : '<span class="badge badge-err">missing</span>'}</span></div>
            <div class="meter-row"><span class="lbl">Client Secret</span><span class="val">${adm.github?.clientSecretConfigured ? '<span class="badge badge-ok">set (env)</span>' : '<span class="badge badge-err">missing — set GITHUB_CLIENT_SECRET in env</span>'}</span></div>
            <div class="meter-row"><span class="lbl">Session Secret</span><span class="val">${adm.github?.secrets?.authSecret ? '<span class="badge badge-ok">set</span>' : '<span class="badge badge-err">missing — set AUTH_SECRET</span>'}</span></div>
            <div class="meter-row"><span class="lbl">GitHub Token</span><span class="val">${adm.github?.secrets?.githubToken ? '<span class="badge badge-ok">set</span>' : '<span class="badge badge-muted">not set (optional)</span>'}</span></div>
            <div class="meter-row"><span class="lbl">Webhook Secret</span><span class="val">${adm.github?.secrets?.githubWebhookSecret ? '<span class="badge badge-ok">set</span>' : '<span class="badge badge-muted">not set</span>'}</span></div>
          </div>
          ${adm.github && !adm.github.configured ? `<div class="notice warn"><p style="font-size:12px;margin:0"><strong>چرا بعد از ذخیره هنوز خطا می‌دهد؟</strong></p><p style="font-size:11px;color:var(--text-muted);margin:6px 0 0">ذخیره Client ID فقط نیمی از کار است. باید <span class="mono">GITHUB_CLIENT_SECRET</span> و <span class="mono">AUTH_SECRET</span> را هم در محیط (Railway Variables یا .env) تنظیم کنید و سرویس را <strong>Redeploy / Restart</strong> کنید. این مقادیر هرگز در دیتابیس ذخیره نمی‌شوند و فقط از env خوانده می‌شوند.</p><p style="font-size:11px;margin:6px 0 0"><strong>Railway:</strong> Service → Variables → New Variable → GITHUB_CLIENT_SECRET=… , AUTH_SECRET=… (مثال: <span class="mono">openssl rand -hex 32</span>) → Redeploy</p><p style="font-size:11px;margin:6px 0 0"><strong>Local:</strong> در <span class="mono">.env</span> اضافه کنید سپس <span class="mono">docker compose up --build</span> یا <span class="mono">npm run dev</span></p></div>` : ""}
          <p style="color:var(--text-muted);font-size:11px">Secrets live in environment variables only and are never stored here. Empty fields follow env/defaults.</p>
          <div class="flex mt" style="gap:8px;flex-wrap:wrap"><button class="btn btn-primary" id="adm-gh-save">Save</button><button class="btn" id="adm-gh-test">Test login</button><button class="btn btn-ghost" id="adm-gh-diag">Diagnose</button></div>
          <div id="adm-gh-result" style="margin-top:10px"></div>`}
        </div>
        </div>`, { wide: true });
        wireAdminGithub();
        return;
      }
      if (which === "users") {
        openModal("👥 Users & roles", `
        <div class="card card-body"><div class="card-title">Users ${users ? `(${users.length})` : ""}</div>
          ${users ? `<div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th></th></tr></thead><tbody>
            ${users.map((u) => `<tr><td>${u.avatarUrl ? `<img src="${esc(u.avatarUrl)}" alt="" style="width:20px;height:20px;border-radius:50%;vertical-align:-5px;margin-right:6px"/>` : ""}<strong>${esc(u.name)}</strong><div class="mono" style="color:var(--text-muted);font-size:11px">${esc(u.email || "")} · ${esc(u.externalId)}</div></td>
            <td><select class="select" data-role-for="${u.id}" style="max-width:130px">${["owner", "admin", "developer", "reviewer", "viewer"].map((r) => `<option value="${r}" ${u.role === r ? "selected" : ""}>${r}</option>`).join("")}</select></td>
            <td><button class="btn btn-ghost" data-save-role="${u.id}">Save</button></td></tr>`).join("")}
          </tbody></table></div>` : `<p style="color:var(--text-muted);font-size:12px">User management is visible to owners/admins only.</p>`}
        </div>
        `, { wide: true });
        wireAdminUsers();
        return;
      }
      if (which === "storage") {
        openModal("💾 Storage", `
          <div class="notice ${st.warning ? "warn" : "ok"}">
            <h4>${st.warning ? "⚠️ Ephemeral storage" : "✓ Persistent storage"}</h4>
            <p>Database path: <span class="mono">${esc(st.dir || h.database.path || "")}</span></p>
            ${st.warning ? `<p>Every redeploy starts a fresh container, so GitHub login settings, users and data are lost. Attach a volume mounted at <span class="mono">${esc(st.dir || "/app/data")}</span>, or set these variables in your host environment:</p>
            <pre id="env-recipe">${esc(recipe)}</pre>
            <div class="flex"><button class="btn" id="env-copy-btn">📋 Copy variables</button></div>` : `<p>Data survives restarts and redeploys.</p>`}
          </div>`, { wide: true });
        wireAdminEnvCopy();
        return;
      }
      if (which === "backup") {
        openModal("🛡️ Backup & restore", bakCard, { wide: true });
        wireAdminBackup();
      }
    };
  });

