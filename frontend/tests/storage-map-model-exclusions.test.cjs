const test = require('node:test');
const assert = require('node:assert/strict');
const map = require('../js/storage-map.js');
const d3 = require('../assets/d3.v7.min.js');

// Normalized observations only: no application initialization, filesystem reads or jobs.
const root = 'C:\\';
function observation() {
  const media = 'C:\\Media';
  const nodes = [
    {path:root, name:'C:', size:1000, isDir:true, children:['C:\\hiberfil.sys', media, 'C:\\__MORE__', 'C:\\empty.txt', 'C:\\unknown.txt']},
    {path:'C:\\hiberfil.sys', name:'hiberfil.sys', size:600, category:'System', protected:true, parentPath:root},
    {path:media, name:'Media', size:150, isDir:true, parentPath:root, children:['C:\\Media\\film.mp4', 'C:\\Media\\cover.jpg']},
    {path:'C:\\Media\\film.mp4', name:'film.mp4', size:120, category:'Video', parentPath:media},
    {path:'C:\\Media\\cover.jpg', name:'cover.jpg', size:30, category:'Images', parentPath:media},
    {path:'C:\\__MORE__', name:'Collapsed paths', size:100, synthetic:true, collapsed_entries:5, unknown_entries:2, parentPath:root},
    {path:'C:\\empty.txt', name:'empty.txt', size:0, category:'Documents', parentPath:root},
    {path:'C:\\unknown.txt', name:'unknown.txt', size:null, category:'Documents', parentPath:root},
  ];
  return map.build(new Map(nodes.map(item => [item.path, item])), root);
}
function proportional(view) {
  const representation = map.hierarchy(view);
  const layout = map.layout(d3, representation, 800, 400);
  assert.equal(representation.total, view.total);
  assert.equal(layout.value, view.total);
  assert.equal(layout.leaves().reduce((total, leaf) => total + leaf.value, 0), view.total);
  if (view.total > 0) {
    for (const leaf of layout.leaves()) {
      const share = (leaf.x1 - leaf.x0) * (leaf.y1 - leaf.y0) / (800 * 400);
      assert.ok(Math.abs(share - leaf.value / view.total) < 1e-10, 'Remaining tile area uses only the displayed known bytes');
    }
  }
}

test('hiding a giant real file reveals the remaining bytes without changing the observed scope', () => {
  const model = observation(), excluded = new Set(['C:\\hiberfil.sys']);
  const view = map.view(model, root, undefined, null, excluded);
  assert.equal(view.scopeTotal, 1000);
  assert.equal(view.matchedTotal, 1000);
  assert.equal(view.hiddenBytes, 600);
  assert.equal(view.hiddenCount, 1);
  assert.equal(view.total, 400);
  assert.equal(view.rows.some(item => item.path === 'C:\\hiberfil.sys'), false);
  assert.equal(model.byKey.get('C:\\hiberfil.sys').protected, true);
  proportional(view);
});

test('unavailable-path aggregates can be hidden without acquiring actionable paths', () => {
  const model = observation(), groups = model.atoms.filter(item => item.aggregate);
  assert.equal(groups.length, 2);
  const view = map.view(model, root, undefined, null, new Set(groups.map(item => item.key)));
  assert.equal(view.hiddenBytes, 250);
  assert.equal(view.hiddenCount, 2);
  assert.equal(view.total, 750);
  assert.equal(view.aggregateBytes, 0);
  assert.equal(view.groupedUnknown, 0);
  for (const item of groups) {
    assert.equal(item.path, null);
    assert.equal(item.actionable, false);
  }
  assert.equal(model.aggregateBytes, 250);
  assert.equal(model.groupedUnknown, 2);
  proportional(view);
});

test('display-group exclusions use retained member keys and never hide an unrelated path', () => {
  const model = observation();
  const representation = map.hierarchy(map.view(model, root), 2);
  const group = representation.tree.children.find(item => item.item?.members).item;
  const grouped = new Set(group.members);
  const excluded = new Set([group.members[0], 'C:\\hiberfil.sys', 'missing-key']);
  const view = map.view(model, root, undefined, grouped, excluded);
  assert.equal(view.scopeTotal, 1000);
  assert.equal(view.matchedTotal, group.size);
  assert.equal(view.hiddenCount, 1);
  assert.equal(view.hiddenBytes, model.byKey.get(group.members[0]).size);
  assert.equal(view.total + view.hiddenBytes, group.size);
  assert.equal(view.rows.every(item => grouped.has(item.key) && !excluded.has(item.key)), true);
  proportional(view);
});

test('unknown-size and zero-byte exclusions affect counts without inventing known bytes', () => {
  const model = observation();
  const view = map.view(model, root, undefined, null, new Set(['C:\\empty.txt', 'C:\\unknown.txt']));
  assert.equal(view.hiddenCount, 2);
  assert.equal(view.hiddenBytes, 0);
  assert.equal(view.total, 1000);
  assert.equal(view.unknown, 0);
  assert.equal(view.zero, 0);
  assert.equal(view.groupedUnknown, 2);
  assert.equal(model.unknown, 1);
  proportional(view);
});

test('hidden counts and bytes honor folder scope, display filters and current group together', () => {
  const model = observation();
  const excluded = new Set(model.atoms.map(item => item.key));
  const group = new Set(['C:\\Media\\film.mp4', 'C:\\hiberfil.sys']);
  const view = map.view(model, 'C:\\Media', item => item.category === 'Video', group, excluded);
  assert.equal(view.scopeTotal, 150);
  assert.equal(view.matchedTotal, 120);
  assert.equal(view.hiddenCount, 1);
  assert.equal(view.hiddenBytes, 120);
  assert.equal(view.total, 0);
  assert.deepEqual(view.rows, []);
  proportional(view);
  const noMatch = map.view(model, 'C:\\Media', item => item.category === 'Images', group, excluded);
  assert.equal(noMatch.scopeTotal, 150);
  assert.equal(noMatch.matchedTotal, 0);
  assert.equal(noMatch.hiddenBytes, 0);
  assert.equal(noMatch.hiddenCount, 0);
});

test('reset restores all rows and original call signatures retain their behavior', () => {
  const model = observation(), before = map.view(model, root);
  const excluded = new Set(model.atoms.map(item => item.key));
  assert.equal(map.view(model, root, undefined, null, excluded).rows.length, 0);
  excluded.clear();
  const restored = map.view(model, root, undefined, null, excluded);
  assert.deepEqual(restored, before);
  assert.equal(before.matchedTotal, before.total);
  assert.equal(before.hiddenBytes, 0);
  assert.equal(before.hiddenCount, 0);
  const oldFiltered = map.view(model, root, item => item.category === 'Video', new Set(['C:\\Media\\film.mp4']));
  assert.equal(oldFiltered.total, 120);
  assert.equal(oldFiltered.matchedTotal, 120);
  assert.equal(oldFiltered.hiddenCount, 0);
});

test('exclusion, grouping and layout never mutate retained atoms, index records or caller sets', () => {
  const model = observation(), atoms = structuredClone(model.atoms), index = structuredClone([...model.index]);
  const group = new Set(model.atoms.map(item => item.key));
  const excluded = new Set(['C:\\hiberfil.sys', 'missing-key']);
  const view = map.view(model, root, undefined, group, excluded);
  proportional(view);
  assert.deepEqual(model.atoms, atoms);
  assert.deepEqual([...model.index], index);
  assert.deepEqual([...group], atoms.map(item => item.key));
  assert.deepEqual([...excluded], ['C:\\hiberfil.sys', 'missing-key']);
  for (const item of view.rows) assert.equal(item, model.byKey.get(item.key));
  assert.equal(model.total, 1000);
});
