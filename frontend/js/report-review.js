/* Saved evidence controls. Review/navigation never executes a diagnostic. */
(() => {
  'use strict';
  const protocol = 'tli-report-review-v1';
  const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const text = v => typeof v === 'string' && v.length > 0 && v.length <= 2000;
  const stamp = v => Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString() : 'Time unavailable';
  const requestToken = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') return Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
    throw new Error('This browser could not prepare a request identifier.');
  };
  const validComparison = (c, before, after) => c && c.before?.id === before && c.after?.id === after &&
    typeof c.comparable === 'boolean' && typeof c.reason === 'string' && typeof c.scope === 'string' &&
    Array.isArray(c.changes) && c.changes.length <= 128 && Array.isArray(c.checks) && c.checks.length <= 128 &&
    c.checks.every(r => r && text(r.label) && ['pass', 'fail', 'unavailable', 'not_recorded'].includes(r.before) && ['pass', 'fail', 'unavailable', 'not_recorded'].includes(r.after));
  function mount(box, report, context) {
    let epoch = 0, busy = false, review = null, result = null, comparison = null, rows = [], notice = '', error = false;
    let uncertain = false, disposed = false, requestId = null;
    const alive = n => !disposed && n === epoch && context.current();
    const node = (tag, value) => { const e = document.createElement(tag); if (value != null) e.textContent = value; return e; };
    const button = (label, action) => {
      const e = node('button', label); e.type = 'button'; e.className = 'btn-outline'; e.disabled = busy;
      e.addEventListener('click', () => { if (!busy && !disposed && context.current()) return Promise.resolve().then(action).catch(err => { if (!disposed && context.current()) { notice = err.message; error = true; paint(); } }); }); return e;
    };
    async function api(url, method = 'GET', body, dispatched) {
      const ticket = epoch;
      if (!alive(ticket)) return null;
      const options = { method, cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) };
      dispatched?.();
      const response = await fetch('/api/intelligence' + url, options);
      if (!alive(ticket)) return null;
      if (response.status === 401) { window.dispatchEvent(new CustomEvent('tli-session-locked')); throw new Error('Unlock TLI to continue.'); }
      const value = await response.json().catch(() => null);
      if (!alive(ticket)) return null;
      if (!response.ok) throw new Error(typeof value?.detail === 'string' ? value.detail : `Request failed (${response.status}).`);
      return value;
    }
    const validEnvelope = v => v?.ok === true && v.protocol === protocol && v.actions_performed === false && Number.isFinite(Date.parse(v.checked_at));
    async function operation(action, mutation = false) {
      if (busy || disposed || !context.current()) return;
      const ticket = ++epoch; busy = true; error = false; notice = mutation ? 'Running the reviewed check. Previous evidence remains below.' : 'Loading saved evidence…'; paint();
      let dispatched = false;
      try { await action(ticket, () => { dispatched = true; }); }
      catch (e) { if (alive(ticket)) { error = true; uncertain ||= mutation && dispatched; notice = e.message + (mutation ? dispatched ? ' The outcome may be uncertain. Review report history before deliberately requesting another check; no automatic retry will occur.' : ' No diagnostic request was sent. The review is unchanged; retry only deliberately.' : ' Previous results were retained.'); } }
      finally { if (alive(ticket)) { busy = false; paint(); } }
    }
    const loadReview = () => operation(async ticket => {
      const v = await api('/diagnostics/' + encodeURIComponent(report.id) + '/repeat-review');
      if (!alive(ticket)) return;
      if (!validEnvelope(v) || v.source?.id !== report.id || !hash(v.source_revision) || typeof v.available !== 'boolean' || typeof v.reason !== 'string') throw new Error('Repeat-check information is incomplete.');
      const r = v.request;
      if (v.available && (!r || r.repeat_of !== report.id || r.expected_report_revision !== v.source_revision || !hash(r.expected_scope) || !text(r.expected_host_id) || !['system', 'network', 'device'].includes(r.kind) || typeof r.internet !== 'boolean' || !text(v.scope?.host?.name) || v.scope.host.id !== r.expected_host_id || v.scope.revision !== r.expected_scope || v.scope.kind !== r.kind || v.scope.internet !== r.internet || (v.scope.target?.id || null) !== r.target_id)) throw new Error('The reviewed host or check scope is incomplete.');
      review = v; requestId = null; uncertain = false; notice = v.available ? 'Review the exact scope below. Nothing has run.' : v.reason;
    });
    const run = () => operation(async (ticket, dispatched) => {
      if (!review?.available || uncertain) throw new Error('Review an available check first.');
      requestId ||= requestToken();
      const request = { ...review.request, request_id: requestId };
      const v = await api('/diagnostics', 'POST', request, dispatched);
      if (!alive(ticket)) return;
      if (!v || !text(v.id) || v.host?.id !== request.expected_host_id || (v.target?.id || null) !== request.target_id || v.kind !== request.kind || v.internet_checks !== request.internet || !Number.isFinite(Date.parse(v.created_at)) || !Array.isArray(v.checks) || v.checks.length > 64 || !v.checks.every(c => c && ['pass', 'fail', 'unavailable'].includes(c.status) && text(c.label) && typeof c.detail === 'string')) throw new Error('The saved check result could not be confirmed.');
      if (v.comparison && !validComparison(v.comparison, report.id, v.id)) throw new Error('The saved comparison could not be confirmed.');
      result = v; review = null; uncertain = false; notice = 'New report saved. Review its evidence; no repair was performed.';
    }, true);
    const loadHistory = () => operation(async ticket => {
      const v = await api('/diagnostics');
      if (!alive(ticket)) return;
      if (!Array.isArray(v?.reports) || v.reports.length > 200 || !v.reports.every(r => r && text(r.id) && text(r.kind))) throw new Error('Saved report history is incomplete.');
      rows = v.reports.filter(r => r.id !== report.id); notice = rows.length ? 'Choose a second report. Comparison reads saved evidence only.' : 'No other reports are available to compare.';
    });
    const compare = id => operation(async ticket => {
      const v = await api('/diagnostics/' + encodeURIComponent(report.id) + '/compare/' + encodeURIComponent(id));
      if (!alive(ticket)) return;
      const c = v?.comparison;
      if (!validEnvelope(v) || !validComparison(c, report.id, id)) throw new Error('The report comparison is incomplete.');
      comparison = c; notice = c.comparable ? 'Saved check statuses compared. This does not confirm a repair.' : c.reason;
    });
    function showComparison(value) {
      if (!value) return;
      const wrap = node('section'); wrap.className = 'report-review-comparison';
      wrap.append(node('h4', 'Recorded differences'), node('p', `${stamp(value.before?.created_at)} → ${stamp(value.after?.created_at)}`));
      if (!value.comparable) wrap.append(node('p', value.reason));
      else {
        const table = node('table'), head = node('tr'); ['Check', 'First report', 'Second report'].forEach(t => head.append(node('th', t))); table.append(head);
        for (const row of value.checks) { const tr = node('tr'); [row.label, row.before.replaceAll('_', ' '), row.after.replaceAll('_', ' ')].forEach(t => tr.append(node('td', t))); table.append(tr); }
        wrap.append(table, node('p', value.scope));
        if (!value.changes.length) wrap.append(node('p', 'No recorded status changes. Check coverage and details can still differ.'));
      }
      box.append(wrap);
    }
    function paint() {
      const focused = box.contains?.(document.activeElement); box.replaceChildren(); box.className = 'report-review';
      box.append(node('h3', 'Continue from this report'), node('p', 'A repeat check creates a new dated report. It does not apply a fix or change this saved report.'));
      const feedback = node('p', notice); feedback.setAttribute('role', 'status'); feedback.tabIndex = -1; if (error) feedback.className = 'error'; box.append(feedback);
      if (report.kind === 'performance') box.append(node('p', 'Use App performance check to choose the current process and workload before a new observation. A saved PID is never restarted or retargeted.'));
      else box.append(button('Review repeat check', loadReview));
      box.append(button('Compare saved reports', loadHistory));
      if (review?.available) {
        const scope = review.scope, area = node('section'); area.className = 'report-review-scope';
        area.append(node('h4', 'Review before running'), node('p', `Runs on ${scope.host.name} (${scope.host.id}).`), node('p', `Measures ${scope.target ? `${scope.target.name} · ${scope.target.address || 'Address unavailable'}` : 'this TLI host'}.`),
          node('p', review.request.kind === 'device' ? 'TCP reachability only; this does not test remote applications or device function.' : review.request.kind === 'system' ? 'One short CPU/RAM sample and accessible drive usage; workload may differ from the earlier report.' : 'Host interfaces, route and gateway response; this does not test the phone’s connection.'),
          node('p', review.request.internet ? 'Internet contact: 1.1.1.1:443 and the configured DNS resolver for example.com.' : 'No optional internet checks.'));
        const start = button('Run reviewed repeat check', run); start.disabled ||= uncertain; start.className = 'btn-primary'; area.append(start, button('Cancel review', () => { review = null; notice = 'Review cancelled. No check was requested.'; paint(); })); box.append(area);
      }
      if (rows.length) {
        const label = node('label', 'Second report'), select = node('select'); select.setAttribute('aria-label', 'Second saved report');
        for (const row of rows) { const o = node('option', `${row.kind} · ${row.target?.name || row.host?.name || 'Host unknown'} · ${stamp(row.created_at)}`); o.value = row.id; select.append(o); }
        label.append(select); box.append(label, button('Compare selected reports', () => compare(select.value)));
      }
      showComparison(comparison);
      if (result) {
        box.append(node('h4', 'New saved report'), node('p', stamp(result.created_at)));
        if (window.TLIReportFacts) box.append(window.TLIReportFacts.render(result.recorded_facts, { reportId: result.id, hostId: result.host?.id, targetId: result.target?.id || null }));
        if (result.recorded_facts === undefined) {
          box.append(node('p', 'Structured report facts are unavailable. These legacy details apply only to the named saved checks.'));
          const ul = node('ul'); result.checks.forEach(c => ul.append(node('li', `${c.status} · ${c.label}: ${c.detail}`))); box.append(ul);
        }
        showComparison(result.comparison);
        box.append(button('Open new saved report', () => context.open(result.id)), button('Link new report to a problem…', () => window.TLITroubleshooting?.offerEvidence({ kind: 'report', id: result.id })));
      }
      if (focused) feedback.focus?.({ preventScroll: true });
    }
    paint();
    return { dispose() { disposed = true; epoch++; review = result = comparison = null; rows = []; box.replaceChildren(); } };
  }
  window.TLIReportReview = { mount };
})();
