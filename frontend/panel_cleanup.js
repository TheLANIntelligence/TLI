/* Keep the existing Tools cross-link. Free Space owns its own workspace actions. */

(function () {
  "use strict";

  function cleanup() {
    // ---- Add "Scripts" link inside Tools panel ----
    const toolsPanel = document.getElementById("panel-tools");
    if (toolsPanel) {
      if (!toolsPanel.querySelector("#tli-tools-scripts-link")) {
        const firstChild = toolsPanel.querySelector(".card, .main-columns, div");
        if (firstChild) {
          const linkBar = document.createElement("div");
          linkBar.id = "tli-tools-scripts-link";
          linkBar.style.cssText = `
            display: flex; gap: 8px; padding: 8px 12px; margin-bottom: 8px;
            background: var(--bg-elevated); border: 1px solid var(--border-subtle);
            border-radius: var(--radius-sm); align-items: center;
          `;
          linkBar.innerHTML = `
            <span style="font-size:13px; color:var(--text-muted);">View:</span>
            <button class="chip-button" onclick="switchPanel('panel-tools')" style="font-size:12px; border-color:var(--accent); color:var(--accent);">
              🧰 Tools
            </button>
            <button class="chip-button" onclick="switchPanel('panel-scripts')" style="font-size:12px;">
              📜 Scripts
            </button>
          `;
          toolsPanel.insertBefore(linkBar, firstChild);
        }
      }
    }

    console.log("[TLI] Panel quick links ready");
  }

  // Run after DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", cleanup);
  } else {
    setTimeout(cleanup, 300);
  }
})();
