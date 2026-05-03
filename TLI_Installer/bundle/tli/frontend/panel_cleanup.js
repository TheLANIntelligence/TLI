/* ============================================
   TLI Panel Cleanup — drop-in after app.js
   
   Removes redundant sidebar items and adds
   cross-links so merged features remain accessible.
   
   Changes:
   - Hides: Automations (dead panel)
   - Hides: Files sidebar (merged into Storage)
   - Hides: Scripts sidebar (merged into Tools)
   - Renames: Visualizer → Storage
   - Renames: Tools → Tools & Scripts
   - Adds: "File Organizer" tab inside Storage panel
   - Adds: "Scripts" tab inside Tools panel
   ============================================ */

(function () {
  "use strict";

  function cleanup() {
    // ---- Hide sidebar buttons ----
    const hide = ["panel-automations", "panel-files", "panel-scripts"];
    document.querySelectorAll(".side-nav-button").forEach(btn => {
      const target = btn.getAttribute("data-panel-target");
      if (hide.includes(target)) {
        btn.style.display = "none";
      }
    });

    // ---- Rename Visualizer → Storage ----
    document.querySelectorAll(".side-nav-button").forEach(btn => {
      if (btn.getAttribute("data-panel-target") === "panel-visualizer") {
        const label = btn.querySelector("span");
        if (label) label.textContent = "Storage";
        const icon = btn.querySelector(".side-nav-button-icon");
        if (icon) icon.textContent = "💾";
      }
    });

    // ---- Rename Tools → Tools & Scripts ----
    document.querySelectorAll(".side-nav-button").forEach(btn => {
      if (btn.getAttribute("data-panel-target") === "panel-tools") {
        const label = btn.querySelector("span");
        if (label) label.textContent = "Tools & Scripts";
      }
    });

    // ---- Add "File Organizer" link inside Visualizer panel ----
    const vizPanel = document.getElementById("panel-visualizer");
    if (vizPanel) {
      // Check if we already added it
      if (!vizPanel.querySelector("#tli-viz-file-link")) {
        // Find the first card or header area
        const firstChild = vizPanel.querySelector(".card, .main-columns, div");
        if (firstChild) {
          const linkBar = document.createElement("div");
          linkBar.id = "tli-viz-file-link";
          linkBar.style.cssText = `
            display: flex; gap: 8px; padding: 8px 12px; margin-bottom: 8px;
            background: var(--bg-elevated); border: 1px solid var(--border-subtle);
            border-radius: var(--radius-sm); align-items: center;
          `;
          linkBar.innerHTML = `
            <span style="font-size:13px; color:var(--text-muted);">Quick access:</span>
            <button class="chip-button" onclick="switchPanel('panel-files')" style="font-size:12px;">
              📁 File Organizer
            </button>
            <button class="chip-button" onclick="switchPanel('panel-visualizer')" style="font-size:12px; border-color:var(--accent); color:var(--accent);">
              📊 Disk Visualizer
            </button>
          `;
          vizPanel.insertBefore(linkBar, firstChild);
        }
      }
    }

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

    console.log("[TLI] Panel cleanup: Automations hidden, Files→Storage, Scripts→Tools");
  }

  // Run after DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", cleanup);
  } else {
    setTimeout(cleanup, 300);
  }
})();
