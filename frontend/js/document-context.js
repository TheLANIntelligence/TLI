/* Explicit, ephemeral text attachments for read-only document questions. */
(() => {
  'use strict';
  const MAX_BYTES = 64 * 1024, MAX_FILE_BYTES = 8 * 1024 * 1024;
  const EXTRACTION_PROTOCOL = 'tli-document-extraction-v1';
  const state = { selected: [], review: [], epoch: 0, read: 0, reading: false, serial: 0, support: null, abort: null };
  const requests = new WeakMap();
  const contextChanged = () => window.dispatchEvent?.(new CustomEvent('tli-chat-context-changed'));
  const $ = id => document.getElementById(id);
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const button = (text, action) => { const n = node('button', text, 'btn-outline'); n.type = 'button'; n.addEventListener('click', action); return n; };
  const bytes = text => new TextEncoder().encode(text).length;
  const validName = name => typeof name === 'string' && name === name.trim() && name.length <= 120 && !/^\.(txt|md|pdf|docx)$/i.test(name) && /\.(txt|md|pdf|docx)$/i.test(name) && !/[\p{C}\\/:\[\]]/u.test(name);
  const isRich = name => /\.(pdf|docx)$/i.test(name);
  const digest = async data => { if (!window.crypto?.subtle) throw new Error('PDF/Word review needs HTTPS or this computer’s localhost address for integrity checks. Text/Markdown still works.'); return Array.from(new Uint8Array(await window.crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join(''); };
  const message = text => { if ($('documents-status')) $('documents-status').textContent = text; };
  function renderSelected() {
    contextChanged();
    const box = $('documents-selected'); if (!box) return;
    box.replaceChildren(); box.hidden = !state.selected.length;
    if (!state.selected.length) return;
    box.append(node('strong', 'Documents for your next question'));
    state.selected.forEach(d => { const row = node('div', null, 'documents-row'); row.append(node('span', d.name), button('Remove ' + d.name, () => { state.selected = state.selected.filter(s => s.key !== d.key); renderSelected(); })); box.append(row); });
    box.append(node('p', 'Read-only question. Text is sent to the TLI host with this question. Longer files may supply whole-line excerpts; the answer shows their coverage. Text is not saved as an attachment, but replies may quote it.'), button('Review documents', open), button('Remove all documents', () => { state.selected = []; renderSelected(); }));
  }
  function renderReview() {
    const list = $('documents-list'); if (!list) return; list.replaceChildren();
    state.review.forEach(d => {
      const card = node('article', null, 'documents-card'); const details = node('details');
      details.append(node('summary', 'Preview ' + d.name), node('pre', d.extraction ? d.text.split('\n').map((line, i) => `L${i + 1}: ${line}`).join('\n') : d.text));
      details.open = !!d.extraction;
      card.append(node('h3', d.name), node('p', `${bytes(d.text).toLocaleString()} bytes · ${d.text.split('\n').length} lines`));
      if (d.extraction) { const origin = d.extraction.origin; card.append(node('p', `Extracted ${origin.format.toUpperCase()} text · ${origin.total_units} ${origin.unit_kind}s in original scope`)); }
      card.append(details);
      if (d.extraction) addOrigin(card, d.extraction.origin);
      card.append(button('Remove ' + d.name, () => { state.review = state.review.filter(s => s.key !== d.key); renderReview(); }));
      list.append(card);
    });
    if (!state.review.length) list.append(node('p', 'Choose files to review their contents here.'));
    $('documents-use').disabled = state.reading || !state.review.length;
    $('documents-choose').disabled = state.reading;
    if ($('documents-rich-choose')) $('documents-rich-choose').disabled = state.reading || !state.support;
    if ($('documents-check-support')) $('documents-check-support').disabled = state.reading;
  }
  async function readFiles(files, rich = false) {
    if (state.reading) return;
    const epoch = state.epoch, read = ++state.read;
    if (!files.length) return;
    state.reading = true; state.abort = rich ? new AbortController() : null; message(rich ? 'Uploading selected file to the TLI host for bounded text extraction. No AI request is running.' : 'Reading selected files on this browser…'); renderReview();
    try {
      if (state.review.length + files.length > 4) throw new Error('Choose up to four documents in total.');
      const names = new Set(state.review.map(d => d.name.toLocaleLowerCase()));
      let total = state.review.reduce((sum, d) => sum + bytes(d.text), 0);
      for (const file of files) {
        if (!validName(file.name) || isRich(file.name) !== rich) throw new Error(rich ? 'Choose a PDF or DOCX file with a plain filename, without brackets, colons, control characters or path separators.' : 'Choose .txt or .md files with names up to 120 characters, without brackets, colons, control characters or path separators.');
        const name = file.name.toLocaleLowerCase();
        if (names.has(name)) throw new Error('Each document must have a different filename: ' + file.name);
        names.add(name); if (!rich) total += file.size;
        if (!Number.isFinite(file.size) || file.size < 0 || (!rich && total > MAX_BYTES)) throw new Error('Selected text must total 64 KiB or less. Choose smaller files or excerpts.');
        if (rich && (!state.support?.formats?.[name.split('.').pop()]?.available || file.size > MAX_FILE_BYTES || !file.size)) throw new Error('Choose an available PDF/DOCX format, up to 8 MiB per file.');
      }
      const added = [];
      for (const file of files) {
        const buffer = await file.arrayBuffer();
        if (epoch !== state.epoch || read !== state.read) return;
        if (buffer.byteLength !== file.size) throw new Error('The file changed while being read. Choose it again.');
        if (rich) {
          const originalHash = await digest(buffer);
          if (epoch !== state.epoch || read !== state.read) return;
          const response = await fetch('/api/ai/documents/extract?name=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json' }, body: buffer, signal: state.abort.signal, cache: 'no-store' });
          let data; try { data = await response.json(); } catch (_) {}
          if (epoch !== state.epoch || read !== state.read) return;
          if (response.status === 401) { clear(); throw new Error('Unlock TLI and choose the original document again.'); }
          if (!response.ok || data?.ok !== true) throw new Error(typeof data?.detail === 'string' ? data.detail : 'This TLI host could not extract the document.');
          const d = data.document, origin = d?.extraction?.origin;
          if (data.protocol !== EXTRACTION_PROTOCOL || !d || d.name !== file.name || typeof d.text !== 'string' || !d.text.trim() || bytes(d.text) > MAX_BYTES || !validOrigin(origin, d.name, d.text.split('\n').length) || origin.original_sha256 !== originalHash || origin.original_bytes !== file.size || !Number.isInteger(d.extraction.expires_at) || d.extraction.expires_at * 1000 <= Date.now() || !/^[a-f0-9]{64}$/.test(d.extraction.signature) || origin.text_sha256 !== await digest(new TextEncoder().encode(d.text))) throw new Error('The host returned inconsistent extracted text or source metadata. Choose the original file again.');
          if (epoch !== state.epoch || read !== state.read) return;
          added.push({ name: d.name, text: d.text, extraction: d.extraction, key: ++state.serial });
          continue;
        }
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/\r\n?/g, '\n'); }
        catch (_) { throw new Error(file.name + ': save this document as UTF-8 text first.'); }
        if (!text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) throw new Error(file.name + ': choose a nonempty plain-text document, without binary content.');
        added.push({ name: file.name, text, key: ++state.serial });
      }
      if (state.review.concat(added).reduce((sum, d) => sum + bytes(d.text), 0) > MAX_BYTES) throw new Error('Selected text must total 64 KiB or less.');
      state.review = state.review.concat(added); message(rich ? 'Extraction complete. Review the text, page/paragraph mapping and omissions before Use in chat. The host read this upload; no AI request has been sent.' : 'Review the files, then choose Use in chat. Nothing has been sent.');
    } catch (e) { if (epoch === state.epoch && read === state.read) message(e.message + ' Your previous selection is unchanged.'); }
    finally { if (epoch === state.epoch && read === state.read) { state.reading = false; state.abort = null; renderReview(); } }
  }
  function open() {
    const dialog = $('documents-dialog'); if (!dialog) return;
    if (!dialog.open) { state.review = [...state.selected]; message(''); renderReview(); dialog.showModal(); }
  }
  function cancelReview() { state.abort?.abort(); state.abort = null; state.read++; state.reading = false; state.review = []; $('documents-input').value = ''; if ($('documents-rich-input')) $('documents-rich-input').value = ''; renderReview(); $('documents-dialog').close(); }
  function clear() {
    state.abort?.abort(); state.abort = null; state.support = null; state.epoch++; state.read++; state.reading = false; state.selected = []; state.review = [];
    if ($('documents-dialog')?.open) $('documents-dialog').close();
    if ($('documents-input')) $('documents-input').value = '';
    if ($('documents-rich-input')) $('documents-rich-input').value = '';
    if ($('documents-support-status')) $('documents-support-status').textContent = '';
    message(''); renderSelected(); renderReview();
  }
  function requestContext(context, { image = false, text = '' } = {}) {
    if (state.reading) throw new Error('Wait for the documents to finish reading.');
    if ($('documents-dialog')?.open) throw new Error('Choose Use in chat or Cancel in the document review first.');
    if (!state.selected.length) return context;
    if (image || context.screenshot || context.note_refs?.length || context.target_id || context.diagnostic_id || context.case_ref || context.include_vault_secrets || /\[vault:[^\]]+\]/i.test(text)) throw new Error('Ask about documents on their own. Remove other selected notes, images, device/report context or vault references first.');
    if (state.selected.some(d => d.extraction && d.extraction.expires_at * 1000 <= Date.now())) throw new Error('A PDF/Word extraction expired. Remove it and choose the original file again. Nothing was sent.');
    const request = { ...context, documents: state.selected.map(d => ({ name: d.name, text: d.text, ...(d.extraction ? { extraction: JSON.parse(JSON.stringify(d.extraction)) } : {}) })) };
    requests.set(request, { epoch: state.epoch, keys: state.selected.map(d => d.key) }); return request;
  }
  function validReceipt(context) {
    return context?.actions_performed === false && Array.isArray(context.documents) && context.documents.length > 0 && context.documents.length <= 4 &&
      new Set(context.documents.map(d => d?.name?.toLocaleLowerCase())).size === context.documents.length &&
      context.documents.every(d => d && validName(d.name) && /^[a-f0-9]{64}$/.test(d.sha256) && Number.isInteger(d.line_count) && d.line_count > 0 && d.line_count <= MAX_BYTES + 1 && Number.isInteger(d.chars) && d.chars > 0 && d.chars <= MAX_BYTES && validCoverage(d) && (isRich(d.name) ? validOrigin(d.extraction, d.name, d.line_count) && d.extraction.text_sha256 === d.sha256 : !d.extraction));
  }
  function validOrigin(o, name, lines) {
    if (!o || o.version !== 1 || !['pdf', 'docx'].includes(o.format) || !name.toLowerCase().endsWith('.' + o.format) || o.unit_kind !== (o.format === 'pdf' ? 'page' : 'paragraph') || !/^[a-f0-9]{64}$/.test(o.original_sha256) || !/^[a-f0-9]{64}$/.test(o.text_sha256) || !Number.isInteger(o.original_bytes) || o.original_bytes < 1 || o.original_bytes > MAX_FILE_BYTES || typeof o.parser !== 'string' || !o.parser.length || o.parser.length > 64 || !Number.isInteger(o.total_units) || o.total_units < 1 || o.total_units > (o.format === 'pdf' ? 100 : 500) || !Array.isArray(o.units) || !o.units.length || o.units.length > 500 || !Array.isArray(o.empty_units) || o.empty_units.length > 500 || !Array.isArray(o.omissions) || !o.omissions.length || o.omissions.length > 6 || o.omissions.some(s => typeof s !== 'string' || s.length > 300)) return false;
    let end = 0, number = 0; const seen = new Set();
    for (const u of o.units) { if (!u || !Number.isInteger(u.number) || u.number <= number || u.number > o.total_units || !Number.isInteger(u.start) || u.start !== end + 1 || !Number.isInteger(u.end) || u.end < u.start || u.end > lines) return false; end = u.end; number = u.number; seen.add(number); }
    for (const n of o.empty_units) { if (!Number.isInteger(n) || n < 1 || n > o.total_units || seen.has(n)) return false; seen.add(n); }
    return end === lines && seen.size === o.total_units;
  }
  function addOrigin(box, o, ranges) {
    const details = node('details'); details.append(node('summary', 'Extraction scope & original locations'));
    const units = o.units.filter(u => !ranges || ranges.some(r => u.start <= r.end && r.start <= u.end));
    details.append(node('p', 'Line references identify extracted text, not visual page lines. ' + units.map(u => `${o.unit_kind === 'page' ? 'Page' : 'Paragraph'} ${u.number}: L${u.start}–L${u.end}`).join('; ')));
    if (o.empty_units.length) details.append(node('p', `No text extracted from ${o.unit_kind}s: ${o.empty_units.join(', ')}. These may be blank or contain unsupported content.`));
    o.omissions.forEach(text => details.append(node('p', text)));
    details.append(node('p', 'Original file SHA-256 ' + o.original_sha256, 'documents-source-hash')); box.append(details);
  }
  async function checkSupport() {
    if (state.reading) return;
    const epoch = state.epoch, read = ++state.read;
    state.reading = true; state.abort = new AbortController(); renderReview();
    $('documents-support-status').textContent = 'Checking this host’s document reader…';
    try {
      if (!window.crypto?.subtle) throw new Error('PDF/Word review needs HTTPS or this computer’s localhost address for integrity checks. Text/Markdown still works.');
      const response = await fetch('/api/ai/documents/extraction-capabilities', { cache: 'no-store', signal: state.abort.signal, headers: { Accept: 'application/json' } });
      let data; try { data = await response.json(); } catch (_) {}
      if (epoch !== state.epoch || read !== state.read) return;
      if (response.status === 401) { clear(); return; }
      if (!response.ok || data?.ok !== true || data.protocol !== EXTRACTION_PROTOCOL || !data.formats?.pdf || !data.formats?.docx) throw new Error('This host does not provide the supported isolated PDF/Word reader. Text/Markdown is still available.');
      state.support = ['pdf','docx'].some(kind => data.formats[kind].available === true) ? data : null;
      $('documents-support-status').textContent = ['pdf','docx'].map(kind => kind.toUpperCase() + ': ' + (data.formats[kind].available === true ? 'Available' : String(data.formats[kind].reason || 'Unavailable'))).join(' · ');
      $('documents-rich-input').accept = ['pdf','docx'].filter(kind => data.formats[kind].available === true).map(kind => '.' + kind).join(',');
    } catch (e) { if (epoch === state.epoch && read === state.read) { state.support = null; $('documents-support-status').textContent = e.message; } }
    finally { if (epoch === state.epoch && read === state.read) { state.reading = false; state.abort = null; renderReview(); } }
  }
  function validCoverage(doc) {
    if (!Object.prototype.hasOwnProperty.call(doc, 'coverage')) return true;
    const c = doc.coverage;
    if (!c || !['full', 'excerpts', 'omitted'].includes(c.mode) || !Array.isArray(c.ranges) || c.ranges.length > 32 || !Number.isInteger(c.included_lines) || !Number.isInteger(c.omitted_lines) || c.included_lines < 0 || c.omitted_lines < 0 || c.included_lines + c.omitted_lines !== doc.line_count) return false;
    let previous = 0, included = 0;
    for (const span of c.ranges) {
      if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start <= previous || span.end < span.start || span.end > doc.line_count) return false;
      included += span.end - span.start + 1; previous = span.end;
    }
    if (included !== c.included_lines) return false;
    if (c.mode === 'full') return included === doc.line_count && c.selection === 'full';
    if (c.mode === 'omitted') return included === 0 && c.selection === 'none';
    return included > 0 && included < doc.line_count && ['question_terms', 'representative'].includes(c.selection);
  }
  function isCurrent(context) { return !context.documents?.length || requests.get(context)?.epoch === state.epoch; }
  async function ensureAvailable(context, signal) {
    if (!context.documents?.length) return;
    let response, data;
    try {
      response = await fetch('/api/ai/documents/capabilities', { signal, cache: 'no-store', headers: { Accept: 'application/json' } });
      data = await response.json();
    } catch (error) { if (error.name === 'AbortError') throw error; /* Old SPA fallback may be HTML. */ }
    if (!response?.ok || data?.ok !== true || data.protocol !== 'tli-document-questions-v1') throw new Error('Document questions are unavailable on this backend. Reconnect, or update and restart TLI normally before sending documents. No document question was sent.');
  }
  function sent(context, meta) {
    if (!context.documents?.length || !isCurrent(context)) return;
    const receipt = meta?.document_context;
    if (!validReceipt(receipt) || receipt.documents.length !== context.documents.length || context.documents.some(d => !receipt.documents.some(r => r.name === d.name && r.line_count === d.text.split('\n').length && r.chars === Array.from(d.text).length && (!d.extraction || r.extraction?.original_sha256 === d.extraction.origin.original_sha256 && r.sha256 === d.extraction.origin.text_sha256)))) throw new Error('TLI did not confirm which documents were used. Your selections are still here.');
    const keys = requests.get(context).keys;
    state.selected = state.selected.filter(d => !keys.includes(d.key)); renderSelected();
  }
  function annotateReply(bubble, meta) {
    const receipt = meta?.document_context; if (!bubble || !validReceipt(receipt)) return;
    const box = node('aside', null, 'documents-receipt'); box.append(node('strong', 'Documents provided to AI'));
    if (receipt.documents.some(d => d.coverage && d.coverage.mode !== 'full')) box.append(node('p', 'Only the listed passages were provided. This answer is not a review of every line in the selected files.', 'documents-coverage-notice'));
    receipt.documents.forEach(d => {
      const c = d.coverage, row = node('section', null, 'documents-coverage');
      row.append(node('strong', d.name));
      row.append(node('p', !c ? `${d.line_count.toLocaleString()} source lines · No coverage breakdown recorded` : c.mode === 'full' ? `${d.line_count.toLocaleString()} lines provided · ${d.extraction ? 'Full extracted text supplied' : 'Full text supplied'}` : c.mode === 'omitted' ? `No lines provided · ${c.omitted_lines.toLocaleString()} lines omitted` : `${c.included_lines.toLocaleString()} of ${d.line_count.toLocaleString()} lines provided · ${c.omitted_lines.toLocaleString()} omitted`));
      if (c?.ranges.length) row.append(node('p', (d.extraction ? 'Extracted lines: ' : 'Original lines: ') + c.ranges.map(r => r.start === r.end ? `L${r.start}` : `L${r.start}–L${r.end}`).join(', '), 'documents-line-ranges'));
      if (c?.mode === 'excerpts') row.append(node('p', c.selection === 'question_terms' ? 'Selected by matching question words, with nearby context. Other relevant passages may be omitted.' : 'Sampled from positions across the document; no question-word matches were found. Other relevant passages may be omitted.'));
      if (d.extraction) addOrigin(row, d.extraction, c?.ranges);
      const hash = node('p', `Host SHA-256 ${d.sha256.slice(0, 12)}…`, 'documents-source-hash'); hash.title = 'Hash of the complete normalized text reported by this TLI host: ' + d.sha256; row.append(hash);
      box.append(row);
    });
    box.append(node('p', 'No actions performed. Check line references against your file. Reattach documents for another question; their contents are not saved as attachments.')); bubble.append(box);
  }
  function init() {
    const row = document.querySelector('.chat-input-row'); if (!row || $('documents-dialog')) return;
    const selected = node('section', null, 'documents-selected'); selected.id = 'documents-selected'; selected.hidden = true; selected.setAttribute('aria-label', 'Documents selected for chat'); row.before(selected);
    $('documents-open')?.addEventListener('click', open);
    const dialog = node('dialog', null, 'documents-dialog'); dialog.id = 'documents-dialog'; dialog.setAttribute('aria-labelledby', 'documents-heading');
    const heading = node('h2', 'Ask about documents'); heading.id = 'documents-heading';
    const input = node('input'); input.id = 'documents-input'; input.type = 'file'; input.accept = '.txt,.md,text/plain,text/markdown'; input.multiple = true; input.hidden = true;
    input.addEventListener('change', () => { const files = Array.from(input.files || []); input.value = ''; return readFiles(files); });
    const choose = button('Choose text or Markdown files', () => input.click()); choose.id = 'documents-choose';
    const rich = node('details'); rich.append(node('summary', 'PDF & Word documents'));
    rich.append(node('p', 'Choosing a PDF or DOCX uploads that file to this TLI host for text extraction before chat. Review the extracted text here. No AI, OCR, macros or external document links are run. Up to 8 MiB, 100 PDF pages or 500 main-body Word paragraphs; all selected extracted/text content must total 64 KiB.'));
    const support = node('p'); support.id = 'documents-support-status'; support.setAttribute('role', 'status');
    const check = button('Check PDF & Word support', checkSupport); check.id = 'documents-check-support';
    const richInput = node('input'); richInput.id = 'documents-rich-input'; richInput.type = 'file'; richInput.accept = '.pdf,.docx'; richInput.hidden = true;
    richInput.addEventListener('change', () => { const files = Array.from(richInput.files || []); richInput.value = ''; return readFiles(files, true); });
    const richChoose = button('Choose PDF or Word file · upload for review', () => richInput.click()); richChoose.id = 'documents-rich-choose'; richChoose.disabled = true;
    rich.append(check, support, richInput, richChoose, node('p', 'Cancel stops this browser waiting; a host extraction already started may finish within its time limit. Uploads and extracted text are not saved as attachments.'));
    const status = node('p'); status.id = 'documents-status'; status.setAttribute('role', 'status');
    const list = node('div', null, 'documents-list'); list.id = 'documents-list';
    const actions = node('div', null, 'documents-actions'); const use = button('Use in chat', () => { if (state.reading || !state.review.length) return; state.selected = [...state.review]; renderSelected(); cancelReview(); $('chat-input')?.focus(); }); use.id = 'documents-use';
    actions.append(use, button('Cancel', cancelReview));
    dialog.append(heading, node('p', 'Choose up to four documents, 64 KiB of text total. Text/Markdown stays in this browser until send. PDF/Word uses the separate host extraction controls below. Review the contents, then write your question in chat.'),
      node('p', 'The TLI host receives selected text when you send. Short files are supplied in full to your selected AI provider. Longer files use whole-line passages matched to your question, or samples across the file; the answer shows included ranges and omitted lines.'),
      node('p', 'File text is not saved as an attachment; your question and AI reply are saved in chat history. Excerpts can miss relevant details. A line too long for the model is never silently cut.'), input, choose, rich, status, list, actions);
    dialog.addEventListener('cancel', e => { e.preventDefault(); cancelReview(); }); document.body.append(dialog);
    $('new-chat-btn')?.addEventListener('click', clear); window.addEventListener('tli-session-locked', clear); window.addEventListener('pagehide', clear);
  }
  function describeContext() {
    return state.selected.map(d => ({ id: 'document:' + d.key, label: d.name, kind: 'document' }));
  }
  function removeContext(id) {
    state.selected = state.selected.filter(d => 'document:' + d.key !== id); renderSelected();
  }
  window.TLIDocuments = { open, clear, requestContext, isCurrent, ensureAvailable, sent, annotateReply, describeContext, removeContext };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
