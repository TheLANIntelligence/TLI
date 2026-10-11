const {test} = require('node:test');
const assert = require('node:assert/strict');
const {build} = require('../js/header-status-facts.js');

const now = 2000000;
function input() {
  return {
    host: {name: 'FOX', id: 'host-1', status: 'known'},
    observation: {
      state: {cpu_pct: 13, ram_pct: 36, probed_ts: now / 1000},
      observationClock: {receivedAt: now, ageAtReceipt: 0},
      storage: {ok: true, system: {pct: 98, drive: 'C:', mount: 'C:\\', free_gb: 9.7, total_gb: 476.3}},
      storageCheckedAt: now, devCount: 2, devNames: ['External HDD', 'PSVR 2'],
    },
    ai: {text: 'AI: Integrated', state: 'ok', kind: 'bundled', title: 'Latest runtime check confirmed availability.', checkedAt: now},
  };
}
const row = (facts, name) => facts.rows.find(item => item[0] === name)?.[1];

test('fresh facts keep host identity, registered devices, storage target and AI source separate', () => {
  const data = input();
  const facts = build(data, now);
  assert.equal(facts.host.label, 'FOX');
  assert.equal(row(facts.host, 'CPU'), '13%');
  assert.equal(facts.storage.label, '98% used');
  assert.equal(facts.storage.tone, 'critical');
  assert.equal(facts.storage.target, 'C:\\');
  assert.equal(row(facts.storage, 'Free'), '9.7 GB');
  assert.equal(facts.devices.label, '2 devices');
  assert.equal(row(facts.devices, 'Names'), 'External HDD, PSVR 2');
  assert.doesNotMatch(facts.devices.detail, /online/i);
  assert.equal(facts.ai.label, 'Integrated');
  assert.equal(facts.ai.tone, 'good');
  assert.equal(facts.nextChangeAt, now + 30000);
  assert.deepEqual(data, input(), 'presentation must not mutate shared snapshots');
});

test('critical storage remains critical after age expiry and after failed refresh', () => {
  const data = input();
  const aged = build(data, now + 30000);
  assert.equal(aged.storage.label, '98% used · Previous');
  assert.equal(aged.storage.tone, 'critical');
  assert.equal(aged.ai.tone, 'warning');
  assert.match(aged.ai.detail, /fresh check/);
  assert.equal(aged.nextChangeAt, null);
  data.observation.storageUnavailable = true;
  const failed = build(data, now + 10000);
  assert.equal(failed.storage.label, '98% used · Unavailable');
  assert.equal(failed.storage.tone, 'critical');
  assert.match(row(failed.storage, 'Storage readings'), /previous reading retained/);
  assert.equal(failed.storage.target, 'C:\\', 'recorded target navigation remains possible without implying a live check');
});

test('missing readings are unknown while measured zero stays valid', () => {
  const unknown = build({}, now);
  assert.equal(unknown.storage.label, 'Storage unknown');
  assert.equal(unknown.storage.target, null);
  assert.equal(unknown.devices.label, 'Devices unknown');
  assert.equal(row(unknown.host, 'CPU'), 'Unknown');
  assert.equal(unknown.nextChangeAt, null);
  const data = input();
  Object.assign(data.observation.state, {cpu_pct: 0, ram_pct: 0});
  Object.assign(data.observation.storage.system, {pct: 0, free_gb: 0});
  data.observation.devCount = 0;
  const zeros = build(data, now);
  assert.equal(row(zeros.host, 'CPU'), '0%');
  assert.equal(row(zeros.storage, 'Free'), '0 GB');
  assert.equal(zeros.storage.label, '0% used');
  assert.equal(zeros.devices.label, '0 devices');
  assert.equal(row(zeros.devices, 'Names'), undefined, 'stale name list cannot contradict zero registered devices');
});

test('locking clears all names, readings, targets and freshness work', () => {
  const data = input(); data.locked = true;
  const locked = build(data, now);
  for (const key of ['host', 'storage', 'devices', 'ai']) {
    assert.equal(locked[key].label, 'Locked');
    assert.equal(locked[key].target, null);
  }
  assert.equal(locked.nextChangeAt, null);
  assert.doesNotMatch(JSON.stringify(locked), /FOX|98%|External HDD|PSVR|Integrated|C:/);
  delete data.locked; data.host.status = 'locked';
  assert.deepEqual(build(data, now), locked, 'identity lock also clears presentation during event ordering');
});

test('server-clock skew uses recorded receipt age and schedules the first real freshness boundary', () => {
  const data = input();
  data.observation.state.probed_ts += 3600;
  data.observation.observationClock.ageAtReceipt = 12000;
  const fresh = build(data, now + 5000);
  assert.match(row(fresh.host, 'System readings'), /Latest/);
  assert.equal(fresh.nextChangeAt, now + 18000);
  const stale = build(data, now + 18000);
  assert.match(row(stale.host, 'System readings'), /stale/);
  assert.equal(stale.nextChangeAt, now + 30000, 'storage and AI retain independent remaining freshness');
});

test('AI LAN selection and actual-answer source never claim current model readiness', () => {
  const data = input();
  data.ai = {text: 'AI: Studio PC · Selected', state: 'warn', kind: 'lan-selected', checkedAt: now};
  const selected = build(data, now);
  assert.equal(selected.ai.label, 'Studio PC · Selected');
  assert.match(selected.ai.detail, /availability checked when you send/);
  assert.notEqual(selected.ai.tone, 'good');
  data.ai = {text: 'AI: Remote answer', state: 'ok', kind: 'answer', checkedAt: now};
  const answer = build(data, now);
  assert.match(answer.ai.detail, /not a new availability check/);
  assert.notEqual(answer.ai.tone, 'good');
});

test('storage target never falls back to a display label or unrelated metrics drive', () => {
  const data = input();
  delete data.observation.storage.system.mount;
  data.observation.state.disk_pct_by_drive = {'D:\\': 70};
  assert.equal(build(data, now).storage.target, null);
  data.observation.storage.system.pct = NaN;
  data.observation.storage.system.mount = 'C:\\';
  assert.equal(build(data, now).storage.target, null);
});

test('storage without a timestamp retains its reading with unknown freshness', () => {
  const data = input();
  data.observation.storageCheckedAt = null;
  assert.equal(build(data, now).storage.label, '98% used · Not confirmed');
  data.observation.storageCheckedAt = now + 6000;
  assert.match(build(data, now).storage.detail, /freshness not confirmed/);
});
