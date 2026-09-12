  /* CONVERSATIONS */
  on("/conversations", async () => {
    const list = asArray(await api("/conversations"));
    $("#content").innerHTML = `<div class="overview"><div><h1>Conversations</h1><p>Chat history — standalone and project-connected, with auto-summarization</p></div></div>
      ${searchPanelHtml("conversation-search", "Search conversations by title, project, source, message text or updated time…")}
      <div class="card card-body"><div class="table-wrap"><table><thead><tr><th>Title</th><th>Project</th><th>Source</th><th>Messages</th><th>Updated</th><th></th></tr></thead><tbody id="conversation-tbody"></tbody></table></div></div>`;
    bindSearchPanel("conversation-search", list, conversationRows, "#conversation-tbody", "conversation", { emptyHtml: () => `<tr><td colspan="6">${emptyState("🔎", "No matching conversations", "Try searching by title, project, source or message content.")}</td></tr>` });
  });
  function conversationRows(list) {
    return list.map((c) => `<tr><td><a href="#/conversations/${c.id}"><strong>${esc(c.title)}</strong></a>${c.summary ? `<div class="sub">${esc(c.summary.slice(0,100))}</div>` : ""}</td><td class="mono">${(c.projectId||"—").slice(0,12)}</td><td>${esc(c.source)}</td><td>${asArray(c.messages).length}</td><td>${timeAgo(c.updatedAt)}</td><td style="white-space:nowrap"><a class="btn btn-ghost" href="#/conversations/${esc(c.id)}">Open</a><button class="btn btn-ghost" title="Delete conversation" onclick="conversationDelete(${esc(JSON.stringify(c.id))})">🗑</button></td></tr>`).join("");
  }

  /* CONVERSATION DETAIL (full-page chat view) */
  on("/conversations/:id", async (rest) => {
    const id = rest[0];
    const render = async (seed) => {
      const c = seed && seed.id ? seed : await api(`/conversations/${id}`);
      const msgs = asArray(c && c.messages);
      // Standalone chats show no project info at all — that lives in the project section.
      const projectBit = c.projectId ? `project ${esc(c.projectId.slice(0, 12))} · ` : "";
      const modelBit = esc(c.modelId || (c.projectId ? "project default" : "default"));
      const askPlaceholder = c.projectId ? "Ask anything about this project…" : "Ask anything…";
      const emptyText = c.projectId ? "💬 No messages yet — type below to start chatting with the project assistant." : "💬 No messages yet — type below to start chatting.";
      $("#content").innerHTML = `
        <div class="overview">
          <div>
            <div class="field-hint"><a href="#/conversations">← All conversations</a></div>
            <h1>💬 ${esc(c.title)}</h1>
            <p class="sub mono">${projectBit}source ${esc(c.source)} · ${msgs.length} message(s) · updated ${timeAgo(c.updatedAt)} · model ${modelBit}</p>
          </div>
          <div class="action-row">
            <button class="btn" id="cv-sum">📝 Summarize now</button>
            <button class="btn btn-danger" onclick="conversationDelete(${esc(JSON.stringify(c.id))}, true)">🗑 Delete</button>
          </div>
        </div>
        ${c.summary ? `<div class="card card-body"><div class="card-title">Context summary <span class="sub">auto-updates every 20 messages</span></div><pre class="mini-pre" dir="auto">${esc(c.summary)}</pre></div>` : ""}
        <div class="card card-body mt" style="padding:0">
          <div id="cv-messages" style="display:flex;flex-direction:column;gap:10px;padding:16px;max-height:65vh;overflow-y:auto;background:var(--bg,#0b0d17)">
            ${msgs.length ? msgs.map(msgBubble).join("") : `<div style="padding:60px 20px;text-align:center;color:var(--text-muted)">${emptyText}</div>`}
          </div>
          <div style="padding:12px 16px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:flex-end">
            <textarea id="cv-input" class="textarea" dir="auto" placeholder="${askPlaceholder}" style="flex:1;min-height:46px;max-height:200px;resize:vertical;margin:0"></textarea>
            <button class="btn btn-primary" id="cv-send" style="height:46px">Send ↵</button>
          </div>
          <div class="field-hint" style="padding:0 16px 12px">Enter sends · Shift+Enter for newline · last ${Math.min(msgs.length, 50)} messages visible to AI; older context is auto-summarized.</div>
        </div>`;
      setTimeout(() => { const box = $("#cv-messages"); if (box) box.scrollTop = box.scrollHeight; }, 30);
      const input = $("#cv-input");
      const sendBtn = $("#cv-send");
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
        const box = $("#cv-messages");
        sending = true;
        setSendBtn(true);
        input.value = "";
        // 1) The user's own message appears instantly — no waiting on the model.
        if (box && msgs.length === 0) box.innerHTML = "";
        if (box) {
          box.insertAdjacentHTML("beforeend", msgBubble({ role: "user", content, createdAt: new Date().toISOString() }));
          box.scrollTop = box.scrollHeight;
        }
        // 2) Typing placeholder while the reply streams in token by token.
        const uid = "cv-live-" + Date.now();
        if (box) {
          box.insertAdjacentHTML("beforeend", streamingBubbleHtml(uid));
          box.scrollTop = box.scrollHeight;
        }
        let finalConv = null;
        let gotEvent = false;
        streamAbort = new AbortController();
        try {
          await streamConversationSend(id, { role: "user", content }, {
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
          }, { signal: streamAbort.signal });
          // Authoritative re-render from the stored conversation.
          if (finalConv && finalConv.id) await render(finalConv);
          else {
            const fresh = await api(`/conversations/${id}`).catch(() => null);
            if (fresh && fresh.id) await render(fresh);
            else { document.getElementById(uid)?.remove(); sending = false; streamAbort = null; setSendBtn(false); return; }
          }
        } catch (e) {
          if (e && e.name === "AbortError") {
            // Stopped by the user: the server kept the partial reply — show it.
            const fresh = await api(`/conversations/${id}`).catch(() => null);
            if (fresh && fresh.id) await render(fresh);
          } else if (!gotEvent) {
            // The stream never started (older server / proxy buffering SSE) —
            // fall back to the classic request/response send.
            try {
              const updated = await api(`/conversations/${id}/messages`, { method: "POST", body: { role: "user", content } });
              await render(updated && updated.id ? updated : undefined);
            } catch (e2) {
              toast("Send failed", e2.message, "err");
              document.getElementById(uid)?.remove();
              input.value = content;
            }
          } else {
            toast("Connection interrupted", "Showing what was saved — send “continue” if the reply cut off.", "warn");
            const fresh = await api(`/conversations/${id}`).catch(() => null);
            if (fresh && fresh.id) await render(fresh);
          }
        } finally {
          sending = false; streamAbort = null;
          // `render()` rebuilds the DOM (new button + new closure); only reset
          // the button if this closure's view is still mounted.
          if (document.getElementById("cv-send") === sendBtn) setSendBtn(false);
        }
      };
      sendBtn.onclick = doSend;
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
      });
      $("#cv-sum").onclick = async () => {
        try {
          const s = await api(`/conversations/${id}/summarize`, { method: "POST", body: {} });
          toast("Summary updated", s.method || "ok", "ok");
          render();
        } catch (e) { toast("Summarize failed", e.message, "err"); }
      };
    };
    await render();
  });

  /**
   * POST a message to a conversation over the SSE streaming endpoint and
   * dispatch each frame to `handlers` (onUser/onMeta/onRetry/onDelta/
   * onMessage/onDone/onError). Resolves when the stream ends; throws on
   * transport errors (HTTP failure, network drop, abort) so the caller can
   * fall back to the JSON endpoint or re-fetch the stored state.
   */
  async function streamConversationSend(convId, body, handlers = {}, opts = {}) {
    const res = await fetch(`/conversations/${encodeURIComponent(convId)}/messages/stream`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      let msg = res.statusText;
      try { const jb = await res.json(); msg = jb.message || jb.error || msg; } catch (_) { /* ignore */ }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
        if (!ev || typeof ev.type !== "string") continue;
        const name = "on" + ev.type.charAt(0).toUpperCase() + ev.type.slice(1);
        if (typeof handlers[name] === "function") {
          try { handlers[name](ev); } catch (_) { /* a broken handler must not kill the stream */ }
        }
      }
    }
  }

  /**
   * Assistant bubble placeholder for a streaming reply: animated typing dots
   * until the first `delta` arrives, then the accumulating text + cursor.
   * `uid` prefixes the ids the send handlers update (`${uid}-text` etc.).
   */
  function streamingBubbleHtml(uid, statusText = "thinking…") {
    return `<div id="${uid}" style="display:flex;gap:8px;justify-content:flex-start">
      <span style="font-size:22px;line-height:1;align-self:flex-end">🤖</span>
      <div style="max-width:min(78%,520px);background:var(--panel, var(--glass));color:var(--text);padding:10px 14px;border-radius:16px;border-bottom-left-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,.2)">
        <div style="font-size:11px;opacity:.7;margin-bottom:4px">CodeVia AI · <span id="${uid}-status">${esc(statusText)}</span></div>
        <div id="${uid}-text" dir="auto" style="white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.55"><span class="cv-typing-dots"><span></span><span></span><span></span></span></div>
        <div id="${uid}-meta" style="font-size:10px;opacity:.55;margin-top:6px;display:flex;gap:6px;flex-wrap:wrap"></div>
      </div>
    </div>`;
  }

  /**
   * Streaming-frame handlers shared by the simple chats: typing status, model
   * badge, token-by-token text with cursor, auto-scroll, and capture of the
   * authoritative conversation from message/done/error frames.
   */
  function liveChatHandlers(uid, box) {
    let finalConv = null;
    let gotEvent = false;
    const scroll = () => { if (box) box.scrollTop = box.scrollHeight; };
    return {
      get finalConv() { return finalConv; },
      get gotEvent() { return gotEvent; },
      handlers: {
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
            const acc = (t.dataset.acc || "") + (ev.text || "");
            t.dataset.acc = acc;
            t.innerHTML = `${esc(acc)}<span class="chat-cursor">▍</span>`;
            t.setAttribute("dir", dirForText(acc));
          }
          scroll();
        },
        onMessage: (ev) => { gotEvent = true; if (ev.conversation) finalConv = ev.conversation; },
        onDone: (ev) => { gotEvent = true; if (ev.conversation) finalConv = ev.conversation; },
        onError: (ev) => { gotEvent = true; if (ev.conversation) finalConv = ev.conversation; },
      },
    };
  }

  function msgBubble(m) {
    const isUser = m.role === "user";
    const dir = dirForText(m.content);
    const bg = isUser ? "var(--primary, #7c6cff)" : "var(--panel, var(--glass))";
    const color = isUser ? "#fff" : "var(--text)";
    const align = isUser ? "flex-end" : "flex-start";
    const icon = isUser ? "🧑" : "🤖";
    const label = isUser ? "You" : "CodeVia AI";
    const meta = m.metadata || {};
    const atts = (meta.attachments || []).map((a) => {
      if (a.dataUrl && a.contentType && a.contentType.startsWith("image/")) return `<img src="${esc(a.dataUrl)}" alt="${esc(a.name)}" style="max-width:180px;max-height:180px;border-radius:8px;margin-top:8px;display:block;border:1px solid rgba(255,255,255,.15)"/>`;
      return `<div style="margin-top:6px;padding:6px 8px;background:rgba(255,255,255,.08);border-radius:8px;font-size:12px;display:inline-flex;gap:6px;align-items:center">📎 ${esc(a.name)} <span style="opacity:.7">${Math.round((a.size||0)/1024)}KB${a.preview?" · "+esc(a.preview):""}</span></div>`;
    }).join("");
    const metaRow = meta.modelId || meta.executionMode ? `<div style="font-size:10px;opacity:.55;margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">${meta.modelId?`<span class="badge" style="background:rgba(255,255,255,.1);padding:1px 6px;border-radius:4px">${esc(String(meta.modelId).replace(/^model-/,""))}</span>`:""}${meta.executionMode?`<span class="badge" style="background:rgba(255,255,255,.1);padding:1px 6px;border-radius:4px">${esc(meta.executionMode)}</span>`:""}${meta.dispatchedTaskId?`<span class="badge" style="background:rgba(255,255,255,.1);padding:1px 6px;border-radius:4px">task ${esc(String(meta.dispatchedTaskId).slice(0,8))}</span>`:""}</div>` : "";
    return `<div style="display:flex;gap:8px;justify-content:${align}">
      ${isUser ? "" : `<span style="font-size:22px;line-height:1;align-self:flex-end">${icon}</span>`}
      <div style="max-width:min(78%,520px);background:${bg};color:${color};padding:10px 14px;border-radius:16px;border-bottom-${isUser?"right":"left"}-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,.2)">
        <div style="font-size:11px;opacity:.7;margin-bottom:4px">${esc(label)} · ${timeAgo(m.createdAt)}</div>
        <div dir="${dir}" style="white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.55">${esc(m.content)}</div>
        ${atts}
        ${metaRow}
      </div>
      ${isUser ? `<span style="font-size:22px;line-height:1;align-self:flex-end">${icon}</span>` : ""}
    </div>`;
  }

  window.conversationDelete = async (convId, goBack) => {
    if (!confirm("Delete this conversation? This cannot be undone.")) return;
    try {
      await api(`/conversations/${convId}`, { method: "DELETE" });
      toast("Conversation deleted", "", "ok");
      if (goBack) location.hash = "#/conversations";
      else refreshCurrent();
    } catch (e) { toast("Delete failed", e.message, "err"); }
  };

  /* MEMORY */
  on("/memory", async () => {
    const list = await api("/memory");
    $("#content").innerHTML = `<div class="overview"><div><h1>Memory</h1><p>GitHub-backed multi-level memory (project, agent, task, decisions, bugs, knowledge)</p></div>
      <button class="btn btn-primary" onclick="addMemory()">＋ Add Entry</button></div>
      ${searchPanelHtml("memory-search", "Search memory by type, scope, key, project, tag or content…")}
      <div class="card card-body"><div class="table-wrap"><table><thead><tr><th>Type</th><th>Scope</th><th>Key</th><th>Project</th><th>Tags</th></tr></thead><tbody id="memory-tbody"></tbody></table></div></div>`;
    bindSearchPanel("memory-search", list, memoryRows, "#memory-tbody", "memory entry", { emptyHtml: () => `<tr><td colspan="5">${emptyState("🔎", "No matching memory entries", "Try searching by type, key, tag, project or content.")}</td></tr>` });
  });
  function memoryRows(list) {
    return list.map((m) => `<tr><td><span class="badge badge-info">${esc(m.type)}</span></td><td>${esc(m.scope)}</td><td>${esc(m.key)}</td><td class="mono">${(m.projectId||"—").slice(0,12)}</td><td>${(m.tags||[]).map(t=>`<span class="badge badge-muted">${esc(t)}</span>`).join(" ")}</td></tr>`).join("");
  }
  window.addMemory = async () => {
    const projects = await api("/projects").catch(() => []);
    openModal("Add Memory Entry", `<div class="field"><label>Project</label><select class="select" id="mm-project"><option value="">(global)</option>${projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></div><div class="field"><label>Type</label><select class="select" id="mm-type">${["architecture","business","technical","decision","bug","knowledge","lesson","conversation"].map(t=>`<option ${t === "knowledge" ? "selected" : ""}>${t}</option>`).join("")}</select></div><div class="field"><label>Key</label><input class="input" id="mm-key" placeholder="auth.session-strategy"/></div><div class="field"><label>Content</label><textarea class="textarea" id="mm-content"></textarea></div><div class="field"><label>Tags (comma separated)</label><input class="input" id="mm-tags"/></div><div class="flex"><button class="btn btn-primary" id="mm-go">Save</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
    $("#mm-go").onclick = async () => {
      const key = $("#mm-key").value.trim(); const content = $("#mm-content").value.trim();
      if (!key || !content) { toast("Key and content are required", "", "err"); return; }
      try {
        await api("/memory", { method: "POST", body: { projectId: $("#mm-project").value || undefined, scope: $("#mm-project").value ? "project" : "global", type: $("#mm-type").value, key, content, tags: $("#mm-tags").value.split(",").map((t) => t.trim()).filter(Boolean) } });
        closeModal(); toast("Memory saved", key, "ok"); refreshCurrent();
      } catch (e) { toast("Error", e.message, "err"); }
    };
  };

  /* GITHUB */
  // Renders the top-bar user/login slot from the cached authState. Uses the
  // OAuth config status from /auth/me (loginConfigured) — no extra request,
  // no 401 (these endpoints are public).
  async function renderUserSlot() {
    const slot = $("#user-slot");
    if (!slot) return;
    try {
      if (authState.authenticated && authState.user && authState.user.externalId !== "demo") {
        const u = authState.user;
        const avatar = u.avatarUrl ? `<img class="user-avatar" src="${esc(u.avatarUrl)}" alt=""/>` : `<span class="user-avatar user-avatar-fallback">${esc((u.name || "?").trim().slice(0, 1).toUpperCase())}</span>`;
        slot.innerHTML = `<span class="user-chip" title="${esc(u.email || "")} (${esc(u.role)})">${avatar}<span class="user-name">${esc(u.name)}</span><span class="badge badge-muted user-role">${esc(u.role)}</span></span>
          <button class="btn btn-ghost" id="logout-btn" title="Sign out">⏻</button>`;
        $("#logout-btn").onclick = async () => {
          await api("/auth/logout", { method: "POST" }).catch(() => {});
          try { localStorage.removeItem("cv_token"); } catch (_) {}
          toast("Logged out", "Signed out of GitHub.", "ok");
          await refreshAuthState();
          renderUserSlot(); refreshCurrent();
        };
      } else {
        slot.innerHTML = authState.loginConfigured
          ? `<a class="btn btn-primary" href="/auth/github/login">🐙 Sign in</a>`
          : `<a class="btn btn-ghost" href="#/github" title="GitHub OAuth is not configured — running in demo mode">👤 Demo</a>`;
      }
    } catch (_) { /* leave slot empty when API unreachable */ }
  }
