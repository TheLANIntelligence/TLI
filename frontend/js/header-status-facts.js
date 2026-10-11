/* Shared header presentation only: no requests, timers, persistence or actions. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./ui-health.js') : root.TLIUIHealth);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TLIHeaderStatusFacts = api;
})(typeof window === 'undefined' ? globalThis : window, function (health) {
  'use strict';
  const STALE_MS = 30000;
  const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 320) : '';
  const stamp = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 8640000000000000 ? value : null;
  const percent = value => health.percent(value);
  const pct = value => percent(value) === null ? 'Unknown' : `${Math.round(value)}%`;
  const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${Number(value.toFixed(1))} GB` : 'Unknown';
  const time = value => stamp(value) === null ? 'Not recorded' : new Date(value).toLocaleString();
  const entry = (label, detail, tone, rows, target = null) => ({label, detail, title: `${label} · ${detail}`, tone, rows, target});
  function build({observation = {}, ai = {}, host = {}, locked = false} = {}, now = Date.now()) {
    observation = observation || {}; ai = ai || {}; host = host || {};
    if (locked || host.status === 'locked') {
      const result = {};
      for (const key of ['host', 'storage', 'devices', 'ai']) result[key] = entry('Locked', 'Unlock TLI to check', 'muted', [['Status', 'Unlock TLI to check']]);
      return {...result, nextChangeAt: null};
    }
    const deadlines = [];
    const later = value => { if (Number.isFinite(value) && value > now) deadlines.push(value); };
    const state = observation.state || {};
    const observed = health.observation(observation, now);
    const clock = observation.observationClock;
    if (observed.stamp !== null && !observation.monitoringUnavailable && !state.probe_error) {
      if (clock && Number.isFinite(clock.receivedAt) && Number.isFinite(clock.ageAtReceipt) && clock.ageAtReceipt >= 0) later(clock.receivedAt + STALE_MS - clock.ageAtReceipt);
      else if (!clock) later(observed.stamp + STALE_MS);
    }
    const hostName = clean(host.name);
    const cpu = observed.stamp === null ? null : percent(state.cpu_pct);
    const ram = observed.stamp === null ? null : percent(state.ram_pct);
    const metricDetail = `CPU ${pct(cpu)} · Memory ${pct(ram)}`;
    const hostDetail = `${metricDetail} · ${observed.label}`;
    const hostFacts = entry(hostName || 'Host unknown', hostDetail,
      ['stale', 'unavailable'].includes(observed.freshness) ? 'warning' : hostName ? 'neutral' : 'muted',
      [['TLI host', hostName || 'Not confirmed'], ['CPU', pct(cpu)], ['Memory', pct(ram)], ['System readings', observed.label], ['Observed', time(observed.stamp)]]);

    const disk = observation.storage?.system || observation.storage || {};
    const used = percent(disk.pct);
    const storageAt = stamp(observation.storageCheckedAt);
    const unavailable = observation.monitoringUnavailable === true || observation.storageUnavailable === true;
    const storageAge = storageAt === null ? null : now - storageAt;
    const storageState = unavailable ? 'unavailable' : storageAge === null || storageAge < -5000 ? 'unknown' : storageAge >= STALE_MS ? 'stale' : 'fresh';
    if (used !== null && storageAt !== null && storageState === 'fresh') later(storageAt + STALE_MS);
    const drive = clean(disk.drive) || clean(disk.mount) || 'System drive';
    const capacity = `${amount(disk.free_gb)} free of ${amount(disk.total_gb)}`;
    const storageStatus = {fresh: 'Latest storage reading', stale: 'Previous reading', unavailable: used === null ? 'Storage unavailable' : 'Refresh unavailable; previous reading retained', unknown: 'Storage freshness not confirmed'}[storageState];
    const suffix = {fresh: '', stale: ' · Previous', unavailable: ' · Unavailable', unknown: ' · Not confirmed'}[storageState];
    const storageFacts = entry(used === null ? 'Storage unknown' : `${pct(used)} used${suffix}`,
      `${drive} · ${capacity} · ${storageStatus}`,
      used !== null && used >= 95 ? 'critical' : used !== null && used >= 85 ? 'warning' : storageState === 'fresh' ? 'neutral' : used === null ? 'muted' : 'warning',
      [['Drive', drive], ['Used', pct(used)], ['Free', amount(disk.free_gb)], ['Capacity', amount(disk.total_gb)], ['Storage readings', storageStatus], ['Checked', time(storageAt)]],
      used !== null ? clean(disk.mount) || null : null);

    const count = Number.isInteger(observation.devCount) && observation.devCount >= 0 ? observation.devCount : null;
    const names = Array.isArray(observation.devNames) ? observation.devNames.map(clean).filter(Boolean) : [];
    const deviceDetail = count === null ? 'Registered device inventory has not been confirmed' : 'Registered smart devices; availability is checked in Smart home';
    const deviceRows = [['Registered devices', count === null ? 'Not confirmed' : String(count)], ['Availability', 'Not established by the registered count']];
    if (count !== null && count > 0 && names.length) deviceRows.push(['Names', names.slice(0, count).join(', ')]);
    if (observation.monitoringUnavailable) deviceRows.push(['Inventory', 'Refresh unavailable; retained inventory']);
    const deviceFacts = entry(count === null ? 'Devices unknown' : `${count} device${count === 1 ? '' : 's'}`, deviceDetail, count === null ? 'muted' : 'neutral', deviceRows);

    const aiLabel = clean(ai.text).replace(/^AI:\s*/i, '') || 'AI unknown';
    const aiAt = stamp(ai.checkedAt);
    const aiAge = aiAt === null ? null : now - aiAt;
    const aiFresh = aiAge !== null && aiAge >= -5000 && aiAge < STALE_MS;
    const selected = ai.kind === 'lan-selected';
    const answered = ai.kind === 'answer';
    const aiStatus = selected ? 'Selected resource; availability checked when you send' : answered ? 'Source reported for an answer; not a new availability check' : !aiFresh ? 'Availability needs a fresh check' : ai.state === 'ok' ? 'Availability confirmed by latest check' : 'Availability not confirmed';
    if (aiFresh && !selected && !answered) later(aiAt + STALE_MS);
    const aiDetail = `${clean(ai.title) || 'Open AI settings for details.'} · ${aiStatus}`;
    const aiFacts = entry(aiLabel, aiDetail, ai.state === 'ok' && aiFresh && !selected && !answered ? 'good' : 'warning',
      [['AI source', aiLabel], ['Status', aiStatus], [answered ? 'Reported' : 'Checked', time(aiAt)]]);
    return {host: hostFacts, storage: storageFacts, devices: deviceFacts, ai: aiFacts, nextChangeAt: deadlines.length ? Math.min(...deadlines) : null};
  }
  return {build};
});
