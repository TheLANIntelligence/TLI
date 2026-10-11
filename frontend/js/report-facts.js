/* Pure presentation of bounded server-projected saved report facts. */
(() => {
  'use strict';
  const metrics = {
    host_cpu_percent: ['Host CPU', 'host', 'percent'],
    host_ram_percent: ['Host RAM', 'host', 'percent'],
    host_ram_used_bytes: ['Host RAM used', 'host', 'bytes'],
    host_ram_total_bytes: ['Host RAM total', 'host', 'bytes'],
    process_cpu_percent: ['Selected process CPU · whole host capacity', 'selected_process', 'percent'],
    process_rss_bytes: ['Selected process resident memory', 'selected_process', 'bytes'],
  };
  const text = (v, max, nullable = false) => nullable && v === null || typeof v === 'string' && v.length <= max;
  const number = (v, max = Number.MAX_VALUE) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
  const count = (v, max = 3600) => Number.isSafeInteger(v) && v >= 0 && v <= max;
  const optionalNumber = (v, max) => v === null || number(v, max);
  const identity = v => v && text(v.id, 256, true) && text(v.name, 240, true);
  const date = v => v === null || typeof v === 'string' && v.length <= 64 && /(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
  const node = (tag, value, cls) => { const e = document.createElement(tag); if (value !== undefined) e.textContent = value; if (cls) e.className = cls; return e; };
  function validate(v, expected = {}) {
    if (!v || v.version !== 1 || v.basis !== 'saved_report' || !text(v.report_id, 256) || !v.report_id || expected.reportId && v.report_id !== expected.reportId ||
      !['system', 'network', 'device', 'performance', 'unknown'].includes(v.kind) || !identity(v.host) || v.target !== null && !identity(v.target) ||
      expected.hostId !== undefined && v.host.id !== expected.hostId || expected.targetId !== undefined && (v.target?.id || null) !== expected.targetId ||
      !['completed', 'partial', 'stopped', 'failed', 'unknown'].includes(v.status) || !text(v.status_label, 100) ||
      ![v.recorded_at, v.started_at, v.finished_at].every(date) || !optionalNumber(v.duration_seconds, 86400) || !optionalNumber(v.requested_duration_seconds, 86400) ||
      v.recorded_samples !== null && !count(v.recorded_samples) || v.expected_samples !== null && (!count(v.expected_samples) || !v.expected_samples) ||
      !Array.isArray(v.measurements) || v.measurements.length > 6 || new Set(v.measurements.map(m => m?.key)).size !== v.measurements.length ||
      !Array.isArray(v.checks) || v.checks.length > 64 || !count(v.omitted_checks, 10000) ||
      !Array.isArray(v.limitations) || v.limitations.length > 12 || !v.limitations.every(s => text(s, 300))) return false;
    if (v.process !== null && (!v.process || !text(v.process.name, 240, true) || v.process.pid !== null && (!Number.isSafeInteger(v.process.pid) || v.process.pid < 1) || !optionalNumber(v.process.create_time))) return false;
    if (v.kind !== 'performance' && (v.process !== null || v.measurements.length)) return false;
    if (!v.measurements.every(m => {
      const known = metrics[m?.key];
      if (!known || !text(m.label, 100) || m.scope !== known[1] || m.unit !== known[2] || !count(m.valid_samples) || v.recorded_samples !== null && m.valid_samples > v.recorded_samples) return false;
      if (!m.valid_samples) return m.mean === null && m.minimum === null && m.maximum === null;
      return [m.minimum, m.mean, m.maximum].every(x => number(x, m.unit === 'percent' ? 100 : Number.MAX_VALUE)) && m.minimum <= m.mean && m.mean <= m.maximum;
    })) return false;
    if (!v.checks.every(c => c && text(c.id, 256, true) && text(c.label, 240) && text(c.detail, 1000, true) && ['pass', 'fail', 'unavailable', 'unknown'].includes(c.status) && ['host', 'host_to_device', 'unknown'].includes(c.scope))) return false;
    if (v.status === 'completed' && v.kind === 'performance' && (!v.host.id || !v.process?.pid || v.process.create_time === null || !v.expected_samples || v.recorded_samples !== v.expected_samples || v.measurements.length !== 6 || v.measurements.some(m => m.valid_samples !== v.expected_samples))) return false;
    return true;
  }
  const time = v => v === null ? 'Time not recorded' : new Date(v).toLocaleString();
  const identityText = v => `${v?.name || 'Name not recorded'} · ${v?.id || 'ID not recorded'}`;
  const value = (v, unit) => v === null ? 'Unknown' : unit === 'percent' ? `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}%` : `${(v / 1048576).toLocaleString(undefined, { maximumFractionDigits: 2 })} MiB`;
  function render(facts, expected = {}, options = {}) {
    const section = node('section', undefined, 'report-facts'); section.setAttribute('aria-label', 'Recorded report facts');
    const compact = options.compact === true;
    if (compact) section.className += ' report-facts-compact';
    section.append(node('h3', 'Recorded report facts'), node('p', 'Saved evidence, not current health or proof of a repair.', 'report-facts-note'));
    if (!validate(facts, expected)) { section.append(node('p', 'A usable structured report summary is unavailable. Do not infer completion, current health or a different target from missing details.', 'report-facts-unavailable')); return section; }
    const performance = facts.kind === 'performance';
    const status = performance ? { completed: 'Planned sampling completed', partial: 'Observation partially completed', stopped: 'Observation stopped', failed: 'Observation failed', unknown: 'Completion unknown' } : { completed: 'Check results recorded', partial: 'Some check results unavailable or unknown', stopped: 'Check stopped', failed: 'Check failed', unknown: 'Completion unknown' };
    section.append(node('p', status[facts.status], 'report-facts-status report-facts-' + facts.status));
    const identities = node('dl', undefined, 'report-facts-identities'), extendedIdentities = node('dl', undefined, 'report-facts-identities');
    const row = (label, content, extended = false) => { const r = node('div'); r.append(node('dt', label), node('dd', content)); (compact && extended ? extendedIdentities : identities).append(r); };
    row('Executing TLI host', identityText(facts.host));
    if (performance) {
      row('Selected process', `${facts.process?.name || 'Name not recorded'} · PID ${facts.process?.pid ?? 'unknown'}`);
      const created = facts.process?.create_time == null ? null : new Date(facts.process.create_time * 1000);
      row('Process identity', created === null ? 'Start time not recorded; no other process is substituted.' : `Started ${Number.isFinite(created.getTime()) ? created.toLocaleString() : 'date outside displayable range'} · recorded start value ${facts.process.create_time}`, true);
    } else row('Measured subject', facts.target ? identityText(facts.target) : ['unknown', 'device'].includes(facts.kind) ? 'Subject not recorded; no different target is assumed' : 'The executing TLI host');
    row('Report recorded', time(facts.recorded_at));
    if (performance) {
      row('Observation interval', `${time(facts.started_at)} → ${time(facts.finished_at)}`, true);
      row('Duration', `${facts.duration_seconds === null ? 'Unknown elapsed time' : facts.duration_seconds.toLocaleString() + ' s observed'} · ${facts.requested_duration_seconds === null ? 'requested duration unknown' : facts.requested_duration_seconds.toLocaleString() + ' s requested'}`, true);
      row('Sample coverage', `${facts.recorded_samples ?? 'Unknown'} recorded · ${facts.expected_samples ?? 'unknown'} planned`);
    }
    section.append(identities);
    const body = compact ? node('details', undefined, 'report-facts-expanded') : section;
    if (compact) { body.append(node('summary', 'Measurements, interval and limitations')); if (extendedIdentities.children.length) body.append(extendedIdentities); section.append(body); }
    if (facts.measurements.length) {
      body.append(node('p', 'Host and selected-process measurements have different scopes. Values below summarize only their usable recorded samples.', 'report-facts-note'));
      const scroll = node('div', undefined, 'report-facts-table-scroll'); scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', 'Recorded measurements; scroll horizontally for all columns');
      const table = node('table'), head = node('thead'), hrow = node('tr'), rows = node('tbody');
      ['Measured scope', 'Mean', 'Minimum', 'Maximum', 'Usable samples'].forEach(s => { const c = node('th', s); c.setAttribute('scope', 'col'); hrow.append(c); }); head.append(hrow);
      for (const m of facts.measurements) {
        const r = node('tr'), label = node('th', metrics[m.key][0]); label.setAttribute('scope', 'row');
        r.append(label, ...[value(m.mean, m.unit), value(m.minimum, m.unit), value(m.maximum, m.unit), `${m.valid_samples} of ${facts.recorded_samples ?? 'unknown'}`].map(s => node('td', s))); rows.append(r);
      }
      table.append(head, rows); scroll.append(table); body.append(scroll, node('p', 'Scroll the table sideways for all columns. Keyboard: focus the table, then use the arrow keys.', 'report-facts-scroll-hint'));
    }
    if (facts.checks.length) {
      const list = node('ul', undefined, 'report-facts-checks');
      for (const c of facts.checks) {
        const li = node('li'); li.append(node('strong', `${{ pass: 'Recorded pass', fail: 'Recorded failure', unavailable: 'Unavailable', unknown: 'Unknown' }[c.status]} · ${c.label}`), node('p', c.detail || 'Check details not recorded.'), node('p', { host: 'Scope: executing host', host_to_device: 'Scope: host-to-device reachability', unknown: 'Scope not recorded' }[c.scope], 'report-facts-note')); list.append(li);
      }
      body.append(list);
    }
    if (facts.omitted_checks) body.append(node('p', `${facts.omitted_checks} additional saved checks are not included in this bounded summary.`));
    const details = node('details'); details.append(node('summary', 'Coverage and limitations'));
    const list = node('ul'); facts.limitations.forEach(s => list.append(node('li', s))); details.append(list, node('p', `Saved report ID: ${facts.report_id}`, 'report-facts-note')); body.append(details);
    return section;
  }
  window.TLIReportFacts = { validate, render };
})();
