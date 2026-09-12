  /* SEARCH */
  on("/search", async () => {
    $("#content").innerHTML = `<div class="overview"><div><h1>Search</h1><p>Search everything — projects, agents, tasks, memory, skills</p></div></div>
      <div class="card card-body"><div class="field"><label>Query</label><input class="input" id="q-input" placeholder="login, accounting, bug…"/></div>
      <div id="q-results"></div></div>`;
    $("#q-input").addEventListener("input", async (e) => {
      const q = e.target.value.trim();
      if (q.length < 2) { $("#q-results").innerHTML = ""; return; }
      const r = await api("/search?q=" + encodeURIComponent(q));
      $("#q-results").innerHTML = r.results.length ? `<div class="table-wrap"><table><thead><tr><th>Type</th><th>Title</th><th>Snippet</th></tr></thead><tbody>${r.results.map((x) => `<tr><td><span class="badge badge-info">${esc(x.type)}</span></td><td><strong>${esc(x.title)}</strong></td><td>${esc(x.snippet)}</td></tr>`).join("")}</tbody></table></div>` : `<p style="color:var(--text-muted)">No results for "${esc(q)}".</p>`;
    });
  });

  /* ---------- boot ---------- */
  window.addEventListener("hashchange", route);
  renderNav();
  connectSocket();
  // route() primes session state before the first render. Calling
  // refreshAuthState() here as well used to issue two /auth/me requests on
  // every page load and could race the route gate.
  route();
})();
