/* Pure representation of one validated storage observation. No I/O or actions. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TLIStorageMap = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const number = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const sum = rows => rows.reduce((n, row) => n + (number(row.size) ? row.size : 0), 0);
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
  function build(index, rootPath) {
    const top = index.get(rootPath);
    if (!top || index.size > 25000) throw Error('The saved tree is unavailable or exceeds its representation limit.');
    const order = [], pending = [top], totals = new Map(), atoms = [];
    while (pending.length) {
      const item = pending.pop(); order.push(item);
      for (const path of item.children || []) {
        const child = index.get(path);
        if (!child || child.parentPath !== item.path) throw Error('A recorded child does not belong to its folder.');
        pending.push(child);
      }
    }
    const ancestry = item => {
      const result = []; let parent = index.get(item.parentPath);
      while (parent) {
        if (result.length > 64) throw Error('Recorded folder nesting exceeds the supported limit.');
        result.unshift(parent.path); parent = index.get(parent.parentPath);
      }
      return result;
    };
    function atom(item, changes = {}) {
      const value = {...item, key:item.path, ancestors:ancestry(item), actionable:!item.isDir && !item.synthetic, ...changes};
      atoms.push(value); return value;
    }
    for (const item of order.reverse()) {
      const children = (item.children || []).map(path => index.get(path));
      const childBytes = children.reduce((n, child) => n + totals.get(child.path), 0);
      if (number(item.size) && childBytes > item.size) throw Error('Recorded child sizes exceed their folder total. The previous observation was retained.');
      const total = number(item.size) ? item.size : childBytes;
      totals.set(item.path, total);
      if (item.synthetic) {
        if (children.length) throw Error('A grouped entry cannot contain actionable paths.');
        atom(item, {path:null, sourceKey:item.path, category:'Grouped', aggregate:true, actionable:false,
          entries:count(item.collapsed_entries), reason:'The host retained a grouped size, not individual paths.'+(item.unknown_entries?' '+item.unknown_entries+' additional unknown-size entries were reported inside this group.':'')});
      } else if (!item.isDir) atom(item);
      else {
        const missing = total - childBytes;
        if (missing > 0) atom(item, {key:'remainder:'+JSON.stringify(item.path), path:null, parentPath:item.path,
          ancestors:[...ancestry(item),item.path], name:'Other indexed contents', size:missing, isDir:false,
          category:'Grouped', synthetic:true, aggregate:true, actionable:false, entries:count(item.omitted_entries),
          reason:'These indexed bytes are included in the folder total; their individual paths were not retained.'});
        if (!children.length && total === 0) atom(item, {actionable:false});
      }
    }
    const total = sum(atoms);
    if (total !== totals.get(rootPath)) throw Error('The retained map does not account for the recorded folder total.');
    return {root:rootPath, index, atoms, byKey:new Map(atoms.map(item => [item.key,item])), total,
      aggregateBytes:sum(atoms.filter(item => item.aggregate)), unknown:atoms.filter(item => item.size === null).length,
      groupedUnknown:atoms.filter(item => item.aggregate).reduce((n,item)=>n+(count(item.unknown_entries)||0),0)};
  }
  function view(model, focus, predicate = () => true, group = null) {
    const scoped = model.atoms.filter(item => item.path === focus || item.ancestors.includes(focus));
    const rows = scoped.filter(item => (!group || group.has(item.key)) && predicate(item));
    return {model, focus, rows, total:sum(rows), scopeTotal:sum(scoped), unknown:rows.filter(item => item.size === null).length,
      zero:rows.filter(item => item.size === 0).length, aggregateBytes:sum(rows.filter(item => item.aggregate)),
      groupedUnknown:rows.filter(item => item.aggregate).reduce((n,item)=>n+(count(item.unknown_entries)||0),0)};
  }
  function hierarchy(view, maxLeaves = 240) {
    if (!Number.isSafeInteger(maxLeaves) || maxLeaves < 2 || maxLeaves > 500) throw Error('Invalid map display limit.');
    const positive = view.rows.filter(item => number(item.size) && item.size > 0).sort((a,b) => b.size-a.size || a.key.localeCompare(b.key));
    const kept = positive.length > maxLeaves ? positive.slice(0,maxLeaves-1) : positive;
    const omitted = positive.slice(kept.length), folders = new Map();
    const tree = {name:view.model.index.get(view.focus).name,path:view.focus,children:[]}; folders.set(view.focus,tree);
    for (const item of kept) {
      let parent = tree;
      const ancestors = item.ancestors.slice(item.ancestors.indexOf(view.focus)+1);
      for (const path of ancestors) {
        if (!folders.has(path)) {
          const folder = view.model.index.get(path), branch = {name:folder.name,path,children:[]};
          folders.set(path,branch); parent.children.push(branch);
        }
        parent = folders.get(path);
      }
      parent.children.push({name:item.name,weight:item.size,item});
    }
    if (omitted.length) {
      const item = {key:'display-remainder',path:null,parentPath:view.focus,name:'Other mapped entries',size:sum(omitted),
        category:'Grouped',synthetic:true,aggregate:true,actionable:false,entries:omitted.length,members:omitted.map(n=>n.key),
        reason:'Grouped for display only. Open this group to inspect its retained entries; no files are selected.'};
      tree.children.push({name:item.name,weight:item.size,item});
    }
    return {tree,total:view.total,positiveCount:positive.length,renderedLeaves:kept.length+(omitted.length?1:0),groupedCount:omitted.length};
  }
  function layout(d3, representation, width, height) {
    if (!number(width) || !number(height) || !width || !height) throw Error('Map dimensions are unavailable.');
    // Internal folder values are zero: summing their recorded total again would double-count every child.
    const tree = d3.hierarchy(representation.tree).sum(node => node.children ? 0 : node.weight || 0).sort((a,b)=>b.value-a.value);
    d3.treemap().tile(d3.treemapSquarify).size([width,height]).round(false).padding(0)(tree);
    return tree;
  }
  return Object.freeze({build,view,hierarchy,layout,sum});
});
