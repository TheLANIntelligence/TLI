// ---------- VISUALIZER (Treemap + filters) ----------
// ---------- Explicit saved storage observations ----------
(function () {
  const protocol = "storage-history-v1";
  let current = null, saved = [], busy = false, epoch = 0, initialized = false, pendingRemove = null;
  let selectedPath = null, selectedComparison = null, comparisonRevision = 0;
  const $ = id => document.getElementById(id);
  const node = (tag, text, id) => { const el = document.createElement(tag); if (text) el.textContent = text; if (id) el.id = id; return el; };
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const validSummary = value => value && /^[a-f0-9]{32}$/.test(value.id) && value.version === 1 &&
    typeof value.root === "string" && typeof value.scanned_at === "string" && Number.isFinite(Date.parse(value.scanned_at)) &&
    typeof value.host?.id === "string" && typeof value.host.name === "string" &&
    ["known", "unknown", "changed"].includes(value.drive?.status) &&
    (value.drive.status !== "known" || /^[a-f0-9]{64}$/.test(value.drive.fingerprint)) &&
    typeof value.coverage?.complete === "boolean" && Array.isArray(value.coverage.reasons) && value.coverage.reasons.every(r => typeof r === "string") &&
    integer(value.total_bytes) && integer(value.direct_file_bytes) &&
    integer(value.filters?.max_depth) && integer(value.filters.max_entries) && integer(value.filters.max_seconds) &&
    value.filters.follow_links === false && Array.isArray(value.filters.excluded_names) && value.filters.excluded_names.every(n => typeof n === "string");
  const validScan = value => value?.protocol === protocol && value.available === true && value.version === 1 &&
    /^[a-f0-9]{32}$/.test(value.scan_id) && validSummary(value.summary) && value.summary.id === value.scan_id &&
    typeof value.expires_at === "number" && Number.isFinite(value.expires_at);
  const bytes = value => {
    const sign = value < 0 ? "−" : ""; let amount = Math.abs(value), unit = 0;
    const units = ["B", "KB", "MB", "GB", "TB"];
    while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
    return sign + amount.toLocaleString(undefined, {maximumFractionDigits: unit ? 1 : 0}) + " " + units[unit];
  };
  const delta = value => (value > 0 ? "+" : "") + bytes(value);
  const date = value => new Date(value).toLocaleString();
  function status(message) { if ($("storage-history-status")) $("storage-history-status").textContent = message; }
  function clearComparison(clearPath = false) {
    selectedComparison = null; comparisonRevision++;
    if (clearPath) selectedPath = null;
    renderSelection();
  }
  function selectPath(path) {
    selectedPath = typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.includes('\0') ? path : null;
    renderSelection();
  }
  function compatibleSelection(data) {
    const a=data.baseline,b=data.current,keys=[...new Set([...Object.keys(a.filters),...Object.keys(b.filters)])];
    return a.root===b.root && a.host.id!=='unknown' && a.host.id===b.host.id && a.drive.status==='known' && b.drive.status==='known' &&
      a.drive.fingerprint===b.drive.fingerprint && Date.parse(a.scanned_at)<Date.parse(b.scanned_at) &&
      keys.every(key=>JSON.stringify(a.filters[key])===JSON.stringify(b.filters[key])) &&
      !a.accounting?.identity_unknown && !b.accounting?.identity_unknown;
  }
  function renderSelection() {
    const box=$('storage-history-selection');if(!box)return;box.replaceChildren();if(!selectedPath)return;
    box.append(node('h4','Selected path changes'),node('p',selectedPath));
    const unavailable=reason=>box.append(node('p','Comparison unavailable for this selected path. '+reason));
    const data=selectedComparison;
    if(!data || data.current.id!==current?.scan_id || data.baseline.id!==$('storage-history-baseline')?.value) {
      unavailable('Choose a saved baseline and run Compare. No comparison runs automatically.');return;
    }
    if(!compatibleSelection(data)) {unavailable('Host identity, drive identity, scan policy or observation time does not support this comparison.');return;}
    const windows=/^[a-z]:[\\/]|^\\\\/i.test(data.current.root);
    const normalize=value=>{const path=value.replace(/\\/g,'/').replace(/\/+$/,'');return windows?path.toLowerCase():path;};
    const root=normalize(data.current.root),path=normalize(selectedPath);
    const measured=(label,row)=>box.append(node('p',`${label} changed by ${delta(row.delta_bytes)} (${bytes(row.before_bytes)} → ${bytes(row.after_bytes)}).`));
    if(path===root) {
      if(data.comparable)measured('Recorded root bytes',data.totals);
      else unavailable('Whole-root totals are unsupported. '+data.reasons.join(' '));
      return;
    }
    if(!path.startsWith(root+'/')) {unavailable('The selection is outside the compared root.');return;}
    const relative=path.slice(root.length+1);
    const safeRelative=value=>typeof value==='string' && value.length>0 && value.length<=4096 && !value.includes('\0') && !value.includes(':') &&
      !value.replace(/\\/g,'/').startsWith('/') && value.replace(/\\/g,'/').split('/').every(part=>part && part!=='.' && part!=='..');
    const validRow=row=>row && ['grew','shrank','newly_observed','not_observed','added','removed'].includes(row.status) &&
      (['grew','shrank'].includes(row.status) ? integer(row.before_bytes) && integer(row.after_bytes) && Number.isSafeInteger(row.delta_bytes) &&
        row.delta_bytes===row.after_bytes-row.before_bytes && (row.status==='grew'?row.delta_bytes>0:row.delta_bytes<0) :
        row.delta_bytes===null && (['newly_observed','added'].includes(row.status)?row.before_bytes===null && integer(row.after_bytes):row.after_bytes===null && integer(row.before_bytes)));
    let row=null,kind='';
    if(data.file_comparison?.available===true && Array.isArray(data.files) && data.files.length<=1000) {
      const matches=data.files.filter(item=>safeRelative(item?.path) && normalize(item.path)===relative);
      const candidate=matches.length===1?matches[0]:null;
      if(validRow(candidate) && (data.comparable || data.file_comparison.complete===false && ['grew','shrank'].includes(candidate.status)) &&
        (!['added','removed'].includes(candidate.status) || data.file_comparison.complete===true)) {row=candidate;kind='Recorded file path';}
    }
    if(!row && data.comparable && data.folder_comparison?.available!==false && !relative.includes('/')) {
      const matches=data.folders.filter(item=>safeRelative(item.name) && !item.name.replace(/\\/g,'/').includes('/') && normalize(item.name)===relative);
      if(matches.length===1 && validRow(matches[0])) {row=matches[0];kind='Recorded immediate folder';}
    }
    if(!row) {
      unavailable('The retained comparison contains no supported change row for it. Missing entries are not evidence of no change.'+
        (!data.comparable?' Whole-scan and folder totals are unavailable for this partial or incompatible comparison.':'')+
        (data.folder_comparison?.available===false && typeof data.folder_comparison.reason==='string'?' '+data.folder_comparison.reason:''));
      return;
    }
    if(['grew','shrank'].includes(row.status))measured(kind+' logical size',row);
    else box.append(node('p',`${kind}: ${row.after_bytes===null?'not observed in the later scan; previously '+bytes(row.before_bytes):'newly observed at '+bytes(row.after_bytes)}. No measured before-and-after size delta is available; this does not establish creation or deletion.`));
    if(!data.comparable)box.append(node('p','Partial coverage: only this retained path’s recorded logical sizes are compared. Whole-scan growth is unavailable; replacement or movement may explain the path change.'));
    if(row.hardlink_duplicate)box.append(node('p','Hard-link alias: these logical bytes must not be added to counted totals.'));
    box.append(node('p','Point-in-time path evidence only. File changes must not be added to folder or root deltas.'));
  }
  function controls() {
    if (!initialized) return;
    const available = current && current.expires_at * 1000 > Date.now();
    $("storage-history-save").disabled = busy || !available || saved.some(s => s.id === current.scan_id);
    $("storage-history-load").disabled = busy;
    $("storage-history-baseline").disabled = busy || !saved.length;
    $("storage-history-remove").disabled = busy || !$("storage-history-baseline").value;
    const removeConfirm = $("storage-history-remove-confirm"); if (removeConfirm) removeConfirm.disabled = busy;
    $("storage-history-compare").disabled = busy || !available || !$("storage-history-baseline").value || $("storage-history-baseline").value === current?.scan_id;
  }
  function list() {
    const select = $("storage-history-baseline"), selected = select.value;
    select.replaceChildren(node("option", "Choose a saved scan")); select.children[0].value = "";
    for (const summary of saved) {
      const option = node("option", `${date(summary.scanned_at)} · ${summary.root} · ${summary.coverage.complete ? "Complete coverage" : "Partial coverage"}`);
      option.value = summary.id; select.appendChild(option);
    }
    select.value = saved.some(row => row.id === selected) ? selected : saved.find(row => row.id !== current?.scan_id)?.id || "";
    if(selectedComparison && selectedComparison.baseline.id!==select.value)clearComparison();
    controls(); timeline();
  }
  const validCapacity = value => value && [value.total,value.used,value.free].every(integer) && value.total>0 && value.used<=value.total && value.free<=value.total && typeof value.root_is_volume==='boolean';
  function timeline(){
    const box=$('storage-history-timeline');if(!box)return;box.replaceChildren();
    const anchor=current?.summary||saved.find(row=>row.id===$('storage-history-baseline').value)||saved[0];if(!anchor)return;
    const rows=saved.filter(row=>row.root===anchor.root&&row.host.id===anchor.host.id&&row.drive.fingerprint===anchor.drive.fingerprint).sort((a,b)=>Date.parse(a.scanned_at)-Date.parse(b.scanned_at));
    if(!rows.length)return;box.append(node('h4','Storage growth timeline'),node('p','Saved point-in-time readings for '+anchor.root+'. Capacity covers the entire volume; inspected file bytes cover the scan scope.'));
    for(const row of rows){const line=node('div');line.className='storage-history-point';line.append(node('span',date(row.scanned_at)));const meter=node('span');meter.className='fs-meter';const fill=node('span');
      if(validCapacity(row.capacity)){fill.style.width=row.capacity.used/row.capacity.total*100+'%';meter.append(fill);line.append(meter,node('span',bytes(row.capacity.free)+' free · '+bytes(row.capacity.used)+' used'));}
      else line.append(node('span','Capacity not recorded'));
      line.append(node('small',bytes(row.total_bytes)+' inspected'+(row.coverage.complete?'':' · Partial scan')));box.append(line);
    }
  }
  function describe(summary, label) {
    const line = node("p", `${label}: ${summary.root} · ${date(summary.scanned_at)} · ${summary.host.name} · ${bytes(summary.total_bytes)} inspected file bytes.`);
    line.appendChild(node("span", summary.coverage.complete ? " Coverage complete within the recorded scan policy." :
      " Partial coverage: " + summary.coverage.reasons.join("; ") + "."));
    if (summary.drive.status !== "known") line.appendChild(node("span", " Drive/folder identity unavailable or changed; comparison is blocked."));
    return line;
  }
  async function request(url, payload, method) {
    const res = await fetch(url, method === "DELETE" ? {method} : payload ? {method: method || "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)} :
      {method: "GET", cache: "no-store"});
    let data; try { data = await res.json(); } catch { throw new Error("The host returned an unreadable result."); }
    if (!res.ok) throw new Error(typeof data?.detail === "string" ? data.detail : `Request failed (${res.status}).`);
    if (data?.ok !== true || data.protocol !== protocol) throw new Error("This running TLI host does not confirm saved-scan support. Restart the updated backend and scan again.");
    return data;
  }
  async function act(fn) {
    if (busy) return;
    busy = true; controls(); const revision = epoch;
    try { await fn(revision); } catch (error) { if (revision === epoch) status(error.message + " No scan or retry ran automatically."); }
    finally { if (revision === epoch) { busy = false; controls(); } }
  }
  function save() {
    if (!validScan(current) || current.expires_at * 1000 <= Date.now()) { status("Scan the folder again before saving; this observation is unavailable or expired."); return; }
    const scan = current;
    return act(async revision => {
      const data = await request("/visualizer/history/save", {scan_id: scan.scan_id, version: 1});
      if (revision !== epoch) return;
      if (data.saved !== true || !validSummary(data.snapshot) || data.snapshot.id !== scan.scan_id ||
          data.snapshot.root !== scan.summary.root || data.snapshot.scanned_at !== scan.summary.scanned_at ||
          data.snapshot.total_bytes !== scan.summary.total_bytes) throw new Error("Saving this scan was not confirmed. Reload saved scans before trying again.");
      const removed=Array.isArray(data.removed_ids)?new Set(data.removed_ids.filter(id=>typeof id==='string')):new Set();
      saved = [data.snapshot, ...saved.filter(s => s.id !== data.snapshot.id&&!removed.has(s.id))]; list();
      status("Scan summary saved for this account. No files or file contents were copied. Partial observations cannot establish growth.");
    });
  }
  function load() {
    return act(async revision => {
      const data = await request("/visualizer/history");
      if (revision !== epoch) return;
      if (!Array.isArray(data.snapshots) || data.snapshots.length > 20 || !data.snapshots.every(validSummary) ||
          new Set(data.snapshots.map(s => s.id)).size !== data.snapshots.length) throw new Error("Saved scan history has an invalid format; it was not displayed.");
      saved = data.snapshots; list(); status(`${saved.length} of ${integer(data.limit)?data.limit:20} saved summaries loaded. Select an earlier scan to compare.`);
    });
  }
  function cancelRemove() {
    pendingRemove = null; $("storage-history-remove-review")?.replaceChildren();
  }
  function reviewRemove() {
    if (busy) return;
    const selected = saved.find(row => row.id === $("storage-history-baseline").value);
    if (!selected) return;
    pendingRemove = selected.id;
    const box = $("storage-history-remove-review");
    box.replaceChildren(node("p", `Remove the saved summary for ${selected.root}, observed ${date(selected.scanned_at)}? Only this summary will be removed. The folder and its files will not be touched.`));
    const confirm = node("button", "Remove this saved summary", "storage-history-remove-confirm"); confirm.className = "pill-btn ghost";
    confirm.addEventListener("click", () => {
      if (pendingRemove !== selected.id || $("storage-history-baseline").value !== selected.id) return;
      return act(async revision => {
        const data = await request("/visualizer/history/" + selected.id, null, "DELETE");
        if (revision !== epoch) return;
        if (data.deleted !== true || data.snapshot_id !== selected.id) throw new Error("Removal of the saved summary was not confirmed. Reload saved scans before trying again.");
        saved = saved.filter(row => row.id !== selected.id); cancelRemove(); list();
        $("storage-history-result").replaceChildren(); status("Saved summary removed. The folder and its files were not changed.");
      });
    });
    const cancel = node("button", "Cancel"); cancel.className = "pill-btn ghost"; cancel.addEventListener("click", cancelRemove);
    box.append(confirm, cancel);
  }
  function compare() {
    const baselineId = $("storage-history-baseline").value, scan = current;
    if (!validScan(scan) || scan.expires_at * 1000 <= Date.now() || !saved.some(s => s.id === baselineId)) {
      status("Select a saved baseline and scan the folder again if the current observation expired."); return;
    }
    return act(async revision => {
      clearComparison(); const comparisonToken=comparisonRevision;
      const data = await request("/visualizer/history/compare", {baseline_id: baselineId, scan_id: scan.scan_id, version: 1});
      if (revision !== epoch || comparisonToken!==comparisonRevision || current!==scan || $('storage-history-baseline').value!==baselineId) return;
      if (typeof data.comparable !== "boolean" || data.point_in_time !== true || !validSummary(data.baseline) || !validSummary(data.current) ||
          data.baseline.id !== baselineId || data.current.id !== scan.scan_id || !Array.isArray(data.reasons) ||
          data.reasons.some(r => typeof r !== "string") || !Array.isArray(data.folders) || data.folders.length > 200) throw new Error("The comparison result could not be validated.");
      if (data.comparable && (!data.baseline.coverage.complete || !data.current.coverage.complete || data.reasons.length ||
          data.baseline.root !== data.current.root || data.baseline.host.id === "unknown" || data.baseline.host.id !== data.current.host.id ||
          data.baseline.drive.status !== "known" || data.current.drive.status !== "known" || data.baseline.drive.fingerprint !== data.current.drive.fingerprint ||
          Date.parse(data.baseline.scanned_at) >= Date.parse(data.current.scanned_at) ||
          ["max_depth", "max_entries", "max_seconds"].some(k => data.baseline.filters[k] !== data.current.filters[k]) ||
          data.baseline.filters.excluded_names.join("\0") !== data.current.filters.excluded_names.join("\0") ||
          !integer(data.totals?.before_bytes) || !integer(data.totals.after_bytes) || !Number.isSafeInteger(data.totals.delta_bytes) ||
          (data.totals.direct_file_delta_available===false ? data.totals.direct_file_delta_bytes!==null : !Number.isSafeInteger(data.totals.direct_file_delta_bytes)) || data.totals.delta_bytes !== data.totals.after_bytes - data.totals.before_bytes ||
          data.totals.before_bytes !== data.baseline.total_bytes || data.totals.after_bytes !== data.current.total_bytes ||
          (data.totals.direct_file_delta_available!==false && data.totals.direct_file_delta_bytes !== data.current.direct_file_bytes - data.baseline.direct_file_bytes) ||
          data.folders.some(row => !row || typeof row.name !== "string" || !["grew", "shrank", "newly_observed", "not_observed"].includes(row.status) ||
            (row.before_bytes !== null && !integer(row.before_bytes)) || (row.after_bytes !== null && !integer(row.after_bytes)) ||
            (row.status === "newly_observed" ? row.before_bytes !== null || !integer(row.after_bytes) || row.delta_bytes !== null :
              row.status === "not_observed" ? row.after_bytes !== null || !integer(row.before_bytes) || row.delta_bytes !== null :
                !integer(row.before_bytes) || !integer(row.after_bytes) || !Number.isSafeInteger(row.delta_bytes) ||
                row.delta_bytes !== row.after_bytes - row.before_bytes || (row.status === "grew" ? row.delta_bytes <= 0 : row.delta_bytes >= 0))))) throw new Error("Growth was not confirmed by a consistent comparison result.");
      if (!data.comparable && (data.totals !== null || data.folders.length || !data.reasons.length)) throw new Error("An incomplete comparison returned unsupported growth claims.");
      selectedComparison=data;renderSelection();
      const box = $("storage-history-result"); box.replaceChildren(describe(data.baseline, "Saved baseline"), describe(data.current, "Current observation"));
      if (!data.comparable) {
        box.appendChild(node("p", "Comparison unavailable: " + data.reasons.join(" ")));
      } else {
        box.appendChild(node("strong", `Inspected file bytes changed by ${delta(data.totals.delta_bytes)} (${bytes(data.totals.before_bytes)} → ${bytes(data.totals.after_bytes)}).`));
        if(data.totals.direct_file_delta_available!==false)box.appendChild(node("p", `Files directly in this folder changed by ${delta(data.totals.direct_file_delta_bytes)}.`));
        const rows = node("ol");
        for (const item of data.folders) {
          const change = item.status === "newly_observed" ? `Newly observed · ${bytes(item.after_bytes)}` :
            item.status === "not_observed" ? `Not observed in the later scan · previously ${bytes(item.before_bytes)}` :
            `${item.status === "grew" ? "Grew" : "Shrank"} ${delta(item.delta_bytes)} · ${bytes(item.before_bytes)} → ${bytes(item.after_bytes)}`;
          rows.appendChild(node("li", `${item.name}: ${change}`));
        }
        box.appendChild(rows);
        if (!data.folders.length&&data.folder_comparison?.available!==false) box.appendChild(node("p", "No immediate-folder size changes were observed."));
        if (data.folders_limited) box.appendChild(node("p", "Only the largest 200 changed folder entries are shown."));
        box.appendChild(node("p", "Newly observed and not observed names may reflect renames or moves; they do not prove creation or deletion."));
      }
      box.appendChild(node("p", "Point-in-time observations only. This did not check whether the drive is currently connected. File sizes can differ from space used on disk. No files were changed."));
      if(typeof data.folder_comparison?.reason==='string')box.append(node('p',data.folder_comparison.reason));
      if(typeof data.message==='string')box.append(node('p',data.message));
      showCapacityComparison(data,box);
      const measuredFiles=showFileComparison(data,box);
      status(data.comparable ? "Comparison ready." : measuredFiles ? "Partial comparison ready. Individual measured file changes are shown; whole-scan growth is unavailable." : "Comparison unavailable; no growth or shrinkage is claimed.");
    });
  }
  function showCapacityComparison(data,box){
    const c=data.capacity;if(!c)return;
    if(c.available!==true){if(typeof c.explanation==='string')box.append(node('p',c.explanation));return;}
    if(!validCapacity(c.before)||!validCapacity(c.after)||c.before.total!==c.after.total||!Number.isSafeInteger(c.used_delta_bytes)||!Number.isSafeInteger(c.free_delta_bytes)||c.used_delta_bytes!==c.after.used-c.before.used||c.free_delta_bytes!==c.after.free-c.before.free)return;
    box.append(node('h4','Measured volume capacity'),node('p',`Available space changed by ${delta(c.free_delta_bytes)} (${bytes(c.before.free)} → ${bytes(c.after.free)}). Volume use changed by ${delta(c.used_delta_bytes)}.`));
    if(c.unexplained_delta_bytes!==null&&Number.isSafeInteger(c.unexplained_delta_bytes)&&Number.isSafeInteger(c.scanned_allocated_delta_bytes)&&data.comparable&&c.before.root_is_volume&&c.after.root_is_volume&&c.unexplained_delta_bytes===c.used_delta_bytes-c.scanned_allocated_delta_bytes)box.append(node('p',`Measured allocated-file change: ${delta(c.scanned_allocated_delta_bytes)}. Difference not explained by tracked allocation: ${delta(c.unexplained_delta_bytes)}.`));
    if(typeof c.explanation==='string')box.append(node('p',c.explanation));
  }
  function showFileComparison(data,box){
    if(data.file_comparison?.available!==true){if(typeof data.file_comparison?.reason==='string')box.append(node('p',data.file_comparison.reason));return;}
    if(!Array.isArray(data.files)||data.files.length>1000)return;
    const baseline=data.baseline,current=data.current;
    if(!data.comparable&&(data.file_comparison.complete!==false||baseline.root!==current.root||baseline.host.id==='unknown'||baseline.host.id!==current.host.id||baseline.drive.status!=='known'||current.drive.status!=='known'||baseline.drive.fingerprint!==current.drive.fingerprint||Date.parse(baseline.scanned_at)>=Date.parse(current.scanned_at)||['max_depth','max_entries','max_seconds'].some(k=>baseline.filters[k]!==current.filters[k])||baseline.filters.excluded_names.join('\0')!==current.filters.excluded_names.join('\0')))return;
    const section=node('details');section.append(node('summary','Changes in retained files'));
    if(typeof data.file_comparison.reason==='string')section.append(node('p',data.file_comparison.reason));
    const rows=node('ol');
    for(const row of data.files.slice(0,100)){
      if(typeof row.path!=='string'||row.path.length>4096||!['grew','shrank','newly_observed','not_observed','added','removed'].includes(row.status)||(row.before_bytes!==null&&!integer(row.before_bytes))||(row.after_bytes!==null&&!integer(row.after_bytes)))continue;
      const measured=row.before_bytes!==null&&row.after_bytes!==null;
      if(measured&&(!Number.isSafeInteger(row.delta_bytes)||row.delta_bytes!==row.after_bytes-row.before_bytes))continue;
      if(['grew','shrank'].includes(row.status)&&(!measured||(row.status==='grew'?row.delta_bytes<=0:row.delta_bytes>=0)))continue;
      if(!data.comparable&&!['grew','shrank'].includes(row.status))continue;
      if(['added','removed'].includes(row.status)&&data.file_comparison.complete!==true)continue;
      const description=measured?delta(row.delta_bytes):row.after_bytes!==null?'Now '+bytes(row.after_bytes):'Previously '+bytes(row.before_bytes);
      rows.append(node('li',row.path+' · '+row.status.replace(/_/g,' ')+' · '+description+(row.hardlink_duplicate?' · Hard-link alias; do not add to counted totals.':'')));
    }
    section.append(rows);if(data.files.length>100)section.append(node('p','Showing the largest 100 retained file changes.'));box.append(section);return rows.children.length;
  }
  function settingsUI(){
    const section=node('details');section.className='storage-history-settings';section.append(node('summary','History retention & maintenance'),node('p','Retention affects saved scan summaries only. File contents are never removed by history maintenance.'));
    for(const [id,title,min,max,value] of [['storage-retention-count','Maximum saved scans',1,20,20],['storage-retention-days','Maximum age in days (0 keeps all ages)',0,3650,0]]){const label=node('label',title+' '),input=node('input','',id);input.type='number';input.min=min;input.max=max;input.value=value;label.append(input);section.append(label);}
    const label=node('label','Maintain history when saving new scans '),auto=node('input','','storage-retention-auto');auto.type='checkbox';label.append(auto);section.append(label);
    const validate=value=>integer(value.max_snapshots)&&value.max_snapshots>=1&&value.max_snapshots<=20&&integer(value.max_age_days)&&value.max_age_days<=3650&&typeof value.auto_prune==='boolean';
    const load=node('button','Load retention settings');load.className='pill-btn ghost';load.addEventListener('click',()=>act(async revision=>{const data=await request('/visualizer/history/retention');if(revision!==epoch)return;if(!validate(data))throw Error('Retention settings could not be validated.');$('storage-retention-count').value=data.max_snapshots;$('storage-retention-days').value=data.max_age_days;$('storage-retention-auto').checked=data.auto_prune;status('Retention settings loaded.');}));
    const save=node('button','Save retention settings');save.className='pill-btn ghost';save.addEventListener('click',()=>act(async revision=>{const payload={max_snapshots:Number($('storage-retention-count').value),max_age_days:Number($('storage-retention-days').value),auto_prune:$('storage-retention-auto').checked===true};if(!validate(payload))throw Error('Choose 1–20 scans and 0–3650 days.');const data=await request('/visualizer/history/retention',payload,'PUT');if(revision!==epoch)return;if(!validate(data)||Object.keys(payload).some(key=>payload[key]!==data[key]))throw Error('Saving retention settings was not confirmed.');status('Retention settings saved. Automatic maintenance runs only when enabled and saving a scan.');}));
    const prune=node('button','Remove summaries outside retention policy');prune.className='pill-btn ghost';prune.addEventListener('click',()=>act(async revision=>{const data=await request('/visualizer/history/maintenance',{});if(revision!==epoch)return;if(!integer(data.removed_count)||!Array.isArray(data.removed_ids)||data.removed_count!==data.removed_ids.length)throw Error('History maintenance was not confirmed.');saved=saved.filter(row=>!data.removed_ids.includes(row.id));list();status(`${data.removed_count} saved summaries removed. No scanned files were changed.`);}));section.append(load,save,prune);return section;
  }
  function beginScan(preservePrevious = false) {
    epoch++; busy = preservePrevious;
    clearComparison(true);
    if (!preservePrevious) current = null;
    if (initialized) {
      cancelRemove();
      if (!preservePrevious) { $("storage-history-current").replaceChildren(); $("storage-history-result").replaceChildren(); }
      status(preservePrevious ? "A new scan is running. The previous observation stays visible until it succeeds." : "Finish a new scan to save or compare its observation."); controls();
    }
  }
  function scanFailed() {
    busy = false;
    if (initialized) { status(current ? "The new scan failed. The previous observation is retained with its original scan time and expiry." : "No new observation was saved. Retry the scan when the folder is available."); controls(); }
  }
  function receiveScan(data) {
    beginScan();
    if (!initialized) return;
    const scan = data?.meta?.saved_scan;
    if (!validScan(scan)) { status("Saving and comparison require a scan from the updated TLI backend. Existing scan results remain available."); return; }
    current = scan;
    const info = $("storage-history-current"); info.appendChild(describe(scan.summary, "Latest scan"));
    const filters = scan.summary.filters;
    info.appendChild(node("p", `Policy: depth ${filters.max_depth}, up to ${filters.max_entries.toLocaleString()} entries, ${filters.max_seconds} seconds; links excluded. Excluded names: ${filters.excluded_names.join(", ") || "none"}.`));
    status("Save this observation explicitly, or compare it with an earlier saved scan. The current summary expires after 30 minutes."); controls();timeline();
  }
  function setup() {
    if (initialized || !$("vis4-summary")) return;
    initialized = true;
    const box = node("section", "", "storage-history"); box.className = "storage-history card-section"; box.setAttribute("aria-labelledby", "storage-history-title");
    box.append(node("h3", "What grew?", "storage-history-title"),
      node("p", "Explicitly save a folder scan, then compare a later scan. History is private to this account. These summaries use the full scanned scope; map and display filters do not change saved totals."),
      node("div", "", "storage-history-current"));
    const buttons = node("div"); buttons.className = "storage-history-controls";
    for (const [id, label, action] of [["storage-history-save", "Save scan", save], ["storage-history-load", "Load saved scans", load]]) {
      const button = node("button", label, id); button.className = "pill-btn ghost"; button.addEventListener("click", action); buttons.appendChild(button);
    }
    const label = node("label", "Compare against saved scan ");
    const select = node("select", "", "storage-history-baseline"); select.addEventListener("change", () => { clearComparison(); cancelRemove(); controls(); timeline(); }); label.appendChild(select);
    const button = node("button", "Compare", "storage-history-compare"); button.className = "pill-btn primary"; button.addEventListener("click", compare);
    const remove = node("button", "Remove selected saved scan", "storage-history-remove"); remove.className = "pill-btn ghost"; remove.addEventListener("click", reviewRemove);
    const message = node("p", "Scan a folder to begin.", "storage-history-status"); message.setAttribute("role", "status");
    box.append(buttons, label, button, remove, node("div", "", "storage-history-remove-review"), message, node('div','','storage-history-selection'),node('div','','storage-history-timeline'),node("div", "", "storage-history-result"),settingsUI());
    if ($("fs-view-history")) $("fs-view-history").append(box); else $("vis4-summary").after(box); list(); controls();
    const clear = () => { beginScan(); saved = []; list(); status(""); };
    window.addEventListener("tli-session-locked", clear); window.addEventListener("pagehide", event => { if (!event.persisted) clear(); });
  }
  window.TLIStorageHistory = {setup, beginScan, receiveScan, scanFailed,selectPath,selectedBaseline:root=>saved.find(row=>row.id===$('storage-history-baseline')?.value&&row.root===root)?.id||null};
})();
// ---------- End saved storage observations ----------
function visEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"})[c]);
}

async function visFetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed (${response.status}).`);
  return response.json();
}

function visScanFailure(error, received = false) {
  if (received) return "The scan returned, but its results could not be displayed. Refresh TLI and try again.";
  if (error.status === 401) return "Your TLI session expired. Unlock TLI, then try again.";
  if (error.status === 403) return "TLI denied access to this scan. Check your session and access permissions.";
  if (error.status === 404) return "The folder or scan endpoint was not found. Check the path on the TLI host; if you just updated TLI, restart its backend.";
  if (error.status === 400) return "The scan path was rejected. Choose an existing folder on the TLI host.";
  if (error.status === 422) return "The backend rejected the scan request. If you just updated TLI, restart its backend and refresh this page.";
  if (error.status >= 500) return `The TLI backend could not complete the scan (HTTP ${error.status}). If you just updated TLI, restart its backend and retry.`;
  return "The scan connection failed or returned an invalid response. Check that TLI is running, then retry.";
}

// Review candidates are not a claim that these bytes can safely be reclaimed.
function visReview(tree) {
  const files = [];
  let protectedBytes = 0;
  const visit = (node, inherited = false) => {
    if (!node || node.synthetic) return;
    const protectedPath = inherited || node.protected || isProtectedSystemPathClient(node.path || "");
    if (Array.isArray(node.children)) {
      node.children.forEach(child => visit(child, protectedPath));
    } else if (protectedPath) {
      protectedBytes += Number(node.size) || 0;
    } else if (node.size > 0) {
      files.push(node);
    }
  };
  visit(tree);
  files.sort((a, b) => b.size - a.size);
  return { files: files.slice(0, 3), protectedBytes };
}

function visCoverage(meta) {
  if (!meta || typeof meta.partial !== "boolean") return "Scan coverage is unknown. Sizes represent only files inspected.";
  const reasons = [];
  if (meta.denied) reasons.push(`${meta.denied} unreadable ${meta.denied === 1 ? "entry" : "entries"}`);
  if (meta.skipped) reasons.push(`${meta.skipped} excluded folders or links`);
  if (meta.depth_limited) reasons.push("folder depth limit reached");
  if (meta.entry_limited) reasons.push("entry limit reached");
  if (meta.time_limited) reasons.push("time limit reached");
  if (meta.cancelled) reasons.push("stopped before all entries were inspected");
  const representation = meta.representation_limited ? " The returned tree is limited; some inspected paths are grouped or omitted. Select a smaller location and scan explicitly to inspect them." : "";
  return (meta.partial
    ? `Partial scan: ${reasons.join("; ") || "some entries were not inspected"}. Scan a specific folder for more detail.`
    : "Scan finished within its limits. File sizes can differ from space used on disk.") + representation;
}

function visCleanupCoverage(target) {
  if (target.size_partial === false) return "File sizes inspected; this is not a promise of reclaimable space.";
  if (target.size_partial !== true) return "Estimate coverage is unknown. Review the folder before acting.";
  const meta = target.size_meta || {};
  const reasons = [];
  if (meta.denied) reasons.push("some entries could not be read");
  if (meta.skipped) reasons.push("links were skipped");
  if (meta.time_limited) reasons.push("time limit reached");
  if (meta.entry_limited) reasons.push("entry limit reached");
  if (meta.byte_limited) reasons.push("size limit reached");
  return `Partial estimate: ${reasons.join("; ") || "some entries were not inspected"}. Scan this folder for more detail.`;
}

function visDuplicateCoverage(meta) {
  if (meta?.verification !== "full_sha256") return "These matches have not been verified by a full-content check. Restart the updated TLI backend and scan again before relying on them.";
  const notes = ["Files of 4 KB or more; matching files were checked in full. Copies may be needed by separate apps or backups. Extra-copy bytes are not guaranteed recoverable space."];
  if (meta.partial) {
    const reasons = [];
    if (meta.time_limited) reasons.push("time limit reached");
    if (meta.entry_limited) reasons.push("entry limit reached");
    if (meta.denied) reasons.push("some files could not be read");
    if (meta.skipped) reasons.push("protected locations, excluded folders or links skipped");
    if (meta.changed) reasons.push("files changed during the check");
    notes.push(`Partial scan: ${reasons.join("; ") || "some files were not checked"}. Scan a smaller folder to continue reviewing.`);
  }
  if (meta.hardlinks_skipped) notes.push("Additional hard-link names were excluded from duplicate counts.");
  if (meta.results_limited) notes.push("Only the largest 100 groups were returned.");
  return notes.join(" ");
}


function getParentFolderPath(fullPath) {
  if (!fullPath) return fullPath;
  if (/^[a-z]:[\\/]?$/i.test(fullPath)) return fullPath.slice(0, 2) + (fullPath.includes('/') ? '/' : '\\');
  if (/^\/+$/u.test(fullPath)) return '/';

  // Strip trailing slashes first
  const norm = fullPath.replace(/[\\\/]+$/, "");
  const lastSlash = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));

  // If there's no parent, just return the normalized path
  if (lastSlash < 0) return norm;
  if (lastSlash === 0) return norm.slice(0, 1);
  if (lastSlash === 2 && /^[a-z]:/i.test(norm)) return norm.slice(0, 3);

  return norm.slice(0, lastSlash);
}


  function isProtectedSystemPathClient(fullPath) {
    if (!fullPath) return false;
    const lower = fullPath.replace(/\\/g, "/").toLowerCase();

    // Windows
    if (_tliIsWindows()) {
      const protectedFiles = [
        "c:/hiberfil.sys",
        "c:/pagefile.sys",
        "c:/swapfile.sys",
        "c:/bootmgr",
        "c:/bootnxt",
        "c:/boot/bcd",
        "c:/boot/bootstat.dat",
      ];
      // Any .sys file directly on any drive root (e.g. D:/hiberfil.sys)
      if (/^[a-z]:\/[^/]+\.sys$/.test(lower)) return true;
      const protectedPrefixes = [
        "c:/windows",
        "c:/program files",
        "c:/program files (x86)",
        "c:/programdata",
        "c:/system volume information",
        "c:/$recycle.bin",
      ];

      if (protectedFiles.includes(lower)) return true;
      return protectedPrefixes.some(
        p => lower === p || lower.startsWith(p + "/")
      );
    }

    // macOS
    if (_tliIsMac()) {
      const prefixes = [
        "/system",
        "/usr",
        "/bin",
        "/sbin",
        "/private",
        "/library",
        "/applications",
        "/volumes/recovery",
      ];
      return prefixes.some(
        p => lower === p || lower.startsWith(p + "/")
      );
    }

    // Generic Linux / Unix
    const posixPrefixes = [
      "/bin",
      "/boot",
      "/dev",
      "/etc",
      "/lib",
      "/lib32",
      "/lib64",
      "/proc",
      "/root",
      "/run",
      "/sbin",
      "/sys",
      "/usr",
      "/var",
      "/snap",
      "/opt",
    ];
    return posixPrefixes.some(
      p => lower === p || lower.startsWith(p + "/")
    );
  }


/* Free Space owns one in-memory observation lifecycle. No scans on navigation. */
(function () {
  'use strict';
  const protocol = 'storage-jobs-v1', PAGE_SIZE = 50, TREE_ROW_HEIGHT = 44, TREE_OVERSCAN = 12;
  const terminal = new Set(['completed', 'partial', 'cancelled', 'failed']);
  const operations = ['scan', 'large_files', 'duplicates', 'common_folders'];
  const labels = {scan:'Folder scan', large_files:'Large file search', duplicates:'Duplicate check', common_folders:'Common folder check'};
  const state = {initialized:false, locked:false, paused:false, panelActive:true, epoch:0, sequence:0, drives:[], drivesLoaded:false, driveBusy:false,
    job:null, pendingStart:null, busy:false, timer:null, requests:new Set(), observation:null, tools:{}, tab:'explore',
    focus:'', mode:'map', surface:'list', mapGroup:null, mapView:null, mapExcluded:new Set(), metric:'size', sort:'size', direction:-1, selected:null, handoff:null, investigationBusy:false, investigationRevision:0,
    expanded:new Set(), filterExpanded:new Set(), treeRows:[], treeActiveKey:null, extensionFilter:null, treeRatio:60, typePage:0};
  let mapObserver = null, workbenchObserver = null, mapMarks = [], tableMarks = [], entryMenu = null, revealPending = null, renderedList = null;
  const $ = id => document.getElementById(id);
  const make = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
  const button = (text, fn, className = 'fs-button') => { const n = make('button', text, className); n.type = 'button'; n.addEventListener('click', fn); return n; };
  const text = (id, value) => { if ($(id)) $(id).textContent = value; };
  const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const pathOK = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f]/.test(value);
  const normalized = value => /^[A-Za-z]:[\\/]/.test(value) ? value.replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase() : value.replace(/\/+$/,'') || '/';
  const samePath = (a,b) => pathOK(a) && pathOK(b) && normalized(a) === normalized(b);
  const selectedPath = () => $('visualizerPathInput').value.trim();
  const matchesLocation = observation => !!observation && (observation.job.operation === 'common_folders' || samePath(observation.root, selectedPath()));
  const visibleObservation = () => matchesLocation(state.observation) ? state.observation : null;
  const below = (path, root) => samePath(path,root) || normalized(path).startsWith(normalized(root).replace(/\/$/,'') + '/');
  const bytes = value => { if (!finite(value)) return 'Size unknown'; const units=['B','KiB','MiB','GiB','TiB','PiB']; let i=0; while(value>=1024 && i<units.length-1){value/=1024;i++;} return value.toLocaleString(undefined,{maximumFractionDigits:i?1:0})+' '+units[i]; };
  const date = value => { const d = new Date(typeof value === 'number' ? value*1000 : value); return Number.isFinite(d.getTime()) ? d.toLocaleString() : 'Observation time unavailable'; };
  const current = epoch => !state.locked && !state.paused && !document.hidden && epoch === state.epoch;
  const itemBytes = item => item?.hardlink_duplicate ? (finite(item.logical_size)?bytes(item.logical_size)+' logical':'Logical size unknown')+' · counted elsewhere' : item?.size===null || item?.size_known===false || item?.size_unavailable===true ? 'Size unknown' : (item?.size_partial===true?'At least ':'')+bytes(item?.size);
  const allocatedBytes = item => item?.hardlink_duplicate ? 'Counted elsewhere' : finite(item?.allocated_size) ? bytes(item.allocated_size) : finite(item?.allocated_known_bytes) && item.allocated_known_bytes > 0 ? 'At least '+bytes(item.allocated_known_bytes) : 'Unknown';
  const metricBytes = item => state.metric==='allocated_size' ? allocatedBytes(item) : itemBytes(item);
  const status = message => text('visualizerStatus', message);
  const hostName = () => window.__tli_node_name || window.__tli_hostname || 'TLI host';
  const category = name => { const ext=(name.match(/\.([^.]*)$/)?.[1]||'').toLowerCase(); for(const [name,exts] of Object.entries({'System files':['sys','dll','drv'],'Disk images':['iso','vhd','vhdx','vmdk','qcow2','img'],Images:['jpg','jpeg','png','webp','gif','heic','svg'],Video:['mp4','mov','mkv','avi','webm'],Audio:['mp3','flac','wav','m4a'],Documents:['pdf','doc','docx','txt','md','xlsx','csv','pptx'],Archives:['zip','7z','rar','tar','gz'],Installers:['exe','msi','dmg','pkg','deb','apk'],Models:['gguf','safetensors','onnx','pt']})) if(exts.includes(ext))return name; return 'Other'; };
  function requestId() { const c=window.crypto; if(c?.randomUUID)return c.randomUUID(); if(!c?.getRandomValues)throw Error('Secure request identifiers are unavailable in this browser.'); const b=new Uint8Array(16); c.getRandomValues(b); return Array.from(b,n=>n.toString(16).padStart(2,'0')).join(''); }
  async function api(url, payload, epoch=state.epoch, method) {
    const abort = new AbortController(); state.requests.add(abort); const timeout=setTimeout(()=>abort.abort(),20000);
    try {
      const response=await fetch(url,{method:method||(payload?'POST':'GET'),credentials:'same-origin',cache:'no-store',signal:abort.signal,...(payload?{headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}:{})});
      if(!current(epoch))throw Error('View changed.');
      let data; try{data=await response.json();}catch{throw Error('The host returned an unreadable response.');}
      if(!current(epoch))throw Error('View changed.');
      if(!response.ok){const detail=data?.detail;const e=Error(typeof detail==='string'?detail:typeof detail?.message==='string'?detail.message:`Request failed (${response.status}).`);e.status=response.status;if(typeof detail?.code==='string')e.code=detail.code; if(response.status===401){window.dispatchEvent(new CustomEvent('tli-session-locked'));} throw e;}
      return data;
    } finally {clearTimeout(timeout);state.requests.delete(abort);}
  }
  function validateJob(data, expected) {
    const j=data?.job;
    if(data?.ok!==true || data.protocol!==protocol || !j || typeof j.id!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(j.id) || !operations.includes(j.operation) || !['quick','deep'].includes(j.profile) || !['queued','running','cancelling',...terminal].includes(j.status) || typeof j.result_available!=='boolean')throw Error('The host did not confirm a valid storage job.');
    if(expected && ((expected.id && j.id!==expected.id) || j.operation!==expected.operation || j.profile!==expected.profile || (j.operation!=='common_folders'&&!samePath(j.path,expected.path)) || (typeof j.include_excluded==='boolean' && typeof expected.include_excluded==='boolean' && j.include_excluded!==expected.include_excluded)))throw Error('The response belongs to a different storage job, location or inclusion policy.');
    return j;
  }
  function validateResult(data, job) {
    if(!data || typeof data!=='object' || (job.operation!=='common_folders' && (!data.meta || typeof data.meta!=='object')))throw Error('The observation is incomplete or malformed. Previous results are retained.');
    const validHost=h=>h&&typeof h.id==='string'&&h.id.length>0&&h.id.length<=256&&typeof h.name==='string'&&h.name.length>0&&h.name.length<=256;
    const savedHost=data.meta?.saved_scan?.summary?.host;
    if(validHost(job.host)&&validHost(savedHost)&&job.host.id!==savedHost.id)throw Error('The saved observation belongs to a different host.');
    const host=validHost(job.host)?{id:job.host.id,name:job.host.name}:validHost(savedHost)?{id:savedHost.id,name:savedHost.name}:{id:null,name:'Host identity unavailable'};
    if(job.operation==='scan') {
      if(!data.tree || !samePath(data.tree.path,job.path) || (data.path && !samePath(data.path,job.path)))throw Error('The returned scan root does not match the requested location.');
      const stack=[{node:data.tree,protected:false,parentPath:null}], seen=new Set(), files=[],folders=[],index=new Map();let count=0;
      while(stack.length){const entry=stack.pop(),n=entry.node;if(!n || ++count>25000 || typeof n.name!=='string' || n.name.length>4096 || !pathOK(n.path) || !below(n.path,job.path) || (entry.parentPath&&!samePath(getParentFolderPath(n.path),entry.parentPath)) || seen.has(normalized(n.path)) || (n.size!==null && n.size!==undefined && !finite(n.size)) || (n.children!==undefined && !Array.isArray(n.children)) || ['collapsed_entries','omitted_entries','unknown_entries'].some(k=>n[k]!==undefined&&(!Number.isSafeInteger(n[k])||n[k]<0||n[k]>500000)))throw Error('The scan contains invalid or repeated file entries.');seen.add(normalized(n.path));
        const synthetic=n.synthetic===true||n.kind==='aggregate',isDir=!synthetic&&(n.kind==='directory'||n.is_dir===true||Array.isArray(n.children)),protectedPath=entry.protected||n.protected===true||isProtectedSystemPathClient(n.path);
        if(n.allocated_size!=null&&!finite(n.allocated_size)||n.allocated_known_bytes!=null&&!finite(n.allocated_known_bytes)||n.omitted_bytes!=null&&!finite(n.omitted_bytes)||n.files!=null&&(!Number.isSafeInteger(n.files)||n.files<0)||n.modified_at!=null&&(typeof n.modified_at!=='string'||!Number.isFinite(Date.parse(n.modified_at))))throw Error('The scan contains invalid allocation or timestamp metadata.');
        const item={name:n.name,path:n.path,parentPath:entry.parentPath,size:n.size_known===false||n.size_unavailable===true?null:finite(n.size)?n.size:null,size_partial:n.size_partial===true,size_reason:typeof n.size_reason==='string'?n.size_reason.slice(0,2000):null,isDir,protected:protectedPath,synthetic,collapsed_entries:n.collapsed_entries,omitted_entries:n.omitted_entries,omitted_bytes:n.omitted_bytes,unknown_entries:n.unknown_entries,category:isDir?'Folder':category(n.name),children:n.children?.map(c=>c.path)||[],allocated_size:n.allocated_partial===true?null:finite(n.allocated_size)?n.allocated_size:null,allocated_partial:n.allocated_partial===true,allocated_known_bytes:finite(n.allocated_known_bytes)?n.allocated_known_bytes:n.allocated_partial===true&&finite(n.allocated_size)?n.allocated_size:null,files:Number.isSafeInteger(n.files)?n.files:isDir?null:1,modified_at:n.modified_at||null,extension:typeof n.extension==='string'?n.extension.toLowerCase():(n.name.match(/\.[^.]+$/)?.[0]||'').toLowerCase(),hardlink_duplicate:n.hardlink_duplicate===true,actionable:!isDir&&!synthetic&&n.hardlink_duplicate!==true,logical_size:finite(n.logical_size)?n.logical_size:null};index.set(n.path,item);
        if(!item.synthetic){if(isDir)folders.push(item);else files.push(item);}for(const child of n.children||[])stack.push({node:child,protected:protectedPath,parentPath:n.path});
      }
      if(!window.TLIStorageMap)throw Error('The storage map component is unavailable. Refresh TLI; the previous observation is retained.');
      const map=window.TLIStorageMap.build(index,data.tree.path);
      return {raw:data,job,files,folders,index,map,root:data.tree.path,recordedAt:data.meta.saved_scan?.summary?.scanned_at||job.finished_at||job.updated_at,host};
    }
    if(job.operation==='large_files') {
      if(!Array.isArray(data.files)||data.files.length>10000||data.files.some(f=>!pathOK(f.path)||!below(f.path,job.path)||typeof f.name!=='string'||(f.size!==null&&f.size!==undefined&&!finite(f.size))))throw Error('The large-file results did not match this location.');
    } else if(job.operation==='duplicates') {
      if(!Array.isArray(data.groups)||data.groups.length>100||data.groups.some(g=>!finite(g.size)||!Array.isArray(g.paths)||g.paths.length<2||g.paths.length>500000||new Set(g.paths).size!==g.paths.length||g.paths.some(p=>!pathOK(p)||!below(p,job.path)))||data.groups.reduce((n,g)=>n+g.paths.length,0)>500000)throw Error('The duplicate result contains invalid paths or groups.');
    } else if(!Array.isArray(data.targets)||data.targets.length>100||data.targets.some(t=>typeof t.label!=='string'||!pathOK(t.path)||(t.size_bytes!==null&&t.size_bytes!==undefined&&!finite(t.size_bytes))))throw Error('The common-folder result is invalid.');
    return {raw:data,job,root:job.path,recordedAt:job.finished_at||job.updated_at,host};
  }
  function controls() {
    if(!state.initialized)return;
    const waiting=!!state.job&&!terminal.has(state.job.status), blocked=state.busy||waiting||!!state.pendingStart||state.locked||state.paused;
    for(const id of ['visualizerScanBtn','fs-start-large_files','fs-start-duplicates','fs-start-common_folders'])$(id).disabled=blocked;
    $('fs-job-stop').disabled=state.busy||state.paused||!waiting||state.job?.status==='cancelling';
    $('fs-job-stop').hidden=!waiting;
    $('fs-job-check').disabled=state.busy;
    $('fs-job').hidden=(!state.job&&!state.pendingStart)||(state.job&&['completed','partial'].includes(state.job.status)&&$('fs-job-check').hidden);
    const path=selectedPath(), scanActive=(state.pendingStart?.operation==='scan'?state.pendingStart:waiting&&state.job.operation==='scan'?state.job:null);
    text('visualizerScanBtn',scanActive?`Scanning ${scanActive.path}…`:visibleObservation()?'Scan again':path?`Scan ${path}`:'Scan location');
    if(!visibleObservation()){
      const scanning=scanActive&&samePath(scanActive.path,path);
      text('fs-empty-title',scanning?`Scanning ${path}…`:path?`Scan ${path} to see what uses space`:'Choose a drive or folder');
      text('fs-empty-description',scanning?'Results will appear here when the scan finishes.':path?'Choose Scan to view the files and folders here.':'Select a drive above, or enter a folder path.');
    }
    $('fs-ask-chat').disabled=!visibleObservation()||state.locked;
    if($('fs-investigate'))$('fs-investigate').disabled=state.investigationBusy||!visibleObservation()||blocked;
    if($('fs-selected-explain'))$('fs-selected-explain').disabled=state.investigationBusy||blocked||!visibleObservation()||!state.selected?.path||state.selected.synthetic===true||state.selected.aggregate===true;
    if($('fs-selected-reveal'))$('fs-selected-reveal').disabled=state.locked||state.paused||!visibleObservation()||!state.selected?.path||state.selected.synthetic===true;
  }
  function showJob(job) {
    text('fs-job-title',`${labels[job.operation]} · ${job.status}`);
    const p=job.progress||{}, parts=[];
    for(const [key,label] of [['entries_seen','entries inspected'],['files','files inspected'],['found','matches found'],['files_hashed','files checked in full']])if(finite(p[key]))parts.push(p[key].toLocaleString()+' '+label);
    const phases={queued:'Waiting to start',starting:'Starting',scanning:'Inspecting entries',enumerating:'Inspecting entries',hashing:'Checking file contents',finishing:'Preparing result',completed:'Finished',cancelled:'Stopped'};
    const startTime=new Date(typeof job.started_at==='number'?job.started_at*1000:job.started_at).getTime();
    if(Number.isFinite(startTime))parts.push(Math.max(0,Math.floor((Date.now()-startTime)/1000))+'s since start');
    text('fs-job-progress',`${job.operation==='common_folders'?'Common folders on the TLI host':job.path} · ${job.profile} · ${phases[p.phase]||'Waiting for host progress'}. `+(parts.join(' · ') || (job.status==='cancelling'?'Stop requested; waiting for host confirmation.':'No progress counters received yet.')));
    controls();
  }
  function schedule(epoch) {clearTimeout(state.timer);if(current(epoch)&&state.job&&!terminal.has(state.job.status))state.timer=setTimeout(()=>poll(),1000);}
  async function finish(job, epoch, reviewPartial=false) {
    if(!current(epoch))return;
    if(job.status==='cancelled'&&job.result_available&&!reviewPartial){window.TLIStorageHistory?.scanFailed();status('The host confirmed cancellation. Partial results are available for review; earlier scans are retained.');$('fs-job-check').hidden=false;$('fs-job-check').textContent='View partial results';controls();return;}
    if(job.result_available){const data=await api(`/visualizer/jobs/${encodeURIComponent(job.id)}/results`,null,epoch);const resultJob=validateJob(data,job);if(resultJob.status!==job.status||!resultJob.result_available)throw Error('The host did not confirm this completed observation.');const observation=validateResult(data.result,job);if(!current(epoch))return;
      if(job.operation==='scan'){clearInvestigation();state.observation=observation;state.focus=observation.root;state.selected=null;state.mapGroup=null;state.mapView=null;state.mapExcluded.clear();state.expanded.clear();state.filterExpanded.clear();state.treeRows=[];state.treeActiveKey=null;renderedList=null;$('fs-table-wrap').scrollTop=0;$('visualizerDetailsBar').hidden=true;$('fs-selected-cleanup')?.replaceChildren();window.TLIStorageHistory?.receiveScan(data.result);if(state.tab==='explore'&&matchesLocation(observation))applyScope(observation);window.dispatchEvent(new CustomEvent('tli:storage-observation-change',{detail:{id:job.id,path:job.path}}));renderObservation();}
      else {state.tools[job.operation]=observation;if(state.tab===job.operation&&matchesLocation(observation))applyScope(observation);renderTool(job.operation);}
      status(matchesLocation(observation)?`${labels[job.operation]} ${job.status}. ${job.status==='cancelled'?'The host confirmed cancellation; the inspected portion is shown. ':''}Nothing was moved or deleted.`:`${labels[job.operation]} finished for ${observation.root}. Select that location to view its results.`);
    }else{window.TLIStorageHistory?.scanFailed();status(`${labels[job.operation]} ${job.status}. ${typeof job.error?.message==='string'?job.error.message:typeof job.error==='string'?job.error:''} No replacement observation was returned. Previous results are unchanged.`);}
    $('fs-job-check').hidden=true;controls();
  }
  async function start(operation='scan', overridePath) {
    setup();if(state.busy||state.paused||state.pendingStart||(state.job&&!terminal.has(state.job.status))||state.locked||document.hidden)return false;
    const path=overridePath||selectedPath();if(operation!=='common_folders'&&!pathOK(path)){status('Choose a folder or drive on the TLI host first.');return false;}
    if(overridePath&&operation!=='common_folders'){ $('visualizerPathInput').value=path;locationChanged(); }
    const profile=$('fs-profile').value;if(!['quick','deep'].includes(profile))return false;
    let request_id;try{request_id=requestId();}catch(e){status(e.message);return false;}
    const payload={operation,profile,path:operation==='common_folders'?undefined:path,include_excluded:profile==='deep'&&$('fs-include-excluded').checked===true,request_id};
    if(operation==='large_files'){const mb=Number($('vis4-largefiles-minmb').value);if(!Number.isFinite(mb)||mb<1||mb>50000){status('Choose a minimum from 1 to 50,000 MiB.');return false;}payload.min_mb=mb;payload.limit=500;}
    closeEntryMenu();state.pendingStart=payload;state.job=null;if(operation==='scan'){setTab('explore');window.TLIStorageHistory?.beginScan(true);}return submitStart();
  }
  async function submitStart(){if(state.busy||!state.pendingStart)return false;const epoch=state.epoch,payload=state.pendingStart;state.busy=true;controls();text('fs-job-title','Starting '+labels[payload.operation].toLowerCase());text('fs-job-progress','The prior observation stays available while this request is checked.');$('fs-job-check').hidden=true;
    try{if(window.TLIRelease)await window.TLIRelease.requireCapability('storage_jobs_v1');if(!current(epoch))return false;const data=await api('/visualizer/jobs',payload,epoch);const job=validateJob(data,payload);if(!current(epoch))return false;state.job=job;state.pendingStart=null;showJob(job);if(terminal.has(job.status))await finish(job,epoch);else schedule(epoch);return true;}
    catch(e){if(current(epoch)){if(e.status){state.pendingStart=null;status(e.code==='host_version_not_ready'?`Restart TLI to load the update, then refresh and scan ${payload.path||'again'}.`:e.message+' The request was rejected. Previous observations are unchanged; nothing retries automatically.');window.TLIStorageHistory?.scanFailed();}else{status(e.message+' Start was not confirmed. An explicit retry uses the same request ID, but can start the job if the first request never arrived.');$('fs-job-check').hidden=false;$('fs-job-check').textContent='Retry this start request';}}}
    finally{if(current(epoch)){state.busy=false;controls();}}
    return false;
  }
  async function poll(){if(state.busy||!state.job||state.locked||document.hidden)return;const epoch=state.epoch,job=state.job;state.busy=true;controls();
    try{const data=await api(`/visualizer/jobs/${encodeURIComponent(job.id)}`,null,epoch);const updated=validateJob(data,job);if(!current(epoch))return;state.job=updated;showJob(updated);if(terminal.has(updated.status))await finish(updated,epoch);else schedule(epoch);}
    catch(e){if(current(epoch)){if([404,410].includes(e.status)){state.job=null;window.TLIStorageHistory?.scanFailed();status(e.message+' This job is no longer available. Previous observations are retained. Start a new scan explicitly if needed.');}else{status(e.message+' Watching paused. Previous observations are unchanged. Check status explicitly to continue.');$('fs-job-check').hidden=false;$('fs-job-check').textContent='Check status';}}}
    finally{if(current(epoch)){state.busy=false;controls();}}
  }
  async function stop(){if(state.busy||!state.job||terminal.has(state.job.status))return;const epoch=state.epoch,job=state.job;clearTimeout(state.timer);state.busy=true;controls();
    try{const data=await api(`/visualizer/jobs/${encodeURIComponent(job.id)}/cancel`,{},epoch);const updated=validateJob(data,job);if(!current(epoch))return;state.job=updated;showJob(updated);if(terminal.has(updated.status))await finish(updated,epoch);else schedule(epoch);}
    catch(e){if(current(epoch)){status(e.message+' Cancellation was not confirmed. The host may still be scanning; check status before starting again.');$('fs-job-check').hidden=false;$('fs-job-check').textContent='Check status';}}
    finally{if(current(epoch)){state.busy=false;controls();}}
  }
  function prepare(path){setup();if(state.locked||!pathOK(path))return false;$('visualizerPathInput').value=path;locationChanged();status(visibleObservation()?'Showing the last scan of this location. No new scan has run.':'Location selected; no scan has run.');return true;}
  function renderSelectedCapacity(){const drive=state.drives.find(d=>samePath(d.mountpoint,selectedPath()));text('fs-location-capacity',drive?`${bytes(drive.free)} free of ${bytes(drive.total)}`:'Select a drive or enter a folder on the TLI host.');}
  function locationChanged(){
    closeEntryMenu();closeHandoff();clearInvestigation();const path=selectedPath();
    window.TLIStorageCleanup?.setLocation?.(path);
    text('fs-location-title',path||'Choose where to look');text('fs-location-summary-hint',path||'Choose a drive or folder');
    renderSelectedCapacity();
    for(const n of $('vis4-drives').querySelectorAll('button'))n.setAttribute('aria-pressed',String(samePath(n.dataset.mount,path)));
    state.displayRevision=(state.displayRevision||0)+1;state.selected=null;state.treeRows=[];state.treeActiveKey=null;window.TLIStorageHistory?.selectPath?.(null);$('visualizerDetailsBar').hidden=true;for(const id of ['fs-selected-cleanup','visualizerDetailsName','visualizerDetailsPath','visualizerDetailsSize'])$(id).replaceChildren();
    if(state.tab==='explore'&&visibleObservation())applyScope(state.observation);
    else if(matchesLocation(state.tools[state.tab]))applyScope(state.tools[state.tab]);
    renderObservation();for(const operation of operations.slice(1))renderTool(operation);controls();
  }
  async function drives(force=false){setup();if(state.driveBusy||state.locked||state.paused||document.hidden||(!force&&state.drivesLoaded))return;if(state.pendingStart||state.job&&!terminal.has(state.job.status)){text('fs-drives-status','A storage job is active. Refresh capacity explicitly after it finishes. Previous readings are retained.');return;}const epoch=state.epoch;state.driveBusy=true;$('fs-drives-refresh').disabled=true;text('fs-drives-status','Reading drive capacity…');
    try{if(!window.TLI_PATHS&&typeof window._tliLoadCommonPaths==='function'){await window._tliLoadCommonPaths();if(!current(epoch))return;}const data=await api('/visualizer/drives',null,epoch);if(!Array.isArray(data.drives)||data.drives.length>256||data.drives.some(d=>!pathOK(d.mountpoint||d.mount||d.path)))throw Error('Drive information has an invalid format.');if(!current(epoch))return;state.drives=data.drives.map(d=>({...d,mountpoint:d.mountpoint||d.mount||d.path,free:d.free_bytes??d.free,total:d.total_bytes??d.total}));state.drivesLoaded=true;renderDrives();renderSelectedCapacity();text('fs-drives-status',`${state.drives.length} drives · capacity read ${new Date().toLocaleTimeString()}`);}
    catch(e){if(current(epoch))text('fs-drives-status','Drive information is unavailable. Previous readings are retained; you can enter a folder or refresh explicitly.');}
    finally{if(current(epoch)){state.driveBusy=false;$('fs-drives-refresh').disabled=false;}}
  }
  function renderDrives(){const query=$('fs-drive-search').value.toLowerCase(),sort=$('fs-drive-sort').value,rows=state.drives.filter(d=>(String(d.label||'')+' '+d.mountpoint).toLowerCase().includes(query)).sort((a,b)=>sort==='free'?(finite(a.free)?a.free:Infinity)-(finite(b.free)?b.free:Infinity):sort==='used'?(finite(b.percent_used)?b.percent_used:-1)-(finite(a.percent_used)?a.percent_used:-1):String(a.label||a.mountpoint).localeCompare(String(b.label||b.mountpoint)));const list=$('vis4-drives');list.replaceChildren();
    for(const d of rows){const b=button('',()=>prepare(d.mountpoint),'fs-drive');b.dataset.mount=d.mountpoint;b.setAttribute('aria-pressed',String(samePath($('visualizerPathInput').value,d.mountpoint)));const top=make('span',undefined,'fs-drive-top');top.append(make('strong',d.label||d.mountpoint),make('span',finite(d.percent_used)&&d.percent_used<=100?Math.round(d.percent_used)+'% used':'Usage unknown','fs-help'));b.append(top,make('span',d.mountpoint,'fs-path'));const meter=make('span',undefined,'fs-meter'),fill=make('span');fill.style.width=(finite(d.percent_used)&&d.percent_used<=100?d.percent_used:0)+'%';meter.append(fill);b.append(meter,make('span',`${bytes(d.free)} free / ${bytes(d.total)}`,'fs-help'));if(d.availability&&d.availability!=='available'){b.append(make('span',({offline:'Offline',unavailable:'Capacity unavailable',unknown:'Capacity unknown'}[d.availability]||'Capacity unavailable')+(typeof d.detail==='string'?' · '+d.detail.slice(0,240):''),'fs-drive-availability'));}list.append(b);}if(!rows.length)list.append(make('p',state.drives.length?'No drives match your search.':'No drives returned. Enter a folder to continue.','fs-help'));}
  function applyScope(observation){if(observation)window.TLIStorageCleanup?.setScope?.({observationId:observation.job.id,root:observation.root||'common_folders',host:observation.host||{name:hostName(),id:null}});}
  function setTab(tab,focusResults=false){if(!['explore','large_files','duplicates','common_folders','history'].includes(tab))return;const changed=state.tab!==tab;closeEntryMenu();state.tab=tab;if(tab!=='explore'&&$('fs-more-tools'))$('fs-more-tools').open=true;for(const b of document.querySelectorAll('[data-fs-tab]')){const active=b.dataset.fsTab===tab;b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;$('fs-view-'+b.dataset.fsTab).hidden=!active;}if(changed){if(tab==='explore'){if(visibleObservation())applyScope(state.observation);renderObservation();}else if(operations.includes(tab)){if(matchesLocation(state.tools[tab]))applyScope(state.tools[tab]);renderTool(tab);}}if(tab==='explore'&&focusResults){const target=visibleObservation()?$('vis4-summary').querySelector('strong'):$('fs-empty-title');target?.setAttribute('tabindex','-1');target?.focus();target?.scrollIntoView?.({block:'start',behavior:'instant'});}}
  function renderObservation(){const o=visibleObservation(),path=selectedPath();$('fs-empty').hidden=!!o;$('storage-results').hidden=!o;$('panel-visualizer').classList.toggle('fs-has-observation',!!o);window.visualizerV4=o?{scanPath:o.root,meta:o.raw.meta,root:o.raw.tree}:null;
    if(!o){renderedList=null;mapObserver?.disconnect();mapObserver=null;mapMarks=[];tableMarks=[];state.mapView=null;text('fs-empty-title',path?`Scan ${path} to see what uses space`:'Choose a drive or folder');text('fs-empty-description',path?'Choose Scan to view the files and folders here.':'Select a drive above, or enter a folder path.');for(const id of ['vis4-summary','visualizerTableBody','visualizerTypeBars','vis4-treemap-container','fs-map-breadcrumbs','fs-map-folders','fs-map-hidden'])$(id).replaceChildren();return;}
    const summary=$('vis4-summary');summary.replaceChildren();const heading=make('div',undefined,'fs-heading');heading.append(make('strong',o.root));if(o.raw.meta.partial||o.raw.tree.size_partial||o.job.status!=='completed')heading.append(make('span','Partial scan','fs-badge'));summary.append(heading,make('p',`${itemBytes(o.index.get(o.root))} inspected · ${date(o.recordedAt)} · ${o.host.name}`,'fs-help'));
    const details=make('details',undefined,'fs-policy');details.append(make('summary','Recorded scope & limits'),make('p',o.root,'fs-path'),make('p',visCoverage(o.raw.meta)));details.append(make('p',`Host ID: ${o.host.id||'unavailable'} · Job: ${o.job.id} · ${o.job.profile} profile. This is a saved observation, not a current capacity reading.`));const filters=o.raw.meta.scan_filters||o.raw.meta.saved_scan?.summary?.filters;if(filters){const excluded=Array.isArray(filters.excluded_names)?filters.excluded_names.filter(n=>typeof n==='string').slice(0,100):null;details.append(make('p',`Limits: ${finite(filters.max_seconds)?filters.max_seconds+' seconds':'time unavailable'}, ${finite(filters.max_entries)?filters.max_entries.toLocaleString()+' entries':'entry limit unavailable'}, ${finite(filters.max_depth)?filters.max_depth+' folder levels':'depth unavailable'}. Excluded names: ${excluded?excluded.join(', ')||'none':'not recorded'}.`));}else details.append(make('p','The returned observation did not record a scan-policy breakdown.'));summary.append(details);
    if(o.raw.meta.scanner)details.append(make('p',`Scanner: ${o.raw.meta.scanner.engine || 'filesystem traversal'}${o.raw.meta.scanner.mft===false?' · MFT acceleration unavailable':''}. ${Array.isArray(o.raw.meta.scanner.limitations)?o.raw.meta.scanner.limitations.join(' '):''}`));
    const cats=$('visualizerCategoryFilter'),selected=cats.value;cats.replaceChildren();for(const c of ['all',...new Set(o.files.map(f=>f.category))].sort((a,b)=>a==='all'?-1:b==='all'?1:a.localeCompare(b))){const option=make('option',c==='all'?'All types':c);option.value=c;cats.append(option);}cats.value=Array.from(cats.options).some(x=>x.value===selected)?selected:'all';renderConsumers(o);expandFilterMatches();renderExplorer();}
  function filteredView(ignoreExtension=false) {
    const o=visibleObservation();if(!o)return [];
    const query=$('visualizerSearchInput').value.trim().toLowerCase(),cat=$('visualizerCategoryFilter').value,min=Number($('visualizerMinSize').value)||0,input=($('fs-extension-filter')?.value||'').trim().toLowerCase(),extension=state.extensionFilter!==null?state.extensionFilter:input?input.replace(/^\.?/,'.'):null;
    const matches=f=>(!query||(f.name+' '+(f.path||f.parentPath)).toLowerCase().includes(query))&&(ignoreExtension||extension===null||!f.aggregate&&f.extension===extension)&&(cat==='all'||f.category===cat)&&(min===0||finite(f[state.metric])&&f[state.metric]>=min);
    return window.TLIStorageMap.view(o.map,state.focus,matches,state.mapGroup,state.mapExcluded,state.metric);
  }
  function matching(){state.mapView=filteredView();return state.mapView?.rows||[];}
  function filtersActive(){return !!$('visualizerSearchInput').value.trim()||$('visualizerCategoryFilter').value!=='all'||Number($('visualizerMinSize').value)>0||state.extensionFilter!==null||!!$('fs-extension-filter')?.value.trim();}
  function expandFilterMatches(){state.filterExpanded.clear();if(!visibleObservation()||!filtersActive())return;for(const item of filteredView().rows)for(const path of item.ancestors||[])state.filterExpanded.add(path);}
  const itemKey=item=>item?.key||item?.path;
  function renderConsumers(o){
    const box=$('fs-largest-consumers');if(!box)return;box.replaceChildren();
    for(const [label,entries] of [['Largest files',o.files],['Largest folders',o.folders.filter(f=>f.path!==o.root)]]){
      const card=make('section');card.append(make('h4',label));
      for(const item of [...entries].filter(f=>finite(f[state.metric])).sort((a,b)=>b[state.metric]-a[state.metric]).slice(0,5)){
        const row=button('',()=>{if(!inspectable(o))return;if(item.isDir)drill(item.path,o);else{state.focus=o.root;state.mapGroup=null;renderExplorer();choose(item,o);}},'fs-consumer-row');
        row.append(make('span',item.name),make('strong',metricBytes(item)));row.title=item.path;card.append(row);
      }
      if(card.children.length===1)card.append(make('p','No measured entries retained.','fs-help'));box.append(card);
    }
  }
  function clearInvestigation(){state.investigationRevision++;state.investigationBusy=false;$('fs-investigation-result')?.replaceChildren();text('fs-investigation-status','');}
  async function investigate(selected=false){
    const o=visibleObservation(),item=selected?state.selected:null;if(!inspectable(o)||state.investigationBusy||selected&&(!item?.path||item.synthetic||item.aggregate||!o.index.has(item.path)))return;const epoch=state.epoch,revision=state.investigationRevision,targetPath=item?.path||null;state.investigationBusy=true;controls();
    if(selected){const section=$('fs-investigation-result')?.closest?.('details');if(section)section.open=true;}
    text('fs-investigation-status','Reviewing recorded evidence on this host…');$('fs-investigation-result').replaceChildren();
    try{
      const payload={job_id:o.job.id,question:($('fs-investigation-question').value||'').trim()};
      if(targetPath)payload.selected_path=targetPath;
      if($('fs-investigation-baseline')?.checked){payload.baseline_id=window.TLIStorageHistory?.selectedBaseline?.(o.root);if(!payload.baseline_id)throw Error('Load saved scans and select a baseline for this location in Saved scans first.');}
      const result=await api('/visualizer/investigate',payload,epoch);
      if(!inspectable(o)||revision!==state.investigationRevision||targetPath&&state.selected?.path!==targetPath)return;
      if(result.ok!==true||result.protocol!=='storage-investigation-v1'||result.local_only!==true||typeof result.reply!=='string'||result.reply.length>40000||!samePath(result.evidence?.root,o.root)||result.evidence.job_id!==o.job.id||!Array.isArray(result.recommendations)||result.recommendations.length>100)throw Error('The host did not return a verified local investigation.');
      if(targetPath&&!samePath(result.evidence.selected_path,targetPath))throw Error('The host did not confirm evidence for the selected path.');
      const box=$('fs-investigation-result');box.append(make('p',result.reply,'fs-investigation-answer'));
      if(targetPath)box.append(make('p','Selected recorded path: '+targetPath,'fs-path'));
      const evidence=make('details');evidence.append(make('summary','Evidence used'),make('p',`${o.root} · ${date(o.recordedAt)} · ${itemBytes(o.index.get(o.root))} logical · ${allocatedBytes(o.index.get(o.root))} allocated.`),make('p',visCoverage(o.raw.meta)));box.append(evidence);
      for(const recommendation of result.recommendations){
        if(!pathOK(recommendation.path)||typeof recommendation.reason!=='string'||typeof recommendation.consequence!=='string'||!['generally_safe_to_review','requires_review','protected'].includes(recommendation.classification))continue;
        const card=make('div',undefined,'fs-recommendation');card.append(make('strong',({generally_safe_to_review:'Generally safe to review',requires_review:'Requires review',protected:'Protected'})[recommendation.classification]),make('p',recommendation.path,'fs-path'),make('p',recommendation.reason),make('p',recommendation.consequence,'fs-help'));
        if(finite(recommendation.size_bytes))card.append(make('span',bytes(recommendation.size_bytes)+' observed; recovery is not guaranteed.','fs-help'));box.append(card);
      }
      text('fs-investigation-status','Local evidence review ready. No cleanup has run.');
    }catch(error){if(current(epoch)&&o===visibleObservation()&&revision===state.investigationRevision)text('fs-investigation-status',error.message+' Scan evidence remains available.');}
    finally{if(current(epoch)&&revision===state.investigationRevision){state.investigationBusy=false;controls();}}
  }
  function setupMonitor(){
    const host=$('fs-more-tools');if(!host||$('fs-monitor'))return;
    const box=make('details',undefined,'fs-monitor');box.id='fs-monitor';box.append(make('summary','Storage monitoring'),make('p','Capacity sampling is lightweight. Scheduled Quick scans use the selected, previously scanned location and keep the existing time and entry limits. Monitoring pauses when this session expires or TLI restarts.','fs-help'));
    const fields=[['sample_interval_seconds','Capacity sample interval (seconds)',60,3600,120],['warn_percent','Warn at used capacity (%)',50,98,85],['critical_percent','Critical used capacity (%)',51,99,95],['sudden_bytes','Sudden consumption threshold (bytes)',1048576,1024**5,5*1024**3],['window_hours','Growth window (hours)',1,168,12],['cooldown_hours','Notification cooldown (hours)',1,168,6],['scan_interval_hours','Scheduled Quick scan interval (hours)',6,168,24]];
    const values=make('div',undefined,'fs-filters');
    for(const [key,title,min,max,value] of fields){const label=make('label',title,'fs-field'),input=make('input');input.id='fs-monitor-'+key;input.type='number';input.min=min;input.max=max;input.value=value;label.append(input);values.append(label);}
    for(const [key,title] of [['enabled','Enable periodic capacity checks'],['schedule_enabled','Enable scheduled Quick scans of the current recorded location']]){const label=make('label',undefined,'fs-check'),input=make('input');input.id='fs-monitor-'+key;input.type='checkbox';label.append(input,make('span',title));box.append(label);}
    const message=make('p','Load monitoring settings to inspect the current configuration.','fs-status');message.id='fs-monitor-status';message.setAttribute('role','status');
    const readings=make('div');readings.id='fs-monitor-readings';let pending=false;
    const valid=settings=>settings&&typeof settings.enabled==='boolean'&&typeof settings.schedule_enabled==='boolean'&&(!settings.schedule_enabled||settings.enabled)&&fields.every(([key,,min,max])=>Number.isSafeInteger(settings[key])&&settings[key]>=min&&settings[key]<=max)&&settings.critical_percent>settings.warn_percent;
    const render=result=>{
      if(result.ok!==true||!valid(result.settings))throw Error('Monitoring settings could not be validated.');
      for(const [key] of fields)$('fs-monitor-'+key).value=result.settings[key];for(const key of ['enabled','schedule_enabled'])$('fs-monitor-'+key).checked=result.settings[key];
      readings.replaceChildren();if(typeof result.schedule_scope==='string')readings.append(make('p','Scheduled scope: '+result.schedule_scope,'fs-path'));
      if(typeof result.detail==='string')readings.append(make('p',result.detail,'fs-help'));
      for(const [mount,samples] of Object.entries(result.samples||{}).slice(0,16)){if(!Array.isArray(samples))continue;const last=samples[samples.length-1];if(last&&finite(last.free)&&finite(last.total))readings.append(make('p',`${mount} · ${bytes(last.free)} free of ${bytes(last.total)} · sampled ${date(last.at)}`,'fs-help'));}
      for(const finding of (Array.isArray(result.findings)?result.findings:[]).slice(-10)){if(typeof finding.message==='string')readings.append(make('p',finding.message));}
      text('fs-monitor-status',result.active?'Storage monitoring is active for this session.':'Storage monitoring is inactive. Save settings to enable it for this session.');
    };
    const run=async save=>{
      if(pending||state.locked||state.paused)return;const epoch=state.epoch;pending=true;load.disabled=true;apply.disabled=true;
      try{let payload;if(save){payload={};for(const [key] of fields)payload[key]=Number($('fs-monitor-'+key).value);for(const key of ['enabled','schedule_enabled'])payload[key]=$('fs-monitor-'+key).checked===true;if(!valid(payload))throw Error('Check the monitoring ranges and set the critical percentage above the warning percentage.');if(payload.schedule_enabled){const o=visibleObservation();if(!o)throw Error('Scan the selected location before scheduling it.');payload.job_id=o.job.id;}}
        const result=await api('/visualizer/monitor',payload,epoch,save?'PUT':'GET');if(current(epoch))render(result);
      }catch(error){if(current(epoch))text('fs-monitor-status',error.message+' No retry ran automatically.');}finally{pending=false;if(current(epoch)){load.disabled=false;apply.disabled=false;}}
    };
    const load=button('Load monitoring settings',()=>run(false)),apply=button('Save monitoring settings',()=>run(true),'fs-button fs-primary');load.id='fs-monitor-load';apply.id='fs-monitor-save';box.append(values,load,apply,message,readings);host.append(box);
  }
  const inspectable=(o,revision)=>!!o&&o===visibleObservation()&&!state.locked&&!state.paused&&!document.hidden&&state.tab==='explore'&&(revision===undefined||revision===state.displayRevision);
  function guardChoice(control, allowed){if(control)for(const eventName of ['change','click'])control.addEventListener(eventName,event=>{if(!control.isConnected||!allowed()){event.preventDefault();event.stopImmediatePropagation();}},true);return control;}
  function highlightSelection(){
    const key=itemKey(state.selected);
    for(const {node,item} of [...mapMarks,...tableMarks]){const active=key===itemKey(item)||!!item.members?.includes(key)||!!state.selected?.members?.includes(itemKey(item));node.classList.toggle('fs-is-selected',active);node.setAttribute(node.tagName==='BUTTON'?'aria-pressed':node.tagName==='TR'?'aria-selected':'aria-current',String(active));}
  }
  function revealSelectedRow(){
    const wrap=$('fs-table-wrap'),key=itemKey(state.selected),position=state.treeRows.findIndex(row=>row.key===key||state.selected?.members?.includes(row.key));
    if(!wrap||position<0)return;
    const top=position*TREE_ROW_HEIGHT,height=Math.max(TREE_ROW_HEIGHT,(wrap.clientHeight||528)-TREE_ROW_HEIGHT),scroll=wrap.scrollTop||0;
    // Scroll only the virtual tree. The page and map stay in place.
    if(top<scroll)wrap.scrollTop=top;else if(top+TREE_ROW_HEIGHT>scroll+height)wrap.scrollTop=top+TREE_ROW_HEIGHT-height;
    renderTreeWindow();
  }
  function choose(item,o=state.observation,revision,reveal=false){
    if(!inspectable(o,revision))return;
    if(itemKey(state.selected)!==itemKey(item))clearInvestigation();state.selected=item;state.treeActiveKey=itemKey(item);window.TLIStorageHistory?.selectPath?.(item.path&&!item.synthetic?item.path:null);
    const expanded=window.TLIStorageMap.reveal(o.map,item.members?.[0]||itemKey(item),state.expanded,state.focus);
    if(expanded.size!==state.expanded.size){state.expanded=expanded;renderExplorer();}
    $('visualizerDetailsBar').hidden=false;text('visualizerDetailsName',item.name);
    text('visualizerDetailsPath',item.path||`Grouped under ${item.parentPath||state.focus} · no individual file path`);
    const coverage=item.size_partial||o.raw.meta.partial||o.job.status!=='completed'?'Partial scan coverage; missing entries may change totals.':'Recorded scan coverage; filesystem changes since this scan are not reflected.';
    text('visualizerDetailsSize',`${itemBytes(item)}${item.hardlink_duplicate?'':' logical'} · ${allocatedBytes(item)} allocated · ${item.aggregate?'Grouped indexed bytes; not an actionable file':item.isDir?'Folder in this observation':item.category}${item.protected?' · Protected location':''}${item.hardlink_duplicate?' · Additional hard-link name; its bytes are counted once elsewhere':''} · Modified ${item.modified_at?date(item.modified_at):'unknown'} · Observed ${date(o.recordedAt)}${!item.aggregate&&Number.isSafeInteger(item.files)?' · '+item.files.toLocaleString()+' recorded file'+(item.files===1?'':'s'):''}${item.isDir?' · '+(item.children?.length||0)+' child rows retained':''}${item.omitted_entries?' · '+item.omitted_entries.toLocaleString()+' entries omitted from retained paths':''}${item.omitted_bytes?' · '+bytes(item.omitted_bytes)+' omitted-path bytes':''}${item.collapsed_entries?' · '+item.collapsed_entries.toLocaleString()+' entries grouped without individual paths':''}${item.unknown_entries?' · '+item.unknown_entries.toLocaleString()+' unknown-size entries':''} · ${coverage}${item.size_reason?' · '+item.size_reason:''}${item.reason?' · '+item.reason:''}`);
    $('visualizerCopyPathBtn').disabled=!item.path||item.synthetic;
    $('visualizerSendToFilesBtn').disabled=!item.path||item.synthetic;
    const actions=$('fs-selected-cleanup');actions.replaceChildren();
    if(item.members){actions.append(button('Show grouped entries',()=>{if(!inspectable(o))return;state.mapGroup=new Set(item.members);clearInvestigation();state.selected=null;window.TLIStorageHistory?.selectPath?.(null);$('visualizerDetailsBar').hidden=true;renderExplorer();},'fs-button fs-small'));}
    else if(item.isDir&&!item.synthetic&&item.children?.length)actions.append(button('Open recorded folder',()=>drill(item.path,o),'fs-button fs-small'));
    else if(item.actionable!==false&&!item.isDir&&!item.synthetic){const selectedRevision=state.displayRevision,choice=guardChoice(window.TLIStorageCleanup?.choice?.(item),()=>inspectable(o,selectedRevision)),input=choice?.querySelector('input');if(input?.dataset.cleanupBlocked==='false'){const label=choice.querySelector('span');if(label)label.textContent='Add to review';input.setAttribute('aria-label','Add '+item.path+' to cleanup review');}actions.append(choice||make('span','Cleanup unavailable'));}
    highlightSelection();revealSelectedRow();controls();if(reveal)$('visualizerDetailsBar').scrollIntoView?.({block:'nearest',behavior:'instant'});
  }
  function closeEntryMenu(restoreFocus=false){
    const opened=entryMenu;if(!opened)return;entryMenu=null;
    for(const input of opened.box.querySelectorAll('input'))input.disabled=true;
    opened.box.remove();
    if(restoreFocus){const target=opened.invoker?.isConnected?opened.invoker:$('fs-selected-actions');target?.focus?.({preventScroll:true});}
  }
  function hideFromView(items,o=state.observation,revision){
    if(!inspectable(o,revision))return;
    for(const item of items)for(const key of item.members||[itemKey(item)])if(o.map.byKey.has(key))state.mapExcluded.add(key);
    clearInvestigation();state.selected=null;window.TLIStorageHistory?.selectPath?.(null);$('visualizerDetailsBar').hidden=true;$('fs-selected-cleanup').replaceChildren();renderExplorer();
    status('Hidden from this view only. The saved observation and cleanup selection are unchanged.');
  }
  function restoreHidden(o,revision){
    if(!inspectable(o,revision))return;state.mapExcluded.clear();renderExplorer();status('Hidden entries shown again. No scan or file action ran.');
  }
  async function copyPath(item,o,revision){
    if(!inspectable(o,revision)||!item?.path||item.synthetic)return;
    try{await navigator.clipboard.writeText(item.path);if(inspectable(o,revision))status('Selected path copied.');}
    catch{if(inspectable(o,revision))status('Copy is unavailable. Select the displayed path to copy it manually.');}
  }
  const fileManager = () => _tliIsWindows() ? 'File Explorer' : _tliIsMac() ? 'Finder' : 'file manager';
  const revealLabel = item => item.isDir && !_tliIsMac() ? `Open folder in ${fileManager()}` : `Show in ${fileManager()}`;
  async function revealOnHost(item,o,revision){
    if(!inspectable(o,revision)||!item?.path||item.synthetic)return;
    if(revealPending){status('A request to the host file manager is already in progress.');return;}
    const pending={};revealPending=pending;
    status(`Asking ${fileManager()} on the TLI host (${o.host.name}) to show ${item.path}…`);
    try{
      const data=await api('/open_reveal',{path:item.path});
      if(data?.status!=='ok')throw Error('The host did not confirm the file-manager request.');
      if(inspectable(o,revision))status(`Requested ${fileManager()} on the TLI host (${o.host.name}) for ${item.path}.`);
    }catch(error){if(inspectable(o,revision))status(`Could not show this location on the TLI host: ${error.message}`);}
    finally{if(revealPending===pending)revealPending=null;}
  }
  function bindEntryActions(target,item,o,revision){
    const invoker=event=>target.tagName==='TR'?(event.target?.closest?.('button,input')||target.querySelector('button')):target;
    target.addEventListener('contextmenu',event=>{if(!inspectable(o,revision))return;event.preventDefault();event.stopPropagation();showEntryMenu(item,o,revision,invoker(event),event);});
    target.addEventListener('keydown',event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();event.stopPropagation();showEntryMenu(item,o,revision,invoker(event));}});
  }
  function showEntryMenu(item,o,revision,invoker,event){
    if(!inspectable(o,revision))return;
    // The popup is its own inspector. Revealing a second inspector here moves
    // the map under the pointer and triggers scroll anchoring during right-click.
    closeEntryMenu();if(itemKey(state.selected)!==itemKey(item))clearInvestigation();state.selected=item;window.TLIStorageHistory?.selectPath?.(item.path&&!item.synthetic?item.path:null);highlightSelection();controls();
    const selectedRevision=state.displayRevision,box=make('div',undefined,'fs-entry-menu');box.id='fs-entry-menu';box.setAttribute('role','dialog');box.setAttribute('aria-labelledby','fs-menu-title');
    const opened={box,invoker};entryMenu=opened;
    const valid=()=>entryMenu===opened&&inspectable(o,selectedRevision);
    const add=(label,action)=>{const control=button(label,()=>{if(!valid())return;closeEntryMenu(true);action();},'fs-menu-action');box.append(control);return control;};
    const title=make('strong',item.name);title.id='fs-menu-title';box.append(title,make('p',item.path||item.reason||'Grouped entries; no individual file path','fs-path'),make('p',`${itemBytes(item)} · ${item.aggregate?'Grouped bytes':item.isDir?'Folder':item.category}${item.protected?' · Protected location':''}`,'fs-help'));
    add('Inspect details',()=>choose(item,o,selectedRevision,true));
    if(item.members)add('Show grouped entries',()=>{state.mapGroup=new Set(item.members);clearInvestigation();state.selected=null;window.TLIStorageHistory?.selectPath?.(null);$('visualizerDetailsBar').hidden=true;renderExplorer();});
    const folder=item.isDir&&!item.synthetic?item.path:item.parentPath;
    if(item.path&&!item.synthetic){
      add(revealLabel(item),()=>revealOnHost(item,o,selectedRevision)).disabled=!!revealPending;
      box.append(make('p',`Opens on the TLI host (${o.host.name}).`,'fs-help'));
      if(o.index.get(folder)?.isDir)add(item.isDir?'Open recorded folder':'Show parent folder in map',()=>drill(folder,o));
      add('Copy path',()=>copyPath(item,o,selectedRevision));
      add('Review folder in Files',()=>reviewHandoff('files'));
    }
    if(folder&&o.index.get(folder)?.isDir)add('Prepare folder scan',()=>{prepare(folder);$('visualizerPathInput').focus();});
    if(!item.isDir)add('Hide from this view',()=>hideFromView([item],o,selectedRevision));
    if(item.actionable!==false&&!item.isDir&&!item.synthetic){
      const choice=window.TLIStorageCleanup?.choice?.(item);
      if(choice){
        // The cleanup owner keeps all selection/keeper/auth guards. Detached menu controls are inert.
        choice.addEventListener('change',e=>{if(!valid()){e.preventDefault();e.stopImmediatePropagation();}},true);
        box.append(choice);
      }
      add('Review selected files',openCleanup);
    }
    add('Close actions',()=>{});
    box.addEventListener('keydown',e=>{
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeEntryMenu(true);return;}
      const controls=[...box.querySelectorAll('button,input')].filter(n=>!n.disabled),index=controls.indexOf(document.activeElement);let next;
      if(e.key==='ArrowDown'||e.key==='Tab'&&!e.shiftKey)next=(index+1)%controls.length;
      if(e.key==='ArrowUp'||e.key==='Tab'&&e.shiftKey)next=(index+controls.length-1)%controls.length;
      if(e.key==='Home')next=0;if(e.key==='End')next=controls.length-1;
      if(next!==undefined){e.preventDefault();controls[next]?.focus();}
    });
    // Render outside contained workspace panels so fixed coordinates stay in
    // the viewport, including when the layout or theme creates a containing block.
    document.body.append(box);
    const anchor=invoker?.getBoundingClientRect?.()||{left:12,bottom:12},rect=box.getBoundingClientRect?.()||{width:280,height:400};
    const width=window.innerWidth||800,height=window.innerHeight||700;
    const x=event&&Number.isFinite(event.clientX)?event.clientX:anchor.left,y=event&&Number.isFinite(event.clientY)?event.clientY:anchor.bottom;
    box.style.left=Math.max(8,Math.min(x,width-rect.width-8))+'px';box.style.top=Math.max(8,Math.min(y,height-rect.height-8))+'px';
    box.querySelector('button')?.focus({preventScroll:true});
  }
  function drill(path,o=state.observation){
    if(!inspectable(o))return;const item=o.index.get(path);if(!item?.isDir||item.synthetic)return;
    clearInvestigation();state.focus=path;state.mapGroup=null;state.selected=null;state.treeActiveKey=null;window.TLIStorageHistory?.selectPath?.(null);renderedList=null;$('fs-table-wrap').scrollTop=0;expandFilterMatches();$('visualizerDetailsBar').hidden=true;$('fs-selected-cleanup').replaceChildren();renderExplorer();controls();$('visualizerCenterTitle').focus();
  }
  function renderBreadcrumbs(o){
    const box=$('fs-map-breadcrumbs');box.replaceChildren();const trail=[];let item=o.index.get(state.focus);
    while(item){trail.unshift(item);item=o.index.get(item.parentPath);}
    for(const folder of trail){if(box.childElementCount)box.append(make('span','/'));const b=button(folder.path===o.root?folder.path:folder.name,()=>drill(folder.path,o),'fs-button fs-small');if(folder.path===state.focus&&!state.mapGroup)b.setAttribute('aria-current','location');box.append(b);}
    if(state.mapGroup){box.append(make('span','/'),button('Grouped display subset · show all',()=>{if(!inspectable(o))return;state.mapGroup=null;clearInvestigation();state.selected=null;window.TLIStorageHistory?.selectPath?.(null);$('visualizerDetailsBar').hidden=true;renderExplorer();},'fs-button fs-small'));}
  }
  function renderMapNavigation(o,revision){
    const hidden=$('fs-map-hidden');hidden.replaceChildren();hidden.hidden=!state.mapExcluded.size;
    if(state.mapExcluded.size){hidden.append(make('span',`${bytes(state.mapView.hiddenBytes)} in ${state.mapView.hiddenCount} matching entries hidden from this view. Saved totals and cleanup selection are unchanged.`),button('Show hidden entries',()=>restoreHidden(o,revision),'fs-button fs-small'));}
    const folders=$('fs-map-folders');if(folders){folders.replaceChildren();folders.hidden=true;if(folders.parentElement?.tagName==='DETAILS'){folders.parentElement.hidden=true;folders.parentElement.open=false;}}
  }
  function setSurface(surface){if(!['list','map','types'].includes(surface))return;state.surface=surface;$('fs-map-workbench').dataset.surface=surface;for(const value of ['map','list','types'])$('fs-mobile-'+value)?.setAttribute('aria-pressed',String(surface===value));if(surface==='list')revealSelectedRow();}
  function setupWorkbench(){
    const bench=$('fs-map-workbench'),splitter=$('fs-tree-splitter');if(!bench)return;
    const ratio=value=>{state.treeRatio=Math.max(35,Math.min(75,value));bench.style.setProperty?.('--fs-tree-width',state.treeRatio+'%');splitter?.setAttribute('aria-valuenow',Math.round(state.treeRatio));splitter?.setAttribute('aria-valuetext',Math.round(state.treeRatio)+'% folder tree width');};
    try{const value=Number(window.localStorage?.getItem('tli-free-space-tree-ratio'));if(value>=35&&value<=75)state.treeRatio=value;}catch{}
    ratio(state.treeRatio);const save=()=>{try{window.localStorage?.setItem('tli-free-space-tree-ratio',String(state.treeRatio));}catch{}};
    const resize=width=>{if(!width)return;const layout=width>=1100?'split':width>=760?'stacked':'tabs';bench.dataset.layout=layout;$('fs-mobile-map-list').hidden=layout!=='tabs';splitter?.setAttribute('aria-hidden',String(layout!=='split'));if(splitter)splitter.tabIndex=layout==='split'?0:-1;renderTreeWindow();};
    resize(bench.getBoundingClientRect?.().width||window.innerWidth||1200);
    if(window.ResizeObserver){workbenchObserver=new window.ResizeObserver(entries=>resize(entries[0]?.contentRect.width));workbenchObserver.observe(bench);}
    if(!splitter)return;splitter.setAttribute('aria-valuemin','35');splitter.setAttribute('aria-valuemax','75');
    splitter.addEventListener('keydown',event=>{let value=state.treeRatio;if(event.key==='ArrowLeft')value-=2;else if(event.key==='ArrowRight')value+=2;else if(event.key==='Home')value=35;else if(event.key==='End')value=75;else return;event.preventDefault();ratio(value);save();});
    let drag=null;splitter.addEventListener('pointerdown',event=>{if(event.button!==0||bench.dataset.layout!=='split')return;const rect=bench.getBoundingClientRect?.();if(!rect?.width)return;drag={id:event.pointerId,left:rect.left,width:rect.width};splitter.setPointerCapture?.(event.pointerId);event.preventDefault();});
    splitter.addEventListener('pointermove',event=>{if(drag?.id!==event.pointerId)return;ratio((event.clientX-drag.left)/drag.width*100);});
    const finish=event=>{if(drag?.id!==event.pointerId)return;splitter.releasePointerCapture?.(event.pointerId);drag=null;save();};splitter.addEventListener('pointerup',finish);splitter.addEventListener('pointercancel',finish);
  }
  function toggleTree(row,o=visibleObservation()){
    if(!inspectable(o)||!row.hasChildren)return;
    if(row.expanded){state.expanded.delete(row.key);state.filterExpanded.delete(row.key);}else state.expanded.add(row.key);
    state.treeActiveKey=row.key;renderExplorer();tableMarks.find(mark=>itemKey(mark.item)===row.key)?.node.focus?.({preventScroll:true});
  }
  function focusTreeRow(position){
    const row=state.treeRows[Math.max(0,Math.min(position,state.treeRows.length-1))];if(!row)return;
    choose(row.item);state.treeActiveKey=row.key;renderTreeWindow();tableMarks.find(mark=>itemKey(mark.item)===row.key)?.node.focus?.({preventScroll:true});
  }
  function treeKey(event,row,o){
    if(!inspectable(o)||event.target?.tagName==='INPUT')return;
    const position=state.treeRows.findIndex(item=>item.key===row.key);let next=null;
    if(event.key==='ArrowDown')next=position+1;else if(event.key==='ArrowUp')next=position-1;else if(event.key==='Home')next=0;else if(event.key==='End')next=state.treeRows.length-1;
    else if(event.key==='ArrowRight'){if(row.hasChildren&&!row.expanded){event.preventDefault();toggleTree(row,o);return;}if(row.hasChildren)next=position+1;}
    else if(event.key==='ArrowLeft'){if(row.hasChildren&&row.expanded){event.preventDefault();toggleTree(row,o);return;}next=state.treeRows.findIndex(item=>item.key===row.parentKey);}
    else if((event.key==='Enter'||event.key===' ')&&event.target?.tagName==='TR'){event.preventDefault();if(event.key==='Enter'&&row.item.isDir&&!row.item.synthetic)drill(row.item.path,o);else choose(row.item,o);return;}
    if(next!==null&&next>=0){event.preventDefault();focusTreeRow(next);}
  }
  function renderTreeWindow(){
    const o=visibleObservation();if(!inspectable(o))return;const revision=state.displayRevision,rows=state.treeRows,wrap=$('fs-table-wrap'),body=$('visualizerTableBody');
    const maxScroll=Math.max(0,rows.length*TREE_ROW_HEIGHT-Math.max(TREE_ROW_HEIGHT,(wrap.clientHeight||528)-TREE_ROW_HEIGHT));
    if((wrap.scrollTop||0)>maxScroll)wrap.scrollTop=maxScroll;
    const start=Math.max(0,Math.floor((wrap.scrollTop||0)/TREE_ROW_HEIGHT)-TREE_OVERSCAN),end=Math.min(rows.length,start+Math.ceil((wrap.clientHeight||528)/TREE_ROW_HEIGHT)+TREE_OVERSCAN*2);
    const active=document.activeElement,focused=tableMarks.find(mark=>mark.node.contains(active)),focusIndex=focused?rows.findIndex(row=>row.key===itemKey(focused.item)):-1,controlIndex=focused?Array.from(focused.node.querySelectorAll('button,input')).indexOf(active):-1;
    const key=JSON.stringify([revision,start,end,state.treeActiveKey,itemKey(state.selected),focusIndex]);if(renderedList?.observation===o&&renderedList.key===key)return;
    const reusable=new Map(tableMarks.filter(mark=>mark.revision===revision).map(mark=>[itemKey(mark.item),mark]));
    body.replaceChildren();tableMarks=[];
    const spacer=height=>{if(!height)return;const tr=make('tr',undefined,'fs-tree-spacer'),td=make('td');tr.setAttribute('aria-hidden','true');td.colSpan=8;td.style.height=height+'px';td.style.padding='0';td.style.border='0';tr.append(td);body.append(tr);};
    const positions=Array.from({length:end-start},(_,i)=>start+i);if(focusIndex>=0&&!positions.includes(focusIndex))positions.push(focusIndex);positions.sort((a,b)=>a-b);let cursor=0;
    for(const index of positions){
      spacer((index-cursor)*TREE_ROW_HEIGHT);cursor=index+1;
      const prior=reusable.get(rows[index].key);if(prior){prior.node.tabIndex=(state.treeActiveKey||rows[0]?.key)===rows[index].key?0:-1;body.append(prior.node);tableMarks.push(prior);continue;}
      const row=rows[index],item=row.item,tr=make('tr',undefined,'fs-tree-row'),name=make('td',undefined,'fs-tree-name');tr.dataset.treeKey=row.key;tr.setAttribute('role','row');tr.setAttribute('aria-level',row.depth+1);tr.setAttribute('aria-rowindex',index+2);tr.setAttribute('aria-selected',String(itemKey(state.selected)===row.key));if(row.hasChildren)tr.setAttribute('aria-expanded',String(row.expanded));tr.tabIndex=(state.treeActiveKey||rows[0]?.key)===row.key?0:-1;name.style.paddingLeft=(row.depth*16+8)+'px';name.style.setProperty?.('--fs-tree-depth',String(row.depth));
      if(row.hasChildren){const toggle=button(row.expanded?'▾':'▸',()=>{if(inspectable(o,revision))toggleTree(row,o);},'fs-tree-toggle');toggle.setAttribute('aria-label',(row.expanded?'Collapse ':'Expand ')+item.name);toggle.setAttribute('aria-expanded',String(row.expanded));toggle.tabIndex=-1;name.append(toggle);}
      const action=button(item.name,()=>{if(inspectable(o,revision))choose(item,o,revision);},'fs-file-name storage-file-action');action.title=item.path||item.name;action.tabIndex=-1;name.append(action,make('small',item.path||`Grouped under ${item.parentPath} · no individual path`,'fs-path'));
      if(item.isDir&&!item.synthetic)action.addEventListener('dblclick',()=>{if(inspectable(o,revision))drill(item.path,o);});
      const review=make('td');
      if(item.actionable!==false&&!item.isDir&&!item.synthetic)review.append(guardChoice(window.TLIStorageCleanup?.choice?.(item),()=>inspectable(o,revision))||make('span','Cleanup unavailable'));
      else review.append(make('span',item.hardlink_duplicate?'Hard-link alias · cleanup unavailable':item.aggregate?'Grouped · review only':item.isDir?'Recorded folder':item.size===null?'Size unknown':'No file action','fs-help'));
      const more=button('Actions',()=>showEntryMenu(item,o,revision,more),'fs-button fs-small fs-entry-actions');more.setAttribute('aria-label','Actions for '+item.name);more.setAttribute('aria-haspopup','dialog');review.append(more);bindEntryActions(tr,item,o,revision);tr.addEventListener('keydown',event=>treeKey(event,row,o));
      const parent=o.index.get(item.parentPath),parentBytes=parent?.[state.metric],percentValue=finite(item[state.metric])&&finite(parentBytes)&&parentBytes>0?item[state.metric]/parentBytes*100:null,percent=percentValue!==null?percentValue.toLocaleString(undefined,{maximumFractionDigits:2})+'%':'—',share=make('td',percent,'fs-parent-share');if(percentValue!==null)share.style.setProperty?.('--fs-parent-percent',Math.max(0,Math.min(100,percentValue))+'%');
      tr.append(name,make('td',item.aggregate?'Grouped':item.category),make('td',itemBytes(item)),make('td',allocatedBytes(item)),share,make('td',!item.aggregate&&Number.isSafeInteger(item.files)?item.files.toLocaleString():'—'),make('td',item.modified_at?date(item.modified_at):'Unknown'),review);body.append(tr);tableMarks.push({node:tr,item,revision});
    }
    spacer((rows.length-cursor)*TREE_ROW_HEIGHT);
    if(!rows.length){const tr=make('tr'),td=make('td',o.map.atoms.length?'No entries match these display filters. Change a filter or return to the scanned root.':'No indexed entries were retained. Check coverage before treating the folder as empty.');td.colSpan=8;tr.append(td);body.append(tr);}
    const table=$('fs-tree-table')||wrap.querySelector('table');table?.setAttribute('role','treegrid');table?.setAttribute('aria-rowcount',rows.length+1);table?.setAttribute('aria-colcount',8);
    renderedList={observation:o,key};highlightSelection();updateCleanup();
    if(focused){const restored=tableMarks.find(mark=>itemKey(mark.item)===itemKey(focused.item));(controlIndex>=0?restored?.node.querySelectorAll('button,input')[controlIndex]:restored?.node)?.focus?.({preventScroll:true});}
  }
  function renderExplorer(){
    closeEntryMenu();const o=visibleObservation();if(!o)return;state.displayRevision=(state.displayRevision||0)+1;const revision=state.displayRevision;
    for(const th of document.querySelectorAll('#panel-visualizer th[data-sort]'))th.setAttribute('aria-sort',th.dataset.sort===state.sort?(state.direction===1?'ascending':'descending'):'none');
    const rows=matching();state.treeRows=window.TLIStorageMap.tree(state.mapView,{expanded:new Set([...state.expanded,...state.filterExpanded]),sort:state.sort,direction:state.direction}).rows;if(!state.treeRows.some(row=>row.key===state.treeActiveKey))state.treeActiveKey=state.treeRows[0]?.key||null;
    renderMapNavigation(o,revision);
    text('visualizerCenterSubtitle',state.focus);$('visualizerBackBtn').disabled=samePath(state.focus,o.root);renderBreadcrumbs(o);
    text('visualizerStatusLine',`${rows.length.toLocaleString()} retained entries${filtersActive()?' matching filters':''} · display navigation reads only this scan`);
    text('fs-tree-summary',`${state.treeRows.length.toLocaleString()} visible tree rows · ${rows.filter(item=>!item.isDir&&!item.aggregate).length.toLocaleString()} retained file paths${filtersActive()?' matching filters; folder totals retain their full recorded size':''}`);
    for(const id of ['fs-map-workbench','fs-map-list-panel','fs-table-wrap','vis4-treemap-container','visualizerTypeBars'])$(id).hidden=false;
    $('fs-map-workbench').classList.remove('fs-list-only','fs-map-expanded');if($('fs-paging'))$('fs-paging').hidden=true;
    renderTreeWindow();
    mapObserver?.disconnect();mapObserver=null;
    renderMap(state.mapView,o,revision);renderTypes(filteredView(true));setSurface(state.surface);highlightSelection();updateCleanup();
  }
  function renderMap(view,o,revision){
    closeEntryMenu();const box=$('vis4-treemap-container');box.replaceChildren();mapMarks=[];
    const representation=window.TLIStorageMap.hierarchy(view);
    const header=make('div',undefined,'fs-map-heading');header.append(make('strong','Space map'),make('span',`${bytes(view.total)} ${state.metric==='allocated_size'?'known allocated':'logical'} bytes`,'fs-map-total'));box.append(header);
    box.append(make('p','Larger blocks use more space. Right-click a file or folder for actions.','fs-help'));
    const areaDetails=make('details',undefined,'fs-map-accounting');areaDetails.append(make('summary','About this map'),make('p',`${bytes(view.scopeTotal)} known indexed bytes in this recorded folder scope. The map uses ${bytes(view.total)} matching known bytes; display filters do not change saved totals. Folder and child bytes are never added twice. Unknown sizes are excluded from area, not treated as empty.`));
    if(view.aggregateBytes){const note=make('div',undefined,'fs-map-coverage');note.append(make('span',`${bytes(view.aggregateBytes)} is grouped because individual file paths were not saved.`, 'fs-help'),button('Hide grouped bytes',()=>hideFromView(view.rows.filter(n=>n.aggregate),o,revision),'fs-button fs-small'));areaDetails.append(note);}
    areaDetails.append(make('p',`${view.unknown} retained unknown-size${view.groupedUnknown?' · '+view.groupedUnknown+' additional unknown sizes inside groups':''} · ${view.zero} zero-byte entries outside map. Recorded bytes, not drive capacity.`));
    if(representation.groupedCount)areaDetails.append(make('p',`${representation.groupedCount.toLocaleString()} entries are combined in “Other mapped entries” to bound drawing. Select that group to inspect its retained entries. All indexed bytes remain in the denominator.`));
    if(!view.total){box.append(make('p','No positive known sizes match. Show hidden entries or change the filters to see more. The linked list retains matching zero and unknown-size entries.'),areaDetails);return;}
    if(!window.d3?.treemap){box.append(make('p','The map library is unavailable. The linked list retains every recorded entry and size.'));return;}
    const canvas=make('div',undefined,'fs-map-canvas');canvas.setAttribute('role','group');canvas.setAttribute('aria-label','Recorded file bytes by folder and file type; small tiles are available in the linked list');box.append(canvas);
    const colors=new Set(), width=Math.max(1,Math.round(canvas.getBoundingClientRect?.().width||box.getBoundingClientRect?.().width||600)), height=canvas.getBoundingClientRect?.().height||480;
    const layout=window.TLIStorageMap.layout(window.d3,representation,width,height);
    for(const leaf of layout.leaves()){
      const item=leaf.data.item,w=leaf.x1-leaf.x0,h=leaf.y1-leaf.y0,large=w>=36&&h>=28;
      const category=item.aggregate?'Grouped':item.category,key=String(category).toLowerCase().replace(/[^a-z]/g,'');colors.add(category);
      const mark=large?button('',event=>choose(item,o,revision,event.detail===0),'fs-map-item'):make('div',undefined,'fs-map-item fs-map-tiny');
      mark.classList.add('fs-map-type-'+key);mark.dataset.mapKey=itemKey(item);
      if(large)mark.setAttribute('aria-label',`${item.name} · ${metricBytes(item)} · ${item.path||'non-actionable grouped entries'}`);else mark.setAttribute('aria-hidden','true');
      mark.title=`${item.name}\n${itemBytes(item)}${item.hardlink_duplicate?'':' logical'} · ${allocatedBytes(item)} allocated · ${category}\n${item.path||item.reason}`;bindEntryActions(mark,item,o,revision);
      if(!large)mark.addEventListener('click',()=>choose(item,o,revision));
      if(!item.aggregate&&o.index.get(item.parentPath)?.isDir)mark.addEventListener('dblclick',()=>{if(inspectable(o,revision))drill(item.parentPath,o);});
      Object.assign(mark.style,{left:leaf.x0/width*100+'%',top:leaf.y0/height*100+'%',width:w/width*100+'%',height:h/height*100+'%'});
      if(w>=80&&h>=54){const label=make('span',undefined,'fs-map-tile-label');label.append(make('span',item.name),make('small',`${bytes(leaf.value)} · ${(leaf.value/view.total*100).toLocaleString(undefined,{maximumFractionDigits:1})}%`));if(w>=140&&h>=110)label.append(make('small',item.members?'Retained entries grouped for display':item.aggregate?'Paths not retained':`${category}${item.protected?' · Protected':''}`,'fs-map-tile-type'));mark.append(label);}
      canvas.append(mark);mapMarks.push({node:mark,item});
    }
    for(const folder of layout.descendants().filter(n=>n.depth===1&&n.children)){
      const w=folder.x1-folder.x0,h=folder.y1-folder.y0,frame=make('div',undefined,'fs-map-folder-boundary');frame.setAttribute('aria-hidden','true');Object.assign(frame.style,{left:folder.x0/width*100+'%',top:folder.y0/height*100+'%',width:w/width*100+'%',height:h/height*100+'%'});canvas.append(frame);
      if(w>=100&&h>=90){const b=button(folder.data.name,()=>{if(inspectable(o,revision))choose(o.index.get(folder.data.path),o,revision);},'fs-map-folder-label');b.setAttribute('aria-label',`Select recorded folder ${folder.data.path} · ${bytes(folder.value)} in this map region`);b.addEventListener('dblclick',()=>{if(inspectable(o,revision))drill(folder.data.path,o);});Object.assign(b.style,{left:folder.x0/width*100+'%',top:folder.y1/height*100+'%',maxWidth:w/width*100+'%'});bindEntryActions(b,o.index.get(folder.data.path),o,revision);canvas.append(b);}
    }
    const legend=make('div',undefined,'fs-map-legend');legend.setAttribute('aria-label','File type colors');
    for(const category of [...colors].sort()){const item=make('span'),swatch=make('i',undefined,'fs-map-swatch fs-map-type-'+category.toLowerCase().replace(/[^a-z]/g,''));swatch.setAttribute('aria-hidden','true');item.append(swatch,make('span',category));legend.append(item);}areaDetails.append(make('p','Double-click a file to focus on its recorded folder. Use Actions in the list for small tiles, touch or keyboard. Colors describe file types, not cleanup safety.'));box.append(legend,areaDetails);
    highlightSelection();
    if(window.ResizeObserver){mapObserver?.disconnect();let measured=width;mapObserver=new window.ResizeObserver(entries=>{const next=Math.round(entries[0]?.contentRect.width||0);if(next>0&&Math.abs(next-measured)>2&&inspectable(o,revision)&&state.mode==='map'){measured=next;mapObserver.disconnect();renderMap(view,o,revision);}});mapObserver.observe(canvas);}
  }

  function renderTypes(view){
    const box=$('visualizerTypeBars'),o=visibleObservation(),revision=state.displayRevision,distribution=window.TLIStorageMap.types(view,{sort:state.metric,direction:-1});box.replaceChildren();box.append(make('h4','Extensions'),make('p',`${distribution.retainedFiles.toLocaleString()} retained file paths · ${bytes(distribution.total)} known ${state.metric==='size'?'logical':'allocated'} bytes. Extension selection filters the tree and map; this distribution remains visible. Counts exclude paths not retained in the scan.`,'fs-help'));
    const input=($('fs-extension-filter')?.value||'').trim().toLowerCase(),active=state.extensionFilter!==null?state.extensionFilter:input?input.replace(/^\.?/,'.'):null;
    if(active!==null)box.append(button('Clear extension filter',()=>{if(!inspectable(o,revision))return;state.extensionFilter=null;$('fs-extension-filter').value='';expandFilterMatches();$('fs-table-wrap').scrollTop=0;renderExplorer();},'fs-button fs-small'));
    const pageSize=80,maxPage=Math.max(0,Math.ceil(distribution.rows.length/pageSize)-1);state.typePage=Math.min(state.typePage,maxPage);
    for(const entry of distribution.rows.slice(state.typePage*pageSize,(state.typePage+1)*pageSize)){
      const select=()=>{if(!inspectable(o,revision))return;state.extensionFilter=active===entry.extension?null:entry.extension;$('fs-extension-filter').value=state.extensionFilter||'';expandFilterMatches();$('fs-table-wrap').scrollTop=0;renderExplorer();};
      const row=entry.extension===null?make('div',undefined,'fs-extension-row'):button('',select,'fs-extension-row');
      if(entry.extension!==null){row.dataset.extension=entry.extension;row.setAttribute('aria-pressed',String(active===entry.extension));}
      row.append(make('strong',entry.name),make('span',`${bytes(entry.total)}${entry.unknown?' known':''} · ${entry.extension===null?'individual file count unavailable':entry.files.toLocaleString()+' retained file paths'}${entry.unknown?' · '+entry.unknown+' unknown sizes':''}${entry.hardlinkAliases?' · '+entry.hardlinkAliases+' hard-link aliases (counted elsewhere)':''}`));
      const meter=make('span',undefined,'fs-meter'),fill=make('span');fill.style.width=(distribution.total?entry.total/distribution.total*100:0)+'%';meter.append(fill);row.append(meter);box.append(row);
    }
    if(distribution.rows.length>pageSize){const navigation=make('div',undefined,'fs-actions'),previous=button('Previous extensions',()=>{if(!inspectable(o,revision))return;state.typePage--;renderTypes(view);}),next=button('Next extensions',()=>{if(!inspectable(o,revision))return;state.typePage++;renderTypes(view);});previous.disabled=state.typePage===0;next.disabled=state.typePage>=maxPage;navigation.append(previous,make('span',`${state.typePage*pageSize+1}–${Math.min((state.typePage+1)*pageSize,distribution.rows.length)} of ${distribution.rows.length} extension groups`,'fs-help'),next);box.append(navigation);}
    if(!distribution.rows.length)box.append(make('p','No retained entries match the other display filters.'));
  }
  function renderTool(operation){
    const o=state.tools[operation],box=$('fs-'+operation+'-results');box.replaceChildren();
    if(!matchesLocation(o)){text('fs-'+operation+'-status',operation==='common_folders'?'Check common folders across the TLI host.':selectedPath()?`No results for ${selectedPath()}. Start ${operation==='large_files'?'a large-file search':'a duplicate check'} for this location.`:'Choose a drive or folder first.');return;}
    const data=o.raw,allowed=()=>state.tools[operation]===o&&matchesLocation(o)&&!state.locked&&!state.paused&&!document.hidden;
    text('fs-'+operation+'-status',`${operation==='common_folders'?'Common folders across the TLI host':o.root} · ${date(o.recordedAt)}`);
    const coverage=make('details',undefined,'fs-policy');coverage.append(make('summary','Scan details'));
    if(operation==='large_files'){
      coverage.append(make('p',visCoverage(data.meta)));box.append(make('p',`${data.files.length} files returned${finite(data.meta.found)?' of '+data.meta.found+' matches found':''}. ${finite(o.job.min_mb)?'Minimum '+o.job.min_mb+' MiB.':''}`),coverage);
      let count=0;const show=()=>{if(!allowed())return;const end=Math.min(count+PAGE_SIZE,data.files.length);for(;count<end;count++){const f=data.files[count],row=make('div',undefined,'fs-tool-row');row.append(make('strong',f.name),make('p',f.path,'fs-path'),make('span',itemBytes(f)),f.hardlink_duplicate?make('span','Hard-link alias · cleanup unavailable'):guardChoice(window.TLIStorageCleanup?.choice?.({...f,isDir:false}),allowed)||make('span','Cleanup unavailable'),button('Select parent folder',()=>{if(allowed()&&row.isConnected)prepare(getParentFolderPath(f.path));}));box.append(row);}more.hidden=count>=data.files.length;};
      const more=button('Show more files',()=>{if(more.isConnected)show();});show();box.append(more);if(!data.files.length)box.append(make('p','No matching files returned. Partial coverage does not establish that none exist.'));
    }else if(operation==='duplicates'){
      coverage.append(make('p',visDuplicateCoverage(data.meta)));box.append(make('p',`${data.groups.length} groups returned${finite(data.meta.groups_found)?' of '+data.meta.groups_found+' found':''}.`),coverage);
      for(const group of data.groups){const details=make('details',undefined,'fs-dupe');details.append(make('summary',`${group.paths.length} copies · ${bytes(group.size)} each · ${bytes(group.wasted_bytes)} in extra copies`));let mounted=false;details.addEventListener('toggle',()=>{if(!details.open||mounted||!details.isConnected||!allowed())return;mounted=true;if(data.meta.verification==='full_sha256'&&window.TLIStorageCleanup?.duplicateControls)details.append(guardChoice(window.TLIStorageCleanup.duplicateControls(group),allowed));else{for(const path of group.paths.slice(0,100))details.append(make('p',path,'fs-path'));if(group.paths.length>100)details.append(make('p','Only the first 100 unverified paths are displayed. No cleanup selection is available without full-content verification.'));}});box.append(details);}if(!data.groups.length)box.append(make('p','No duplicate groups returned from the files checked.'));
    }else{for(const target of data.targets){const row=make('div',undefined,'fs-tool-row');row.append(make('strong',target.label),make('p',target.path,'fs-path'),make('span',target.size_partial?'At least '+bytes(target.size_bytes):bytes(target.size_bytes)),make('p',visCleanupCoverage(target),'fs-help'),button('Select this folder',()=>{if(allowed()&&row.isConnected)prepare(target.path);}));box.append(row);}if(!data.targets.length)box.append(make('p','No supported common folders were returned. You can still scan a selected location.'));}updateCleanup();
  }
  function openCleanup(){if(window.TLIStorageCleanup?.openReview){window.TLIStorageCleanup.openReview();return true;}const box=$('storage-cleanup-review');if(!box)return false;box.open=true;box.scrollIntoView({block:'nearest'});box.querySelector('summary').focus();return true;}
  function updateCleanup(){const summary=$('storage-cleanup-review')?.querySelector('summary');if(summary)summary.textContent='Cleanup review · '+($('cleanup-count')?.textContent||'no files selected');}
  function closeHandoff(){state.handoff=null;$('fs-handoff')?.close();text('fs-handoff-text','');text('fs-handoff-status','');}
  function reviewHandoff(kind){const o=visibleObservation(),item=state.selected;if(!inspectable(o)||(kind==='files'&&!item))return;const content=kind==='files'?(item.isDir?item.path:getParentFolderPath(item.path)):`Recorded storage observation on ${o.host.name}, ${date(o.recordedAt)}. Root: ${o.root}. Inspected file bytes: ${itemBytes(o.index.get(o.root))}. ${visCoverage(o.raw.meta)}\nLargest recorded files:\n${[...o.files].sort((a,b)=>(b.size||0)-(a.size||0)).slice(0,5).map(f=>`${f.path} — ${itemBytes(f)}`).join('\n')}\nPlease help me interpret this historical scan and suggest what I should review. Do not assume any file is safe to delete or that disk space has been freed.`;
    state.handoff={kind,content,epoch:state.epoch,hostId:o.host.id,candidatePaths:kind==='files'&&!item.isDir&&item.actionable!==false&&!item.synthetic?[item.path]:[],observation:{id:o.job.id,recordedAt:o.recordedAt,coverage:visCoverage(o.raw.meta)}};text('fs-handoff-title',kind==='files'?'Review this folder in Files':'Review the scan summary for Chat');text('fs-handoff-text',content);text('fs-handoff-help',kind==='files'?'Prepare this folder in Organize. A selected file is offered for your plan after its folder is scanned. Existing drafts are preserved until you choose a replacement. No scan, plan or move runs here.':'This prepares plain reference text in an empty Chat draft. It does not send a message, attach a verified report or change any existing context.');text('fs-handoff-confirm',kind==='files'?'Open Files with this location':'Use in an empty Chat draft');text('fs-handoff-status','');$('fs-handoff').showModal();}
  function confirmHandoff(){const h=state.handoff;if(!h||!current(h.epoch))return;if(h.kind==='files'){if(window.TLIStorageWorkspace?.prepare){const result=window.TLIStorageWorkspace.prepare({view:'organize',root:h.content,hostId:h.hostId,candidatePaths:h.candidatePaths,observation:h.observation,source:'space'});if(result.status==='unavailable'){text('fs-handoff-status','The folder could not be prepared. Finish active file work or verify the connected host.');return;}closeHandoff();return;}const input=$('filesRootInput');if(!input){text('fs-handoff-status','Files is unavailable.');return;}if(input.value.trim()&&!samePath(input.value.trim(),h.content)){text('fs-handoff-status','Files already has a different folder draft. It was preserved. Copy this path and review the existing Files draft first.');return;}input.value=h.content;input.dispatchEvent(new Event('input',{bubbles:true}));closeHandoff();if(typeof switchPanel==='function')switchPanel('panel-files');input.focus();}
    else {const input=$('chat-input');const context=[window.TLIIntelligence,window.TLIDocuments,window.TLINotebook,window.TLICaseContext].flatMap(m=>m?.describeContext?.()||[]);if(!input||input.value.trim()||$('chat-send-btn')?.disabled||context.length){text('fs-handoff-status','Chat has a draft, an active reply or selected context. Those are preserved. Finish or clear them explicitly in Chat before using this summary.');return;}input.value=h.content;input.dispatchEvent(new Event('input',{bubbles:true}));closeHandoff();if(typeof switchPanel==='function')switchPanel('panel-main');input.focus();}}
  function clearPrivate(){state.expanded.clear();state.filterExpanded.clear();state.treeRows=[];state.treeActiveKey=null;state.extensionFilter=null;state.typePage=0;window.TLIStorageHistory?.selectPath?.(null);text('fs-tree-summary','');if($('fs-table-wrap'))$('fs-table-wrap').scrollTop=0;$('fs-monitor-readings')?.replaceChildren();text('fs-monitor-status','Monitoring details cleared. Load settings after unlocking.');for(const key of ['enabled','schedule_enabled'])if($('fs-monitor-'+key))$('fs-monitor-'+key).checked=false;clearInvestigation();text('fs-investigation-question','');if($('fs-investigation-question'))$('fs-investigation-question').value='';renderedList=null;closeEntryMenu();state.mapExcluded.clear();mapObserver?.disconnect();mapObserver=null;mapMarks=[];tableMarks=[];state.mapView=null;state.mapGroup=null;state.epoch++;clearTimeout(state.timer);for(const a of state.requests)a.abort();state.requests.clear();state.job=null;state.pendingStart=null;state.busy=false;state.driveBusy=false;state.drives=[];state.drivesLoaded=false;state.observation=null;state.tools={};state.selected=null;state.focus='';window.visualizerV4=null;if(!state.initialized)return;closeHandoff();for(const id of ['fs-largest-consumers','fs-map-breadcrumbs','fs-map-hidden','fs-map-folders','fs-selected-cleanup','vis4-drives','vis4-summary','visualizerTableBody','visualizerTypeBars','vis4-treemap-container','visualizerDetailsPath','visualizerDetailsName','visualizerDetailsSize','fs-large_files-results','fs-duplicates-results','fs-common_folders-results','visualizerPathSuggestions','fs-job-title','fs-job-progress','visualizerCenterSubtitle'])$(id)?.replaceChildren();for(const id of ['visualizerPathInput','visualizerSearchInput','fs-extension-filter','fs-drive-search'])$(id).value='';$('visualizerDetailsBar').hidden=true;$('fs-drives-refresh').disabled=false;for(const op of operations.slice(1))text('fs-'+op+'-status','No observation loaded.');text('fs-drives-status','Refresh to read drive capacity.');status('Private observations cleared. Watching stopped; any host scan may continue within its limits. No cleanup or retry ran.');locationChanged();renderObservation();controls();}
  function setup(){if(state.initialized||!$('panel-visualizer'))return;state.initialized=true;
    $('fs-more-tools')?.addEventListener('toggle',()=>{if(!$('fs-more-tools').open&&state.tab!=='explore')setTab('explore');});
    $('visualizerScanBtn').addEventListener('click',()=>start('scan'));$('visualizerPathInput').addEventListener('input',locationChanged);$('fs-drives-refresh').addEventListener('click',()=>drives(true));$('fs-drive-search').addEventListener('input',renderDrives);$('fs-drive-sort').addEventListener('change',renderDrives);
    for(const b of document.querySelectorAll('[data-vis-preset]'))b.addEventListener('click',()=>{const path=window.TLI_PATHS?.common?.[b.dataset.visPreset]||(b.dataset.visPreset==='home'?window.TLI_PATHS?.home:null);if(path)prepare(path);else status('The host has not supplied this folder path. Enter its absolute path or refresh TLI.');});
    for(const b of document.querySelectorAll('[data-fs-tab]')){b.addEventListener('click',()=>setTab(b.dataset.fsTab,b.dataset.fsTab==='explore'));b.addEventListener('keydown',e=>{const tabs=[...document.querySelectorAll('[data-fs-tab]')],i=tabs.indexOf(b);let next;if(e.key==='ArrowRight')next=(i+1)%tabs.length;if(e.key==='ArrowLeft')next=(i+tabs.length-1)%tabs.length;if(e.key==='Home')next=0;if(e.key==='End')next=tabs.length-1;if(next!==undefined){e.preventDefault();setTab(tabs[next].dataset.fsTab);tabs[next].focus();}});}
    $('fs-profile').addEventListener('change',()=>{const deep=$('fs-profile').value==='deep';$('fs-include-excluded').disabled=!deep;if(!deep)$('fs-include-excluded').checked=false;});
    for(const op of operations.slice(1))$('fs-start-'+op).addEventListener('click',()=>start(op));$('fs-job-stop').addEventListener('click',stop);$('fs-job-check').addEventListener('click',async()=>{if(state.pendingStart)return submitStart();if(state.job?.status==='cancelled'&&state.job.result_available){if(state.busy)return;const epoch=state.epoch;state.busy=true;controls();try{await finish(state.job,epoch,true);}catch(e){if(current(epoch))status(e.message+' The previous observation is retained.');}finally{if(current(epoch)){state.busy=false;controls();}}return;}return poll();});
    for(const value of ['map','list','types'])$('fs-mobile-'+value)?.addEventListener('click',()=>setSurface(value));
    for(const id of ['visualizerSearchInput','visualizerCategoryFilter','visualizerMinSize','fs-extension-filter'])$(id)?.addEventListener(['visualizerSearchInput','fs-extension-filter'].includes(id)?'input':'change',()=>{if(id==='fs-extension-filter')state.extensionFilter=null;expandFilterMatches();$('fs-table-wrap').scrollTop=0;renderExplorer();});
    $('fs-size-metric')?.addEventListener('change',()=>{state.metric=$('fs-size-metric').value==='allocated_size'?'allocated_size':'size';state.sort=state.metric;state.direction=-1;if(visibleObservation())renderConsumers(state.observation);expandFilterMatches();renderExplorer();});
    $('fs-investigate')?.addEventListener('click',()=>investigate());$('fs-selected-explain')?.addEventListener('click',()=>investigate(true));
    for(const th of document.querySelectorAll('#panel-visualizer th[data-sort]'))th.querySelector('button').addEventListener('click',()=>{state.direction=state.sort===th.dataset.sort?-state.direction:['size','allocated_size','files','modified_at'].includes(th.dataset.sort)?-1:1;state.sort=th.dataset.sort;for(const t of document.querySelectorAll('#panel-visualizer th[data-sort]'))t.setAttribute('aria-sort',t===th?(state.direction===1?'ascending':'descending'):'none');renderExplorer();});
    $('fs-table-wrap').addEventListener('scroll',renderTreeWindow,{passive:true});
    $('fs-tree-collapse')?.addEventListener('click',()=>{state.expanded.clear();state.filterExpanded.clear();$('fs-table-wrap').scrollTop=0;renderExplorer();});
    $('fs-tree-expand')?.addEventListener('click',()=>{const o=visibleObservation();if(!inspectable(o))return;for(const item of o.folders)state.expanded.add(item.path);renderExplorer();});
    $('fs-show-changes')?.addEventListener('click',()=>{window.TLIStorageHistory?.selectPath?.(state.selected?.path&&!state.selected.synthetic?state.selected.path:null);setTab('history');$('storage-history')?.scrollIntoView?.({block:'nearest'});});
    $('fs-show-tools')?.addEventListener('click',()=>{$('fs-more-tools').open=true;$('fs-more-tools').scrollIntoView?.({block:'nearest'});});
    $('fs-show-monitor')?.addEventListener('click',()=>{$('fs-more-tools').open=true;if($('fs-monitor')){$('fs-monitor').open=true;$('fs-monitor').scrollIntoView?.({block:'nearest'});}});
    $('visualizerBackBtn').addEventListener('click',()=>drill(getParentFolderPath(state.focus)));
    $('visualizerCopyPathBtn').addEventListener('click',()=>copyPath(state.selected,state.observation,state.displayRevision));
    $('fs-selected-actions').addEventListener('click',()=>{if(state.selected)showEntryMenu(state.selected,state.observation,state.displayRevision,$('fs-selected-actions'));});
    $('fs-selected-reveal')?.addEventListener('click',()=>revealOnHost(state.selected,state.observation,state.displayRevision));
    document.addEventListener('pointerdown',e=>{if(entryMenu&&!entryMenu.box.contains(e.target))closeEntryMenu();});
    window.addEventListener('resize',()=>closeEntryMenu());
    // Dismiss for deliberate background scrolling, not delayed scroll anchoring
    // from focusing a control. Scrollbar/touch interactions also hit pointerdown.
    document.addEventListener('wheel',e=>{if(entryMenu&&!entryMenu.box.contains(e.target))closeEntryMenu();},{capture:true,passive:true});
    $('visualizerSendToFilesBtn').addEventListener('click',()=>reviewHandoff('files'));$('fs-ask-chat').addEventListener('click',()=>reviewHandoff('chat'));$('fs-handoff-close').addEventListener('click',closeHandoff);$('fs-handoff').addEventListener('cancel',e=>{e.preventDefault();closeHandoff();});$('fs-handoff-confirm').addEventListener('click',confirmHandoff);$('fs-open-cleanup').addEventListener('click',openCleanup);
    window.TLIStorageHistory?.setup();setupMonitor();setupWorkbench();window.addEventListener('tli:cleanup-selection-change',updateCleanup);controls();
  }
  window.TLIFreeSpace={setup,prepare,startScan:({path}={})=>start('scan',path),start,stop,poll,loadDrives:drives,clearPrivate,openCleanup,updateCleanup,
    // Read-only validators also exercised by isolated controller tests.
    validateJob,validateResult,bytes,getState:()=>({busy:state.busy,job:state.job,observation:state.observation,tab:state.tab,epoch:state.epoch,mode:state.mode,focus:state.focus,selected:state.selected,mapView:state.mapView,treeRows:state.treeRows.slice(),expanded:new Set(state.expanded),surface:state.surface})};
  window.TLIVisualizer={scanPath:prepare,startScan:({path}={})=>start('scan',path)};
  function pause(){clearInvestigation();closeEntryMenu();mapObserver?.disconnect();mapObserver=null;state.paused=true;state.epoch++;clearTimeout(state.timer);for(const a of state.requests)a.abort();state.requests.clear();state.busy=false;state.driveBusy=false;closeHandoff();controls();}
  function resume(){if(!state.paused||state.locked||document.hidden||!state.panelActive)return;state.paused=false;for(const id of ['fs-monitor-load','fs-monitor-save'])if($(id))$(id).disabled=false;if(state.initialized)$('fs-drives-refresh').disabled=false;controls();if(state.observation&&state.tab==='explore')renderExplorer();if(state.job&&!terminal.has(state.job.status))poll();else if(state.pendingStart){status('Start response was interrupted. Retry this start request explicitly using its same request ID.');$('fs-job-check').hidden=false;$('fs-job-check').textContent='Retry this start request';}}
  window.addEventListener('tli-session-locked',()=>{
    const job=state.job;state.locked=true;clearPrivate();
    if(job&&!terminal.has(job.status))fetch(`/visualizer/jobs/${encodeURIComponent(job.id)}/cancel`,{method:'POST',credentials:'same-origin',cache:'no-store',keepalive:true,headers:{'Content-Type':'application/json'},body:'{}'}).catch(()=>{});
  });
  window.addEventListener('tli-session-unlocked',()=>{state.locked=false;state.paused=document.hidden||!state.panelActive;for(const id of ['fs-monitor-load','fs-monitor-save'])if($(id))$(id).disabled=false;controls();});
  window.addEventListener('pagehide',event=>{if(event.persisted)pause();else clearPrivate();});
  window.addEventListener('pageshow',event=>{if(event.persisted)resume();});
  document.addEventListener?.('visibilitychange',()=>{if(document.hidden)pause();else resume();});
  document.addEventListener?.('tli-panel-switched',event=>{state.panelActive=event.detail?.panelId==='panel-visualizer';if(state.panelActive)resume();else pause();});
})();
function setupVisualizer(){window.TLIFreeSpace.setup();}
function loadVisualizerDrives(){return window.TLIFreeSpace.loadDrives();}
function renderStorageExplorer(){throw new Error('Storage observations require a validated job result.');}
