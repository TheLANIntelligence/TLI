/* Presentation only: move the existing controls without replacing their handlers. */
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
    plan.querySelector('.section-subhead').textContent = 'Adjust destination folders, then review every source and destination.';
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
    quick.querySelector('.section-subhead').textContent = 'Adjust the draft, then use Review moves.';
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
  window.TLIStorageWorkspace = {refresh, openCleanup, updateCleanup: () => window.TLIFreeSpace?.updateCleanup?.()};
  function init() {
    refresh();
    const observer = new MutationObserver(() => { adoptReview(); });
    for (const id of ['panel-files']) {
      const panel = el(id); if (panel) observer.observe(panel, {childList: true, subtree: true});
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once: true}); else init();
})();
