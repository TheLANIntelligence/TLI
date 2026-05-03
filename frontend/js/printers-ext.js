// TLI Printers Extended
(() => {
  const TAG = "TLI_PRINTERS_NATIVE_SETTINGS_WIRE";

  async function _openNativePrinters() {
    try {
      await fetch("/api/printers/open_add", { method: "POST" });
      if (typeof toast === "function") toast("Opening system printer screen…");
      else if (typeof showToast === "function") showToast("Opening system printer screen…");
    } catch (e) {
      if (typeof toast === "function") toast("Printer screen not available (backend).", "warning");
      else if (typeof showToast === "function") showToast("Printer screen not available (backend).", "warning");
      console.warn(TAG, "open_add failed:", e);
    }
  }

  function _btnText(el) {
    try { return (el.textContent || "").trim().toLowerCase(); } catch { return ""; }
  }

  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!t) return;

    // find closest button-like element
    const btn = t.closest("button, .btn, [role='button']");
    if (!btn) return;

    const txt = _btnText(btn);
    if (txt === "discover" || txt === "add printer") {
      ev.preventDefault();
      _openNativePrinters();
    }
  }, true);
})();



/* === TLI PRINTERS MODULE v2 (locked) === */
/* === TLI PRINTERS MODULE v2 (locked) ===
   Restores: Refresh list + WIA devices + OS open + Test Print
   Backend endpoints expected:
     GET /api/printers
     GET|POST /api/printers/open_add
     GET /api/scan/wia/devices
     POST /api/printers/test_print
     POST /api/printers/fix  (optional)
========================================= */
(function(){
  function pill(id, text, cls){
    const el = document.getElementById(id);
    if (!el) return;
    el.className = "pill " + (cls || "pill-muted");
    el.textContent = text;
  }
  function setText(id, text){
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || "";
  }
  function esc(s){
    return String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
  }
  async function fetchJson(url, opts){
    const r = await fetch(url, opts);
    let j = null;
    try { j = await r.json(); } catch {}
    return { r, j };
  }
  function renderPrinters(printers, meta){
    const box = document.getElementById("devices-printers-list");
    if (!box) return;
    if (!Array.isArray(printers) || printers.length === 0){
      box.innerHTML = `
        <div class="tli-empty-mini">
          <div class="tli-empty-title">No printers found</div>
          <div class="tli-empty-sub">If your printer isn’t installed yet, click Add Printer.</div>
        </div>`;
      return;
    }
    const head = meta?.default_printer ? `<div class="small-meta" style="margin-bottom:8px;">Default: <b>${esc(meta.default_printer)}</b></div>` : "";
    box.innerHTML = head + printers.map(p => {
      const name = esc(p.Name || p.name || "Printer");
      const driver = esc(p.DriverName || p.driver || "—");
      const port = esc(p.PortName || p.port || "—");
      const isDefault = !!(p.Default || p.default || p.is_default);
      return `
        <div class="card-mini">
          <div class="card-mini-title">${name}${isDefault ? ' <span class="badge">Default</span>' : ""}</div>
          <div class="card-mini-sub">Driver: <code>${driver}</code> · Port: <code>${port}</code></div>
        </div>`;
    }).join("");
  }

  window.refreshPrinters = async function(){
    pill("devices-printers-status", "Scanning…", "pill-muted");
    setText("devices-printers-summary", "");
    try{
      const { r, j } = await fetchJson("/api/printers");
      // /api/printers returns a raw array on success, or {ok:false, error:"..."} on failure
      if (!r.ok || !j){
        const msg = (j && (j.error || j.detail)) ? (j.error || j.detail) : ("HTTP " + r.status);
        pill("devices-printers-status", "Error", "pill-warn");
        setText("devices-printers-summary", msg);
        return;
      }
      if (!Array.isArray(j) && j.ok === false){
        pill("devices-printers-status", "Error", "pill-warn");
        setText("devices-printers-summary", j.error || "Unknown error");
        return;
      }
      const printers = Array.isArray(j) ? j : [];
      const defaultPrinter = printers.find(p => p.is_default || p.Default)?.name || null;
      pill("devices-printers-status", "OK", "pill-ok");
      setText("devices-printers-summary", `Found ${printers.length} printer(s).`);
      renderPrinters(printers, { default_printer: defaultPrinter });
    }catch(e){
      pill("devices-printers-status", "Error", "pill-warn");
      setText("devices-printers-summary", String(e));
    }
  };

  window.openAddPrinter = async function(){
    try{
      // backend supports GET or POST (we'll POST)
      await fetch("/api/printers/open_add", { method: "POST" });
      if (typeof toast === "function") toast("Opening system printer screen…");
      else if (typeof showToast === "function") showToast("Opening system printer screen…");
    }catch(e){
      if (typeof toast === "function") toast("Could not open printer screen.", "warning");
      else if (typeof showToast === "function") showToast("Could not open printer screen.", "warning");
    }
  };

  window.discoverPrinters = async function(){
    try { await fetch("/api/printers/discover"); } catch {}
    try { await window.openAddPrinter(); } catch {}
    try { await window.refreshPrinters(); } catch {}
  };

  window.fixPrinter = async function(){
  pill("devices-printers-status", "Working…", "pill-muted");
  setText("devices-printers-summary", "Attempting repair…");
  try{
    const { r, j } = await fetchJson("/api/quick/fix_printer", { method: "POST" });
    if (!r.ok || !j || (j.status !== "ok" && j.ok !== true)){
      const msg = (j && (j.message || j.detail || j.error)) ? (j.message || j.detail || j.error) : ("HTTP " + r.status);
      pill("devices-printers-status", "Error", "pill-warn");
      setText("devices-printers-summary", msg);
      return;
    }
    // j.healthy=true means “nothing was wrong”
    pill("devices-printers-status", j.healthy ? "Healthy" : "OK", "pill-ok");
    setText("devices-printers-summary", j.message || "Repair completed.");
    try { await window.refreshPrinters(); } catch {}
  }catch(e){
    pill("devices-printers-status", "Error", "pill-warn");
    setText("devices-printers-summary", String(e));
  }
};

  // ---- WIA: devices dropdown ----
  window.refreshWiaDevices = async function(){
    pill("wia-status", "Loading…", "pill-muted");
    setText("wia-summary", "Loading WIA devices…");
    const sel = document.getElementById("wia-device");
    if (!sel) return;
    try{
      const { r, j } = await fetchJson("/api/scan/wia/devices");
      sel.innerHTML = "";
      if (!r.ok || !j || j.ok !== true){
        sel.innerHTML = `<option value="">No WIA devices</option>`;
        pill("wia-status", "WIA unavailable", "pill-warn");
        setText("wia-summary", (j && (j.message || j.detail)) ? (j.message || j.detail) : ("HTTP " + r.status));
        return;
      }
      const devs = Array.isArray(j.devices) ? j.devices : [];
      if (devs.length === 0){
        sel.innerHTML = `<option value="">No WIA devices</option>`;
        pill("wia-status", "No devices", "pill-warn");
        setText("wia-summary", "Windows reports no WIA scanners.");
        return;
      }
      for (const d of devs){
        const opt = document.createElement("option");
        opt.value = d.id;
        opt.textContent = d.name || d.id;
        sel.appendChild(opt);
      }
      pill("wia-status", "WIA ready", "pill-ok");
      setText("wia-summary", `Found ${devs.length} device(s).`);
    }catch(e){
      sel.innerHTML = `<option value="">No WIA devices</option>`;
      pill("wia-status", "WIA error", "pill-warn");
      setText("wia-summary", String(e));
    }
  };

  // Ensure PDF option exists in format select
  try{
    const fmt = document.getElementById("wia-format");
    if (fmt){
      const hasPdf = Array.from(fmt.options).some(o => (o.value || "").toLowerCase() === "pdf");
      if (!hasPdf){
        const opt = document.createElement("option");
        opt.value = "pdf";
        opt.textContent = "PDF";
        fmt.appendChild(opt);
      }
    }
  }catch{}

  // ---- Test Print ----
  window.testPrint = async function(){
    pill("devices-printers-status", "Printing…", "pill-muted");
    setText("devices-printers-summary", "Sending TLI test page…");
    try{
      const { r, j } = await fetchJson("/api/printers/test_print", { method: "POST" });
      if (!r.ok || !j || j.ok !== true){
        const msg = (j && (j.message || j.detail)) ? (j.message || j.detail) : ("HTTP " + r.status);
        pill("devices-printers-status", "Error", "pill-warn");
        setText("devices-printers-summary", msg);
        return;
      }
      pill("devices-printers-status", "Sent", "pill-ok");
      setText("devices-printers-summary", "Test page sent to: " + (j.printer || "Default printer"));
      try{
        if (typeof toast === "function") toast("Test page sent.");
        else if (typeof showToast === "function") showToast("Test page sent.");
      }catch{}
    }catch(e){
      pill("devices-printers-status", "Error", "pill-warn");
      setText("devices-printers-summary", String(e));
    }
  };

  // Add a Test Print button next to Add Printer if it doesn't exist
  function ensureTestButton(){
    try{
      const btns = Array.from(document.querySelectorAll("button"));
      const add = btns.find(b => (b.textContent || "").trim().toLowerCase() === "add printer");
      if (add){
        const parent = add.parentElement;
        if (parent && !parent.querySelector('button[data-tli="test-print"]')){
          const b = document.createElement("button");
          b.className = add.className || "btn-ghost";
          b.textContent = "Test Print";
          b.setAttribute("data-tli", "test-print");
          b.onclick = () => window.testPrint();
          parent.insertBefore(b, add);
        }
      }
    }catch{}
  }
  let tries = 0;
  const t = setInterval(()=>{ ensureTestButton(); tries++; if (tries>10) clearInterval(t); }, 500);

  // Bootstrap — printer refresh moved to dedicated IIFE below to prevent duplicate startup calls
  // setTimeout(()=>{ try{ window.refreshPrinters(); }catch{} try{ window.refreshWiaDevices(); }catch{} }, 300);

  // Auto-load printers + WIA devices once UI is ready — suppressed (duplicate, see TLI_PRINTERS_HTTP_FALLBACK_V1)
  // try { setTimeout(() => { window.refreshPrinters && window.refreshPrinters(); window.refreshWiaDevices && window.refreshWiaDevices(); }, 250); } catch {}
})();


/* =========================================================
   TLI_PRINTERS_HPSMART_BUNDLE_V1
   Professional HP Smart-like renderer for Printers panel.
   - Search / Filters / Sort
   - Rollup strip (A): overall health + default + issue counts
   - Actions (B): Manage (open OS printers UI) + Test (default printer)
   - Truncation + tap-to-copy chips
   Safety: additive; discovery-only
   ========================================================= */
(() => {
  const TAG = "TLI_PRINTERS_HPSMART_BUNDLE_V1";

  const STATE = { printers: [], query: "", filter: "all", sort: "default", expanded: new Set(), showVirtual: false, suppliesByName: {} };
  const STATUS_ORDER = { ready: 0, unknown: 1, offline: 2, error: 3 };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function norm(s) { return String(s ?? "").trim().toLowerCase(); }
  function keyOf(p) { return String(p?.system_name || p?.name || "").trim() || "printer"; }

  function pillClassForStatus(status) {
    const s = norm(status);
    if (s === "ready") return "pill-ok";
    if (s === "offline") return "pill-warn";
    if (s === "error") return "pill-warn";
    return "pill-muted";
  }
  function statusIcon(status) {
    const s = norm(status);
    if (s === "ready") return "✅";
    if (s === "offline") return "📴";
    if (s === "error") return "⚠️";
    return "•";
  }
  

  function suppliesHtml(p) {
    try {
      const name = p?.name ? String(p.name) : "";
      const it = name ? STATE.suppliesByName?.[name] : null;
      if (!it) return `<div class="tli-supplies-note">Ink: <span class="pill pill-muted">not loaded</span></div>`;
      if (it.ok !== true) {
        const msg = esc(it.error || "Unavailable");
        return `<div class="tli-supplies-note">Ink: <span class="pill pill-warn">unavailable</span> <span class="small-meta">${msg}</span></div>`;
      }
      const arr = Array.isArray(it.supplies) ? it.supplies : [];
      if (!arr.length) return `<div class="tli-supplies-note">Ink: <span class="pill pill-muted">no data</span></div>`;
      const rows = arr.map(s => {
        const label = esc(s?.name || s?.description || "Supply");
        const pct = (typeof s?.percent === "number") ? s.percent : null;
        const pctText = (pct === null || Number.isNaN(pct)) ? "—" : `${Math.max(0, Math.min(100, Math.round(pct)))}%`;
        const barW = (pct === null || Number.isNaN(pct)) ? 0 : Math.max(0, Math.min(100, Math.round(pct)));
        return `
          <div class="tli-supply-row">
            <div class="tli-supply-top"><span class="tli-supply-name">${label}</span><span class="tli-supply-pct">${pctText}</span></div>
            <div class="tli-supply-bar"><div class="tli-supply-fill" style="width:${barW}%"></div></div>
          </div>`;
      }).join("");
      return `<div class="tli-supplies">
        <div class="tli-supplies-head">Ink / Toner <span class="small-meta">via SNMP</span></div>
        ${rows}
      </div>`;
    } catch {
      return `<div class="tli-supplies-note">Ink: <span class="pill pill-muted">unknown</span></div>`;
    }
  }

function toastMsg(msg, kind) {
    try { if (typeof toast === "function") return toast(msg, kind); if (typeof showToast === "function") return showToast(msg, kind); } catch {}
  }

  function applyFilter(list) {
    const q = norm(STATE.query);
    const f = STATE.filter;
    return (list || []).filter((p) => {
      const name = norm(p?.name);
      const driver = norm(p?.driver);
      const port = norm(p?.port);
      const loc = norm(p?.location);
      const st = norm(p?.status);
      const matches = !q || name.includes(q) || driver.includes(q) || port.includes(q) || loc.includes(q) || st.includes(q);
      if (!matches) return false;
      if (!STATE.showVirtual && !!p?.is_virtual) return false;
      if (f === "all") return true;
      if (f === "default") return !!p?.is_default;
      if (f === "network") return !!p?.is_network;
      if (f === "local") return !p?.is_network;
      if (f === "issues") return st === "offline" || st === "error";
      return true;
    });
  }

  function applySort(list) {
    const s = STATE.sort;
    const arr = [...(list || [])];
    if (s === "name") { arr.sort((a, b) => norm(a?.name).localeCompare(norm(b?.name))); return arr; }
    if (s === "status") { arr.sort((a, b) => (STATUS_ORDER[norm(a?.status)] ?? 9) - (STATUS_ORDER[norm(b?.status)] ?? 9)); return arr; }
    arr.sort((a, b) => {
      const ad = a?.is_default ? 0 : 1;
      const bd = b?.is_default ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return norm(a?.name).localeCompare(norm(b?.name));
    });
    return arr;
  }

  function ensureToolbar() {
    const list = $("devices-printers-list");
    if (!list) return;
    const host = list.parentElement;
    if (!host) return;
    if ($("tli-printers-toolbar")) return;

    const toolbar = document.createElement("div");
    toolbar.id = "tli-printers-toolbar";
    toolbar.className = "tli-printers-toolbar";
    toolbar.innerHTML = `
      <div class="tli-printers-toolbar-row">
        <div class="tli-printers-search">
          <span class="tli-printers-search-ico" aria-hidden="true">🔎</span>
          <input id="tli-printers-search" class="input tli-printers-search-input" placeholder="Search printers, drivers, ports, status…" />
          <button id="tli-printers-clear" class="btn-ghost tli-printers-clear" title="Clear search" aria-label="Clear search">✕</button>
        </div>
        <div class="tli-printers-controls">
          <div class="tli-printers-seg" role="tablist" aria-label="Printer filters">
            <button class="tli-seg-btn" data-filter="all">All</button>
            <button class="tli-seg-btn" data-filter="default">Default</button>
            <button class="tli-seg-btn" data-filter="network">Network</button>
            <button class="tli-seg-btn" data-filter="local">Local</button>
            <button class="tli-seg-btn" data-filter="issues">Issues</button>
          </div>
          <select id="tli-printers-sort" class="input tli-printers-sort" aria-label="Sort printers">
            <option value="default">Sort: Default</option>
            <option value="name">Sort: Name</option>
            <option value="status">Sort: Status</option>
          </select>
          <label class="tli-printers-toggle" title="Show system/virtual printers (PDF, Fax, OneNote, XPS)"><input type="checkbox" id="tli-printers-show-virtual" /> System</label>
        </div
      </div>
      <div class="tli-printers-toolbar-meta"><span id="tli-printers-count" class="small-meta"></span></div>
    `;
    host.insertBefore(toolbar, list);

    const search = $("tli-printers-search");
    const clear = $("tli-printers-clear");
    const sort = $("tli-printers-sort");

    search?.addEventListener("input", () => { STATE.query = search.value || ""; render(); });
    clear?.addEventListener("click", () => { STATE.query = ""; if (search) search.value = ""; render(); search?.focus?.(); });

    toolbar.addEventListener("click", (ev) => {
      const btn = ev.target?.closest?.("button[data-filter]");
      if (!btn) return;
      STATE.filter = btn.getAttribute("data-filter") || "all";
      render();
    });
    sort?.addEventListener("change", () => { STATE.sort = sort.value || "default"; render(); });


    const showVirtual = $("tli-printers-show-virtual");
    if (showVirtual) { showVirtual.checked = !!STATE.showVirtual; showVirtual.addEventListener("change", () => { STATE.showVirtual = !!showVirtual.checked; render(); }); }
    render();
  }

  function setSegActive(filter) {
    const toolbar = $("tli-printers-toolbar");
    if (!toolbar) return;
    const btns = Array.from(toolbar.querySelectorAll("button[data-filter]"));
    for (const b of btns) {
      const on = (b.getAttribute("data-filter") || "") === filter;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    }
  }

  function updateRollup(list) {
    const host = $("tli-printers-rollup");
    if (!host) return;
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) { host.classList.add("hidden"); host.innerHTML = ""; return; }

    const def = arr.find((p) => !!p?.is_default);
    const defName = def?.name ? esc(def.name) : "";

    const offline = arr.filter((p) => norm(p?.status) === "offline").length;
    const error = arr.filter((p) => norm(p?.status) === "error").length;
    const issues = offline + error;

    const headline = issues ? "Needs attention" : "All good";
    const pillCls = issues ? "pill-warn" : "pill-ok";

    host.classList.remove("hidden");
    host.innerHTML = `
      <div class="tli-rollup-left">
        <span class="pill ${pillCls}">${esc(headline)}</span>
        <span class="tli-rollup-title">Printers</span>
        <span class="tli-rollup-meta">
          ${defName ? `Default: <b>${defName}</b> · ` : ""}
          ${issues ? `${issues} issue(s)` : `${arr.length} available`}
          ${offline ? ` · Offline: ${offline}` : ""}
          ${error ? ` · Errors: ${error}` : ""}
        </span>
      </div>
      <div class="tli-rollup-actions">
        <button class="btn-ghost" id="tli-rollup-manage" title="Open system printers">Manage</button>
        <button class="btn-ghost" id="tli-rollup-test" title="Send test page to default printer">Test page</button>
      </div>
    `;

    $("tli-rollup-manage")?.addEventListener("click", async () => {
      try { if (typeof window.openAddPrinter === "function") return await window.openAddPrinter(); await fetch("/api/printers/open_add", { method: "POST" }); }
      catch { toastMsg("Could not open printer settings.", "warning"); }
    });
    $("tli-rollup-test")?.addEventListener("click", async () => {
      try { if (typeof window.testPrint === "function") return await window.testPrint(); await fetch("/api/printers/test_print", { method: "POST" }); }
      catch { toastMsg("Could not send test page.", "warning"); }
    });
  }

  function renderEmpty(title, subtitle) {
    const box = $("devices-printers-list");
    if (!box) return;
    box.classList.remove("tli-printers-grid");
    box.innerHTML = `
      <div class="tli-empty-mini tli-empty-polished">
        <div class="tli-empty-title">${esc(title || "No printers found")}</div>
        <div class="tli-empty-sub">${esc(subtitle || "Click Refresh to load installed printers, or Add Printer to install one.")}</div>
      </div>
    `;
  }

  function renderLoading() {
    const box = $("devices-printers-list");
    if (!box) return;
    box.classList.remove("tli-printers-grid");
    box.innerHTML = `
      <div class="tli-printers-skeleton">
        ${Array.from({ length: 4 }).map(() => `
          <div class="tli-printer-card tli-skel">
            <div class="tli-printer-top">
              <div class="tli-skel-line w60"></div>
              <div class="tli-skel-pill"></div>
            </div>
            <div class="tli-skel-line w40"></div>
            <div class="tli-skel-line w80"></div>
          </div>
        `).join("")}
      </div>
    `;
  }

  function render() {
    ensureToolbar();
    setSegActive(STATE.filter);

    const box = $("devices-printers-list");
    const count = $("tli-printers-count");
    if (!box) return;

    const filtered = applyFilter(STATE.printers);
    const sorted = applySort(filtered);

    if (count) count.textContent = `${sorted.length} shown · ${STATE.printers.length} total`;

    updateRollup(STATE.printers);

    if (!sorted.length) {
      renderEmpty(STATE.printers.length ? "No matches" : "No printers found", STATE.printers.length ? "Try a different search or filter." : "Click Refresh to load installed printers.");
      return;
    }

    box.classList.add("tli-printers-grid");
    box.innerHTML = sorted.map((p) => {
      const k = keyOf(p);
      const open = STATE.expanded.has(k);

      const name = esc(p?.name || "Printer");
      const driver = esc(p?.driver || "—");
      const port = esc(p?.port || "—");
      const location = esc(p?.location || "");
      const type = p?.is_network ? "Network" : "Local";
      const status = esc(norm(p?.status) || "unknown");

      const testDisabled = !p?.is_default;
      const testTitle = testDisabled ? "Test page prints to the default printer" : "Send test page";

      return `
        <div class="tli-printer-card" data-key="${esc(k)}">
          <div class="tli-printer-top">
            <div class="tli-printer-name">
              <span class="tli-printer-status-dot ${esc(pillClassForStatus(status))}" aria-hidden="true"></span>
              <span class="tli-printer-title">${esc(statusIcon(status))} ${name}</span>
              ${p?.is_default ? `<span class="badge tli-badge">Default</span>` : ``}
              <span class="badge tli-badge">${esc(type)}</span>
            </div>

            <div class="tli-printer-actions">
              <button class="btn-ghost ps-deeplink-btn" data-printshop="${esc(p?.name || "")}" title="Open in Print &amp; Scan Studio">🖨️ Print</button>
              <button class="btn-ghost" data-expand="${esc(k)}" aria-expanded="${open ? "true" : "false"}">${open ? "Hide" : "Details"}</button>
            </div>
          </div>

          <div class="tli-printer-sub">
            <span class="tli-kv"><span class="tli-k">Driver</span><span class="tli-v"><code class="tli-code" data-full="${driver}">${driver}</code></span></span>
            <span class="tli-kv"><span class="tli-k">Port</span><span class="tli-v"><code class="tli-code" data-full="${port}">${port}</code></span></span>
            <span class="tli-kv"><span class="tli-k">Status</span><span class="tli-v"><span class="pill ${esc(pillClassForStatus(status))}">${status}</span></span></span>
          </div>

          <div class="tli-printer-details ${open ? "is-open" : ""}">
            ${location ? `<div class="tli-detail-row"><span class="tli-detail-k">Location</span><span class="tli-detail-v"><code class="tli-code" data-full="${location}">${location}</code></span></div>` : ""}
            <div class="tli-detail-row"><span class="tli-detail-k">System name</span><span class="tli-detail-v"><code class="tli-code" data-full="${esc(p?.system_name || p?.name || "")}">${esc(p?.system_name || p?.name || "")}</code></span></div>
            ${(p?.ip || p?.hostname) ? `<div class="tli-detail-row"><span class="tli-detail-k">Host</span><span class="tli-detail-v"><code class="tli-code" data-full="${esc(p?.ip || p?.hostname)}">${esc(p?.ip || p?.hostname)}</code></span></div>` : ``}
            <div class="tli-detail-actions">
              <button class="btn-ghost" data-manage="${esc(k)}" title="Open system printers">Manage</button>
              <button class="btn-ghost" data-test="${esc(k)}" title="${esc(testTitle)}" ${testDisabled ? "disabled" : ""}>Test page</button>
            </div>
            ${suppliesHtml(p)}
          </div>
        </div>
      `;
    }).join("");

    box.onclick = async (ev) => {
      const expand = ev.target?.closest?.("button[data-expand]");
      if (expand) {
        const k = expand.getAttribute("data-expand") || "";
        if (!k) return;
        if (STATE.expanded.has(k)) STATE.expanded.delete(k);
        else STATE.expanded.add(k);
        render();
        return;
      }
      const manage = ev.target?.closest?.("button[data-manage]");
      if (manage) {
        try { if (typeof window.openAddPrinter === "function") return await window.openAddPrinter(); await fetch("/api/printers/open_add", { method: "POST" }); toastMsg("Opening system printer screen…"); }
        catch { toastMsg("Could not open printer screen.", "warning"); }
        return;
      }
      const test = ev.target?.closest?.("button[data-test]");
      if (test && !test.disabled) {
        try { if (typeof window.testPrint === "function") return await window.testPrint(); await fetch("/api/printers/test_print", { method: "POST" }); toastMsg("Test page sent."); }
        catch { toastMsg("Could not send test page.", "warning"); }
        return;
      }
      const deeplink = ev.target?.closest?.("button[data-printshop]");
      if (deeplink) {
        const printerName = deeplink.getAttribute("data-printshop");
        switchToPrintShop(printerName);
        return;
      }
    };
  }

  // Tap-to-copy
  document.addEventListener("click", (ev) => {
    const code = ev.target?.closest?.(".tli-code");
    if (!code) return;
    const val = code.getAttribute("data-full") || code.textContent || "";
    const t = String(val).trim();
    if (!t) return;
    navigator.clipboard?.writeText?.(t).catch(() => {});
    code.classList.add("is-copied");
    window.setTimeout(() => code.classList.remove("is-copied"), 450);
  });

  async function fetchPrinters() {
    const r = await fetch("/api/printers", { cache: "no-store" });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error("Printer service error");
    if (Array.isArray(j)) return j;
    if (j && typeof j === "object" && j.ok === false) return [];
    if (j && j.ok === true && Array.isArray(j.printers)) {
      return j.printers.map((p) => ({
        name: p?.name || p?.Name,
        system_name: p?.system_name || p?.name || p?.Name,
        is_default: !!(p?.is_default || p?.Default || p?.default),
        status: (p?.status || p?.PrinterStatus || "unknown"),
        driver: (p?.driver || p?.DriverName || null),
        port: (p?.port || p?.PortName || null),
        location: (p?.location || p?.Location || null),
        is_network: !!(p?.is_network || p?.ip || p?.host),
        is_virtual: !!(p?.is_virtual),
        ip: (p?.ip || null),
        hostname: (p?.hostname || null),
        connection_type: (p?.connection_type || (p?.is_network ? "network" : "local")),
      }));
    }
    return [];
  }


  async function fetchSupplies() {
    // Returns map: printer_name -> result object from /api/printers/supplies
    try {
      const r = await fetch("/api/printers/supplies", { cache: "no-store" });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || j.ok !== true || !Array.isArray(j.results)) return {};
      const out = {};
      for (const it of j.results) {
        const n = (it && it.name) ? String(it.name) : "";
        if (!n) continue;
        out[n] = it;
      }
      return out;
    } catch {
      return {};
    }
  }

  function wrapRefresh() {
    if (typeof window.refreshPrinters !== "function") return;
    const original = window.refreshPrinters;
    if (original.__tli_hp_smart__) return;

    window.refreshPrinters = async function () {
      try { ensureToolbar(); renderLoading(); } catch {}
      let res;
      try { res = await original(); } catch (e) { console.warn(TAG, "original refresh error:", e); }
      try {
        STATE.printers = await fetchPrinters();
        STATE.suppliesByName = await fetchSupplies();
        render();} catch (e) {
        console.warn(TAG, "fetch/render error:", e);
        STATE.printers = [];
        updateRollup([]);
        renderEmpty("Printer service error", "Could not load printers from the backend.");
      }
      return res;
    };

    window.refreshPrinters.__tli_hp_smart__ = true;
  }

  function boot() { try { ensureToolbar(); } catch {} try { wrapRefresh(); } catch {} try { render(); } catch {} }
  document.addEventListener("DOMContentLoaded", boot);
  console.debug(TAG, "loaded");
})();

/* =========================================================
   TLI_PRINTERS_HTTP_FALLBACK_V1
   Fix "Method Not Allowed" (405) by retrying GET when POST is rejected.
   Additive only: wraps existing openAddPrinter/testPrint safely.
   ========================================================= */
(() => {
  const TAG = "TLI_PRINTERS_HTTP_FALLBACK_V1";

  async function tryPostThenGetJson(url) {
    // Try POST first (current UI), fallback to GET on 405.
    let r = await fetch(url, { method: "POST" });
    if (r.status === 405) r = await fetch(url, { method: "GET" });
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    const j = ct.includes("application/json") ? await r.json().catch(() => null) : null;
    return { r, j };
  }

  function safeToast(msg, kind) {
    try {
      if (typeof toast === "function") return toast(msg, kind);
      if (typeof showToast === "function") return showToast(msg, kind);
    } catch {}
  }

  // ---- Wrap openAddPrinter ----
  if (typeof window.openAddPrinter === "function" && !window.openAddPrinter.__tli_http_fallback__) {
    const original = window.openAddPrinter;
    window.openAddPrinter = async function () {
      try {
        // Call original first (it also updates UI/alerts in your app.js)
        await original();
        return;
      } catch (e) {
        // If original threw, still attempt fallback logic.
      }

      try {
        const { r, j } = await tryPostThenGetJson("/api/printers/open_add");
        if (!r.ok) throw new Error((j && (j.detail || j.message)) || `HTTP ${r.status}`);
        safeToast("Opening system printer screen…");
      } catch (e) {
        safeToast("Could not open printer settings.", "warning");
        console.warn(TAG, "openAddPrinter failed:", e);
      }
    };
    window.openAddPrinter.__tli_http_fallback__ = true;
  }

  // ---- Wrap testPrint ----
  if (typeof window.testPrint === "function" && !window.testPrint.__tli_http_fallback__) {
    const original = window.testPrint;
    window.testPrint = async function () {
      try {
        await original();
        return;
      } catch (e) {
        // If original threw, still attempt fallback logic.
      }

      try {
        const { r, j } = await tryPostThenGetJson("/api/printers/test_print");
        if (!r.ok || !j || j.ok !== true) {
          throw new Error((j && (j.message || j.detail)) || `HTTP ${r.status}`);
        }
        safeToast("Test page sent.");
      } catch (e) {
        safeToast("Could not send test page.", "warning");
        console.warn(TAG, "testPrint failed:", e);
      }
    };
    window.testPrint.__tli_http_fallback__ = true;
  }
})();

/* =====================================================
   TLI_PRINTERS_DISABLE_UNUSED_ACTIONS_V1
   Why:
   - Discover/Fix are not part of Phase 1 and may 404/405.
   ===================================================== */
(() => {
  // Keep functions defined if other code calls them, but make them no-ops.
  if (typeof window.discoverPrinters === "function") {
    window.discoverPrinters = async () => {
      try { if (typeof showToast === "function") showToast("Discover is not enabled in Phase 1.", "warning"); } catch {}
    };
  }
  if (typeof window.fixPrinter === "function") {
    window.fixPrinter = async () => {
      try { if (typeof showToast === "function") showToast("Fix Printer is not enabled in Phase 1.", "warning"); } catch {}
    };
  }
})();

/* =====================================================
   TLI_SCAN_LAUNCH_V1
   Opens Windows Scan (stable, packaged-friendly).
   Uses POST then GET fallback to avoid 405s.
   ===================================================== */
(() => {
  async function postThenGet(url) {
    let r = await fetch(url, { method: "POST" });
    if (r.status === 405) r = await fetch(url, { method: "GET" });
    return r;
  }

  function toastMsg(msg, kind) {
    try {
      if (typeof showToast === "function") return showToast(msg, kind);
      if (typeof toast === "function") return toast(msg, kind);
    } catch {}
  }

  window.openScan = async function () {
    try {
      const r = await postThenGet("/api/printers/open_scan");
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok !== true) throw new Error(j.message || j.error || `HTTP ${r.status}`);
      toastMsg("Opening Windows Scan…");
    } catch (e) {
      toastMsg("Could not open Windows Scan.", "warning");
      console.warn("openScan failed:", e);
    }
  };
})();

/* =====================================================
   TLI_PRINTER_ACTIONS_WIRING_V1
   Fixes:
   - "Error HTTP 200" false errors (non-JSON 200 responses)
   - Buttons not working (missing openScan or method mismatch)
   Strategy:
   - POST then GET fallback
   - Accept JSON OR empty/text responses as success when HTTP 2xx
   - Provide consistent toasts
   ===================================================== */
(() => {
  async function fetchPostThenGet(url) {
    let r = await fetch(url, { method: "POST" });
    if (r.status === 405) r = await fetch(url, { method: "GET" });
    return r;
  }

  async function parseJsonSafe(r) {
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("application/json")) return null;
    return await r.json().catch(() => null);
  }

  function toastMsg(msg, kind) {
    try {
      if (typeof showToast === "function") return showToast(msg, kind);
      if (typeof toast === "function") return toast(msg, kind);
    } catch {}
  }

  // Scan -> backend route we just added
  window.openScan = async function () {
    try {
      const r = await fetchPostThenGet("/api/printers/open_scan");
      const j = await parseJsonSafe(r);

      if (!r.ok) throw new Error(j?.message || j?.error || `HTTP ${r.status}`);
      // If JSON exists and ok==false, treat as error; otherwise treat 2xx as success
      if (j && j.ok === false) throw new Error(j.message || j.error || "Scan failed");

      toastMsg("Opening Windows Scan…");
    } catch (e) {
      toastMsg("Could not open Windows Scan.", "warning");
      console.warn("openScan failed:", e);
    }
  };

  // Test page -> backend route we just added
  const prevTestPrint = window.testPrint;
  window.testPrint = async function () {
    try {
      const r = await fetchPostThenGet("/api/printers/test_print");
      const j = await parseJsonSafe(r);

      if (!r.ok) throw new Error(j?.message || j?.error || `HTTP ${r.status}`);
      if (j && j.ok === false) throw new Error(j.message || j.error || "Test print failed");

      toastMsg("Test page sent.");
    } catch (e) {
      toastMsg("Could not send test page.", "warning");
      console.warn("testPrint failed:", e);
      // if an older impl exists, try it as a last resort
      try { if (typeof prevTestPrint === "function") return await prevTestPrint(); } catch {}
    }
  };

  // Manage -> your main.py has /api/printers/open_add (may be GET-only and may not return JSON)
  const prevOpenAdd = window.openAddPrinter;
  window.openAddPrinter = async function () {
    try {
      const r = await fetchPostThenGet("/api/printers/open_add");
      const j = await parseJsonSafe(r);

      if (!r.ok) throw new Error(j?.message || j?.error || `HTTP ${r.status}`);
      if (j && j.ok === false) throw new Error(j.message || j.error || "Could not open settings");

      toastMsg("Opening printer settings…");
    } catch (e) {
      toastMsg("Could not open printer settings.", "warning");
      console.warn("openAddPrinter failed:", e);
      try { if (typeof prevOpenAdd === "function") return await prevOpenAdd(); } catch {}
    }
  };
})();

/* =====================================================
   TLI_PRINTERS_FINAL_WIRING_V3
   Fixes (production-safe):
   - Removes false "Error HTTP 200" by accepting array payloads from /api/printers
   - Ensures Manage/Test/Scan always work (POST -> GET fallback)
   - Treats any 2xx as success even if response is not JSON (prevents "HTTP 200" false errors)
   - Single authoritative handlers (prevents duplicate toasts)
   ===================================================== */
(() => {
  const TAG = "TLI_PRINTERS_FINAL_WIRING_V3";

  function toastMsg(msg, kind) {
    try {
      if (typeof showToast === "function") return showToast(msg, kind);
      if (typeof toast === "function") return toast(msg, kind);
    } catch {}
  }

  function setStatus(ok, msg) {
    try {
      if (typeof pill === "function") pill("devices-printers-status", ok ? "OK" : "Error", ok ? "pill-ok" : "pill-warn");
      if (typeof setText === "function") setText("devices-printers-summary", msg || "");
    } catch {}
  }

  async function postThenGet(url) {
    let r = await fetch(url, { method: "POST" });
    if (r.status === 405) r = await fetch(url, { method: "GET" });
    return r;
  }

  async function jsonOrNull(r) {
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("application/json")) return null;
    return await r.json().catch(() => null);
  }

  function normalizePrintersPayload(j) {
    if (Array.isArray(j)) return { ok: true, printers: j };
    if (j && typeof j === "object" && Array.isArray(j.printers)) return { ok: j.ok !== false, printers: j.printers };
    if (j && typeof j === "object" && j.ok === false) return { ok: false, error: j.error || j.message || "Not supported yet" };
    return { ok: false, error: "Unexpected printer payload" };
  }

  // Authoritative refresh: fetch /api/printers and render cards with existing renderPrinters()
  window.refreshPrinters = async function () {
    try {
      try {
        if (typeof pill === "function") pill("devices-printers-status", "Scanning…", "pill-muted");
        if (typeof setText === "function") setText("devices-printers-summary", "");
      } catch {}

      const r = await fetch("/api/printers", { cache: "no-store" });
      const j = await jsonOrNull(r) ?? await r.json().catch(() => null); // try json; tolerate failures

      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      const norm = normalizePrintersPayload(j);
      if (!norm.ok) {
        setStatus(false, norm.error || "Printer service error");
        return;
      }

      const printers = norm.printers || [];
      const msg = `Found ${printers.length} printer(s).`;
      setStatus(true, msg);

      if (typeof renderPrinters === "function") {
        renderPrinters(printers, { total: printers.length });
      }
    } catch (e) {
      setStatus(false, String(e));
      console.warn(TAG, "refreshPrinters failed:", e);
    }
  };

  // Manage: main.py provides POST /api/printers/open_add returning {ok:true}
  window.openAddPrinter = async function () {
    try {
      const r = await postThenGet("/api/printers/open_add");
      const j = await jsonOrNull(r);
      if (!r.ok) throw new Error(j?.message || j?.error || `HTTP ${r.status}`);
      if (j && j.ok === false) throw new Error(j.message || j.error || "Could not open settings");
      toastMsg("Opening printer settings…");
    } catch (e) {
      toastMsg("Could not open printer settings.", "warning");
      console.warn(TAG, "openAddPrinter failed:", e);
    }
  };

  // Test Page: router provides GET|POST /api/printers/test_print returning {ok:true}
  window.testPrint = async function () {
    try {
      const r = await postThenGet("/api/printers/test_print");
      const j = await jsonOrNull(r);
      if (!r.ok) throw new Error(j?.message || j?.error || `HTTP ${r.status}`);
      if (j && j.ok === false) throw new Error(j.message || j.error || "Test print failed");
      toastMsg("Test page sent.");
    } catch (e) {
      toastMsg("Could not send test page.", "warning");
      console.warn(TAG, "testPrint failed:", e);
    }
  };

  // Scan: router provides GET|POST /api/printers/open_scan returning {ok:true}
  window.openScan = async function () {
    try {
      const r = await postThenGet("/api/printers/open_scan");
      const j = await jsonOrNull(r);
      if (!r.ok) throw new Error(j?.message || j?.error || `HTTP ${r.status}`);
      if (j && j.ok === false) throw new Error(j.message || j.error || "Scan launch failed");
      toastMsg("Opening Windows Scan…");
    } catch (e) {
      toastMsg("Could not open Windows Scan.", "warning");
      console.warn(TAG, "openScan failed:", e);
    }
  };

  // Auto-refresh once when loaded — delayed to avoid competing with startup activity
  try { window.setTimeout(() => { try { window.refreshPrinters(); } catch {} }, 8000); } catch {}
})();
