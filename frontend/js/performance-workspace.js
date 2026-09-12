/* Explicit host observations. Opening the workspace never starts sampling. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id), base = '/api/intelligence/performance';
  const state = { epoch: 0, locked: false, open: false, busy: false, rows: [], processes: [], selected: '', current: null, timer: null, uncertain: null, request: null, saveRequests: new Map(), readTicket: 0, starterValue:null, pendingStarter:null, setupExpanded:false };
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const stamp = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Time unavailable';
  const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const fmt = (n, memory = false) => finite(n) ? memory ? `${(n / 1048576).toFixed(1)} MiB` : `${n.toFixed(1)}%` : 'Unknown';
  const token = () => { if (window.crypto?.randomUUID) return window.crypto.randomUUID(); if (window.crypto?.getRandomValues) return Array.from(window.crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join(''); return `performance-${Date.now()}-${Math.random().toString(36).slice(2)}`; };
  const alive = epoch => state.open && !state.locked && epoch === state.epoch;
  const message = text => { if ($('perf-status')) $('perf-status').textContent = text; };
  function button(text, fn) { const b = node('button', text, 'btn-outline'); b.type = 'button'; b.addEventListener('click', fn); return b; }
  function controls() {
    const running = state.current?.status === 'running';
    const hasResult=!!state.current;
    $('performance-workspace')?.classList.toggle('perf-has-result',hasResult);
    $('performance-workspace')?.classList.toggle('perf-setup-expanded',state.setupExpanded || !hasResult);
    if($('perf-observation'))$('perf-observation').hidden=!hasResult;
    if($('perf-change-app')){$('perf-change-app').hidden=!hasResult;$('perf-change-app').disabled=state.busy || running;$('perf-change-app').textContent=state.setupExpanded?'Keep this app selection':'Choose an app for another observation';}
    if($('perf-selected-summary')){$('perf-selected-summary').hidden=!hasResult;$('perf-selected-summary').textContent=hasResult?`${state.current.process?.name || 'App'} · PID ${state.current.process?.pid ?? 'unknown'} · ${running?'Recording for up to 30 seconds':'Recorded observation below'}`:'';}
    if ($('perf-start')) $('perf-start').disabled = state.busy || running || !state.selected || !!state.uncertain || state.locked;
    if ($('perf-processes')) $('perf-processes').disabled = state.busy || running;
    if ($('perf-refresh')) $('perf-refresh').disabled = state.busy || running;
    if ($('perf-stop')) { $('perf-stop').hidden = !running; $('perf-stop').disabled = state.busy; }
    if ($('perf-save')) { $('perf-save').hidden = !state.current || running; $('perf-save').disabled = state.busy || !!state.current?.saved_report_id || !state.current?.sample_count; }
    if ($('perf-resolve')) { $('perf-resolve').hidden = !state.uncertain; $('perf-resolve').disabled = state.busy; }
    if ($('perf-new-request')) { $('perf-new-request').hidden = !state.uncertain; $('perf-new-request').disabled = state.busy; }
    if ($('perf-saved-actions')) $('perf-saved-actions').hidden = !state.current?.saved_report_id;
    $('perf-history')?.querySelectorAll('button').forEach(b => { b.disabled = state.busy || running; });
  }
  async function api(path, method = 'GET', body) {
    const epoch = state.epoch;
    let response;
    try { response = await fetch(base + path, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { const e = new Error('Connection lost. The host outcome is uncertain. No request will be repeated automatically.'); e.uncertain = method !== 'GET'; throw e; }
    if (epoch !== state.epoch || state.locked) throw new Error('This view has changed; late results were ignored.');
    if (response.status === 401) window.dispatchEvent(new CustomEvent('tli-session-locked'));
    let data; try { data = await response.json(); } catch { const e = new Error('The host returned an unreadable result. Check the recorded observation before trying again.'); e.uncertain = method !== 'GET'; throw e; }
    if (epoch !== state.epoch || state.locked) throw new Error('This view has changed; late results were ignored.');
    if (!response.ok || data.ok !== true || data.protocol !== 'tli-performance-v1') {
      const e = new Error(typeof data.detail === 'string' ? data.detail : `Performance workspace unavailable (HTTP ${response.status}).`); e.status = response.status; throw e;
    }
    return data;
  }
  async function task(fn) {
    if (state.busy || state.locked || !state.open) return;
    state.busy = true; state.readTicket++; controls(); const epoch = state.epoch;
    try { await fn(epoch); } catch (e) { if (alive(epoch)) message(e.message + (state.current ? ' Previous readings remain available below.' : '')); }
    finally { if (alive(epoch)) { state.busy = false; controls(); } }
  }
  const reasons = { process_exited: 'The selected app exited.', process_reused: 'The process ID was reused by a different launch.', process_identity_unavailable: 'The selected app could no longer be identified.', process_executable_changed: 'The executable changed.', stopped_by_user: 'Stopped by you; recorded samples are retained.', some_metrics_unavailable: 'Some measurements were unavailable.', observation_unavailable: 'The observation could not continue.', sampling_delayed: 'Sampling was delayed; the observation ended with partial coverage.' };
  function renderHistory() {
    const box = $('perf-history'); if (!box) return; box.replaceChildren();
    if (!state.rows.length) { box.append(node('p', 'No observations retained in this session on the host. Unsaved results expire after 10 minutes.', 'perf-muted')); return; }
    for (const row of state.rows.slice(0, 20)) {
      const b = button(`${row.process?.name || 'App'} · ${row.status} · ${stamp(row.started_at)}`, () => { if (state.busy || state.current?.status === 'running') return; state.current = row; render(); if (row.status === 'running') pollSoon(); });
      b.disabled = state.busy || state.current?.status === 'running'; box.append(b);
    }
  }
  function accept(row) {
    if (!row || typeof row.id !== 'string' || !Array.isArray(row.samples) || !['running', 'completed', 'partial', 'stopped', 'failed'].includes(row.status)) throw new Error('The observation result is incomplete. Existing readings are unchanged.');
    state.current = row; state.rows = [row, ...state.rows.filter(r => r.id !== row.id)].slice(0, 20); render();
  }
  function render() {
    const row = state.current, box = $('perf-result'); if (!box) return; const expanded = !!box.querySelector('details')?.open; box.replaceChildren(); controls(); renderHistory();
    if (!row) { box.append(node('p', 'Your next observation will appear here. Choose an app and start when the workload you want to understand is running.', 'perf-empty')); return; }
    const heading = node('div', null, 'perf-result-heading'); heading.append(node('h3', row.process?.name || 'Selected app'), node('span', row.status === 'running' ? 'Recording' : row.status, 'perf-state')); box.append(heading);
    box.append(node('p', `${row.host?.name || 'TLI host'} · PID ${row.process?.pid ?? 'unknown'} · started ${stamp(row.started_at)}`, 'perf-muted'));
    const progress = node('progress'); progress.max = row.expected_samples || 30; progress.value = row.sample_count || 0; progress.setAttribute('aria-label', 'Recorded samples'); box.append(progress);
    box.append(node('p', `${row.sample_count || 0} of ${row.expected_samples || 30} planned samples · ${Number(row.duration_seconds || 0).toFixed(1)} seconds. ${reasons[row.reason] || (row.status === 'running' ? 'One sample per second. Keep the relevant workload running.' : 'This records use, not the cause of a slowdown.')}`));
    const grid = node('div', null, 'perf-metrics');
    for (const [key, label, memory] of [['host_cpu_percent', 'Host CPU', false], ['host_ram_percent', 'Host RAM', false], ['process_cpu_percent', 'App CPU', false], ['process_rss_bytes', 'App memory (RSS)', true]]) {
      const metric = row.summary?.[key] || {}, card = node('div', null, 'perf-metric');
      card.append(node('span', label), node('strong', fmt(metric.mean, memory)), node('small', `${metric.samples || 0} samples · peak ${fmt(metric.max, memory)}`)); grid.append(card);
    }
    box.append(grid);
    const details = node('details', null, 'perf-details'); details.open = expanded; details.append(node('summary', 'Measurement scope & individual samples'));
    details.append(node('p', row.scope || 'CPU and memory only. No FPS, GPU or temperature measurements.'));
    details.append(node('p', `Executable: ${row.process?.exe || 'Unknown; comparisons are unavailable'}. App launch identity: ${row.process?.create_time ?? 'unknown'}.`));
    details.append(node('p', `Last observed: ${stamp(row.samples.at(-1)?.observed_at)}. ${row.expires_at ? `Unsaved result expires ${stamp(row.expires_at)}.` : 'Recording is limited to 30 seconds.'}`));
    const tableWrap = node('div', null, 'perf-table-wrap'), table = node('table'), caption = node('caption', 'Recorded samples; missing probes stay unknown'); table.append(caption);
    const head = node('tr'); ['Elapsed', 'Host CPU', 'Host RAM', 'App CPU', 'App RSS'].forEach(t => head.append(node('th', t))); const thead = node('thead'); thead.append(head); table.append(thead); const body = node('tbody');
    row.samples.slice(0, 30).forEach(sample => { const tr = node('tr'); [String(sample.elapsed_seconds) + 's', fmt(sample.host_cpu_percent), fmt(sample.host_ram_percent), fmt(sample.process_cpu_percent), fmt(sample.process_rss_bytes, true)].forEach(v => tr.append(node('td', v))); body.append(tr); }); table.append(body); tableWrap.append(table); details.append(tableWrap); box.append(details);
    if (row.comparison?.changes?.length) { const compare = node('details', null, 'perf-details'); compare.append(node('summary', 'Compare with the previous saved observation'), node('p', row.comparison.scope || 'Same host and known executable. Workloads may differ.')); for (const change of row.comparison.changes) compare.append(node('p', `${change.check.replaceAll('_', ' ')}: ${fmt(change.before, change.check.endsWith('_bytes'))} to ${fmt(change.after, change.check.endsWith('_bytes'))}`)); box.append(compare); }
    if (row.saved_report_id) box.append(node('p', 'Saved to your encrypted diagnostic history. Saving does not run a check or attach anything to Chat.', 'perf-saved'));
  }
  async function refreshProcesses() { return task(async epoch => {
    message('Reading the host process list…'); const selected = state.processes.find(p => `${p.pid}:${p.create_time}` === state.selected);
    const data = await api('/processes?q=' + encodeURIComponent($('perf-search')?.value.trim() || '') + '&limit=100'); if (!alive(epoch)) return;
    if (!Array.isArray(data.processes)) throw new Error('The process list is unavailable.'); state.processes = data.processes;
    const list = $('perf-processes'); list.replaceChildren(); const placeholder = node('option', 'Choose a running app'); placeholder.value = ''; list.append(placeholder);
    state.processes.forEach(p => { const o = node('option', `${p.name} · PID ${p.pid}`); o.value = `${p.pid}:${p.create_time}`; list.append(o); });
    state.selected = selected && state.processes.some(p => p.pid === selected.pid && p.create_time === selected.create_time) ? `${selected.pid}:${selected.create_time}` : ''; list.value = state.selected;
    $('perf-host').textContent = `Observing this TLI host: ${data.host?.name || 'name unavailable'}. Other selected computers are not targeted.`;
    message(`${data.processes.length} processes shown · checked ${stamp(data.checked_at)}.${data.coverage?.limited ? ' List is bounded; use a name or PID to narrow it.' : ''} No observation started.`);
  }); }
  async function start() { return task(async epoch => {
    const selected = state.processes.find(p => `${p.pid}:${p.create_time}` === state.selected); if (!selected || state.current?.status === 'running' || state.uncertain) return;
    const request = { request_id: token(), pid: selected.pid, create_time: selected.create_time }; state.request = request; message('Starting the reviewed 30-second observation…');
    try { const data = await api('/observations', 'POST', request); if (!alive(epoch)) return;state.setupExpanded=false; accept(data.observation); message('Recording started. Leaving this view does not stop the observation; it finishes within 30 seconds.'); pollSoon(); }
    catch (e) { if (alive(epoch) && e.uncertain) state.uncertain = request.request_id; throw e; }
  }); }
  function pollSoon() { clearTimeout(state.timer); if (state.open && !state.locked && state.current?.status === 'running') state.timer = setTimeout(poll, 1000); }
  async function poll() {
    if (!state.open || state.locked || state.current?.status !== 'running') return;
    if (state.busy) { pollSoon(); return; }
    const epoch = state.epoch, id = state.current.id, ticket = state.readTicket;
    try { const data = await api('/observations/' + encodeURIComponent(id)); if (!alive(epoch) || state.current?.id !== id || ticket !== state.readTicket) return; accept(data.observation); if (state.current.status !== 'running') message('Observation finished. Review coverage before saving or comparing.'); else pollSoon(); }
    catch (e) { if (alive(epoch)) message('Observation updates paused: ' + e.message + ' The host may still be recording. Use Refresh observations; this does not start another run.'); }
  }
  async function refresh() { return task(async epoch => {
    const data = await api('/observations'); if (!alive(epoch)) return;
    if (!Array.isArray(data.observations)) throw new Error('Retained observations are unavailable.'); state.rows = data.observations;
    const match = state.rows.find(r => r.id === state.current?.id) || state.rows.find(r => r.status === 'running') || (!state.current && state.rows[0]);
    if (match) accept(match); else renderHistory(); message(`Observations checked ${stamp(data.checked_at)}. Previously displayed readings remain historical.`); pollSoon();
  }); }
  async function stop() { return task(async epoch => { const id = state.current?.id; if (!id || state.current.status !== 'running') return; message('Requesting Stop; waiting for the host to confirm its final samples…'); const data = await api('/observations/' + encodeURIComponent(id) + '/stop', 'POST'); if (!alive(epoch)) return; accept(data.observation); message(data.observation.status === 'running' ? 'Stop requested. The host is finishing its current sample.' : 'Observation stopped. Partial readings remain available.'); pollSoon(); }); }
  async function save() { return task(async epoch => {
    const row = state.current; if (!row || row.status === 'running' || row.saved_report_id || !row.sample_count) return;
    if (!state.saveRequests.has(row.id)) state.saveRequests.set(row.id, token());
    message('Saving these recorded readings to encrypted diagnostic history…');
    const data = await api('/observations/' + encodeURIComponent(row.id) + '/save', 'POST', { request_id: state.saveRequests.get(row.id) }); if (!alive(epoch)) return;
    if (!data.report?.id) throw new Error('The save outcome is unavailable. Refresh observations before retrying.'); row.saved_report_id = data.report.id; row.comparison = data.report.comparison || null; render(); message('Report saved. You choose whether to discuss it or link it to a problem.');
  }); }
  async function resolve() { return task(async epoch => { if (!state.uncertain) return; const data = await api('/observations/by-request/' + encodeURIComponent(state.uncertain)); if (!alive(epoch)) return; accept(data.observation); state.uncertain = null; message('The original request was found. No second observation was started.'); pollSoon(); }); }
  function close(clear = false) { state.epoch++; state.open = false; state.busy = false; clearTimeout(state.timer); if (clear) { state.current = null; state.rows = []; state.processes = []; state.selected = ''; state.uncertain = null; state.request = null; state.starterValue=null;state.pendingStarter=null;state.setupExpanded=false;state.saveRequests.clear(); $('perf-processes')?.replaceChildren(); if ($('perf-search')) $('perf-search').value = '';if($('perf-starter-review'))$('perf-starter-review').hidden=true; render(); message(''); } }
  async function chooseStarter(value) {
    if(state.busy || state.locked || !state.open || state.current?.status==='running')return;
    const input=$('perf-search');if(!input)return;
    if(input.value.trim() && input.value!==state.starterValue){state.pendingStarter=value;if($('perf-starter-review'))$('perf-starter-review').hidden=false;message('Your custom app search is retained. Choose whether to replace it with this starter or keep it. No process list was read.');return;}
    input.value=value;state.starterValue=value;state.pendingStarter=null;if($('perf-starter-review'))$('perf-starter-review').hidden=true;
    state.selected='';if($('perf-processes'))$('perf-processes').value='';state.setupExpanded=true;await refreshProcesses();
  }
  function setup() {
    if (!$('performance-workspace') || setup.done) return; setup.done = true;
    const setupBox=$('perf-setup');
    if(setupBox){const summary=node('p',null,'perf-selected-summary');summary.id='perf-selected-summary';const change=button('Choose an app for another observation',()=>{state.setupExpanded=!state.setupExpanded;controls();if(state.setupExpanded)$('perf-search')?.focus();});change.id='perf-change-app';setupBox.append(summary,change);}
    const starterReview=node('div',null,'perf-starter-review');starterReview.id='perf-starter-review';starterReview.hidden=true;
    starterReview.append(node('p','Keep your custom search, or replace it with the selected starter?'),button('Use starter & read processes',async()=>{if(state.busy || state.locked || !state.open || state.pendingStarter===null)return;const value=state.pendingStarter;state.starterValue=$('perf-search')?.value;await chooseStarter(value);}),button('Keep my search',()=>{state.pendingStarter=null;starterReview.hidden=true;message('Your custom search is unchanged.');}));
    $('perf-search')?.after?.(starterReview);
    $('perf-refresh')?.addEventListener('click', refreshProcesses); $('perf-start')?.addEventListener('click', start); $('perf-stop')?.addEventListener('click', stop); $('perf-save')?.addEventListener('click', save); $('perf-resolve')?.addEventListener('click', resolve); $('perf-refresh-observations')?.addEventListener('click', refresh);
    $('perf-processes')?.addEventListener('change', () => { if (!state.busy && state.current?.status !== 'running') state.selected = $('perf-processes').value; controls(); });
    $('perf-new-request')?.addEventListener('click', () => {
      if (state.busy || state.locked || !state.uncertain) return;
      state.uncertain = null; state.request = null; state.selected = ''; if ($('perf-processes')) $('perf-processes').value = '';
      message('The original outcome is still unknown. Review the process and workload again. A new observation starts only when you choose Start; it may be a second recording if the original completed.'); controls(); $('perf-processes')?.focus();
    });
    $('perf-search')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); refreshProcesses(); } });
    $('perf-search')?.addEventListener('input',()=>{state.pendingStarter=null;if($('perf-starter-review'))$('perf-starter-review').hidden=true;});
    document.querySelectorAll('[data-perf-starter]').forEach(b => b.addEventListener('click', () => chooseStarter(b.dataset.perfStarter)));
    $('perf-discuss')?.addEventListener('click', () => task(async () => { if (state.current?.saved_report_id) await window.TLIIntelligence?.discussReport?.(state.current.saved_report_id, 'Help me interpret these observed CPU and memory readings. What do they establish, and what remains unknown?'); }));
    $('perf-link')?.addEventListener('click', () => task(async () => { if (state.current?.saved_report_id) await window.TLITroubleshooting?.offerEvidence?.({ kind: 'report', id: state.current.saved_report_id }); }));
    $('perf-open-report')?.addEventListener('click', () => task(async () => { if (state.current?.saved_report_id) await window.TLIIntelligence?.openSavedReport?.(state.current.saved_report_id); }));
    document.addEventListener('tli-panel-switched', e => { const panel = e.detail?.panel || e.detail?.panelId || e.detail?.id; if (panel && panel !== 'panel-games') close(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) close(true); });
    window.addEventListener('tli-session-locked', () => { state.locked = true; close(true); }); window.addEventListener('tli-session-unlocked', () => { state.locked = false; }); window.addEventListener('pagehide', () => close(true)); render();
  }
  async function onOpen() { setup(); if (!$('performance-workspace') || state.locked) return; state.open = true; state.busy = false; const epoch = ++state.epoch; message('Checking observation availability…'); try { await api('/capabilities'); if (!alive(epoch)) return; await refresh(); } catch (e) { if (alive(epoch)) message(e.message); } }
  window.TLIPerformance = { setup, onOpen, onClose: close };
})();
