/* =============================================================
   Command Palette  —  Ctrl+K / Cmd+K
   Navigation plus bounded, owner-scoped saved-item search while open.
   ============================================================= */
(function () {
  'use strict';
  async function requestResult(path, options) {
    const response = await fetch(path, options);
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.ok !== true) {
      const reason = typeof result?.detail === 'string' ? result.detail : typeof result?.error === 'string' ? result.error : `TLI did not confirm the result (HTTP ${response.status}).`;
      throw new Error(reason);
    }
    return result;
  }
  function openPanel(panel) {
    if (typeof switchPanel !== 'function' || !document.getElementById(panel)) throw new Error('This panel is unavailable.');
    switchPanel(panel);
  }
  // ── Static commands ─────────────────────────────────────────

  const NAV_ALIASES = {
    'panel-main': 'Main Main Chat Chat AI chat controls screenshot screen help image',
    'panel-tli-chat': 'TLI Chat mesh messaging',
    'panel-visualizer': 'Storage disk usage treemap',
    'panel-tools': 'Tools & Scripts diagnostics builtins',
    'panel-files': 'File Organizer',
    'panel-builder': 'coding agent projects',
    'panel-hub': 'apps community',
    'panel-printshop': 'printers scanners',
  };
  const NAV_ITEMS = Array.from(document.querySelectorAll('.sidebar-nav [data-panel-target]')).map(button => {
    const panel = button.dataset.panelTarget;
    const label = button.querySelector('span').textContent.trim();
    return { id: 'nav-' + panel, label, sub: 'Open ' + label,
      aliases: NAV_ALIASES[panel] || '', panel, cat: 'Navigate', action: () => switchPanel(panel) };
  });
  function navigation() {
    const catalog = window.TLIUI?.navigation;
    if (!Array.isArray(catalog)) return NAV_ITEMS;
    return catalog.map(item => ({ id: 'nav-' + item.id, label: item.label, sub: item.purpose || 'Open ' + item.label,
      aliases: [NAV_ALIASES[item.id] || '', ...(Array.isArray(item.aliases) ? item.aliases : [item.aliases || ''])].join(' '),
      cat: 'Navigate', action: () => {
        if (item.id === 'saved-notes') {
          if (!window.TLINotebook?.open) throw new Error('Notes & fixes is unavailable.');
          return window.TLIUI?.openNotes ? window.TLIUI.openNotes() : window.TLINotebook.open();
        }
        openPanel(item.id);
      } }));
  }

  const ACTIONS = [
    {
      id: 'act-lock', label: 'Lock TLI', sub: 'Return to PIN screen', cat: 'Action',
      action: async () => {
        if (typeof window.TLIPinLock?.lock !== 'function') throw new Error('Browser locking is unavailable.');
        await window.TLIPinLock.lock();
      },
    },
    {
      id: 'act-vault-lock', label: 'Lock Vault', sub: 'End Vault access for this TLI account', cat: 'Action',
      action: async current => {
        if (typeof window.TLIVault?.lock === 'function') {
          if (await window.TLIVault.lock() !== true || !current()) return;
          return { message: 'Vault locked for this TLI account.', type: 'info' };
        }
        await requestResult('/vault/lock', { method: 'POST' });
        document.getElementById('vault-content-area')?.classList.add('hidden');
        for (const id of ['vault-files-list', 'vault-secrets-list', 'vault-notes-list']) document.getElementById(id)?.replaceChildren();
        document.getElementById('vault-note-editor')?.classList.add('hidden');
        for (const id of ['vault-password', 'vault-secret-key-input', 'vault-secret-val-input', 'vault-note-title-input', 'vault-note-body']) {
          const field = document.getElementById(id); if (field) field.value = '';
        }
        if (!current()) return;
        return { message: 'Vault locked for this TLI account.', type: 'info' };
      },
    },
    {
      id: 'act-clean-temp', label: 'Review Temp Cleanup', sub: 'Open Storage to scan and review files', aliases: 'clean temp files free space', cat: 'Action',
      action: () => {
        openPanel('panel-visualizer');
        window.TLIStorageWorkspace?.openCleanup();
        document.getElementById('cleanup-title')?.scrollIntoView({ block: 'center' });
        return { message: 'Storage cleanup review opened. No files were deleted.', type: 'info' };
      },
    },
    {
      id: 'act-rotate-logs', label: 'Rotate Logs', sub: 'Archive debug_log.jsonl if over 5 MB', cat: 'Action',
      action: async () => {
        const data = await requestResult('/agent/tasks/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task_id: 'rotate_logs' }),
        });
        const result = data.result;
        if (data.task_id !== 'rotate_logs' || !result || typeof result.rotated !== 'boolean') throw new Error('TLI returned an incomplete log rotation result.');
        if (result.rotated) return { message: 'Logs rotated.', type: 'success' };
        if (result.reason === 'log file does not exist') return { message: 'No log file was present to rotate.', type: 'info' };
        if (result.reason === 'size below threshold') return { message: 'Logs were below the rotation threshold. No rotation was needed.', type: 'info' };
        throw new Error('Logs were not rotated: ' + (typeof result.reason === 'string' ? result.reason : 'reason unavailable'));
      },
    },
    {
      id: 'act-refresh-dash', label: 'Open Dashboard', sub: 'View the latest available status', aliases: 'refresh dashboard', cat: 'Action',
      action: () => {
        openPanel('panel-dashboard2');
        return { message: 'Dashboard opened. Check the displayed observation times for freshness.', type: 'info' };
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
  var _returnFocus = null;
  var _dynLoaded   = false;
  const _pending = new Set();
  var _sessionGeneration = 0;
  let _savedCmds = [], _searchTimer = null, _searchController = null, _searchGeneration = 0;
  let _dynamicController = null;
  const SEARCH_LIMIT = 6, MAX_RECORDS = 1000, MAX_BYTES = 1024 * 1024, MAX_QUERY = 120;

  // ── DOM refs ─────────────────────────────────────────────────
  var overlay = document.getElementById('tli-cmd-overlay');
  var input   = document.getElementById('tli-cmd-input');
  var results = document.getElementById('tli-cmd-results');
  if (!overlay || !input || !results) return;
  let searchStatus = document.getElementById('tli-cmd-saved-status');
  if (!searchStatus) {
    searchStatus = document.createElement('p'); searchStatus.id = 'tli-cmd-saved-status';
    searchStatus.className = 'tli-cmd-saved-status'; searchStatus.setAttribute('role', 'status');
    (results.parentElement || overlay).appendChild(searchStatus);
  }
  input.maxLength = MAX_QUERY;

  // No persistent index: a query exists only for this open palette and session.
  function _clearSearch() {
    if (_searchTimer !== null) clearTimeout(_searchTimer);
    _searchTimer = null; _searchController?.abort(); _searchController = null;
    _searchGeneration++; _savedCmds = []; searchStatus.textContent = '';
  }
  async function _boundedJSON(url, signal) {
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal });
    if (signal.aborted) throw new Error('Search cancelled');
    if (response.status === 401) { _sessionGeneration++; _closepalette(); throw new Error('Unlock TLI to search saved items.'); }
    if (!response.ok) throw new Error('Unavailable');
    const length = Number(response.headers?.get('content-length'));
    if (length > MAX_BYTES) { await response.body?.cancel(); throw new Error('Response exceeds search limit'); }
    if (response.body?.getReader) {
      const reader = response.body.getReader(), decoder = new TextDecoder(); let bytes = 0, text = '';
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error('Response exceeds search limit'); }
          text += decoder.decode(chunk.value, { stream: true });
        }
        return JSON.parse(text + decoder.decode());
      } finally { reader.releaseLock(); }
    }
    const data = await response.json();
    if (JSON.stringify(data).length > MAX_BYTES / 4) throw new Error('Response exceeds search limit');
    return data;
  }
  const _validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(id);
  const _title = (value, fallback) => typeof value === 'string' && value.trim() ? value.slice(0, 160) : fallback;
  const _contains = (query, ...values) => values.some(v => typeof v === 'string' && v.slice(0, 16000).toLowerCase().includes(query));
  async function _searchSaved(query, generation) {
    if (!_isOpen || generation !== _searchGeneration) return;
    const controller = new AbortController(); _searchController = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    const current = () => _isOpen && generation === _searchGeneration && !controller.signal.aborted;
    searchStatus.textContent = 'Searching Notes & fixes, conversations and favorites…';
    const sources = [
      { label: 'Notes & fixes', url: '/api/intelligence/memory', parse(data) {
        if (!Array.isArray(data.facts)) throw new Error('Unsupported');
        const matches = data.facts.slice(0, MAX_RECORDS).filter(n => _validId(n.id) && !n.id.startsWith('device-') && /^[a-f0-9]{64}$/i.test(n.revision || '') && _contains(query, n.title, n.text));
        return { limited: data.facts.length > MAX_RECORDS || matches.length > SEARCH_LIMIT || data.facts.slice(0, MAX_RECORDS).some(n => typeof n.text === 'string' && n.text.length > 16000),
          commands: matches.slice(0, SEARCH_LIMIT).map(n => {
            const ref = { id: n.id, revision: n.revision };
            return { id: 'note-' + n.id, label: _title(n.title, 'Untitled note'), sub: 'Open in Notes & fixes · not added to chat', cat: 'Note', action: () => {
              if (!window.TLINotebook?.open) throw new Error('Notes & fixes is unavailable.');
              return window.TLINotebook.open(ref, { source: 'search' });
            } };
          }) };
      } },
      { label: 'Conversations', url: '/api/intelligence/conversation-search?q=' + encodeURIComponent(query) + '&limit=' + SEARCH_LIMIT, parse(data) {
        if (data.ok !== true || data.protocol !== 'conversation-search-v1' || !Array.isArray(data.items) || data.query?.toLowerCase() !== query || !data.coverage) throw new Error('Unsupported');
        return { limited: data.coverage.complete !== true || data.coverage.text_limited === true || !!data.next_cursor || data.items.length > SEARCH_LIMIT,
          commands: data.items.slice(0, SEARCH_LIMIT).filter(n => _validId(n.id)).map(n => {
            const id = n.id, title = _title(n.title, 'Saved conversation');
            return { id: 'conversation-' + id, label: title, sub: 'Resume saved conversation', cat: 'Chat', action: async () => {
              if (typeof window.loadConversation !== 'function') throw new Error('Conversation history is unavailable.');
              openPanel('panel-main'); await window.loadConversation(id, title);
            } };
          }) };
      } },
      { label: 'Favorites', url: '/api/intelligence/places', parse(data) {
        if (data.ok !== true || data.protocol !== 'saved-places-v1' || !Array.isArray(data.places)) throw new Error('Unsupported');
        const matches = data.places.slice(0, 100).filter(n => /^[a-f0-9]{32}$/i.test(n.id || '') && _contains(query, n.name, n.target));
        return { limited: data.places.length > 100 || matches.length > SEARCH_LIMIT,
          commands: matches.slice(0, SEARCH_LIMIT).map(n => {
            const id = n.id;
            return { id: 'favorite-' + id, label: _title(n.name, 'Favorite'), sub: 'Review favorite · choose Open or Scan there', cat: 'Favorite', action: () => {
              if (!window.TLIPlaces?.openFavorite) throw new Error('Favorites are unavailable.');
              return window.TLIPlaces.openFavorite(id);
            } };
          }) };
      } },
    ];
    const replies = await Promise.allSettled(sources.map(async source => source.parse(await _boundedJSON(source.url, controller.signal))));
    clearTimeout(timeout);
    if (!_isOpen || generation !== _searchGeneration) return;
    if (!current()) { searchStatus.textContent = 'Saved search timed out. Edit your search to retry.'; return; }
    _searchController = null;
    const unavailable = [], limited = [];
    replies.forEach((reply, i) => {
      if (reply.status !== 'fulfilled') unavailable.push(sources[i].label);
      else { _savedCmds.push(...reply.value.commands); if (reply.value.limited) limited.push(sources[i].label); }
    });
    _filter();
    searchStatus.textContent = [
      _savedCmds.length ? `${_savedCmds.length} saved results. Opening a result never sends a message or runs an action.` : 'No matching saved items in the checked records.',
      limited.length ? `${limited.join(', ')}: partial results; narrow your search or open the existing view.` : '',
      unavailable.length ? `${unavailable.join(', ')} unavailable or beyond the search limit. Edit your search to retry.` : '',
    ].filter(Boolean).join(' ');
  }
  function _queryChanged() {
    _clearSearch(); _filter();
    const query = input.value.trim().toLowerCase();
    if (!_isOpen || query.length < 2) return;
    if (query.length > MAX_QUERY) { searchStatus.textContent = 'Use up to 120 characters to search saved items.'; return; }
    const generation = _searchGeneration;
    _searchTimer = setTimeout(() => { _searchTimer = null; _searchSaved(query, generation); }, 300);
  }

  // ── Fuzzy match ──────────────────────────────────────────────
  function _matches(query, cmd) {
    if (!query) return true;
    var q = query.toLowerCase();
    var hay = (cmd.label + ' ' + (cmd.sub || '') + ' ' + (cmd.aliases || '') + ' ' + cmd.cat).toLowerCase();
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
    input.setAttribute('aria-activedescendant', _filtered.length ? 'tli-cmd-option-' + _active : '');
    if (_filtered.length === 0) {
      results.innerHTML = '<div class="tli-cmd-empty">No results</div>';
      return;
    }
    _filtered.forEach(function (cmd, i) {
      var el = document.createElement('div');
      el.id = 'tli-cmd-option-' + i;
      el.className = 'tli-cmd-item' + (i === _active ? ' active' : '');
      el.setAttribute('role', 'option');
      el.setAttribute('aria-selected', String(i === _active));
      el.setAttribute('aria-disabled', String(_pending.has(cmd.id)));
      el.setAttribute('aria-busy', String(_pending.has(cmd.id)));
      el.dataset.index = i;
      el.innerHTML =
        '<div class="tli-cmd-item-main">' +
          '<span class="tli-cmd-item-label">' + _esc(cmd.label) + '</span>' +
          (cmd.sub ? '<span class="tli-cmd-item-sub">' + _esc(_pending.has(cmd.id) ? 'Already in progress' : cmd.sub) + '</span>' : '') +
        '</div>' +
        '<span class="tli-cmd-item-cat tli-cmd-cat-' + _esc(cmd.cat.toLowerCase()) + '">' + _esc(cmd.cat) + '</span>';
      el.addEventListener('mousedown', (function (idx) {
        return function (e) { e.preventDefault(); _select(idx); };
      })(i));
      el.addEventListener('mousemove', (function (idx) {
        return function () { if (_active !== idx) { _active = idx; _render(); } };
      })(i));
      results.appendChild(el);
    });
    var activeEl = results.querySelector('.tli-cmd-item.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  }

  // ── Filter ───────────────────────────────────────────────────
  function _filter() {
    var q = input.value.trim();
    _allCmds = navigation().concat(ACTIONS).concat(_dynamicCmds);
    _filtered = _allCmds.filter(function (cmd) { return _matches(q, cmd); }).concat(_savedCmds);
    _active = 0;
    _render();
  }

  // ── Select item ──────────────────────────────────────────────
  async function _select(index) {
    var cmd = _filtered[index];
    if (!cmd) return;
    if (_pending.has(cmd.id)) return;
    _pending.add(cmd.id);
    const generation = _sessionGeneration;
    _closepalette();
    try {
      const result = await cmd.action(() => generation === _sessionGeneration);
      if (generation === _sessionGeneration && result?.message) showToast(result.message, result.type || 'info');
    } catch (error) {
      if (generation === _sessionGeneration) showToast(cmd.label + ': ' + (error?.message || 'The result could not be confirmed.') + ' No automatic retry was made.', 'error');
    } finally {
      _pending.delete(cmd.id);
      if (_isOpen) _render();
    }
  }

  // ── Move cursor ──────────────────────────────────────────────
  function _move(dir) {
    if (_filtered.length === 0) return;
    _active = (_active + dir + _filtered.length) % _filtered.length;
    _render();
  }

  // ── Open ─────────────────────────────────────────────────────
  function _openpalette() {
    if (_isOpen) { input.focus(); return; }
    _returnFocus = document.activeElement;
    _isOpen = true;
    overlay.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.value = '';
    _filter();
    requestAnimationFrame(function () { input.focus(); });
    if (!_dynLoaded) _loadDynamic();
  }

  // ── Close ────────────────────────────────────────────────────
  function _closepalette() {
    _clearSearch();
    _isOpen = false;
    overlay.hidden = true;
    input.value = '';
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-activedescendant', '');
    _filtered = []; results.innerHTML = '';
    _dynamicController?.abort(); _dynamicController = null;
    _dynamicCmds = []; _dynLoaded = false; _allCmds = navigation().concat(ACTIONS);
    if (_returnFocus && _returnFocus.isConnected) _returnFocus.focus();
    _returnFocus = null;
  }

  // ── Load dynamic commands (tools + mesh nodes) ───────────────
  async function _loadDynamic() {
    _dynLoaded = true;
    const generation = _sessionGeneration;
    const controller = new AbortController(); _dynamicController = controller;
    const current = () => _isOpen && !controller.signal.aborted && generation === _sessionGeneration;
    var cmds = [];
    try {
      var d = await _boundedJSON('/tools/list', controller.signal);
      if (current()) {
        (Array.isArray(d.tools) ? d.tools : []).slice(0, 100).forEach(function (t) {
          cmds.push({
            id: 'tool-' + t.id,
            label: t.label || t.id,
            sub: 'Open Tools to choose and run this tool',
            cat: 'Tool',
            action: (function (captured) {
              return function () {
                openPanel('panel-tools');
                return { message: 'Tools opened. Select ' + (captured.label || captured.id) + ' there; it has not run.', type: 'info' };
              };
            })(t),
          });
        });
      }
    } catch (_e) {}
    if (!current()) return;
    try {
      var d2 = await _boundedJSON('/mesh/directory', controller.signal);
      if (current()) {
        (Array.isArray(d2.devices) ? d2.devices : []).slice(0, 100).forEach(function (dev) {
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
    if (!current()) return;
    _dynamicCmds = cmds;
    if (_isOpen) _filter();
  }

  // ── Event listeners ──────────────────────────────────────────
  input.addEventListener('input', _queryChanged);

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
  window.addEventListener('tli-session-locked', function () {
    _sessionGeneration++;
    _dynamicCmds = [];
    _dynLoaded = false;
    _closepalette();
  });
  window.addEventListener('pagehide', _closepalette);

  // ── Public API ───────────────────────────────────────────────
  window.TLICmdPalette = { open: _openpalette, close: _closepalette };
})();
