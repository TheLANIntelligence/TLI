/* =============================================================
   Command Palette  —  Ctrl+K / Cmd+K
   Fuzzy search across navigation, actions, tools, and mesh nodes.
   ============================================================= */
(function () {
  // ── Static commands ─────────────────────────────────────────

  const NAV_ITEMS = [
    { id: 'nav-main',        label: 'Main',            sub: 'AI chat + controls',         panel: 'panel-main' },
    { id: 'nav-dashboard',   label: 'Dashboard',       sub: 'System overview',            panel: 'panel-dashboard2' },
    { id: 'nav-chat',        label: 'TLI Chat',        sub: 'Mesh messaging',             panel: 'panel-tli-chat' },
    { id: 'nav-vault',       label: 'Vault',           sub: 'Encrypted file storage',     panel: 'panel-vault' },
    { id: 'nav-homeauto',    label: 'Home Automation', sub: 'Shelly device control',      panel: 'panel-homeauto' },
    { id: 'nav-automations', label: 'Automations',     sub: 'Scheduled action sequences', panel: 'panel-automations' },
    { id: 'nav-visualizer',  label: 'Visualizer',      sub: 'Disk usage treemap',         panel: 'panel-visualizer' },
    { id: 'nav-games',       label: 'Game Optimizer',  sub: 'Detect + boost games',       panel: 'panel-games' },
    { id: 'nav-files',       label: 'Files',           sub: 'File manager + organizer',   panel: 'panel-files' },
    { id: 'nav-devices',     label: 'Devices',         sub: 'Printers + hardware',        panel: 'panel-devices' },
    { id: 'nav-mesh',        label: 'Mesh',            sub: 'LAN node network',           panel: 'panel-mesh' },
    { id: 'nav-tools',       label: 'Tools',           sub: 'Diagnostics + builtins',     panel: 'panel-tools' },
    { id: 'nav-scripts',     label: 'Scripts',         sub: 'Generated scripts',          panel: 'panel-scripts' },
    { id: 'nav-settings',    label: 'Settings',        sub: 'Node identity + PIN + config', panel: 'panel-settings' },
  ].map(n => ({ ...n, cat: 'Navigate', action: () => switchPanel(n.panel) }));

  const ACTIONS = [
    {
      id: 'act-lock', label: 'Lock TLI', sub: 'Return to PIN screen', cat: 'Action',
      action: () => { if (window.TLIPinLock) window.TLIPinLock.checkAndLock(); },
    },
    {
      id: 'act-vault-lock', label: 'Lock Vault', sub: 'Clear vault session keys', cat: 'Action',
      action: async () => {
        await fetch('/vault/lock', { method: 'POST' });
        showToast('Vault locked.', 'info');
      },
    },
    {
      id: 'act-clean-temp', label: 'Clean Temp Files', sub: 'Free safe temp locations on this node', cat: 'Action',
      action: async () => {
        const r = await fetch('/agent/maintenance/clean_temp', { method: 'POST' });
        const d = await r.json();
        const n = d && d.summary ? d.summary.total_files_deleted : 0;
        const b = d && d.summary ? (d.summary.total_bytes_reclaimed_human || '') : '';
        showToast('Cleaned ' + n + ' file' + (n !== 1 ? 's' : '') + (b ? ' \xb7 ' + b : '') + '.', 'success');
      },
    },
    {
      id: 'act-rotate-logs', label: 'Rotate Logs', sub: 'Archive debug_log.jsonl if over 5 MB', cat: 'Action',
      action: async () => {
        await fetch('/agent/tasks/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task_id: 'rotate_logs' }),
        });
        showToast('Log rotation triggered.', 'info');
      },
    },
    {
      id: 'act-refresh-dash', label: 'Refresh Dashboard', sub: 'Re-poll all status data', cat: 'Action',
      action: () => {
        if (window.TLIDash2 && typeof window.TLIDash2.onOpen === 'function') window.TLIDash2.onOpen();
        showToast('Dashboard refreshed.', 'success');
      },
    },
    {
      id: 'act-settings', label: 'Open Settings', sub: 'Node identity, PIN, system config', cat: 'Action',
      action: () => switchPanel('panel-settings'),
    },
  ];

  // ── State ────────────────────────────────────────────────────
  var _dynamicCmds = [];
  var _allCmds     = NAV_ITEMS.concat(ACTIONS);
  var _filtered    = _allCmds.slice();
  var _active      = 0;
  var _isOpen      = false;
  var _dynLoaded   = false;

  // ── DOM refs ─────────────────────────────────────────────────
  var overlay = document.getElementById('tli-cmd-overlay');
  var input   = document.getElementById('tli-cmd-input');
  var results = document.getElementById('tli-cmd-results');
  if (!overlay || !input || !results) return;

  // ── Fuzzy match ──────────────────────────────────────────────
  function _matches(query, cmd) {
    if (!query) return true;
    var q = query.toLowerCase();
    var hay = (cmd.label + ' ' + (cmd.sub || '') + ' ' + cmd.cat).toLowerCase();
    if (hay.indexOf(q) !== -1) return true;
    // character-order fuzzy match against label
    var qi = 0, lbl = cmd.label.toLowerCase();
    for (var i = 0; i < lbl.length && qi < q.length; i++) {
      if (lbl[i] === q[qi]) qi++;
    }
    return qi === q.length;
  }

  // ── Escape HTML ──────────────────────────────────────────────
  function _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ── Render list ──────────────────────────────────────────────
  function _render() {
    results.innerHTML = '';
    if (_filtered.length === 0) {
      results.innerHTML = '<div class="tli-cmd-empty">No results</div>';
      return;
    }
    _filtered.forEach(function (cmd, i) {
      var el = document.createElement('div');
      el.className = 'tli-cmd-item' + (i === _active ? ' active' : '');
      el.setAttribute('role', 'option');
      el.setAttribute('aria-selected', String(i === _active));
      el.dataset.index = i;
      el.innerHTML =
        '<div class="tli-cmd-item-main">' +
          '<span class="tli-cmd-item-label">' + _esc(cmd.label) + '</span>' +
          (cmd.sub ? '<span class="tli-cmd-item-sub">' + _esc(cmd.sub) + '</span>' : '') +
        '</div>' +
        '<span class="tli-cmd-item-cat tli-cmd-cat-' + _esc(cmd.cat.toLowerCase()) + '">' + _esc(cmd.cat) + '</span>';
      el.addEventListener('mousedown', (function (idx) {
        return function (e) { e.preventDefault(); _select(idx); };
      })(i));
      el.addEventListener('mousemove', (function (idx) {
        return function () { _active = idx; _render(); };
      })(i));
      results.appendChild(el);
    });
    var activeEl = results.querySelector('.tli-cmd-item.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  }

  // ── Filter ───────────────────────────────────────────────────
  function _filter() {
    var q = input.value.trim();
    _allCmds = NAV_ITEMS.concat(ACTIONS).concat(_dynamicCmds);
    _filtered = _allCmds.filter(function (cmd) { return _matches(q, cmd); });
    _active = 0;
    _render();
  }

  // ── Select item ──────────────────────────────────────────────
  function _select(index) {
    var cmd = _filtered[index];
    if (!cmd) return;
    _closepalette();
    try { cmd.action(); } catch (_e) { /* silent */ }
  }

  // ── Move cursor ──────────────────────────────────────────────
  function _move(dir) {
    if (_filtered.length === 0) return;
    _active = (_active + dir + _filtered.length) % _filtered.length;
    _render();
  }

  // ── Open ─────────────────────────────────────────────────────
  function _openpalette() {
    _isOpen = true;
    overlay.hidden = false;
    input.value = '';
    _filter();
    requestAnimationFrame(function () { input.focus(); });
    if (!_dynLoaded) _loadDynamic();
  }

  // ── Close ────────────────────────────────────────────────────
  function _closepalette() {
    _isOpen = false;
    overlay.hidden = true;
    input.value = '';
  }

  // ── Load dynamic commands (tools + mesh nodes) ───────────────
  async function _loadDynamic() {
    _dynLoaded = true;
    var cmds = [];
    try {
      var r = await fetch('/tools/list');
      if (r.ok) {
        var d = await r.json();
        (d.tools || []).forEach(function (t) {
          cmds.push({
            id: 'tool-' + t.id,
            label: t.label || t.id,
            sub: 'Run tool',
            cat: 'Tool',
            action: (function (captured) {
              return function () {
                switchPanel('panel-tools');
                showToast('Opening ' + (captured.label || captured.id) + ' in Tools.', 'info');
              };
            })(t),
          });
        });
      }
    } catch (_e) {}
    try {
      var r2 = await fetch('/mesh/directory');
      if (r2.ok) {
        var d2 = await r2.json();
        (d2.devices || []).forEach(function (dev) {
          if (dev.status !== 'allowed') return;
          cmds.push({
            id: 'mesh-' + dev.device_id,
            label: dev.display_name || dev.device_id,
            sub: (dev.ip ? dev.ip + ':' + dev.tli_port : 'Mesh node'),
            cat: 'Node',
            action: function () { switchPanel('panel-mesh'); },
          });
        });
      }
    } catch (_e2) {}
    _dynamicCmds = cmds;
    _filter();
  }

  // ── Event listeners ──────────────────────────────────────────
  input.addEventListener('input', _filter);

  input.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown')  { e.preventDefault(); _move(1); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); _move(-1); }
    else if (e.key === 'Enter')     { e.preventDefault(); _select(_active); }
    else if (e.key === 'Escape')    { e.preventDefault(); _closepalette(); }
  });

  overlay.addEventListener('mousedown', function (e) {
    if (e.target === overlay) _closepalette();
  });

  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      _isOpen ? _closepalette() : _openpalette();
    }
  });

  // ── Public API ───────────────────────────────────────────────
  window.TLICmdPalette = { open: _openpalette, close: _closepalette };
})();
