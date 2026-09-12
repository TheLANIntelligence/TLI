// TLI AI Source of Truth
(function () {
  if (window.__TLI_AI_SOURCE_OF_TRUTH_V2__) return;
  window.__TLI_AI_SOURCE_OF_TRUTH_V2__ = true;

  const pillEl = () => document.getElementById("ai-source-pill");
  const pillTextEl = () => document.getElementById("ai-source-text");
  const chatBadgeEl = () => document.getElementById("ai-source-badge");
  const manageBtnEl = () => document.getElementById("ai-manage-btn");

  const POLL_MS = 20000;
  const STALE_MS = 30000;
  const PROBE_MS = 3000;
  let lastDisplay = null;
  let facts = null;
  let lastRoute = null;
  let inFlight = null;
  let routeInFlight = null;
  let epoch = 0;
  let locked = false;
  let displayCheckedAt = null;
  const probes = new Set();

  function setPill(text, state, title, badgeText) {
    try {
      const p = pillEl();
      const t = pillTextEl();
      if (t) t.textContent = (text != null && text !== "" ? text : (t.textContent || "AI: Checking…"));
      if (p) {
        p.classList.remove("ai-online", "ai-degraded", "ai-offline", "ai-local", "ai-lan");
        if (state === "ok") p.classList.add("ai-online");
        else if (state === "warn") p.classList.add("ai-degraded");
        else p.classList.add("ai-offline");
        if (title != null) p.title = title;
      }
    } catch {}
    setChatBadge(text, state, title, badgeText);
  }
  // Existing SSE callers report the source of an actual answer. Keep both
  // displays together without changing the selected provider or route policy.
  window.__tliSetAIPill = (text, state, title) => {
    if (!locked) {
      setPill(text, state, title);
      publishDisplay({ text, state, title, kind: 'answer' }, Date.now());
    }
  };

  function publishDisplay(display, checkedAt) {
    const changed = JSON.stringify(lastDisplay) !== JSON.stringify(display) || displayCheckedAt !== checkedAt;
    lastDisplay = display;
    displayCheckedAt = checkedAt;
    if (changed && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('tli-ai-source-changed', { detail: { ...display, checkedAt } }));
    }
  }

  function setChatBadge(text, state, title, badgeText) {
    try {
      const b = chatBadgeEl();
      if (!b) return;
      b.textContent = badgeText || (state === "ok" ? `${text} · Ready` : text);
      b.title = title || "Open the model library for provider details.";
      b.classList.remove("badge-ok", "badge-warn", "badge-err");
      if (state === "ok") b.classList.add("badge-ok");
      else if (state === "warn") b.classList.add("badge-warn");
      else b.classList.add("badge-err");
    } catch {}
  }

  async function readJSON(url) {
    const controller = new AbortController();
    probes.add(controller);
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetch(url, { cache: "no-store", signal: controller.signal });
          if (!response.ok) return { data: null, auth: response.status === 401 || response.status === 403 };
          const data = await response.json();
          return { data: data && typeof data === "object" && !Array.isArray(data) ? data : null };
        })(),
        new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ data: null }); }, PROBE_MS); }),
      ]);
    } catch { return { data: null }; }
    finally { clearTimeout(timer); probes.delete(controller); }
  }

  async function probeBundled() {
    const [info, runtime, mesh] = await Promise.all([
      readJSON("/api/ai/model/info"), readJSON("/api/ai/bundled/status"), readJSON("/api/ai/mesh/status"),
    ]);
    const out = { modelExists: null, healthy: null, statusKnown: false, meshAvailable: null, meshPeer: null,
      auth: !!(info.auth || runtime.auth || mesh.auth), checkedAt: Date.now() };
    if (typeof info.data?.exists === "boolean") out.modelExists = info.data.exists;
    else if (typeof runtime.data?.model_exists === "boolean") out.modelExists = runtime.data.model_exists;
    let status = runtime.data;
    if (typeof status?.healthy !== "boolean" && !out.auth) {
      const fallback = await readJSON("/api/ai/status");
      status = fallback.data;
      out.auth = !!fallback.auth;
    }
    if (typeof status?.healthy === "boolean") out.healthy = status.healthy;
    else if (typeof info.data?.healthy === "boolean") out.healthy = info.data.healthy;
    if (out.modelExists === null && typeof status?.model_exists === "boolean") out.modelExists = status.model_exists;
    out.statusKnown = typeof out.healthy === "boolean";
    if (mesh.data?.available === false) out.meshAvailable = false;
    if (mesh.data?.available === true && mesh.data?.source === "mesh" && mesh.data?.peer) {
      out.meshAvailable = true;
      out.meshPeer = mesh.data.peer;
    }
    out.checkedAt = Date.now();
    return out;
  }

  function displayFromRoute(route, bundled) {
    const unknown = { text: "AI: Not confirmed", state: "warn", title: "AI availability could not be confirmed. Open the model library to check providers.", kind: "unknown" };
    if (locked || bundled?.auth) return { text: "AI: Check access", state: "warn", title: "Unlock TLI to check AI availability.", kind: "unknown" };
    const cache = typeof AIStatus !== "undefined" ? AIStatus : window.AIStatus;
    const fresh = checkedAt => Number.isFinite(checkedAt) && checkedAt > 0 && Date.now() - checkedAt <= STALE_MS;
    const local = cache?.local;
    const lmOk = local?.available === true && local?.health === "ok" && fresh(local.lastCheckedMs);
    const lanOk = cache?.lan?.available === true && fresh(cache.lan.lastCheckedMs);
    const policy = typeof AI_POLICY !== "undefined" ? AI_POLICY : "AUTO";
    const allowLocal = policy !== "LAN_ONLY";
    const allowMesh = policy !== "LOCAL_ONLY";
    const current = bundled && fresh(bundled.checkedAt) ? bundled : null;
    const node = route?.node || cache?.lan?.nodes?.[0] || current?.meshPeer;
    const meshOk = allowMesh && (lanOk || current?.meshAvailable === true);
    const meshDisplay = { text: "AI: Mesh", state: "ok", title: `AI available on ${node?.name || node?.ip || "a LAN host"}. The source used for an answer is reported when it responds.`, kind: "mesh" };
    const source = String(route?.source || "none").toLowerCase();
    if (meshOk && (source === "lan_llm" || policy === "LAN_ONLY" || policy === "PREFER_LAN_ALLOW_LOCAL")) return meshDisplay;
    if (allowLocal && lmOk && source === "local_llm") return { text: "AI: LM Studio", state: "ok", title: "The latest LM Studio check confirmed availability.", kind: "lmstudio" };
    if (allowLocal && current?.healthy === true) return { text: "AI: Integrated", state: "ok", title: "The latest bundled runtime check confirmed availability.", kind: "bundled" };
    if (meshOk) return meshDisplay;
    if (!allowLocal) return { ...unknown, title: "LAN-only AI is selected. A LAN provider has not been confirmed; local models do not change this setting." };
    if (current?.healthy === false) return { text: "AI: Unavailable", state: "warn", title: "The bundled runtime did not pass its latest health check. Open the model library for details.", kind: "off" };
    if (current?.modelExists === true) return { ...unknown, title: "The integrated model is installed, but runtime health has not been confirmed." };
    if (bundled && !current) return { ...unknown, title: "The last AI check is over 30 seconds old. Availability needs a fresh check." };
    return unknown;
  }

  function renderRoute(route) {
    if (route) lastRoute = route;
    const display = displayFromRoute(lastRoute, facts);
    setPill(display.text, display.state, display.title);
    publishDisplay(display, facts?.checkedAt || null);
    window.__tliActiveAISource = display.kind;
    return display;
  }

  function refreshAll({ force = false } = {}) {
    if (locked) return Promise.resolve(renderRoute());
    if (inFlight) return inFlight;
    if (!lastDisplay) setPill("AI: Checking…", "warn", "Checking AI availability…");
    const generation = epoch;
    // Existing route resolution remains authoritative. Do not start overlapping
    // route probes or hold the bundled display hostage to a slow provider.
    if (!routeInFlight && typeof resolveIntelligenceRoute === "function") {
      routeInFlight = Promise.resolve().then(() => resolveIntelligenceRoute({ forceRefresh: !!force }))
        .then(route => { if (generation === epoch) renderRoute(route); }).catch(() => {})
        .finally(() => { routeInFlight = null; });
    }
    inFlight = probeBundled().then(bundled => {
      if (generation !== epoch) return lastDisplay;
      facts = bundled;
      window.__tliBundledStatus = { model_exists: bundled.modelExists, healthy: bundled.healthy,
        statusKnown: bundled.statusKnown, meshPeer: bundled.meshPeer, checkedAt: bundled.checkedAt };
      return renderRoute();
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  window.TLIAISource = { refresh: refreshAll, renderRoute, getSnapshot: () => ({ ...(lastDisplay || {text:'AI: Checking…', state:'warn', title:'Checking AI availability', kind:'unknown'}), checkedAt: displayCheckedAt }) };

  function openSettingsAI() {
    try {
      if (typeof switchPanel === "function") switchPanel("panel-settings");
    } catch {}
  }

  function openAiSourceModal() {
    try {
      if (typeof openAISourceModal === "function") { openAISourceModal(); return true; }
    } catch {}
    return false;
  }

  function openModelManager() {
    try {
      if (typeof window.tliOpenModelManagerModal === "function") { window.tliOpenModelManagerModal(); return true; }
      if (typeof window.tliOpenModelManager === "function") { window.tliOpenModelManager(); return true; }
      if (typeof window.openModelManagerModal === "function") { window.openModelManagerModal(); return true; }
    } catch {}
    return false;
  }

  function onManageClick(e) {
    // Header Settings button (explicit, not implied)
    try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch {}
    openSettingsAI();
  }

  function onAiPillClick(e) {
    // Header AI pill opens the Model Manager (bundled AI download/folder/version)
    try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch {}
    if (openModelManager()) return;
    if (typeof showToast === "function") showToast("Model Manager is not available in this build.", "warn");
    else alert("Model Manager is not available in this build.");
  }

  function bindAiPillOnce() {
    const pill = document.getElementById("ai-source-pill");
    if (!pill || pill.__tliBound) return;
    pill.__tliBound = true;
    pill.addEventListener("click", onAiPillClick);

  }

function bindManageOnce() {
    const btn = manageBtnEl();
    if (!btn || btn.__tliBound) return;
    btn.__tliBound = true;

    // Premium clarity: this button navigates to Settings (not the Model Manager)
    try { btn.textContent = "Settings"; } catch {}
    try { btn.title = "Open Settings"; } catch {}

    btn.addEventListener("click", onManageClick);
  }

  function boot() {
    bindManageOnce();
    bindAiPillOnce();
    refreshAll({ force: true });
    window.setInterval(() => refreshAll(), POLL_MS);
    window.setInterval(() => { if (displayCheckedAt && Date.now() - displayCheckedAt >= STALE_MS) renderRoute(); }, 1000);
  }
  window.addEventListener("tli-session-locked", () => {
    locked = true;
    epoch += 1;
    facts = null;
    lastRoute = null;
    for (const controller of probes) controller.abort();
    window.__tliBundledStatus = null;
    renderRoute();
  });
  window.addEventListener("tli-session-unlocked", () => {
    locked = false;
    // Finish cancellation before admitting a new poll.
    Promise.resolve(inFlight).finally(() => refreshAll({ force: true }));
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
