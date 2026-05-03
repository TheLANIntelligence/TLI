// TLI Bundled AI Model Manager
(function () {
  if (window.__TLI_MODEL_MANAGER_MM2_V2__) return;
  window.__TLI_MODEL_MANAGER_MM2_V2__ = true;

  const overlayId = "model-manager-modal-overlay";

  
  let __mm2AutoRefresh = null;
function el(id){ return document.getElementById(id); }

  function showOverlay(){
    const ov = el(overlayId);
    if (!ov) return false;
    ov.classList.remove("hidden");
    ov.setAttribute("aria-hidden", "false");
    return true;
  }

  function hideOverlay(){
    const ov = el(overlayId);
    if (!ov) return;
    ov.classList.add("hidden");
    ov.setAttribute("aria-hidden", "true");
    stopAutoRefresh();
  }


  function startAutoRefresh(){
    if (__mm2AutoRefresh) return;
    __mm2AutoRefresh = setInterval(function(){
      const ov = el(overlayId);
      if (!ov || ov.classList.contains("hidden") || ov.getAttribute("aria-hidden")==="true") return;
      refresh();
    }, 1000);
  }

  function stopAutoRefresh(){
    if (__mm2AutoRefresh){
      clearInterval(__mm2AutoRefresh);
      __mm2AutoRefresh = null;
    }
  }
  function setProgress(msg){
    const box = el("model-manager-progress");
    if (box) box.textContent = String(msg || "");
  }

  function setBar(pct, meta){
    const bar = el("model-manager-bar");
    if (bar){
      const v = Math.max(0, Math.min(100, Number(pct) || 0));
      bar.style.width = v.toFixed(1) + "%";
    }
    const m = el("model-manager-bar-meta");
    if (m) m.textContent = meta == null ? "—" : String(meta);
  }

  function fmtBytes(n){
    const v = Number(n) || 0;
    const mb = v / (1024*1024);
    if (mb < 1024) return mb.toFixed(1) + " MB";
    return (mb/1024).toFixed(2) + " GB";
  }

  async function refresh(){
    // Reset indicators (truth will set them)    setBar(0, "—");

    try{
      const r = await fetch("/api/ai/model/info", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const info = await r.json();

      if (el("model-manager-expected-name") && info.expected_name) el("model-manager-expected-name").textContent = info.expected_name;
      if (el("model-manager-expected-path") && info.expected_path) el("model-manager-expected-path").textContent = info.expected_path;

      if (el("model-manager-exists")){
        el("model-manager-exists").textContent = info.exists ? "Model found" : "Not downloaded";
        el("model-manager-exists").classList.toggle("yes", !!info.exists);
        el("model-manager-exists").classList.toggle("no", !info.exists);
      }

      // Always prefer backend recommended_url (it can be changed without frontend rebuild)
      const urlEl = el("model-manager-url");
      if (urlEl && info.recommended_url) urlEl.value = info.recommended_url;

      if (info.exists){
        setProgress("Model found.\nIntegrated AI can start.");
        // Hide the no-AI banner in the chat panel now that a model exists
        const noAiBanner = document.getElementById("tli-no-ai-banner");
        if (noAiBanner) noAiBanner.classList.add("hidden");
      } else {
        setProgress("Model file is missing.\nSelect it or download it here.");
      }
    } catch (e){
      setProgress("Could not query /api/ai/model/info.\n" + (e && e.message ? e.message : e));
    }
  }

  async function pollProgress(){
    const startedAt = Date.now();
    let lastDone = 0;
    let lastTs = startedAt;

    while (true){
      let st = null;
      try{
        const urlEl = el("model-manager-url");
        const qUrl = (urlEl && urlEl.value) ? ("?url=" + encodeURIComponent(urlEl.value)) : "";
        const r = await fetch("/api/ai/model/progress" + qUrl, { cache: "no-store" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        st = await r.json();
      } catch (e){
        setProgress("Could not read download progress.\n" + (e && e.message ? e.message : e));
        return;
      }

      const status = String(st.status || "idle");
      const done = Number(st.bytes_done || 0);
      const total = Number(st.bytes_total || 0);
      const pct = total > 0 ? (done / total * 100) : 0;

      const now = Date.now();
      const dt = Math.max(0.25, (now - lastTs) / 1000);
      const speed = (done - lastDone) / dt; // bytes/sec
      lastDone = done;
      lastTs = now;

      // UI updates
      if (status === "downloading"){
        const meta = total > 0
          ? `${fmtBytes(done)} / ${fmtBytes(total)} · ${(speed/(1024*1024)).toFixed(1)} MB/s`
          : `${fmtBytes(done)} · ${(speed/(1024*1024)).toFixed(1)} MB/s`;
        setBar(total > 0 ? pct : 0, meta);
        setProgress(`Downloading… ${total > 0 ? pct.toFixed(1) + "%" : ""}\n${meta}`);
      } else if (status === "starting_ai"){        setBar(100, "Download complete · starting AI…");
        setProgress("Download complete.\nStarting Integrated AI…");
      } else if (status === "complete"){        setBar(100, "Download complete.");
        setProgress("Download complete.\nModel saved. You can close this window.");
        await refresh();
        return;
      } else if (status === "error"){
        setBar(0, "—");
        setProgress("Download failed.\n" + (st.error || "Unknown error") + "\n\nTip: If download fails, you can still select a local .gguf and TLI will place it at the expected path.");
        return;
      } else {
        // idle/unknown
        const elapsed = (Date.now() - startedAt) / 1000;
        if (elapsed > 3){
          // not moving; bail with a useful message
          setProgress("Download did not start.\nIf your installer backend is missing the /api/ai/model/* endpoints, rebuild the installer backend.\n\nTip: Use the Open button for manual download.");
          return;
        }
      }

      await new Promise(res => setTimeout(res, 500));
    }
  }

  async function startDownload(){
    // Always clear visual indicators at the start    setBar(0, "—");

    const url = el("model-manager-url")?.value || "";
    if (!url) { setProgress("No download URL set."); return; }

    try{
      setProgress("Starting download via backend…");
      const r = await fetch("/api/ai/model/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url })
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      await r.json().catch(() => ({}));
      await pollProgress();
    } catch (e){
      // Do NOT auto-open browser (proxy/captive portal causes credential popups)
      setProgress(
        "Backend download not available.\n\n" +
        "This usually means your running backend build is missing /api/ai/model/* endpoints, OR the request is being blocked.\n\n" +
        "Workaround:\n" +
        "1) Click Open to open the URL manually\n" +
        "2) Download the .gguf in your browser\n" +
        "3) Place it at the expected path shown above\n" +
        "4) Click Recheck\n\n" +
        (e && e.message ? e.message : e)
      );
    }
  }

  function bindOnce(){
    const close = el("model-manager-close");
    if (close && !close.__b){ close.__b = true; close.addEventListener("click", hideOverlay); }

    const x = el("model-manager-x");
    if (x && !x.__b){ x.__b = true; x.addEventListener("click", hideOverlay); }

    const ov = el(overlayId);
    if (ov && !ov.__b){
      ov.__b = true;
      ov.addEventListener("click", (e) => { if (e.target && e.target.id === overlayId) hideOverlay(); });
    }
    const copy = el("model-manager-copy");
    if (copy && !copy.__b){
      copy.__b = true;
      copy.addEventListener("click", async () => {
        const url = el("model-manager-url")?.value || "";
        try{ await navigator.clipboard.writeText(url); setProgress("Link copied.\n" + url); }
        catch{ setProgress("Copy failed. Manually copy:\n" + url); }
      });
    }

    const reveal = el("model-manager-reveal");
    if (reveal && !reveal.__b){
      reveal.__b = true;
      reveal.addEventListener("click", async () => {
        try{
          await fetch("/api/ai/model/reveal", {method:"POST"});
          setProgress("Opened models folder.");
        }catch{ setProgress("Could not open models folder."); }
      });
    }

    const cancelBtn = el("model-manager-cancel");
    if (cancelBtn && !cancelBtn.__b){
      cancelBtn.__b = true;
      cancelBtn.addEventListener("click", async () => {
        cancelBtn.disabled = true;
        try{
          await fetch("/api/ai/model/cancel", {method:"POST"});
          setProgress("Download cancelled.");
          setBar(0);
          el("model-manager-bar-meta").textContent = "—";
          await refresh();
        }catch{ setProgress("Cancel failed."); }
        cancelBtn.disabled = false;
      });
    }

    const dl = el("model-manager-download");
    if (dl && !dl.__b){
      dl.__b = true;
      dl.addEventListener("click", startDownload);
    }

    const sel = el("model-manager-select");
    const file = el("model-manager-file");
    if (sel && file && !sel.__b){
      sel.__b = true;
      sel.addEventListener("click", () => file.click());
      file.addEventListener("change", async () => {
        const f = file.files && file.files[0];
        if (!f) return;
        setProgress("Selected: " + f.name + "\nAttempting upload…");
        try{
          const fd = new FormData();
          fd.append("file", f);
          const r = await fetch("/api/ai/model/upload", { method: "POST", body: fd });
          if (!r.ok) throw new Error("HTTP " + r.status);
          const j = await r.json().catch(() => ({}));
          setProgress("Upload complete.\n" + (j.message || "Recheck to confirm."));
          await refresh();
        } catch (e){
          setProgress("Upload endpoint not available.\nPlace file manually at expected path, then Recheck.\n\nSelected: " + f.name);
        }
      });
    }
// NOTE: Header Manage button (#ai-manage-btn) is handled by AI Source-of-Truth v2.
// Here we only bind legacy buttons if present.
const legacyManage = document.getElementById("ai-status-manage-btn");
if (legacyManage && !legacyManage.__mm2b){
  legacyManage.__mm2b = true;
  legacyManage.addEventListener("click", open);
}

// ---- Storage location status + Devices link ----
const goDevicesBtn = el("mm2-storage-go-devices-btn");
if (goDevicesBtn && !goDevicesBtn.__mmb) {
  goDevicesBtn.__mmb = true;
  goDevicesBtn.addEventListener("click", () => {
    hideOverlay();
    if (typeof switchPanel === "function") switchPanel("panel-devices");
    if (typeof refreshUsbDevices === "function") refreshUsbDevices();
  });
}

async function loadStorageInfo() {
  try {
    const r = await fetch("/api/ai/storage/location", { cache: "no-store" });
    if (!r.ok) return;
    const d = await r.json();
    const pathEl = el("mm2-storage-path");
    const freeEl = el("mm2-storage-free");
    if (pathEl) pathEl.textContent = d.path || "—";
    if (freeEl) freeEl.textContent = d.free_gb != null ? `${d.free_gb} GB free` : "";
  } catch {}
}

loadStorageInfo();
}

// ─── Save-to picker ────────────────────────────────────────────────────────

let _savetoCurrentPath = "";

async function loadSaveToPicker() {
  const pathEl   = el("mm2-saveto-path");
  const freeEl   = el("mm2-saveto-free");
  const picker   = el("mm2-saveto-picker");
  const changeBtn = el("mm2-saveto-change-btn");
  if (!pathEl) return;

  // Fetch current save location and connected USB drives in parallel
  let locData = null;
  let usbData = null;
  try {
    [locData, usbData] = await Promise.all([
      fetch("/api/ai/storage/location", { cache: "no-store" }).then(r => r.ok ? r.json() : null),
      fetch("/devices/usb", { cache: "no-store" }).then(r => r.ok ? r.json() : null),
    ]);
  } catch {}

  if (!locData) { pathEl.textContent = "Unknown"; return; }

  _savetoCurrentPath = locData.path || "";
  pathEl.textContent = _savetoCurrentPath;
  freeEl.textContent = locData.free_gb != null ? `${locData.free_gb} GB free` : "";

  // Build options: default TLI location + each USB drive
  const sep = _savetoCurrentPath.includes("/") ? "/" : "\\";
  const options = [
    {
      name: "TLI Default",
      path: _savetoCurrentPath,
      free_gb: locData.free_gb,
      icon: "💻",
    },
  ];

  const drives = (usbData && usbData.devices) || [];
  for (const d of drives) {
    const mount = (d.mount_path || "").replace(/[\\/]+$/, "");
    if (!mount) continue;
    const aiPath = mount + (mount.includes("/") ? "/TLI_Models" : "\\TLI_Models");
    options.push({
      name: d.name || mount,
      path: aiPath,
      free_gb: d.size_bytes != null ? null : null, // size_bytes is total; skip for now
      icon: "💾",
    });
  }

  // Render picker items
  if (picker) {
    picker.innerHTML = options.map((opt, i) => {
      const isActive = opt.path === _savetoCurrentPath;
      const freeStr = opt.free_gb != null ? ` · ${opt.free_gb} GB free` : "";
      return `<button class="mm2-saveto-option${isActive ? " active" : ""}" data-saveto-path="${_esc(opt.path)}">
        <span class="mm2-saveto-opt-icon">${opt.icon}</span>
        <span class="mm2-saveto-opt-info">
          <div class="mm2-saveto-opt-name">${_esc(opt.name)}${freeStr}</div>
          <div class="mm2-saveto-opt-path">${_esc(opt.path)}</div>
        </span>
      </button>`;
    }).join("");

    picker.querySelectorAll(".mm2-saveto-option").forEach(btn => {
      btn.addEventListener("click", async () => {
        const newPath = btn.getAttribute("data-saveto-path");
        if (!newPath) return;
        btn.disabled = true;
        try {
          const r = await fetch("/api/ai/storage/location", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: newPath }),
          });
          const d = await r.json();
          if (d.ok) {
            _savetoCurrentPath = d.path || newPath;
            pathEl.textContent = _savetoCurrentPath;
            freeEl.textContent = "";
            // Refresh with updated free space
            setTimeout(loadSaveToPicker, 200);
            if (picker) picker.classList.add("hidden");
          }
        } catch {}
        btn.disabled = false;
      });
    });
  }

  // Wire Change button (idempotent)
  if (changeBtn && !changeBtn.__stb) {
    changeBtn.__stb = true;
    changeBtn.addEventListener("click", () => {
      if (!picker) return;
      const isHidden = picker.classList.contains("hidden");
      picker.classList.toggle("hidden", !isHidden);
      changeBtn.textContent = isHidden ? "Done" : "Change";
    });
  }
}

// Expose so mesh.js "Use for AI models" can refresh it after setting a path
window._tliRefreshSaveToPicker = loadSaveToPicker;

  function open(){
    if (!showOverlay()){ alert("Model setup overlay not found."); return; }
    refresh();
    loadSaveToPicker();
    if(typeof window._mm4RenderTierCards === "function") window._mm4RenderTierCards();
  }

  // Expose API expected by header/manage
  window.tliOpenModelManagerModal = open;

  function boot(){
    bindOnce();
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      bindOnce();
      if (tries > 40) clearInterval(t);
    }, 250);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

/* ── Model Manager v4: tier card UI ──────────────────────────────── */
(function(){
  const TIER_ORDER = ["lite","standard","power","vision"];
  const TIER_ICONS = { lite:"⚡", standard:"★", power:"🔥", vision:"👁" };
  let _dlPresetId = null; // which preset is currently downloading

  function $m(id){ return document.getElementById(id); }
  function setStatus(msg){ const el=$m("model-manager-progress"); if(el) el.textContent = msg||""; }
  function showProgress(show){
    const w=$m("mm2-progresswrap");
    if(w){ w.classList.toggle("hidden",!show); }
  }
  function setBar(pct, meta){
    const b=$m("model-manager-bar"); if(b) b.style.width=Math.max(0,Math.min(100,pct||0)).toFixed(1)+"%";
    const m=$m("model-manager-bar-meta"); if(m) m.textContent=meta||"—";
  }
  function fmtBytes(n){ const mb=n/(1024*1024); return mb<1024?mb.toFixed(1)+" MB":(mb/1024).toFixed(2)+" GB"; }

  async function renderTierCards(){
    const container=$m("mm2-tiers");
    if(!container) return;
    container.innerHTML='<div class="mm2-tiers-loading">Loading models…</div>';
    let data;
    try{
      const r=await fetch("/api/ai/models/presets",{cache:"no-store"});
      if(!r.ok) throw new Error("HTTP "+r.status);
      data=await r.json();
    }catch(e){
      container.innerHTML='<div class="mm2-tiers-loading">Could not load model list.</div>';
      return;
    }
    const presets=data.presets||[];
    const active=data.active||"standard";

    container.innerHTML="";
    for(const pid of TIER_ORDER){
      const p=presets.find(x=>x.id===pid);
      if(!p) continue;
      const isActive=p.is_active||false;
      const isDl=p.downloaded||false;
      const isRec=pid==="standard";

      const card=document.createElement("div");
      card.className="mm2-tier-card"+(isActive?" active":"")+(isRec?" recommended":"");
      card.dataset.preset=pid;

      let badges="";
      if(isActive) badges+=`<span class="mm2-tier-badge active-badge">Active</span>`;
      else if(isDl) badges+=`<span class="mm2-tier-badge downloaded">Downloaded</span>`;

      const sizeInfo=p.size_human||(p.size_bytes?fmtBytes(p.size_bytes):"");
      const ramInfo=p.min_ram_gb?`${p.min_ram_gb} GB RAM`:"";

      let actions="";
      if(isActive){
        actions=`<button class="mm2-tier-btn ghost-active" disabled>Running</button>`;
      } else if(isDl){
        actions=`<button class="mm2-tier-btn ghost-active mm2-use-btn" data-preset="${pid}">Use this model</button>`;
      } else {
        actions=`<button class="mm2-tier-btn primary mm2-dl-btn" data-preset="${pid}">Download ${sizeInfo}</button>`;
      }

      card.innerHTML=`
        <div class="mm2-tier-name">${TIER_ICONS[pid]||""} ${p.name||pid} ${badges}</div>
        <div class="mm2-tier-desc">${p.description||""}</div>
        <div class="mm2-tier-meta">
          ${sizeInfo?`<span>💾 ${sizeInfo}</span>`:""}
          ${ramInfo?`<span>🧠 ${ramInfo}`:""}
        </div>
        <div class="mm2-tier-actions">${actions}</div>`;
      container.appendChild(card);
    }

    // Bind download buttons
    container.querySelectorAll(".mm2-dl-btn").forEach(btn=>{
      btn.addEventListener("click",async(e)=>{
        e.stopPropagation();
        const pid=btn.dataset.preset;
        await startPresetDownload(pid);
      });
    });
    // Bind use/switch buttons
    container.querySelectorAll(".mm2-use-btn").forEach(btn=>{
      btn.addEventListener("click",async(e)=>{
        e.stopPropagation();
        const pid=btn.dataset.preset;
        setStatus("Switching model…");
        try{
          const r=await fetch("/api/ai/models/select",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({preset_id:pid})});
          const j=await r.json().catch(()=>({}));
          setStatus(r.ok?(j.message||"Model switched. Restart AI to apply."):"Switch failed: "+(j.detail||r.status));
        }catch(e2){ setStatus("Switch failed: "+e2.message); }
        setTimeout(renderTierCards,600);
      });
    });
  }

  async function startPresetDownload(pid){
    _dlPresetId=pid;
    showProgress(true);
    setStatus("Starting download…");
    setBar(0,"—");
    const label=$m("mm2-prog-label");
    if(label) label.textContent="Downloading…";

    try{
      const r=await fetch("/api/ai/model/download",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({preset_id:pid})
      });
      if(!r.ok) throw new Error("HTTP "+r.status);
      await pollDownload(pid);
    }catch(e){
      setStatus("Download failed: "+e.message+"\n\nTip: Download the .gguf manually and use Select .gguf… to add it.");
      showProgress(false);
    }
  }

  async function pollDownload(pid){
    const startedAt=Date.now();
    let lastDone=0, lastTs=startedAt;
    while(true){
      let st=null;
      try{
        const r=await fetch("/api/ai/model/progress",{cache:"no-store"});
        if(!r.ok) throw new Error("HTTP "+r.status);
        st=await r.json();
      }catch(e){ setStatus("Progress check failed: "+e.message); showProgress(false); return; }

      const status=String(st.status||"idle");
      const done=Number(st.bytes_done||0);
      const total=Number(st.bytes_total||0);
      const pct=total>0?(done/total*100):0;
      const now=Date.now();
      const dt=Math.max(0.25,(now-lastTs)/1000);
      const speed=(done-lastDone)/dt;
      lastDone=done; lastTs=now;

      if(status==="downloading"){
        const meta=total>0
          ?`${fmtBytes(done)} / ${fmtBytes(total)} · ${(speed/(1024*1024)).toFixed(1)} MB/s`
          :`${fmtBytes(done)} downloaded`;
        setBar(pct,meta);
        setStatus(`Downloading… ${total>0?pct.toFixed(1)+"%":""}\n${meta}`);
      } else if(status==="starting_ai"||status==="complete"){
        setBar(100,"Complete");
        setStatus("Download complete. Model ready.");
        showProgress(false);
        setTimeout(renderTierCards, 400);
        return;
      } else if(status==="error"){
        setBar(0,"—");
        setStatus("Download failed: "+(st.error||"Unknown error")+"\n\nUse Select .gguf… to add a manually downloaded file.");
        showProgress(false);
        return;
      } else {
        const elapsed=(Date.now()-startedAt)/1000;
        if(elapsed>4){
          setStatus("Download did not start. Try again or use Select .gguf… to add a file manually.");
          showProgress(false);
          return;
        }
      }
      await new Promise(res=>setTimeout(res,500));
    }
  }

  // Wire cancel
  function wireCancel(){
    const c=$m("model-manager-cancel");
    if(c&&!c.__v4b){
      c.__v4b=true;
      c.addEventListener("click",async()=>{
        c.disabled=true;
        try{ await fetch("/api/ai/model/cancel",{method:"POST"}); }catch{}
        setStatus("Download cancelled.");
        showProgress(false);
        c.disabled=false;
        renderTierCards();
      });
    }
  }

  // Wire select GGUF (file upload)
  function wireSelect(){
    const sel=$m("model-manager-select");
    const file=$m("model-manager-file");
    if(sel&&file&&!sel.__v4b){
      sel.__v4b=true;
      sel.addEventListener("click",()=>file.click());
      file.addEventListener("change",async()=>{
        const f=file.files&&file.files[0];
        if(!f) return;
        setStatus("Uploading: "+f.name+"…");
        try{
          const fd=new FormData(); fd.append("file",f);
          const r=await fetch("/api/ai/model/upload",{method:"POST",body:fd});
          const j=await r.json().catch(()=>({}));
          setStatus(r.ok?"Upload complete. "+( j.message||""):"Upload failed: "+(j.detail||r.status));
          renderTierCards();
        }catch(e){ setStatus("Upload failed: "+e.message); }
      });
    }
  }

  // Wire open models folder
  function wireReveal(){
    const r=$m("model-manager-reveal");
    if(r&&!r.__v4b){
      r.__v4b=true;
      r.addEventListener("click",async()=>{
        try{ await fetch("/api/ai/model/reveal",{method:"POST"}); setStatus("Opened models folder."); }
        catch{ setStatus("Could not open models folder."); }
      });
    }
  }

  function boot(){
    wireCancel(); wireSelect(); wireReveal();
    let t=0;
    const iv=setInterval(()=>{ wireCancel();wireSelect();wireReveal(); if(++t>30)clearInterval(iv); },300);
  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",boot);
  else boot();

  window._mm4RenderTierCards=renderTierCards;
})();
