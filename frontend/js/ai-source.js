// TLI AI Source of Truth
(function () {
  if (window.__TLI_AI_SOURCE_OF_TRUTH_V2__) return;
  window.__TLI_AI_SOURCE_OF_TRUTH_V2__ = true;

  const pillEl = () => document.getElementById("ai-source-pill");
  const pillTextEl = () => document.getElementById("ai-source-text");
  const chatBadgeEl = () => document.getElementById("ai-source-badge");
  const manageBtnEl = () => document.getElementById("ai-manage-btn");

  // AI badge polling state (avoid 'Checking…' flicker once satisfied)
  let __aiLastDisplay = null;
  let __aiPollMs = 20000;
  let __aiPollTimer = null;


  function setPill(text, state, title) {
    try {
      const p = pillEl();
      const t = pillTextEl();
      if (t) t.textContent = (text != null && text !== "" ? text : (t.textContent || "AI: Checking…"));
      if (p) {
        p.classList.remove("ai-online", "ai-degraded", "ai-offline");
        if (state === "ok") p.classList.add("ai-online");
        else if (state === "warn") p.classList.add("ai-degraded");
        else p.classList.add("ai-offline");
        if (title != null) p.title = title;
      }
    } catch {}
  }
  window.__tliSetAIPill = setPill;

  function setChatBadge(text, state) {
    try {
      const b = chatBadgeEl();
      if (!b) return;
      b.textContent = text || "AI: Checking…";
      b.classList.remove("badge-ok", "badge-warn", "badge-err");
      if (state === "ok") b.classList.add("badge-ok");
      else if (state === "warn") b.classList.add("badge-warn");
      else b.classList.add("badge-err");
    } catch {}
  }

  async function probeBundled() {
    const out = { modelExists: null, healthy: null, statusKnown: false, meshPeer: null };

    // Model presence
    try {
      const r = await fetch("/api/ai/model/info", { cache: "no-store" });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        if (typeof j.exists === "boolean") out.modelExists = j.exists;
      }
    } catch {}

    // Runtime status
    try {
      let r = null;
      try { r = await fetch("/api/ai/bundled/status", { cache: "no-store" }); } catch {}
      if (!r || !r.ok) {
        try { r = await fetch("/api/ai/status", { cache: "no-store" }); } catch {}
      }
      if (r && r.ok) {
        const j = await r.json().catch(() => ({}));
        if (typeof j.healthy === "boolean") out.healthy = j.healthy;
        if (out.modelExists == null && typeof j.model_exists === "boolean") out.modelExists = j.model_exists;
        out.statusKnown = true;
      }
    } catch {}

    // Mesh AI availability (only check if local is not healthy)
    if (!out.healthy) {
      try {
        const r = await fetch("/api/ai/mesh/status", { cache: "no-store" });
        if (r.ok) {
          const j = await r.json().catch(() => ({}));
          if (j.source === "mesh" && j.peer) out.meshPeer = j.peer;
        }
      } catch {}
    }

    try {
      window.__tliBundledStatus = {
        model_exists: out.modelExists,
        healthy: out.healthy,
        statusKnown: out.statusKnown,
        meshPeer: out.meshPeer,
      };
    } catch {}

    return out;
  }

  function displayFromRoute(route, bundled) {
    const src = (route && route.source) ? String(route.source) : "none";
    const lmOk = !!((typeof AIStatus!=='undefined' ? AIStatus.local.available : (window.AIStatus?.local?.available)));
    const lanOk = !!((typeof AIStatus!=='undefined' ? AIStatus.lan.available : (window.AIStatus?.lan?.available)));
    const node = route?.node || ((typeof AIStatus!=='undefined' ? (AIStatus.lan.nodes && AIStatus.lan.nodes[0]) : (window.AIStatus?.lan?.nodes && window.AIStatus.lan.nodes[0]))) || null;

    // Normalize known enums
    const isLAN = (src === "lan_llm" || src === "LAN_LLM");
    const isLOCAL = (src === "local_llm" || src === "LOCAL_LLM");

    if (isLAN) {
      const nodeName = node?.name || node?.ip || "LAN host";
      return { text: "AI: Mesh", state: lanOk ? "ok" : "warn", title: `Mesh host: ${nodeName}`, kind: "mesh" };
    }

    if (isLOCAL) {
      if (lmOk) return { text: "AI: LM Studio", state: "ok", title: "Local provider: LM Studio", kind: "lmstudio" };

      // Local policy but LM Studio is down -> bundled can serve as local fallback if healthy
      if (bundled?.healthy === true) return { text: "AI: Integrated", state: "ok", title: "Local provider: Integrated AI", kind: "bundled" };

      return { text: "AI: Off", state: "warn", title: "Local AI unavailable", kind: "off" };
    }

    // NONE / unknown
    if (bundled?.healthy === true) return { text: "AI: Integrated", state: "ok", title: "Local provider: Integrated AI", kind: "bundled" };
    if (bundled?.modelExists === true) {
      const tip = (bundled?.statusKnown === true)
        ? "Integrated model is present. Runtime health not confirmed yet."
        : "Integrated model is present. Checking runtime status…";
      return { text: "AI: Integrated", state: "warn", title: tip, kind: "bundled" };
    }

    // Mesh AI fallback — local model missing but a peer has one running
    if (bundled?.meshPeer) {
      const peer = bundled.meshPeer;
      const label = peer.name ? `Mesh AI · ${peer.name}` : "Mesh AI";
      const tierLabel = peer.preset ? ` (${peer.preset})` : "";
      return { text: label, state: "ok", title: `AI routed to ${peer.name || peer.ip}${tierLabel} via mesh`, kind: "mesh_proxy" };
    }

    if (bundled?.modelExists === false) return { text: "AI: Off", state: "warn", title: "No local model — no mesh peers with AI found either", kind: "off" };

    return { text: "AI: Off", state: "err", title: "No AI providers detected", kind: "off" };
  }

  async function refreshAll({ force = false } = {}) {
    // Only show "Checking…" on first load or when forced; keep stable label otherwise.
    try {
      const curTxt = pillTextEl()?.textContent || "";
      const needsCheck = force || !__aiLastDisplay || !curTxt || curTxt.includes("Checking");
      if (needsCheck) {
        setPill("AI: Checking…", "warn", "Checking AI route…");
        setChatBadge("AI: Checking…", "warn");
      }
    } catch {}

    // Refresh provider health so the badge can become "ready"
    try { await refreshLocalAI(); } catch {}
    try { refreshLanAI(); } catch {}

    // Resolve route via your existing policy engine
    let route = null;
    try {
      if (typeof resolveIntelligenceRoute === "function") {
        route = await resolveIntelligenceRoute({ forceRefresh: !!force });
      }
    } catch {}

    // Probe bundled (used only for fallback / labeling)
    const bundled = await probeBundled();
    const display = displayFromRoute(route, bundled);

    setPill(display.text, display.state, display.title);
    setChatBadge(display.text, display.state);

    // Remember last good state so we don't flicker back to "Checking…"
    __aiLastDisplay = display;

    // Once we have a resolved source, slow polling down (still keeps it fresh, but stops the UI spam)
    try {
      const resolved = !!display && display.kind && display.kind !== "checking";
      if (resolved && __aiPollMs < 20000) {
        __aiPollMs = 20000;
        if (__aiPollTimer) {
          clearInterval(__aiPollTimer);
          __aiPollTimer = window.setInterval(() => refreshAll({ force: false }), __aiPollMs);
        }
      }
    } catch {}

    try { window.__tliActiveAISource = display.kind; } catch {}
  }

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
    pill.addEventListener("keydown", (ev) => {
      const k = ev?.key;
      if (k === "Enter" || k === " ") onAiPillClick(ev);
    });
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

  document.addEventListener("DOMContentLoaded", () => {
    bindManageOnce();
    bindAiPillOnce();
    // Delay first AI-pill refresh so it doesn't pile onto the startup fetch burst
    setTimeout(() => {
      refreshAll({ force: true });
      try {
        if (__aiPollTimer) clearInterval(__aiPollTimer);
        __aiPollTimer = window.setInterval(() => refreshAll({ force: false }), __aiPollMs);
      } catch {}
    }, 4000);
  });
})();
