/* Explicit selection -> host preflight -> Trash -> durable per-file receipt. */
(function () {
  'use strict';
  if (window.TLIStorageCleanup) return;
  const selected = new Map(), duplicateGroups = new Map(), unresolved = new Map();
  let preview = null, pending = null, busy = false, epoch = 0, scopeVersion = 0, locked = false, active = true, panelActive = true;
  let needHistory = false, recoveryId = null, scopeKey = '', scope = null;
  let currentLocation, locationAllowed = true;
  let drawer = null;
  const el = id => document.getElementById(id);
  const make = (tag, text = '') => { const e = document.createElement(tag); e.textContent = text; return e; };
  const knownSize = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const uncertainRow = row => ['unknown', 'attempting', 'pending'].includes(row.status);
  const live = value => value === epoch && !locked && active && !document.hidden;
  const normalizedLocation = value => /^[A-Za-z]:[\\/]/.test(value) ? value.replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase() : value.replace(/\/+$/,'') || '/';
  const matchesLocation = () => currentLocation === undefined || !scope || scope.root === 'common_folders' ||
    typeof scope.root === 'string' && !!currentLocation && normalizedLocation(scope.root) === normalizedLocation(currentLocation);
  function size(bytes) {
    if (!knownSize(bytes)) return 'Size unknown';
    const units = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
    while (bytes >= 1024 && i < 4) { bytes /= 1024; i++; }
    return `${bytes.toFixed(i ? 2 : 0)} ${units[i]}`;
  }
  function invalidate() { preview = null; el('cleanup-preview')?.replaceChildren(); }
  function blockedPath(path) { return [...unresolved.values()].some(r => r.results.some(i => i.path === path && uncertainRow(i))); }
  function getSelectionState() {
    const values = [...selected.values()];
    return {count:selected.size, knownBytes:values.reduce((n,f) => n + (knownSize(f.size) ? f.size : 0),0),
      unknownSizeCount:values.filter(f => !knownSize(f.size)).length, busy,
      unresolved:!!pending || needHistory || unresolved.size > 0,
      pendingActivityCount:pending || needHistory ? Math.max(1, unresolved.size) : unresolved.size};
  }
  function sync() {
    if (!el('cleanup-count')) return;
    const state = getSelectionState(), gated = busy || locked || !active || !!pending || needHistory;
    el('cleanup-count').textContent = `${!locationAllowed&&scope?.root?`Selection from ${scope.root}. Return to that location to review these files. `:''}${state.count} of 100 files selected · ${state.unknownSizeCount ? 'At least ' : ''}${size(state.knownBytes)} observed${state.unknownSizeCount ? ` · ${state.unknownSizeCount} sizes unknown` : ''}. Selected sizes are not freed space.`;
    el('cleanup-check').disabled = gated || !selected.size || [...selected.keys()].some(blockedPath);
    el('cleanup-clear').disabled = busy || !selected.size;
    el('cleanup-execute').hidden = !preview?.can_execute;
    el('cleanup-execute').disabled = gated || !preview?.can_execute;
    const count = preview?.items?.length || 0;
    el('cleanup-execute').textContent = `Move ${count} reviewed ${count === 1 ? 'file' : 'files'} to Trash`;
    el('cleanup-result-check').hidden = !state.unresolved;
    el('cleanup-result-check').disabled = busy || locked || !active;
    el('cleanup-history-load').disabled = busy || locked || !active;
    if (el('cleanup-unresolved')) el('cleanup-unresolved').textContent = state.unresolved ?
      'A cleanup result needs attention. Clearing the selection does not cancel a move or resolve an unconfirmed outcome. Check the saved result; nothing retries automatically.' : '';
    document.querySelectorAll('[data-cleanup-path]').forEach(input => {
      input.checked = selected.has(input.dataset.cleanupPath);
      input.disabled = gated || blockedPath(input.dataset.cleanupPath) || input.dataset.cleanupBlocked === 'true';
    });
    document.querySelectorAll('[data-cleanup-keeper]').forEach(select => { select.disabled = gated; });
    document.querySelectorAll('[data-cleanup-page]').forEach(button => { button.disabled=gated || button.dataset.cleanupPageBoundary==='true'; });
    const list = el('cleanup-selection'); list.replaceChildren();
    selected.forEach(file => {
      const li = make('li'), text = make('div', file.path);
      text.append(make('small', `${size(file.size)}${file.keep_path ? ' · Keep: ' + file.keep_path : ''}`));
      const remove = make('button', 'Remove'); remove.type = 'button'; remove.disabled = busy;
      remove.setAttribute('aria-label', `Remove ${file.path} from cleanup selection`);
      remove.addEventListener('click', () => { if (busy) return; selected.delete(file.path); invalidate(); sync(); });
      li.append(text, remove); list.append(li);
    });
    for (const name of ['tli:cleanup-selection-change', 'cleanup_state'])
      window.dispatchEvent?.(new CustomEvent(name, {detail:state}));
  }
  function choice(file, keeper = () => null) {
    const choiceScope = scopeVersion;
    const label = make('label'); label.className = 'cleanup-choice';
    const input = make('input'); input.type = 'checkbox'; input.dataset.cleanupPath = file.path;
    const blocked = !!(file.protected || file.synthetic || file.isDir || file.kind === 'directory' || file.deletable === false || !file.path);
    input.dataset.cleanupBlocked = String(blocked);
    input.disabled = blocked || busy || locked || !active || !!pending || needHistory || blockedPath(file.path);
    input.checked = selected.has(file.path);
    input.setAttribute('aria-label', `Select ${file.path || file.name} for cleanup review`);
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('change', () => {
      if (choiceScope !== scopeVersion || busy || locked || !active || pending || needHistory || blocked || blockedPath(file.path)) { input.checked = selected.has(file.path); return; }
      if (input.checked) {
        const group = duplicateGroups.get(file.path);
        const keep = group ? (group.keep && group.keep !== file.path ? group.keep : false) : keeper();
        if (keep === false) { input.checked = false; el('cleanup-error').textContent = 'Choose a copy to keep before selecting duplicates.'; return; }
        if (selected.size >= 100 && !selected.has(file.path)) { input.checked = false; el('cleanup-error').textContent = 'Select up to 100 files per review.'; return; }
        selected.set(file.path, {...file, keep_path:keep || null});
      } else selected.delete(file.path);
      invalidate(); el('cleanup-error').textContent = ''; sync();
    });
    label.append(input, make('span', blocked ? 'Protected / folder' : 'Review cleanup'));
    return label;
  }
  function duplicateControls(group, options = {}) {
    const choiceScope = scopeVersion;
    const box = make('div'); box.className = 'cleanup-dupe-controls';
    if(!Array.isArray(group.paths) || group.paths.length<2){box.append(make('p','No verified duplicate paths are available.'));return box;}
    const prior=duplicateGroups.get(group.paths[0]);
    const same=prior?.paths?.length===group.paths.length && group.paths.every((path,index)=>prior.paths[index]===path);
    const state=same ? prior : {keep:'',page:0,paths:group.paths};
    const pageSize=Math.max(1,Math.min(100,Number.isInteger(options.pageSize)?options.pageSize:100));
    if(Number.isInteger(options.page))state.page=options.page;
    state.page=Math.max(0,Math.min(Math.ceil(group.paths.length/pageSize)-1,state.page));
    for(const path of group.paths)duplicateGroups.set(path,state);
    if(!same && group.paths.some(path=>selected.has(path)))invalidate();
    const allowed=()=>choiceScope===scopeVersion && !busy && !locked && active && !pending && !needHistory;
    function renderPage(){
      box.replaceChildren();
      const offset=state.page*pageSize, visible=group.paths.slice(offset,offset+pageSize);
      const coverage=make('p',`Showing ${offset+1}–${offset+visible.length} of ${group.paths.length} verified paths. Changing pages selects nothing.`);
      coverage.setAttribute('role','status');box.append(coverage);
      const keepLabel=make('label','Copy to keep '),keep=make('select');
      keep.dataset.cleanupKeeper='true';keep.setAttribute('aria-label','Copy to keep from this duplicate group');
      const initial=make('option','Choose a copy to keep…');initial.value='';keep.append(initial);
      if(state.keep && !visible.includes(state.keep)){const option=make('option','Kept copy on another page: '+state.keep);option.value=state.keep;keep.append(option);}
      for(const path of visible){const option=make('option',path);option.value=path;keep.append(option);}
      keep.value=state.keep;keep.disabled=!allowed();keepLabel.append(keep);box.append(keepLabel);
      for(const path of visible){
        const row=make('div');row.className='cleanup-dupe-row';
        const control=choice({path,size:group.size}),input=control.querySelector('input');
        input.dataset.cleanupBlocked=String(!state.keep || path===state.keep);
        input.disabled=input.disabled || input.dataset.cleanupBlocked==='true';
        row.append(control,make('span',path));box.append(row);
      }
      keep.addEventListener('change',()=>{
        if(!allowed())return;
        state.keep=keep.value;
        for(const path of group.paths){
          if(path===state.keep || !state.keep)selected.delete(path);
          else if(selected.has(path))selected.set(path,{...selected.get(path),keep_path:state.keep});
        }
        invalidate();const controls=renderPage();sync();controls.keep.focus();
      });
      const pages=make('div');pages.className='cleanup-buttons';const controls={keep};
      for(const [label,delta] of [['Previous paths',-1],['Next paths',1]]){
        const button=make('button',label);button.type='button';button.dataset.cleanupPage='true';
        button.dataset.cleanupPageBoundary=String(state.page+delta<0 || (state.page+delta)*pageSize>=group.paths.length);
        button.disabled=!allowed() || button.dataset.cleanupPageBoundary==='true';
        button.addEventListener('click',()=>{if(allowed() && button.dataset.cleanupPageBoundary!=='true'){state.page+=delta;const next=renderPage();sync();(next[label].disabled?next.keep:next[label]).focus();}});pages.append(button);controls[label]=button;
      }
      box.append(pages);
      return controls;
    }
    renderPage();sync();return box;
  }
  async function request(url, body, requestEpoch) {
    const response = await fetch(url,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(45000),
      ...(body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {})});
    if (response.status === 401 && live(requestEpoch)) {
      locked = true; clearPrivate();
      window.dispatchEvent?.(new CustomEvent('tli-session-locked'));
    }
    const data = await response.json();
    if (!response.ok) { const error = new Error(typeof data.detail === 'string' ? data.detail : data.detail?.message || `Request failed (${response.status}).`); error.status=response.status; throw error; }
    return data;
  }
  function showPreview(result) {
    const box = el('cleanup-preview'); box.replaceChildren();
    box.append(make('strong',`${result.unknown_size_count ? 'At least ' : ''}${size(result.total_bytes)} in ${result.items.length} selected files`),make('p',result.space_note));
    if (result.unknown_size_count) box.append(make('p',`Size unavailable for ${result.unknown_size_count} blocked selection(s).`));
    const list = make('ul');
    for (const item of result.items) {
      const li = make('li'); li.append(make('strong',item.eligible ? 'Eligible for Trash' : 'Blocked'),make('span',item.path),make('small',`${size(item.size)}${item.keep_path ? ' · Keep: '+item.keep_path : ''}`));
      if (!item.eligible) li.append(make('span',item.reason)); list.append(li);
    }
    box.append(list,make('p',result.can_execute ? 'Nothing has moved. Review these exact files, then use the Trash button below.' : 'Nothing has moved. Remove blocked files and review again.'));
  }
  function validReceipt(result) {
    return result && typeof result === 'object' && typeof result.id === 'string' && result.id.length > 0 && result.id.length <= 128 &&
      Array.isArray(result.results) && result.results.length <= 100 &&
      ['completed','partial','failed','interrupted','running','ready'].includes(result.status) &&
      result.results.every(row => typeof row.path === 'string' && row.path.length <= 4096 && ['trashed','failed','unknown','not_attempted','pending','attempting'].includes(row.status));
  }
  function remember(result, id) {
    const key = result.id || id;
    if (result.results.some(uncertainRow) || result.status === 'running') unresolved.set(key,result);
    else unresolved.delete(key);
  }
  function showReceipt(result) {
    const box = el('cleanup-receipt'); box.replaceChildren();
    box.append(make('h4',`Cleanup receipt${result.started_at ? ' · '+new Date(result.started_at*1000).toLocaleString() : ''}`),make('strong',result.summary || `Cleanup status: ${result.status}`));
    const list = make('ul');
    for (const item of result.results) {
      const label = {trashed:'Moved to Trash',failed:'Failed',unknown:'Unconfirmed — inspect original and Trash',not_attempted:'Not moved',pending:'Not dispatched yet',attempting:'Dispatch recorded; outcome not confirmed'}[item.status];
      const li=make('li'); li.append(make('strong',label),make('span',item.path));
      if (item.reason) li.append(make('small',item.reason)); list.append(li);
    }
    box.append(list,make('p',result.restore_note || 'Use the operating system’s Trash or Recycle Bin to review moved files.'),
      make('p','File sizes do not equal freed disk space. Trash may still occupy disk space. Previous scans remain historical until you explicitly refresh them.'));
    if (result.receipt_warning) box.append(make('p',result.receipt_warning));
    if (result.results.some(r => ['failed','not_attempted'].includes(r.status))) {
      const retry=make('button','Review files not moved'); retry.type='button';
      retry.addEventListener('click',() => {
        if (busy || locked || !active || pending || needHistory) return;
        selected.clear();
        for (const item of result.results.filter(r=>['failed','not_attempted'].includes(r.status) && !blockedPath(r.path))) selected.set(item.path,item);
        invalidate(); sync(); check();
      }); box.append(retry);
    }
    if (window.TLIVisualizer?.scanPath && scope?.root) {
      const root = scope.root, review=make('button','Review location again'); review.type='button';
      review.addEventListener('click',() => { if (!busy && !locked && active) window.TLIVisualizer.scanPath(root); }); box.append(review);
    }
  }
  async function check() {
    if (busy || locked || !active || pending || needHistory || !selected.size || [...selected.keys()].some(blockedPath)) return;
    for (const file of selected.values()) {
      const group=duplicateGroups.get(file.path);
      if (group && (!group.keep || group.keep===file.path)) { el('cleanup-error').textContent='Choose an unselected copy to keep in the duplicate results first.'; return; }
      if (group) file.keep_path=group.keep;
    }
    const current=epoch, files=[...selected.values()].map(f=>({path:f.path,keep_path:f.keep_path || null}));
    busy=true; invalidate(); sync(); el('cleanup-error').textContent='Checking every file on the TLI host…';
    try {
      const result=await request('/visualizer/cleanup/preview',{files},current);
      if (!live(current)) return;
      if (result.ok!==true || !Array.isArray(result.items) || result.items.length!==files.length || typeof result.preview_id!=='string') throw new Error('The review returned no valid result.');
      preview=result; showPreview(result); el('cleanup-error').textContent='';
    } catch(error) { if (live(current)) el('cleanup-error').textContent=error.message+' Nothing was moved.'; }
    finally { if (live(current)) {busy=false;sync();} }
  }
  async function execute() {
    if (busy || locked || !active || pending || needHistory || !preview?.can_execute) return;
    const current=epoch, submitted=preview; pending={id:submitted.preview_id,paths:submitted.items.map(r=>r.path)};
    busy=true; invalidate(); sync(); el('cleanup-error').textContent='Moving the reviewed files to Trash…';
    try {
      const result=await request('/visualizer/cleanup/execute',{preview_id:pending.id},current);
      if (!live(current)) return;
      if (!validReceipt(result) || result.id!==pending.id || ['running','ready'].includes(result.status) || result.results.length!==pending.paths.length ||
          result.results.some(row=>!pending.paths.includes(row.path)) || new Set(result.results.map(row=>row.path)).size!==result.results.length)
        throw new Error('The final cleanup result is not available yet.');
      remember(result,pending.id); pending=null;
      for (const row of result.results) if (row.status==='trashed') selected.delete(row.path);
      showReceipt(result); el('cleanup-error').textContent='';
    } catch(error) { if (live(current)) el('cleanup-error').textContent=`${error.message} Check the result before another cleanup. Nothing retries automatically.`; }
    finally { if (live(current)) {busy=false;sync();} }
  }
  async function checkResult() {
    if (busy || locked || !active) return;
    if (needHistory && !recoveryId) return loadHistory();
    const id=pending?.id || recoveryId || unresolved.keys().next().value;
    if (!id) return;
    const current=epoch; busy=true;sync();
    try {
      const result=await request(`/visualizer/cleanup/receipt/${encodeURIComponent(id)}`,null,current);
      if (!live(current)) return;
      if (!validReceipt(result) || result.id!==id) throw new Error('No valid saved cleanup result was returned.');
      if (result.status==='ready') { pending=null; recoveryId=null; needHistory=false; unresolved.delete(id); invalidate(); el('cleanup-error').textContent='The request has not run. Review the selection again before any new move.'; }
      else if (result.status==='running') el('cleanup-error').textContent='Cleanup is still running. Check again; no request will be replayed.';
      else {
        remember(result,id); pending=null; recoveryId=null; needHistory=false;
        for (const row of result.results) if (row.status==='trashed') selected.delete(row.path);
        showReceipt(result); el('cleanup-error').textContent='';
      }
    } catch(error) { if(live(current)) el('cleanup-error').textContent=error.message; }
    finally { if(live(current)){busy=false;sync();} }
  }
  async function loadHistory() {
    if (busy || locked || !active) return;
    const current=epoch; busy=true;sync();
    try {
      const data=await request('/visualizer/cleanup/receipts',null,current);
      if(!live(current))return;
      if(data.ok!==true || !Array.isArray(data.receipts) || !data.receipts.every(validReceipt)) throw new Error('No valid cleanup history was returned. Previous results are retained.');
      const list=el('cleanup-history');list.replaceChildren();
      if(!data.receipts.length)list.append(make('p','No saved cleanup receipts.'));
      for(const result of data.receipts){
        remember(result,result.id);
        const button=make('button',`${result.started_at ? new Date(result.started_at*1000).toLocaleString() : 'Saved receipt'} · ${result.summary || result.status}`);
        button.type='button';button.addEventListener('click',()=>{if(!locked&&active){showReceipt(result);sync();}});list.append(button);
      }
      // A running operation may not have written its first journal yet. Never
      // interpret an empty history as cancellation of an in-flight request.
      if(needHistory && (recoveryId || !data.receipts.length)) el('cleanup-error').textContent='Check the outstanding cleanup result before another cleanup. Loading older receipts does not confirm it.';
      else {needHistory=false;el('cleanup-error').textContent='';}
    }catch(error){if(live(current))el('cleanup-error').textContent=error.message;}
    finally{if(live(current)){busy=false;sync();}}
  }
  function clearPrivate() {
    closeReview(false);
    recoveryId=pending?.id || recoveryId;
    needHistory=needHistory || !!pending || unresolved.size>0;
    epoch++;scopeVersion++;active=false;busy=false;pending=null;selected.clear();duplicateGroups.clear();unresolved.clear();scope=null;scopeKey='';currentLocation=undefined;locationAllowed=true;invalidate();
    for(const id of ['cleanup-receipt','cleanup-history','cleanup-selection','cleanup-error'])el(id)?.replaceChildren();
    document.querySelectorAll('[data-cleanup-path]').forEach(input=>{input.checked=false;input.disabled=true;input.removeAttribute?.('aria-label');delete input.dataset.cleanupPath;});
    document.querySelectorAll('[data-cleanup-keeper]').forEach(select=>select.replaceChildren());
    sync();
  }
  function suspend() {
    closeReview(false);
    epoch++;active=false;busy=false;invalidate();sync();
  }
  function setScope(value) {
    const next=JSON.stringify([value?.host || null,value?.root || null,value?.observationId || null]);
    if(next!==scopeKey){epoch++;scopeVersion++; if(pending){needHistory=true;recoveryId=pending.id;} pending=null;busy=false;selected.clear();duplicateGroups.clear();invalidate();}
    scope=value ? {...value} : null;scopeKey=next;locationAllowed=matchesLocation();active=locationAllowed&&panelActive&&!document.hidden;sync();
  }
  function setLocation(value) {
    currentLocation=typeof value==='string'?value.trim():'';
    const allowed=matchesLocation();
    if(allowed!==locationAllowed){
      // A reviewed request belongs to its original location. Preserve selection
      // and any uncertain receipt, but require a fresh review after returning.
      epoch++;busy=false;invalidate();closeReview(false);
    }
    locationAllowed=allowed;active=allowed&&panelActive&&!document.hidden;sync();
  }
  function closeReview(restoreFocus = true) {
    const opened = drawer;
    if (!opened) return;
    drawer = null;
    const {dialog,section,parent,next,invoker} = opened;
    parent.insertBefore(section,next?.parentNode === parent ? next : null);
    if(dialog.open)dialog.close();
    dialog.remove();
    if(restoreFocus){
      const target=invoker?.isConnected ? invoker : el('storage-cleanup-review')?.querySelector('summary');
      target?.focus?.();
    }
  }
  function openReview() {
    if(locked || document.hidden)return;
    if(!locked && !document.hidden)active=locationAllowed&&panelActive;
    const box=el('storage-cleanup-review') || el('cleanup-title')?.closest?.('section');
    if(drawer){drawer.dialog.querySelector('button')?.focus();return;}
    const section=box?.querySelector?.('.storage-cleanup');
    if(section && window.matchMedia?.('(max-width: 800px)').matches){
      const dialog=make('dialog');dialog.id='cleanup-mobile-dialog';dialog.className='cleanup-drawer';
      if(typeof dialog.showModal==='function'){
        const header=make('header'),title=make('h3','Review cleanup'),close=make('button','Close review');
        title.id='cleanup-drawer-title';close.type='button';close.className='pill-btn ghost';
        dialog.setAttribute('aria-labelledby',title.id);header.append(title,close);
        const body=make('div');body.className='cleanup-drawer-body';
        drawer={dialog,section,parent:section.parentNode,next:section.nextSibling,invoker:document.activeElement};
        body.append(section);dialog.append(header,body);document.body.append(dialog);
        close.addEventListener('click',()=>closeReview());
        dialog.addEventListener('cancel',event=>{event.preventDefault();closeReview();});
        dialog.addEventListener('close',()=>{if(drawer?.dialog===dialog)closeReview();});
        dialog.addEventListener('click',event=>{if(event.target===dialog)closeReview();});
        try{dialog.showModal();close.focus();sync();return;}catch(_){closeReview(false);}
      }
    }
    if(box){box.hidden=false;if(box.tagName==='DETAILS')box.open=true;box.scrollIntoView?.({block:'nearest'});}
    const title=box?.querySelector?.('summary') || el('cleanup-title');title?.setAttribute('tabindex','-1');title?.focus?.();sync();
  }
  function init() {
    if(!el('cleanup-check'))return;
    const box=el('storage-cleanup-review') || el('cleanup-title')?.closest?.('section');
    if(box && !el('cleanup-unresolved')){const message=make('p');message.id='cleanup-unresolved';message.setAttribute('role','status');(box.querySelector('.storage-cleanup') || box).append(message);}
    box?.querySelector?.('summary')?.addEventListener('click',event=>{
      if(window.matchMedia?.('(max-width: 800px)').matches){event.preventDefault();openReview();}
    });
    el('cleanup-check').addEventListener('click',check);el('cleanup-execute').addEventListener('click',execute);
    el('cleanup-result-check').addEventListener('click',checkResult);el('cleanup-history-load').addEventListener('click',loadHistory);
    el('cleanup-clear').addEventListener('click',()=>{if(!busy){selected.clear();invalidate();sync();}});
    window.addEventListener?.('tli-session-locked',()=>{locked=true;clearPrivate();});
    window.addEventListener?.('tli-session-unlocked',()=>{locked=false;sync();});
    window.addEventListener?.('pagehide',clearPrivate);
    window.addEventListener?.('resize',()=>{if(drawer && !window.matchMedia?.('(max-width: 800px)').matches){closeReview(false);const box=el('storage-cleanup-review');if(box)box.open=true;}});
    document.addEventListener?.('visibilitychange',()=>{if(document.hidden)suspend();else {active=locationAllowed&&panelActive;sync();}});
    document.addEventListener?.('tli-panel-switched',event=>{panelActive=event.detail?.panelId==='panel-visualizer';if(panelActive){active=locationAllowed&&!document.hidden;sync();}else suspend();});
    sync();
  }
  window.TLIStorageCleanup={choice,duplicateControls,setScope,setLocation,clearPrivate,openReview,closeReview,getSelectionState};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
