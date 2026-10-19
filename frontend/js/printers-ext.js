(() => {
  let printerEpoch = 0, printerLocked = false, printerRecoveryStarted = false;
  const clearPrinterViews = [];
  const printerCurrent = epoch => !printerLocked && epoch === printerEpoch;
  function clearPrinters() { printerEpoch++; printerRecoveryStarted = false; clearPrinterViews.forEach(clear => clear()); }
  function printerAccessFailure(response, data, epoch) {
    if (response.status !== 401 && response.status !== 403) return false;
    if (printerCurrent(epoch)) clearPrinters();
    // Preserve only the public recovery explanation after the global 401
    // interceptor has cleared this request's private session.
    if (!printerRecoveryStarted && epoch + 1 === printerEpoch) {
      const message = typeof data?.detail === 'string' ? data.detail : 'Unlock TLI and retry the printer request.';
      for (const id of ['devices-printers-summary', 'wia-summary']) {
        const node = document.getElementById(id); if (node) node.textContent = message;
      }
    }
    return true;
  }
  window.addEventListener('tli-session-locked', () => { printerLocked = true; clearPrinters(); });
  window.addEventListener('tli-session-unlocked', () => { printerLocked = false; });
/* === TLI PRINTERS MODULE v2 (locked) === */
/* === TLI PRINTERS MODULE v2 (locked) ===
   Restores: Refresh list + WIA devices + OS open + Test Print
   Backend endpoints expected:
     GET /api/printers
     POST /api/printers/open_add
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
          <div class="tli-empty-sub">Use Printer settings to manage printer installation on the TLI host.</div>
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
    if (printerLocked) return;
    printerRecoveryStarted = true;
    const epoch = printerEpoch;
    pill("wia-status", "Loading…", "pill-muted");
    setText("wia-summary", "Loading WIA devices…");
    const sel = document.getElementById("wia-device");
    if (!sel) return;
    try{
      const { r, j } = await fetchJson("/api/scan/wia/devices");
      if (printerAccessFailure(r, j, epoch) || !printerCurrent(epoch)) return;
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
      if (!printerCurrent(epoch)) return;
      sel.innerHTML = `<option value="">No WIA devices</option>`;
      pill("wia-status", "WIA error", "pill-warn");
      setText("wia-summary", String(e));
    }
  };
  clearPrinterViews.push(() => {
    const sel = document.getElementById('wia-device'); if (sel) { sel.innerHTML = ''; sel.value = ''; }
    pill('wia-status', 'Unavailable', 'pill-warn'); setText('wia-summary', 'Unlock TLI, then refresh scanners.');
  });

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
  clearPrinterViews.push(() => {
    STATE.printers = []; STATE.suppliesByName = {}; STATE.expanded.clear(); STATE.query = '';
    const search = $('tli-printers-search'); if (search) search.value = '';
    updateRollup([]);
    const count = $('tli-printers-count'); if (count) count.textContent = '';
    const box = $('devices-printers-list'); if (box) { box.innerHTML = ''; box.onclick = null; }
  });
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
        </div>
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
        <button class="btn-ghost" id="tli-rollup-manage" title="Open printer settings on the TLI host">Printer settings</button>
        <button class="btn-ghost" id="tli-rollup-test" title="Send test page to default printer">Test page</button>
      </div>
    `;

    $("tli-rollup-manage")?.addEventListener("click", async () => {
      try { return await window.openAddPrinter(); }
      catch { toastMsg("Could not open printer settings.", "warning"); }
    });
    $("tli-rollup-test")?.addEventListener("click", async () => {
      try { return await window.testPrint(); }
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
        <div class="tli-empty-sub">${esc(subtitle || "Use Refresh printers to read the installed list, or Printer settings to manage installation on the host.")}</div>
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
    if (printerLocked) return;
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
              <button class="btn-ghost ps-deeplink-btn" data-printshop="${esc(p?.name || "")}" title="Select this printer in Print &amp; Scan; review before submitting">Open Print &amp; Scan</button>
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
              <button class="btn-ghost" data-manage="${esc(k)}" title="Open printer settings on the TLI host">Printer settings</button>
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
        try { return await window.openAddPrinter(); }
        catch { toastMsg("Could not open printer screen.", "warning"); }
        return;
      }
      const test = ev.target?.closest?.("button[data-test]");
      if (test && !test.disabled) {
        try { return await window.testPrint(); }
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


  async function fetchSupplies(epoch) {
    // Returns map: printer_name -> result object from /api/printers/supplies
    try {
      const r = await fetch("/api/printers/supplies", { cache: "no-store" });
      const j = await r.json().catch(() => null);
      if (printerAccessFailure(r, j, epoch) || !printerCurrent(epoch)) return {};
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
      if (printerLocked) return;
      const epoch = printerEpoch;
      try { ensureToolbar(); renderLoading(); } catch {}
      let res;
      try { res = await original(); } catch (e) { console.warn(TAG, "original refresh error:", e); }
      if (!printerCurrent(epoch)) return;
      if (!res?.ok) { STATE.printers = []; STATE.suppliesByName = {}; updateRollup([]); renderEmpty('Printer list unavailable', 'Refresh printers when ready.'); return res; }
      try {
        const supplies = await fetchSupplies(epoch);
        if (!printerCurrent(epoch)) return;
        STATE.printers = res.printers;
        STATE.suppliesByName = supplies;
        render();} catch (e) {
        if (!printerCurrent(epoch)) return;
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

/* =====================================================
   TLI_PRINTERS_FINAL_WIRING_V3
   Fixes (production-safe):
   - Removes false "Error HTTP 200" by accepting array payloads from /api/printers
   - Submit printer actions with POST only; never replay an uncertain action.
   - Require explicit execution confirmation; HTTP success alone is not enough.
   - Serialize duplicate requests and never retry a failed action automatically.
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
    const pill = document.getElementById("devices-printers-status");
    const summary = document.getElementById("devices-printers-summary");
    if (pill) { pill.textContent = ok === null ? "Working…" : ok ? "Confirmed" : "Failed"; pill.className = "pill " + (ok === null ? "pill-muted" : ok ? "pill-ok" : "pill-warn"); }
    if (summary) summary.textContent = msg || "";
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
    if (printerLocked) return;
    printerRecoveryStarted = true;
    const epoch = printerEpoch;
    try {
      try {
        if (typeof pill === "function") pill("devices-printers-status", "Scanning…", "pill-muted");
        if (typeof setText === "function") setText("devices-printers-summary", "");
      } catch {}

      const r = await fetch("/api/printers", { cache: "no-store" });
      const j = await jsonOrNull(r) ?? await r.json().catch(() => null); // try json; tolerate failures

      if (printerAccessFailure(r, j, epoch) || !printerCurrent(epoch)) return;
      if (!r.ok) throw new Error(j?.detail || j?.message || `HTTP ${r.status}`);

      const norm = normalizePrintersPayload(j);
      if (!norm.ok) {
        setStatus(false, norm.error || "Printer service error");
        return;
      }

      const printers = norm.printers || [];
      const msg = `Found ${printers.length} printer(s).`;
      setStatus(true, msg);

      return {ok: true, printers};
    } catch (e) {
      if (!printerCurrent(epoch)) return;
      setStatus(false, String(e));
      console.warn(TAG, "refreshPrinters failed:", e);
    }
  };

  // One owner for printer mutations. Existing data-action bindings call these
  // named handlers; button text in other panels is never an execution trigger.
  const pending = new Map();
  clearPrinterViews.push(() => { setStatus(false, 'Unlock TLI, then refresh printers before using printer controls.'); });
  const actions = {
    openAddPrinter: {url: "/api/printers/open_add", progress: "Opening printer settings on the TLI host…", success: "Printer settings opened on the TLI host.", failure: "Could not open printer settings.", extra: '[data-manage], #tli-rollup-manage'},
    testPrint: {url: "/api/printers/test_print", progress: "Submitting a test page to the host’s default printer…", success: "Test page submitted to the host’s default printer. Check the printer for physical output.", failure: "Could not submit the test page.", extra: '[data-test], #tli-rollup-test'},
    openScan: {url: "/api/printers/open_scan", progress: "Opening the scanner app on the TLI host…", success: "Scanner app opened on the TLI host. No document was scanned by this action.", failure: "Could not open the scanner app.", extra: ''}
  };
  function runPrinterAction(name) {
    if (printerLocked) return Promise.resolve({ok: false, message: "Unlock TLI before using printer controls."});
    if (pending.has(name)) return pending.get(name);
    printerRecoveryStarted = true;
    const action = actions[name], epoch = printerEpoch;
    const selectors = [`#panel-devices [data-action="${name}"]`];
    if (action.extra) selectors.push(...action.extra.split(',').map(selector => '#panel-devices ' + selector.trim()));
    const controls = [...document.querySelectorAll(selectors.join(', '))].map(control => ({control, disabled: control.disabled}));
    controls.forEach(({control}) => { control.disabled = true; });
    setStatus(null, action.progress);
    const work = Promise.resolve().then(async () => {
      if (!printerCurrent(epoch)) return {ok: false, message: "Printer request stopped before submission because TLI locked."};
      try {
        const response = await fetch(action.url, {method: 'POST'});
        const data = await jsonOrNull(response);
        if (printerAccessFailure(response, data, epoch)) return {ok:false, message: typeof data?.detail === 'string' ? data.detail : 'Unlock TLI before retrying.'};
        if (!printerCurrent(epoch)) return {ok:false, hidden:true};
        if (!response.ok || data?.ok !== true) throw new Error(data?.message || data?.detail || data?.error || (response.ok ? "The host did not confirm the action." : `HTTP ${response.status}`));
        const result = {...data, ok: true, message: action.success};
        if (printerCurrent(epoch)) { setStatus(true, action.success); toastMsg(action.success); }
        return result;
      } catch (error) {
        const message = action.failure + " " + error.message + " Retry explicitly when ready.";
        if (printerCurrent(epoch)) { setStatus(false, message); toastMsg(message, "warning"); }
        return {ok: false, message};
      }
    }).finally(() => {
      pending.delete(name);
      controls.forEach(({control, disabled}) => { control.disabled = disabled; });
    });
    pending.set(name, work);
    return work;
  }
  for (const name of Object.keys(actions)) window[name] = () => runPrinterAction(name);
  // Retained compatibility names do not enable unverified legacy workflows.
  window.discoverPrinters = async () => ({ok: false, message: "Use Refresh printers to read the installed printer list."});
  window.fixPrinter = async () => ({ok: false, message: "Automatic printer repair is unavailable. Open Printer settings to review the device."});

  // Auto-refresh once when loaded — delayed to avoid competing with startup activity
  try { window.setTimeout(() => { try { window.refreshPrinters(); } catch {} }, 8000); } catch {}
})();
})();
