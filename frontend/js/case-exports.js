/* Explicit, reviewed, unencrypted troubleshooting exports. No local persistence. */
(() => {
  'use strict';
  const BASE = '/api/intelligence/case-exports', LIMIT = 512 * 1024;
  const $ = id => document.getElementById(id);
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const state = { epoch: 0, open: false, locked: false, busy: false, row: null, guard: null, preview: null, controller: null, url: null, returnTo: null };
  const active = epoch => state.open && !state.locked && state.epoch === epoch && state.guard?.() !== false;
  function status(text, error = false) { const n = $('case-export-status'); if (n) { n.textContent = text; n.classList.toggle('error', error); } }
  function button(text, callback, primary = false) {
    const b = node('button', text, primary ? 'btn-primary' : 'btn-outline'); b.type = 'button';
    b.addEventListener('click', async () => { if (b.disabled || !active(state.epoch)) return; try { await callback(); } catch (e) { if (active(state.epoch)) status(e.message, true); } }); return b;
  }
  function field(text, control) { const n = node('label', null, 'case-export-field'); n.append(node('span', text), control); return n; }
  function controls() {
    $('case-export-preview-button').disabled = state.busy;
    $('case-export-download').disabled = state.busy || !state.preview || !$('case-export-reviewed').checked;
    $('case-export-selection').querySelectorAll('input,textarea,select').forEach(n => { n.disabled = state.busy; });
    // Unavailable/changed sources are still exportable as historical pointers only.
    $('case-export-selection').querySelectorAll('[data-export-content]').forEach(n => { n.disabled = state.busy || n.dataset.available !== 'true'; });
  }
  function invalidate() {
    state.preview = null; $('case-export-reviewed').checked = false;
    controls(); status('Selection changed. Review a fresh preview before downloading. The previous preview remains for comparison.');
  }
  function selection() {
    const rows = state.row.evidence;
    const terms = $('case-export-terms').value.split('\n').filter(v => v.trim());
    if (terms.length > 40 || terms.some(v => v.length > 256)) throw new Error('Use at most 40 redaction terms, each up to 256 characters.');
    return { case_id: state.row.id, expected_revision: state.row.revision,
      evidence: rows.flatMap((r, i) => !$('case-export-choose-' + i).checked ? [] : [{ kind: r.kind, id: r.id, revision: r.revision,
        ...(r.kind === 'chat' ? { message_index: r.message_index } : {}), include_content: $('case-export-content-' + i).checked }]),
      redactions: { identifiers: $('case-export-identifiers').checked, terms }, format: $('case-export-format').value };
  }
  async function request(path, body, epoch) {
    state.controller = new AbortController();
    const r = await fetch(BASE + path, { method: 'POST', cache: 'no-store', redirect: 'error', signal: state.controller.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!active(epoch)) return null;
    if (r.status === 401) { window.dispatchEvent(new CustomEvent('tli-session-locked')); return null; }
    if (!r.ok) { const d = await r.json().catch(() => null); throw new Error(typeof d?.detail === 'string' ? d.detail : `Export request failed (${r.status}). Your saved work is unchanged.`); }
    return r;
  }
  async function digest(bytes) {
    if (!crypto.subtle) throw new Error('Export verification needs HTTPS or TLI opened on the host computer.');
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  }
  async function preview() {
    if (state.busy || !active(state.epoch)) return;
    const selected = selection(), epoch = state.epoch;
    state.busy = true; controls(); status('Preparing the selected saved record and redactions…');
    try {
      const r = await request('/preview', selected, epoch); if (!r) return;
      const d = await r.json(); if (!active(epoch)) return;
      const bytes = typeof d?.preview === 'string' ? new TextEncoder().encode(d.preview) : null;
      if (d?.ok !== true || d.protocol !== 'tli-case-export-v1' || d.actions_performed !== false || d.source_unchanged !== true || d.format !== selected.format
        || !bytes || !bytes.length || bytes.length > LIMIT || d.bytes !== bytes.length || !/^[a-f0-9]{64}$/.test(d.review_token || '')
        || !/^[a-f0-9]{64}$/.test(d.preview_sha256 || '') || !Number.isFinite(Date.parse(d.checked_at))
        || !Number.isInteger(d.expires_in_seconds) || d.expires_in_seconds < 1 || d.expires_in_seconds > 600
        || d.filename !== 'tli-troubleshooting.' + ({html:'html',text:'txt',json:'json'}[selected.format])) throw new Error('The export preview was incomplete. No download was enabled.');
      if (await digest(bytes) !== d.preview_sha256) throw new Error('The preview checksum did not match. Request a new preview.');
      if (!active(epoch)) return;
      state.preview = { ...d, selection: selected }; $('case-export-reviewed').checked = false;
      const output = $('case-export-output'); output.replaceChildren();
      if (selected.format === 'html') { const frame = node('iframe'); frame.title = 'Exact redacted troubleshooting export'; frame.setAttribute('sandbox', ''); frame.setAttribute('referrerpolicy', 'no-referrer'); frame.srcdoc = d.preview; output.append(frame); }
      else output.append(node('pre', d.preview));
      $('case-export-preview-section').hidden = false;
      status(`Preview ready · ${d.bytes.toLocaleString()} bytes · ${selected.evidence.length} selected evidence items. Review every section; automatic redaction cannot detect every secret. Nothing has been downloaded.`);
    } catch (e) { if (active(epoch)) status(e.message + ' Previous preview and your selections were retained; retry deliberately.', true); }
    finally { if (active(epoch)) { state.busy = false; controls(); } }
  }
  async function download() {
    if (state.busy || !state.preview || !$('case-export-reviewed').checked || !active(state.epoch)) return;
    const p = state.preview, epoch = state.epoch;
    if (JSON.stringify(selection()) !== JSON.stringify(p.selection)) { invalidate(); return; }
    state.busy = true; controls(); status('Rechecking the reviewed revisions and preparing your download…');
    try {
      const r = await request('/download', { selection: p.selection, review_token: p.review_token, preview_sha256: p.preview_sha256, reviewed: true }, epoch); if (!r) return;
      const raw = await r.arrayBuffer(); if (!active(epoch)) return;
      if (raw.byteLength !== p.bytes || raw.byteLength > LIMIT || r.headers.get('X-TLI-Export-SHA256') !== p.preview_sha256
        || await digest(raw) !== p.preview_sha256) throw new Error('Downloaded bytes differ from your reviewed preview. No file was offered.');
      if (!active(epoch)) return;
      if (state.url) URL.revokeObjectURL(state.url);
      state.url = URL.createObjectURL(new Blob([raw], { type: { html:'text/html',text:'text/plain',json:'application/json' }[p.format] }));
      const link = node('a'); link.href = state.url; link.download = p.filename; document.body.append(link); link.click(); link.remove();
      const url = state.url; setTimeout(() => { URL.revokeObjectURL(url); if (state.url === url) state.url = null; }, 1000);
      status('Download offered to your browser. Confirm the file was saved. It is unencrypted: share it only after reviewing the redactions. Original saved work is unchanged.');
    } catch (e) { if (active(epoch)) status(e.message + ' The reviewed preview remains; no request was replayed.', true); }
    finally { if (active(epoch)) { state.busy = false; controls(); } }
  }
  function close() {
    state.epoch++; state.open = false; state.busy = false; state.controller?.abort(); state.controller = null;
    state.preview = null; state.row = null; state.guard = null;
    if (state.url) URL.revokeObjectURL(state.url); state.url = null;
    const d = $('case-export-dialog'); if (d) { if (d.open) d.close(); d.replaceChildren(); }
    state.returnTo?.focus?.(); state.returnTo = null;
  }
  function open(row, options = {}) {
    if (state.locked || options.current?.() === false || !row?.id || !/^[a-f0-9]{64}$/.test(row.revision || '') || !Array.isArray(row.evidence)) return;
    close(); state.returnTo = document.activeElement; state.row = JSON.parse(JSON.stringify(row)); state.guard = options.current || (() => true); state.open = true;
    let dialog = $('case-export-dialog');
    if (!dialog) { dialog = node('dialog', null, 'case-export-dialog'); dialog.id = 'case-export-dialog'; dialog.setAttribute('aria-labelledby', 'case-export-title'); dialog.addEventListener('cancel', e => { e.preventDefault(); close(); }); dialog.addEventListener('close', () => { if (!dialog.open && state.open) close(); }); document.body.append(dialog); }
    const title = node('h2', 'Review a troubleshooting export'); title.id = 'case-export-title';
    const top = node('header', null, 'case-export-header'); const exit = node('button', 'Close', 'btn-outline'); exit.type = 'button'; exit.addEventListener('click', close); top.append(title, exit);
    const feedback = node('p', 'Choose exactly what to include, then review the redacted preview.', 'case-export-status'); feedback.id = 'case-export-status'; feedback.setAttribute('role', 'status');
    const form = node('section', null, 'case-export-selection'); form.id = 'case-export-selection';
    form.append(node('h3', row.title), node('p', 'Includes this saved problem’s symptom, steps and recorded outcome. Unsaved drafts are excluded. Source content is included only when you select it below.'));
    const evidence = node('fieldset'); evidence.append(node('legend', 'Linked evidence (optional)'));
    if (!row.evidence.length) evidence.append(node('p', 'No evidence is linked to this saved problem.'));
    row.evidence.forEach((r, i) => {
      const item = node('div', null, 'case-export-evidence');
      const choose = node('input'); choose.type = 'checkbox'; choose.id = 'case-export-choose-' + i;
      const content = node('input'); content.type = 'checkbox'; content.id = 'case-export-content-' + i; content.dataset.exportContent = 'true'; content.dataset.available = String(r.availability === 'current'); content.disabled = r.availability !== 'current';
      choose.addEventListener('change', () => { if (!choose.checked) content.checked = false; invalidate(); });
      content.addEventListener('change', () => { if (content.checked) choose.checked = true; invalidate(); });
      item.append(field(`${r.label} · ${r.kind}`, choose), field('Include this source’s text / report results', content), node('small', r.availability === 'current' ? 'A selected body is checked against its saved revision before preview and download.' : 'Changed or unavailable: export a historical pointer only. No earlier body will be reconstructed.')); evidence.append(item);
    });
    const identifiers = node('input'); identifiers.type = 'checkbox'; identifiers.id = 'case-export-identifiers'; identifiers.checked = true;
    const terms = node('textarea'); terms.id = 'case-export-terms'; terms.maxLength = 10280; terms.rows = 3; terms.placeholder = 'One name, address or other exact phrase per line';
    const format = node('select'); format.id = 'case-export-format'; [['html','Readable HTML'],['text','Plain text'],['json','Structured JSON']].forEach(([value,label]) => { const n = node('option',label); n.value = value; format.append(n); }); format.value = 'html';
    identifiers.addEventListener('change', invalidate); terms.addEventListener('input', invalidate); format.addEventListener('change', invalidate);
    form.append(evidence, field('Redact identifiers, known computer names, common addresses and paths', identifiers), field('Also redact these exact phrases (optional; up to 40)', terms), field('Download format', format), node('p', 'Automatic redaction cannot find every secret. Review the entire preview. The downloaded file is unencrypted, has no automatic connection to TLI and is not a backup.', 'case-export-warning'));
    const prepare = button('Prepare redacted preview', preview, true); prepare.id = 'case-export-preview-button';
    const previewSection = node('section', null, 'case-export-preview'); previewSection.id = 'case-export-preview-section'; previewSection.hidden = true;
    const output = node('div'); output.id = 'case-export-output';
    const reviewed = node('input'); reviewed.type = 'checkbox'; reviewed.id = 'case-export-reviewed'; reviewed.addEventListener('change', controls);
    const save = button('Download reviewed export', download, true); save.id = 'case-export-download'; save.disabled = true;
    previewSection.append(node('h3', 'Your exact export preview'), output, field('I reviewed this preview and the information it will share.', reviewed), save);
    dialog.append(top, feedback, form, prepare, previewSection); dialog.showModal();
  }
  window.addEventListener('tli-session-locked', () => { state.locked = true; close(); });
  window.addEventListener('tli-session-unlocked', () => { state.locked = false; });
  window.addEventListener('pagehide', close);
  document.addEventListener('visibilitychange', () => { if (document.hidden) close(); });
  window.TLICaseExport = { open, close };
})();
