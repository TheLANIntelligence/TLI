/* A reviewed, user-scoped catch-up snapshot. Reads never acknowledge activity. */
(function () {
  'use strict';
  if (window.TLIActivitySummary) return;
  const el = id => document.getElementById(id);
  let data = null, busy = false, failed = false, initialized = false, epoch = 0;

  function node(tag, text, className) {
    const item = document.createElement(tag);
    item.textContent = text;
    if (className) item.className = className;
    return item;
  }
  function timeLabel(ts) {
    return Number.isFinite(ts) ? new Date(ts * 1000).toLocaleString([], {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    }) : 'Time unavailable';
  }
  function controls() {
    const complete = ['complete', 'retained'].includes(data?.coverage);
    el('activity-refresh').disabled = busy;
    el('activity-review').disabled = busy || failed || !data || (!data.total && complete);
    el('activity-review').textContent = data?.total ? 'Mark summary reviewed' : complete ? 'Up to date' : 'Start from here';
    el('activity-catchup').setAttribute('aria-busy', String(busy));
    el('activity-catchup').dataset.state = busy ? 'loading' : failed ? (data ? 'stale' : 'unavailable') : data ? 'ready' : 'loading';
  }
  function row(event, grouped) {
    const item = node('li', '', 'activity-summary-row');
    const warning = ['warn', 'warning', 'error', 'alert', 'critical'].includes(event.level);
    item.dataset.level = event.level === 'critical' ? 'critical' : warning ? 'warning' : 'info';
    const label = event.level === 'critical' ? 'Critical recorded' : warning ? 'Warning recorded' : 'Activity';
    const heading = node('div', '', 'activity-summary-row-head');
    heading.append(node('span', label, warning ? 'activity-level activity-warning' : 'activity-level'),
      node('strong', event.title || 'Recorded event'));
    if (grouped && event.count > 1) heading.append(node('span', `×${event.count}`, 'activity-repeat'));
    item.append(heading);
    if (event.body) {
      if (grouped) {
        const details = node('details', '', 'activity-event-details');
        details.append(node('summary', event.count > 1 ? 'Latest event details' : 'Event details'), node('p', event.body));
        item.append(details);
      } else item.append(node('p', event.body));
    }
    if (event.retained_generic) item.append(node('small', 'Retained generic summary · private details were not saved'));
    const when = grouped && event.count > 1
      ? `${timeLabel(event.first_ts)} – ${timeLabel(event.ts)}` : timeLabel(event.ts);
    item.append(node('small', [event.node, event.category, when].filter(Boolean).join(' · '), 'activity-event-meta'));
    return item;
  }
  function render() {
    el('activity-catchup-title').textContent = data.reviewed_at ? 'Since you last checked' : 'Recent activity';
    const count = `${data.total} recorded event${data.total === 1 ? '' : 's'}`;
    el('activity-count').textContent = data.total
      ? `${count} · ${data.warning_count} warning${data.warning_count === 1 ? '' : 's'} recorded`
      : 'No new events in the retained activity.';
    el('activity-coverage').textContent = data.coverage_note;
    const retentionKnown = Number.isInteger(data.history?.limit) && data.history.limit > 0 && Number.isFinite(data.history?.days) && data.history.days > 0;
    el('activity-history-note').textContent = retentionKnown
      ? `This TLI host's eligible operational summaries: up to ${data.history.limit} entries for ${data.history.days} days across restarts. Current-session details: latest ${data.retention_limit} live events. Recorded warnings may have changed; check current alerts for present conditions.`
      : `This response includes up to ${data.retention_limit} live events. Retention across restarts was not reported by this host. Recorded warnings may have changed; check current alerts for present conditions.`;
    const coverage = el('activity-coverage-summary');
    if (coverage) coverage.textContent = data.history?.status && data.history.status !== 'recording' ? 'Retained history is unavailable or incomplete.' :
      data.coverage === 'retained_partial' || data.coverage === 'history_limited' || data.coverage === 'restarted' ? 'Some earlier details are unavailable. See coverage below.' :
      retentionKnown ? 'Includes eligible summaries retained across restarts.' : 'Live activity snapshot · restart retention unreported.';
    const checked = el('activity-checked-at'); if (checked) checked.textContent = Number.isFinite(data.checked_at) ? 'Checked ' + timeLabel(data.checked_at) : 'Observation time unavailable';
    el('activity-reviewed-at').textContent = data.reviewed_at ? `Last marked reviewed ${timeLabel(data.reviewed_at)}.` : '';
    const groups = el('activity-groups');
    const visible = data.groups.slice(0, 3);
    groups.replaceChildren(...visible.map(event => row(event, true)));
    el('activity-more').textContent = data.group_count > visible.length
      ? `Showing ${visible.length} of ${data.group_count} groups, with recorded warnings first.` : '';
    const retained = data.retained_events || data.events;
    el('activity-history-title').textContent = `View all ${retained.length} retained events`;
    el('activity-history').replaceChildren(...retained.map(event => row(event, false)));
    el('activity-history-details').hidden = retained.length === 0;
    el('activity-new').hidden = true;
  }
  async function request(url, options = {}) {
    const generation = epoch;
    const response = await fetch(url, {credentials: 'same-origin', cache: 'no-store',
      signal: AbortSignal.timeout(10000), ...options});
    if (response.status === 401 && generation === epoch) clearPrivate();
    const body = await response.json();
    if (!response.ok || body.ok !== true) throw new Error(typeof body.detail === 'string' ? body.detail : 'Activity could not be updated. Please retry.');
    return body;
  }
  async function refresh() {
    if (busy) return;
    busy = true;
    const generation = epoch;
    controls();
    try {
      const next = await request('/dashboard/activity-summary');
      if (generation !== epoch) return;
      if (!next.cursor || !Number.isInteger(next.cursor.sequence) || !Number.isInteger(next.total) || next.total < 0
          || !Number.isInteger(next.warning_count) || next.warning_count < 0 || next.warning_count > next.total
          || !Number.isInteger(next.group_count) || next.group_count < 0 || typeof next.coverage_note !== 'string'
          || !Number.isInteger(next.retention_limit) || next.retention_limit < 1
          || !Array.isArray(next.groups) || !Array.isArray(next.events)
          || (next.retained_events && !Array.isArray(next.retained_events))
          || ![next.groups, next.events, next.retained_events || []].every(rows => rows.every(event => event && typeof event.title === 'string' && (event.body == null || typeof event.body === 'string')))) {
        throw new Error('Activity summary returned an incomplete response. Please retry.');
      }
      data = next;
      failed = false;
      el('activity-error').textContent = '';
      render();
    } catch (error) {
      if (generation !== epoch) return;
      failed = true;
      el('activity-error').textContent = `${error.message} Previous activity, if shown, is unchanged.`;
    } finally {
      if (generation === epoch) { busy = false; controls(); }
    }
  }
  function clearPrivate() {
    epoch++; data = null; busy = false; failed = true;
    ['activity-groups', 'activity-history'].forEach(id => el(id).replaceChildren());
    ['activity-count', 'activity-coverage', 'activity-reviewed-at', 'activity-more', 'activity-checked-at', 'activity-coverage-summary'].forEach(id => { if (el(id)) el(id).textContent = ''; });
    el('activity-error').textContent = 'Unlock TLI, then refresh activity.';
    el('activity-history-title').textContent = 'View recorded events';
    el('activity-history-details').hidden = true; el('activity-history-details').open = false;
    if (el('activity-coverage-details')) el('activity-coverage-details').open = false;
    el('activity-new').hidden = true; controls();
  }
  async function review() {
    if (busy || failed || !data) return;
    const cursor = {...data.cursor, ...(data.history_cursor ? {history_cursor: {...data.history_cursor}} : {})};
    const generation = epoch;
    busy = true;
    controls();
    let saved = false;
    try {
      await request('/dashboard/activity-summary/review', {method: 'POST',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify(cursor)});
      if (generation !== epoch) return;
      saved = true;
      el('activity-error').textContent = '';
    } catch (error) {
      if (generation !== epoch) return;
      el('activity-error').textContent = error.message;
    } finally {
      if (generation === epoch) { busy = false; controls(); }
    }
    if (saved) await refresh();
  }
  function initNarratorControls() {
    const host = el('nd-narrator-controls') || el('nd-narrator');
    if (!host || el('narrator-preferences')) return;
    const details = node('details', '', 'narrator-preferences'); details.id = 'narrator-preferences';
    details.append(node('summary', 'Narrator settings & warning explanations'));
    details.append(node('p', 'Applies to everyone using this TLI host. Critical alerts, monitoring failures and action confirmations remain visible in every mode.'));
    const label = node('label', 'Narrator mode '), select = node('select', ''); select.id = 'narrator-mode';
    for (const [value, text] of [['', 'Load current setting'], ['quiet', 'Quiet — warnings and confirmations'], ['balanced', 'Balanced — current behavior'], ['detailed', 'Detailed — more frequent measured check-ins']]) {
      const option = node('option', text); option.value = value; select.append(option);
    }
    label.append(select);
    const save = node('button', 'Save mode', 'pill-btn'), reload = node('button', 'Refresh settings and explanation', 'pill-btn');
    save.type = reload.type = 'button'; save.disabled = select.disabled = true;
    const status = node('p', 'Open to load the saved host setting.'); status.setAttribute('role', 'status');
    const reasons = node('div', '', 'narrator-explanations');
    details.append(label, save, reload, status, reasons); host.append(details);
    let pending = false, knownMode = null;
    const explain = narrator => {
      if (!details.open) return;
      reasons.replaceChildren();
      const rows = Array.isArray(narrator?.explanations) ? narrator.explanations.slice(0, 12) : [];
      reasons.append(node('strong', 'Why this warning appears / what clears it'));
      if (!rows.length) reasons.append(node('p', 'No active metric warning is identified in the latest Narrator snapshot. Recorded event messages do not prove current health.'));
      rows.forEach(row => { if (typeof row.why === 'string' && typeof row.clears_when === 'string') reasons.append(node('p', row.why), node('p', 'Clears when: ' + row.clears_when)); });
    };
    async function load(mode) {
      if (pending) return;
      const generation = epoch;
      pending = true; save.disabled = select.disabled = reload.disabled = true;
      status.textContent = mode ? 'Saving Narrator mode…' : 'Loading saved Narrator mode…';
      try {
        const next = await request('/dashboard/narrator/settings', mode ? {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({mode})} : {});
        if (generation !== epoch) return;
        if (next.scope !== 'host' || !['quiet', 'balanced', 'detailed'].includes(next.mode) || (mode && next.mode !== mode)) throw new Error('TLI did not confirm the requested Narrator mode. Refresh before trying again.');
        knownMode = next.mode; select.value = next.mode;
        status.textContent = `${mode ? 'Saved' : 'Current'} host mode: ${next.mode}. Critical alerts remain visible.`;
        explain(next.narrator);
      } catch (error) {
        if (generation !== epoch) return;
        select.value = knownMode || ''; status.textContent = error.message + ' No automatic retry was made.';
      } finally {
        if (generation === epoch) { pending = false; reload.disabled = false; save.disabled = select.disabled = !knownMode; }
      }
    }
    save.addEventListener('click', () => load(select.value)); reload.addEventListener('click', () => load());
    details.addEventListener('toggle', () => { if (details.open) load(); });
    window.EventInterpreter?.on('narrator_update', explain);
    window.addEventListener?.('tli-session-locked', () => {
      pending = false; knownMode = null; details.open = false; reasons.replaceChildren(); select.value = '';
      save.disabled = select.disabled = true; reload.disabled = false; status.textContent = 'Unlock TLI, then refresh these settings.';
    });
  }
  function init() {
    if (initialized || !el('activity-catchup')) return;
    initialized = true;
    initNarratorControls();
    el('activity-refresh').addEventListener('click', refresh);
    el('activity-review').addEventListener('click', review);
    document.addEventListener('tli-panel-switched', event => {
      if (event.detail?.panelId === 'panel-dashboard2') refresh();
    });
    document.addEventListener('tli-activity-event', event => {
      const ev = event.detail;
      if (data && ev && (ev.stream_id !== data.cursor.stream_id || ev.sequence > data.cursor.sequence)) {
        el('activity-new').hidden = false;
      }
    });
    if (!el('panel-dashboard2')?.hidden) refresh();
    window.addEventListener?.('tli-session-locked', clearPrivate);
    window.addEventListener?.('pagehide', clearPrivate);
    controls();
  }
  window.TLIActivitySummary = {refresh};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
