const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../js/mesh-control.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('  const escape ='), source.indexOf('  function fmt(')), context);
const ids = rows => Array.from(context.uniqueNodes(rows), row => row.peer_id);
const peer = (id, day, extra = {}) => ({peer_id:id, node_name:'Dell', ip:'192.168.4.135', port:8000,
  pairing_available:true, last_seen:`2026-10-${day}T12:00:00Z`, ...extra});

test('three unreviewed discoveries produce one current card without changing saved identities', () => {
  const rows = [peer('first', '09'), peer('current', '11'), peer('second', '10')];
  const original = JSON.stringify(rows);
  assert.deepEqual(ids(rows), ['current']);
  assert.deepEqual(ids(rows.slice().reverse()), ['current']);
  assert.equal(JSON.stringify(rows), original);
});

test('approving the current identity keeps older discoveries folded', () => {
  assert.deepEqual(ids([peer('old', '09'), peer('current', '11', {pairing_available:false, trust_state:'verified'})]), ['current']);
});

test('newer pending identity cannot hide or inherit an older reviewed or blocked record', () => {
  const rows = [peer('reviewed', '09', {pairing_available:false}), peer('blocked', '10', {pairing_available:false}), peer('new', '11')];
  assert.deepEqual(ids(rows), ['reviewed', 'blocked', 'new']);
});

test('names alone and distinct listener ports never collapse computers', () => {
  const rows = [peer('one', '09'), peer('other-ip', '10', {ip:'192.168.4.136'}), peer('other-port', '11', {port:8443})];
  assert.deepEqual(ids(rows), ['one', 'other-ip', 'other-port']);
});

test('unknown permission state and inference nodes remain separately visible', () => {
  const rows = [peer('unknown', '09', {pairing_available:undefined}), peer('compute', '10', {peer_profile:'inference_node'}), peer('new', '11')];
  assert.deepEqual(ids(rows), ['unknown', 'compute', 'new']);
});

test('ties and invalid timestamps resolve consistently, using registry identity', () => {
  const rows = [peer('a', '11', {last_seen:'not-a-date', node_id:'z'}), peer('b', '11', {last_seen:null, node_id:'a'})];
  assert.deepEqual(ids(rows), ['b']);
  assert.deepEqual(ids(rows.slice().reverse()), ['b']);
});
