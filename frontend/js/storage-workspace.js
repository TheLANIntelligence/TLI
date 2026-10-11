/* Shared preparation only. Each view owns its scans, reviews and execution. */
(function () {
  'use strict';
  if (window.TLIStorageWorkspace) return;
  const el = id => document.getElementById(id);
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const label = (id, text) => el(id)?.setAttribute('aria-label', text);
  let locked = false, pending = null, context = null;
  const pathOK = path => typeof path === 'string' && path.trim().length > 0 && path.length <= 4096 && !/[\x00-\x1f\x7f]/.test(path);
  const hostId = () => window.TLIUI?.hostIdentity?.get?.().id || window.TLIHostIdentity?.get?.().id || null;
  function normalizeIntent(value) {
    if (!value || !['organize','space'].includes(value.view) || !pathOK(value.root)) return null;
    if (value.hostId != null && (typeof value.hostId !== 'string' || value.hostId.length > 160 || /[\x00-\x1f\x7f]/.test(value.hostId))) return null;
    if (value.hostId && hostId() && value.hostId !== hostId()) return null;
    const paths = value.candidatePaths ?? [];
    if (!Array.isArray(paths) || paths.length > 500 || paths.some(path => !pathOK(path))) return null;
    const observation = value.observation;
    if (observation != null && (typeof observation !== 'object' || Array.isArray(observation) ||
      (observation.id != null && (typeof observation.id !== 'string' || observation.id.length > 160)) ||
      (observation.coverage != null && (typeof observation.coverage !== 'string' || observation.coverage.length > 1200)) ||
      (observation.recordedAt != null && !(typeof observation.recordedAt === 'number' && Number.isFinite(observation.recordedAt)) && !(typeof observation.recordedAt === 'string' && observation.recordedAt.length <= 80)))) return null;
    return {view:value.view,root:value.root.trim(),hostId:value.hostId || null,candidatePaths:[...new Set(paths)],
      observation:observation ? {id:observation.id || null,recordedAt:observation.recordedAt || null,coverage:observation.coverage || ''} : null,
      source:typeof value.source === 'string' ? value.source.slice(0,80) : 'navigation'};
  }
  function message(text) { if (typeof showToast === 'function') showToast(text); }
  function dismissPending() { pending = null; el('storage-folder-handoff')?.remove(); }
  function showPending(intent, currentRoot) {
    dismissPending(); pending = intent;
    const panel = el('panel-files'); if (!panel) return;
    const box = make('section', '', 'storage-folder-handoff'); box.id = 'storage-folder-handoff'; box.setAttribute('aria-label', 'Choose a folder draft');
    const title = make('h3', 'Keep your current draft or prepare another folder');
    box.append(title, make('p', `Current folder: ${currentRoot}`), make('p', `Requested folder: ${intent.root}`),
      make('p', 'Using this folder prepares its path. Your current file selection stays available until a new scan succeeds. No scan or move starts here.'));
    const use = make('button', 'Use this folder', 'pill-btn primary'); use.type = 'button'; use.id = 'storage-use-folder';
    const keep = make('button', 'Keep current draft', 'pill-btn ghost'); keep.type = 'button'; keep.id = 'storage-keep-draft';
    use.addEventListener('click', () => {
      if (locked || pending !== intent) return;
      const checked = normalizeIntent(intent); if (!checked) { message('The host or folder context changed. Prepare this location again.'); return; }
      const result = window.TLIFiles?.prepare(checked, true);
      if (result?.status === 'prepared') { context = checked; dismissPending(); renderContext(); el('filesRootInput')?.focus(); }
      else message('Finish the current file operation before changing folders.');
    });
    keep.addEventListener('click', () => { dismissPending(); el('filesRootInput')?.focus(); });
    box.append(use, keep); (el('files-prepare') || panel).append(box); box.scrollIntoView?.({block:'nearest'}); use.focus?.();
  }
  function renderContext() {
    for (const view of ['organize','space']) {
      const id = 'storage-context-' + view; el(id)?.remove();
      if (!context || context.view !== view) continue;
      const panel = el(view === 'organize' ? 'panel-files' : 'panel-visualizer'); if (!panel) continue;
      const box = make('div', '', 'storage-folder-context'); box.id = id;
      box.append(make('p', `Prepared location: ${context.root}`));
      if (context.observation) {
        const at = context.observation.recordedAt, date = new Date(typeof at === 'number' ? at * 1000 : at);
        box.append(make('p', `From a recorded storage observation${at && Number.isFinite(date.getTime()) ? ' · ' + date.toLocaleString() : ''}. ${context.observation.coverage}`));
      }
      box.append(make('p', view === 'organize' ? 'Organizing keeps files on this drive; it does not free capacity.' : 'Choose Scan to inspect this location. Existing observations keep their own scope and time.'));
      if (view === 'space' && panel.querySelector('.page-header')) panel.querySelector('.page-header').after(box);
      else (view === 'organize' ? el('files-prepare') || panel : panel).append(box);
    }
  }
  function prepare(value) {
    const intent = normalizeIntent(value);
    if (locked || !intent) { message('This folder handoff is unavailable or belongs to a different host.'); return {status:'unavailable'}; }
    const controller = intent.view === 'organize' ? window.TLIFiles : window.TLIFreeSpace;
    if (!controller?.prepare || typeof switchPanel !== 'function') return {status:'unavailable'};
    const result = intent.view === 'organize' ? controller.prepare(intent) : {status:controller.prepare(intent.root) ? 'prepared' : 'unavailable'};
    if (!['prepared','draft-conflict'].includes(result.status)) { message('Finish the current file operation before preparing another folder.'); return result; }
    switchPanel(intent.view === 'organize' ? 'panel-files' : 'panel-visualizer');
    if (result.status === 'draft-conflict') showPending(intent,result.root);
    else { dismissPending(); context = intent; renderContext(); }
    return {status:result.status};
  }
  function disclosure(id, title, content, open = false) {
    let box = el(id);
    if (box) return box;
    box = make('details', '', 'storage-disclosure'); box.id = id; box.open = open;
    box.append(make('summary', title));
    if (content) { content.before(box); box.append(content); }
    return box;
  }
  function initFiles() {
    const panel = el('panel-files');
    if (!panel || panel.dataset.storageWorkspace) return;
    panel.dataset.storageWorkspace = 'true';
    panel.querySelector('.page-subtitle').textContent = 'Choose a folder, prepare a plan, then review the exact changes. Files move only after you confirm.';
    const prepare = make('section', '', 'storage-stage'); prepare.id = 'files-prepare';
    prepare.setAttribute('aria-labelledby', 'files-prepare-title');
    const heading = make('h3', '1. Prepare'); heading.id = 'files-prepare-title';
    const tiles = panel.querySelector('.fo-folder-tiles'); tiles.before(prepare);
    prepare.append(heading, make('p', 'Choose a folder on the computer hosting TLI.', 'storage-help'), tiles, panel.querySelector('.fo-scan-row'));
    const plan = panel.querySelector('.fo-plan-card'); plan.id = 'files-plan';
    plan.querySelector('.section-heading > span').textContent = '2. Review';
    plan.querySelector('.section-subhead').textContent = 'Select the files to organize. Everything else stays here. Review the exact paths before moving.';
    el('filesPreviewButton').hidden = true; // Both existing handlers open the same review.
    el('filesRunButton').textContent = 'Review moves';
    el('filesStatus').setAttribute('role', 'status');
    const result = make('section', '', 'card-section storage-operation-results'); result.id = 'files-operation-stage';
    result.setAttribute('aria-labelledby', 'files-results-title');
    const resultTitle = make('h3', '3. Results'); resultTitle.id = 'files-results-title';
    const hint = make('p', 'Confirmed operations appear here with a result for each file. Nothing has run in this view.', 'storage-help'); hint.id = 'files-result-empty';
    result.append(resultTitle, hint); plan.after(result);
    const sidebar = panel.querySelector('.fo-sidebar');
    const extras = disclosure('files-more-tools', 'More tools · AI suggestions, quick plans & rename', sidebar);
    panel.querySelector('.fo-grid').after(extras);
    const breakdown = el('fo-results-section');
    disclosure('files-type-breakdown', 'Scanned file types', breakdown);
    el('filesCustomRulesButton').textContent = 'Ask AI for an organization suggestion';
    panel.querySelector('.fo-ai-card .section-subhead').textContent = 'AI returns written suggestions. Review them here, then edit the destination categories yourself if useful. Your draft and files stay unchanged.';
    const quick = el('filesQuickImages').closest('.card-section');
    quick.querySelector('.section-subhead').textContent = 'Add one category to the plan. Existing selections stay selected; no files move.';
    for (const [id,text] of [['filesQuickImages','Add images to plan'],['filesQuickInstallers','Add installers to plan'],['filesQuickArchives','Add archives to plan']]) { const label = el(id)?.querySelector('.fo-quick-label'); if (label) label.textContent = text; }
    el('filesScanInVisButton').textContent = 'Review folder in Free Space';
    label('filesRootInput', 'Folder to organize on the TLI host');
    label('filesRulesTextarea', 'Describe an organization plan for the AI to suggest');
    label('filesRenamePrefix', 'Prefix for the rename preview');
    adoptReview();
  }
  function adoptReview() {
    const box = el('files-operation-review'), stage = el('files-operation-stage');
    if (!box || !stage) return;
    const result = box.getAttribute('data-operation-phase') === 'result' && box.childElementCount > 0;
    const destination = result ? stage : el('files-plan');
    if (destination && box.parentElement !== destination) destination.append(box);
    el('files-result-empty').hidden = result;
  }
  function openCleanup() {
    if (window.TLIFreeSpace?.openCleanup) return window.TLIFreeSpace.openCleanup();
    const box = el('storage-cleanup-review');
    if (!box) return false;
    box.open = true; box.scrollIntoView({block: 'nearest'});
    box.querySelector('summary')?.focus();
    return true;
  }
  function refresh() { initFiles(); adoptReview(); }
  window.TLIStorageWorkspace = {refresh, prepare, openCleanup, updateCleanup: () => window.TLIFreeSpace?.updateCleanup?.()};
  window.addEventListener('tli-session-locked', () => { locked = true; dismissPending(); context = null; renderContext(); });
  window.addEventListener('tli-session-unlocked', () => { locked = false; });
  window.addEventListener('pagehide', () => { dismissPending(); context = null; renderContext(); });
  document.addEventListener?.('input', event => {
    const input = event.target;
    if (context && ((context.view === 'organize' && input?.id === 'filesRootInput') || (context.view === 'space' && input?.id === 'visualizerPathInput')) && input.value.trim() !== context.root) {
      context = null; renderContext();
    }
  });
  function init() {
    refresh();
    const observer = new MutationObserver(() => { adoptReview(); });
    for (const id of ['panel-files']) {
      const panel = el(id); if (panel) observer.observe(panel, {childList: true, subtree: true});
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once: true}); else init();
})();
