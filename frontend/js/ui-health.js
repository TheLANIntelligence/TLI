/* Presentation facts; no probes, routing, timers or model lifecycle changes. */
(function (root) {
  'use strict';
  const percent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  function observation(data = {}, now = Date.now()) {
    const state = data.state || {};
    const stamp = typeof state.probed_ts === 'number' && Number.isFinite(state.probed_ts) && state.probed_ts > 0 && state.probed_ts <= 8640000000000 ? state.probed_ts * 1000 : null;
    // Presence records server-relative age at receipt so a phone's clock does
    // not disagree with the host. Keep the original probe time for display.
    const clock = data.observationClock;
    const age = stamp === null ? null : clock
      ? Number.isFinite(clock.ageAtReceipt) && Number.isFinite(clock.receivedAt) ? clock.ageAtReceipt + Math.max(0, now - clock.receivedAt) : null
      : now - stamp;
    const complete = percent(state.cpu_pct) !== null && percent(state.ram_pct) !== null;
    const freshness = data.monitoringUnavailable || state.probe_error ? 'unavailable' : age === null || age < -5000 ? 'unknown' : age >= 30000 ? 'stale' : complete ? 'fresh' : 'incomplete';
    return {stamp, freshness, label: {unavailable:stamp ? 'Monitoring unavailable; previous results retained' : 'Monitoring unavailable; no successful readings yet',unknown:'System monitoring unavailable',stale:'System readings stale',incomplete:'System readings incomplete',fresh:'Latest system readings received'}[freshness]};
  }
  function meshNode(node = {}) {
    return {
      availability: node.online === false ? 'Not reachable' : node.online === true && !node.error ? 'Reported online' : 'Status unknown',
      ai: node.ai_healthy === true ? 'AI ready' : node.ai_healthy === false ? 'AI unavailable' : 'AI status unknown',
      cpu: percent(node.cpu_percent), ram: percent(node.ram_percent),
    };
  }
  function dashboard(data = {}, now = Date.now()) {
    const source = data.aiSource;
    const ai = data.aiOk === true, lm = data.lmOnline === true;
    const known = typeof data.aiOk === 'boolean' && typeof data.lmOnline === 'boolean';
    const alerts = Array.isArray(data.activeAlerts) ? data.activeAlerts : [];
    const attention = alerts.some(a => ['critical','warn','warning','error'].includes(a.severity));
    const observed = observation(data, now);
    const good = observed.freshness === 'fresh' && !attention;
    return {
      aiLabel: source ? String(source.text || 'AI: Not confirmed').replace(/^AI:\s*/, '') : ai ? 'Bundled' : lm ? 'LM Studio' : known ? 'Unavailable' : 'Unknown',
      aiDetail: source ? source.title || 'Check AI availability in the model library' : ai ? 'Bundled runtime confirmed ready' : lm ? 'LM Studio confirmed ready' : known ? 'No AI provider confirmed ready' : 'AI readiness could not be checked',
      orb: attention ? 'warn' : good ? 'good' : 'idle',
      aiReady: source ? source.state === 'ok' : ai || lm,
      observed,
    };
  }
  const api = {dashboard, observation, meshNode, percent};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TLIUIHealth = api;
})(typeof window === 'undefined' ? null : window);
