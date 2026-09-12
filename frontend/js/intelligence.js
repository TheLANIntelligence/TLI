/* Shared context inside the existing Devices, Settings and Chat panels. */
(() => {
  'use strict';
  const state = { devices: [], target: '', report: null, epoch: 0, chatEpoch: 0, locked: false };
  const privateReset = [];
  const current = epoch => !state.locked && epoch === state.epoch;
  const expired = () => Object.assign(new Error('This context request is no longer current.'), { name: 'ContextExpiredError' });
  const reportError = error => { if (error.name !== 'ContextExpiredError' && !state.locked) status(error.message, true); };
  const contextChanged = () => window.dispatchEvent?.(new CustomEvent('tli-chat-context-changed'));
  const $ = id => document.getElementById(id);
  const clientId = () => typeof currentDeviceId !== 'undefined' ? currentDeviceId : null;
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  async function api(path, method = 'GET', body) {
    const epoch = state.epoch;
    if (!current(epoch)) throw expired();
    try {
      const res = await fetch('/api/intelligence' + path, { method, headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!current(epoch)) throw expired();
      if (res.status === 401) {
        window.dispatchEvent(new CustomEvent('tli-session-locked'));
        throw expired();
      }
      const data = await res.json();
      if (!current(epoch)) throw expired();
      if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `Request failed (${res.status}).`);
      return data;
    } catch (error) { if (!current(epoch)) throw expired(); throw error; }
  }
  function button(label, action) {
    const b = el('button', label, 'btn-outline btn-sm');
    b.type = 'button';
    b.addEventListener('click', async () => {
      if (b.disabled || state.locked) return;
      b.disabled = true;
      try { await action(); } catch (e) { reportError(e); }
      finally { b.disabled = false; }
    });
    return b;
  }
  function status(text, error = false) {
    if (state.locked) return;
    document.querySelectorAll('.tli-int-status').forEach(n => {
      n.textContent = text; n.classList.toggle('error', error);
    });
  }
  function field(label, input) {
    const wrap = el('label', null, 'tli-int-field');
    wrap.append(el('span', label), input); return wrap;
  }
  function input(value = '', placeholder = '') {
    const n = el('input'); n.value = value; n.placeholder = placeholder; n.maxLength = 120; return n;
  }
  function select(options) {
    const n = el('select');
    for (const [value, name] of options) { const o = el('option', name); o.value = value; n.append(o); }
    return n;
  }
  function section(panel, title, description) {
    const details = el('details', null, 'tli-intelligence');
    const body = el('div', null, 'tli-int-body');
    const notice = el('p', '', 'tli-int-status'); notice.setAttribute('role', 'status');
    details.append(el('summary', title)); body.append(el('p', description), notice); details.append(body);
    $(panel)?.append(details); return { details, body };
  }
  function syncTargets() {
    document.querySelectorAll('[data-int-target]').forEach(n => {
      n.replaceChildren();
      const empty = el('option', 'No device selected'); empty.value = ''; n.append(empty);
      state.devices.forEach(d => {
        const o = el('option', `${d.name}${d.room ? ' · ' + d.room : ''} · ${d.kind}`); o.value = d.id; n.append(o);
      });
      n.value = state.target;
    });
    const note = $('tli-chat-evidence');
    if (note) note.textContent = state.report ? `Report: ${state.report.kind} · ${new Date(state.report.created_at).toLocaleString()} · ${state.report.host.name}` : 'No diagnostic report attached';
    contextChanged();
  }
  function clearContext({ private: clearPrivate = false } = {}) {
    state.epoch++; state.chatEpoch++; state.target = ''; state.report = null;
    const retention = $('tli-image-retention'); if (retention) retention.value = '0';
    if (clearPrivate) {
      state.devices = [];
      privateReset.forEach(clear => clear());
      document.querySelectorAll('.tli-int-status').forEach(n => { n.textContent = ''; n.classList.toggle('error', false); });
    }
    syncTargets();
  }
  async function loadDevices() {
    const data = await api('/devices'); state.devices = data.devices;
    if (!state.devices.some(d => d.id === state.target)) state.target = '';
    syncTargets(); return data;
  }
  function targetSelect() {
    const n = select([]); n.dataset.intTarget = 'true';
    n.addEventListener('change', () => { if (state.locked) return; state.epoch++; state.target = n.value; state.report = null; syncTargets(); }); return n;
  }
  function appendReportEvidence(box, report) {
    const facts = report.recorded_facts;
    if (window.TLIReportFacts) box.append(window.TLIReportFacts.render(facts, { reportId: report.id, hostId: report.host?.id, targetId: report.target?.id || null }));
    else box.append(el('p', 'Structured report facts are unavailable in this browser. Saved text below is historical evidence, not a current health verdict.'));
    // Old stores remain readable. An explicitly malformed new summary never
    // falls back to raw status text as an authoritative measurement.
    if (facts === undefined && Array.isArray(report.checks)) {
      const legacy = el('details'); legacy.append(el('summary', 'Legacy saved check details'), el('p', 'No structured summary was recorded. These statuses apply to their named checks at the saved time only.'));
      const list = el('ul'); report.checks.forEach(c => list.append(el('li', `${c.status || 'unknown'} · ${c.label || c.id || 'Unnamed check'}: ${c.detail || 'Details not recorded.'}`))); legacy.append(list); box.append(legacy);
    }
    if (Array.isArray(report.findings) && report.findings.length) {
      const notes = el('details', null, 'report-facts-interpretation'); notes.append(el('summary', 'Saved interpretation and notes'), el('p', 'Original saved statements are separate from the structured measurements above. They do not establish current health.'));
      report.findings.forEach(f => notes.append(el('p', f.text || ''))); box.append(notes);
    }
    if (Array.isArray(report.next_steps) && report.next_steps.length) {
      const suggestions = el('section', null, 'report-facts-suggestions'); suggestions.append(el('h4', 'Suggested next steps'), el('p', 'Suggestions have not been performed by opening this report.'));
      const list = el('ul'); report.next_steps.forEach(s => list.append(el('li', s))); suggestions.append(list); box.append(suggestions);
    }
    if (report.verified_fix) box.append(el('h4', 'User-recorded confirmation'), el('p', report.verified_fix.text || ''), el('p', 'A saved user confirmation is not an independent measurement or proof of present health.'));
  }
  function showReport(report, box) {
    if (state.locked) return;
    // Reading a saved result (or viewing a newly completed check) does not
    // select evidence for Chat. Only the explicit Discuss control below does.
    box.replaceChildren();
    box.append(el('h4', `${report.kind} checks · ${new Date(report.created_at).toLocaleString()}`), el('p', report.scope));
    appendReportEvidence(box, report);
    if (report.comparison) box.append(el('p', report.comparison.comparable === false ? report.comparison.reason : report.comparison.changes.length ?
      'Since the previous check: ' + report.comparison.changes.map(c => `${c.check} ${c.before} → ${c.after}`).join('; ') : 'No check-status changes since the previous comparable report.'));
    box.append(button('Link to a problem…', () => window.TLITroubleshooting?.offerEvidence({ kind: 'report', id: report.id })));
    box.append(button('Review repeat or compare…', () => openSavedReport(report.id)));
    const fix = el('textarea'); fix.maxLength = 2000; fix.placeholder = 'What did you change, and how did you verify it worked?';
    box.append(field('Record a fix you have verified', fix), button('Save my confirmed fix', async () => {
      if (!fix.value.trim()) throw new Error('Describe the fix you verified first.');
      showReport(await api(`/diagnostics/${report.id}/fix`, 'POST', { text: fix.value }), box);
      status('Your confirmed fix was saved to this report and your memory.');
    }), button('Discuss this report in chat', () => {
      const chat = $('chat-input');
      if ($('chat-send-btn')?.disabled) throw new Error('Wait for the current response to finish before discussing this report.');
      if (typeof switchPanel === 'function') switchPanel('panel-main');
      else document.querySelector('[data-panel-target="panel-main"]')?.click();
      state.report = report; state.target = report.target?.id || ''; syncTargets();
      if (chat) {
        if (!chat.value.trim()) chat.value = 'Help me interpret this diagnostic report and choose the next check.';
        else status('The report is attached. Your draft is unchanged; review its context before sending.');
        chat.focus();
      }
    }));
  }
  function initDevices() {
    const { details, body } = section('panel-devices', 'Device context & diagnostics', 'Check this TLI host and its registered devices. No repair runs automatically.');
    const host = el('p'); const target = targetSelect();
    const name = input(), aliases = input(), room = input(); aliases.maxLength = 2000;
    const choose = () => {
      const d = state.devices.find(d => d.id === state.target);
      name.value = d?.name || ''; aliases.value = (d?.aliases || []).join(', '); room.value = d?.room || '';
    };
    target.addEventListener('change', choose);
    const edit = el('div', null, 'tli-int-grid'); edit.append(field('Display name', name), field('Aliases, separated by commas', aliases), field('Room (optional)', room));
    body.append(host, field('Registered device', target), button('Open device details', () => { if (!state.target) throw new Error('Select a registered device first.'); window.TLIDeviceDetails?.open(state.target); }), button('Rooms & devices', () => window.TLIDeviceDetails?.openRooms()), edit, button('Save device context', async () => {
      if (!state.target) throw new Error('Select a device first.');
      await api('/devices/' + state.target, 'PATCH', { name: name.value, aliases: aliases.value.split(',').map(s => s.trim()).filter(Boolean), room: room.value || null });
      await loadDevices(); choose(); status('Shared device context saved.');
    }), button('Refresh host printer list', async () => { await api('/printers/refresh', 'POST'); await loadDevices(); choose(); status('Host printer list refreshed.'); }));
    const kind = select([['network', 'Host network'], ['system', 'Host CPU, memory & storage'], ['device', 'Selected device reachability']]);
    const internet = input(); internet.type = 'checkbox';
    const checkOptions = el('div', null, 'tli-int-grid');
    checkOptions.append(field('Checks to run', kind), field('Include external tests to 1.1.1.1 and example.com', internet));
    kind.addEventListener('change', () => { internet.disabled = kind.value !== 'network'; });
    const report = el('div', null, 'tli-int-report'); const history = el('div', null, 'tli-int-history');
    privateReset.push(() => { host.textContent = ''; name.value = ''; aliases.value = ''; room.value = ''; report.replaceChildren(); history.replaceChildren(); details.open = false; });
    async function loadHistory() {
      const data = await api('/diagnostics'); history.replaceChildren();
      if (!data.reports.length) history.append(el('p', 'No diagnostic reports yet.'));
      data.reports.forEach(r => history.append(button(`${r.target?.name || r.kind} · ${new Date(r.created_at).toLocaleString()}`, () => showReport(r, report))));
    }
    body.append(checkOptions, button('Run read-only checks', async () => {
      status('Running checks on the TLI host…');
      showReport(await api('/diagnostics', 'POST', { kind: kind.value, target_id: kind.value === 'device' ? state.target || null : null, internet: kind.value === 'network' && internet.checked }), report);
      await loadHistory(); status('Checks completed. Review the evidence below.');
    }), report, el('h4', 'Your diagnostic history'), button('Refresh history', loadHistory), history);
    details.addEventListener('toggle', async () => {
      if (!details.open) return;
      try { const data = await loadDevices(); host.textContent = `Host: ${data.node.name}. ${data.scope}`; choose(); await loadHistory(); }
      catch (e) { reportError(e); }
    });
  }
  function initSettings() {
    const { details, body } = section('panel-settings', 'Notes & fixes and saved images', 'Manage saved setup details, preferences, past fixes and retained images. Chat history and Vault use separate storage.');
    details.id = 'settings-section-memory-images';
    const modelSection = section('panel-settings', 'Image-capable providers', 'Check which providers can receive an image. This does not download or switch the bundled model.');
    modelSection.details.id = 'settings-section-model-capabilities';
    const models = el('div'), images = el('div');
    privateReset.push(() => { models.replaceChildren(); images.replaceChildren(); details.open = false; modelSection.details.open = false; });
    body.append(el('h4', 'Notes & fixes'), el('p', 'Review, correct or delete your notes. In AI Chat, “Use saved notes” allows relevant notes to be included. You can instead select up to four for a question using only those notes. There is no separate exclusion switch for individual notes.'),
      el('p', 'These records belong to your current TLI account on this host. With the access PIN off, browser visitors use the shared local account.'),
      button('Open Notes & fixes', () => window.TLINotebook?.open()));
    async function loadModels() {
      models.replaceChildren(el('p', 'Checking configured providers…'));
      const data = await api('/models'); models.replaceChildren(el('p', data.note));
      if (data.lmstudio_error) models.append(el('p', data.lmstudio_error));
      for (const m of data.models) {
        const row = el('div', null, 'tli-int-memory');
        row.append(el('p', `${m.name} · ${m.provider} · ${m.available ? 'available' : 'not currently available'}${m.selected ? ' · selected' : ''} · vision: ${m.vision ? 'yes' : m.capability_source === 'unknown' ? 'unknown' : 'no'}`));
        if (m.provider === 'lmstudio') row.append(button(data.vision_model === m.id ? 'Remove image selection' : 'I confirm vision support; use for images', async () => {
          await api('/models/vision', 'PUT', { model_id: m.id, vision: data.vision_model !== m.id }); await loadModels(); status('Image provider preference updated.');
        }));
        models.append(row);
      }
    }
    async function loadImages() {
      const data = await api('/images'); images.replaceChildren();
      if (!data.images.length) images.append(el('p', 'No retained images.'));
      for (const i of data.images) {
        const row = el('div', null, 'tli-int-memory');
        const link = el('a', `View image · expires ${new Date(i.expires_at * 1000).toLocaleString()}`);
        link.href = '/api/intelligence/images/' + i.id; link.target = '_blank'; link.rel = 'noopener';
        row.append(link, button('Delete image', async () => { await api('/images/' + i.id, 'DELETE'); await loadImages(); status('Retained image deleted.'); })); images.append(row);
      }
    }
    modelSection.body.append(button('Check model availability', loadModels), models);
    body.append(el('h4', 'Retained troubleshooting images'), el('p', 'Images are not retained by default. If you chose to retain one, it is encrypted on the TLI host until expiry. Expired images are removed when the image list is next accessed.'),
      button('Refresh retained images', loadImages), images);
    details.addEventListener('toggle', async () => { if (details.open) { try { await loadImages(); } catch (e) { reportError(e); } } });
  }
  function initChat() {
    const row = document.querySelector('.chat-input-row'); if (!row) return;
    const details = el('details', null, 'tli-intelligence tli-int-chat');
    details.append(el('summary', 'Device, report & image context'));
    const body = el('div', null, 'tli-int-body'); const target = targetSelect();
    const report = el('p', 'No diagnostic report attached'); report.id = 'tli-chat-evidence';
    const retention = select([['0', 'Do not retain'], ['1', 'Retain for one day'], ['7', 'Retain for seven days']]); retention.id = 'tli-image-retention';
    body.append(field('Device being discussed', target), report, button('Clear attached report', () => { state.epoch++; state.report = null; syncTargets(); }),
      field('Image retention for this request', retention), el('p', 'JPEG or PNG · up to 6 MB and 16 million pixels. Image requests require an available vision model.'), el('p', '', 'tli-int-status'));
    details.append(body); row.before(details);
    details.addEventListener('toggle', async () => { if (details.open) { try { await loadDevices(); } catch (e) { reportError(e); } } });
    privateReset.push(() => { details.open = false; });
    $('new-chat-btn')?.addEventListener('click', () => clearContext());
  }
  let savedReportTicket = 0;
  let savedReportReview = null;
  function closeSavedReport() { savedReportTicket++; $('tli-saved-report-dialog')?.close(); }
  document.addEventListener?.('tli-panel-switched', closeSavedReport);
  document.addEventListener?.('visibilitychange', () => { if (document.hidden) closeSavedReport(); });
  async function openSavedReport(id) {
    if (state.locked) return;
    const epoch = state.epoch, ticket = ++savedReportTicket;
    const report = await api('/diagnostics/' + encodeURIComponent(id));
    if (!current(epoch) || ticket !== savedReportTicket) return;
    // Reading report history never selects Chat context. Only an explicit
    // Discuss/Include action may attach the reviewed report.
    let dialog = $('tli-saved-report-dialog');
    if (!dialog) {
      dialog = el('dialog', null, 'notebook-dialog'); dialog.id = 'tli-saved-report-dialog';
      dialog.setAttribute('aria-label', 'Saved diagnostic report'); document.body.append(dialog);
      dialog.addEventListener('close', () => { if (dialog.open) return; savedReportTicket++; savedReportReview?.dispose(); savedReportReview = null; dialog.replaceChildren(); });
      privateReset.push(() => { savedReportTicket++; dialog.close(); dialog.replaceChildren(); });
    }
    const data = report.report || report;
    if (!data || data.id !== id || !Array.isArray(data.checks) || !Array.isArray(data.findings)) throw new Error('Saved report is incomplete or does not match the requested source.');
    const returnTo = document.activeElement;
    savedReportReview?.dispose(); savedReportReview = null;
    dialog.replaceChildren(el('h2', 'Saved diagnostic report'), el('p', `${data.kind} · ${new Date(data.created_at).toLocaleString()} · ${data.target?.name || data.host?.name || 'Recorded host'}`),
      el('p', 'Historical evidence. Opening this report does not rerun checks, change chat context or confirm present health.'));
    if (data.scope) dialog.append(el('p', data.scope));
    appendReportEvidence(dialog, data);
    if (data.comparison?.changes?.length) { const comparison = el('details'); comparison.append(el('summary', 'Previous report comparison'), el('p', data.comparison.scope || 'Recorded differences; this does not prove the cause of a change.')); for (const change of data.comparison.changes) comparison.append(el('p', `${change.check}: ${change.before ?? 'Unknown'} to ${change.after ?? 'Unknown'}`)); dialog.append(comparison); }
    if (window.TLIReportReview) {
      const controls = el('section'); dialog.append(controls);
      savedReportReview = window.TLIReportReview.mount(controls, data, { current: () => current(epoch) && ticket === savedReportTicket && dialog.open, open: openSavedReport });
    }
    dialog.append(button('Close report', () => { dialog.close(); returnTo?.focus?.(); })); dialog.showModal();
    return data;
  }
  async function discussReport(id, question = '') {
    if (state.locked) return;
    if ($('chat-send-btn')?.disabled) throw new Error('Wait for the current reply to finish before changing report context.');
    const report = await openSavedReport(id);
    const dialog = $('tli-saved-report-dialog');
    if (!dialog?.open || state.locked) return;
    const ticket = savedReportTicket, epoch = state.epoch;
    // Fetch only an owned saved report; never execute checks or send Chat here.
    if (!current(epoch) || ticket !== savedReportTicket || !dialog.open) return;
    if (report.id !== id || !Array.isArray(report.checks)) throw new Error('This saved report is unavailable.');
    dialog.append(el('p', state.report ? 'Including this report replaces the current report and its device context. Your written draft, selected notes and documents stay unchanged.' : 'Including this report adds its historical evidence and recorded device context to Chat. Review the question before sending.'));
    dialog.append(button('Include report in Chat', () => {
      if (!current(epoch) || ticket !== savedReportTicket || !dialog.open) return;
      if ($('chat-send-btn')?.disabled) throw new Error('Wait for the current reply to finish before changing context.');
      const chat = $('chat-input');
      state.report = report; state.target = report.target?.id || ''; syncTargets();
      if (chat && !chat.value.trim()) chat.value = String(question || 'Help me interpret this saved report. What is known, and what remains unknown?').slice(0, 2000);
      dialog.close();
      if (typeof switchPanel === 'function') switchPanel('panel-main');
      else document.querySelector('[data-panel-target="panel-main"]')?.click();
      chat?.focus();
    }));
  }
  window.TLIIntelligence = {
    openSavedReport,
    discussReport,
    describeContext: () => [
      ...(state.target ? [{ id: 'device:' + state.target, label: state.devices.find(d => d.id === state.target)?.name || state.target, kind: 'device' }] : []),
      ...(state.report ? [{ id: 'report:' + state.report.id, label: `${state.report.kind} report · ${new Date(state.report.created_at).toLocaleString()}`, kind: 'report' }] : []),
    ],
    removeContext: id => {
      state.epoch++;
      if (id === 'device:' + state.target) state.target = '';
      if (state.report && id === 'report:' + state.report.id) state.report = null;
      syncTargets();
    },
    clearReport: () => { state.epoch++; state.report = null; syncTargets(); },
    clearContext,
    capture: () => state.chatEpoch,
    isCurrent: epoch => !state.locked && (epoch === undefined || epoch === state.chatEpoch),
    getContext: () => ({ target_id: state.target || null, diagnostic_id: state.report?.id || null,
      device_id: clientId(), retention_days: Number($('tli-image-retention')?.value || 0) }),
    showMeta: meta => { if (meta.provider) status(`Handled by ${meta.provider}${meta.model ? ' · ' + meta.model : ''}${meta.host ? ' · host ' + meta.host.name : ''}${meta.context_categories ? ' · context: ' + meta.context_categories.join(', ') : ''}`); },
  };
  window.addEventListener?.('tli-session-locked', () => { state.locked = true; clearContext({ private: true }); });
  window.addEventListener?.('pagehide', () => { state.locked = true; clearContext({ private: true }); });
  window.addEventListener?.('tli-session-unlocked', () => { state.locked = false; });
  function init() { initDevices(); initSettings(); initChat(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
