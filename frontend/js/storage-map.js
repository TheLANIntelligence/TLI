/* Pure representation of one validated storage observation. No I/O or actions. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TLIStorageMap = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const number = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const sum = rows => rows.reduce((n, row) => n + (number(row.size) ? row.size : 0), 0);
  const weight = (item, metric = 'size') => number(item[metric]) ? item[metric] : null;
  const measured = (rows, metric) => rows.reduce((n, row) => n + (weight(row, metric) || 0), 0);
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
  function build(index, rootPath) {
    const top = index.get(rootPath);
    if (!top || index.size > 25000) throw Error('The saved tree is unavailable or exceeds its representation limit.');
    const order = [], pending = [top], totals = new Map(), atoms = [], seen = new Set();
    while (pending.length) {
      const item = pending.pop();
      if (seen.has(item.path)) throw Error('A recorded entry occurs more than once in its tree.');
      seen.add(item.path); order.push(item);
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
      const value = {...item, key:item.path, ancestors:ancestry(item), actionable:!item.isDir && !item.synthetic && !item.hardlink_duplicate, ...changes};
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
          allocated_size:number(item.allocated_size) && children.every(child => number(child.allocated_size)) && item.allocated_size >= measured(children,'allocated_size') ? item.allocated_size-measured(children,'allocated_size') : null,
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
  function view(model, focus, predicate = () => true, group = null, excluded = new Set(), metric = 'size') {
    if (!['size','allocated_size'].includes(metric)) throw Error('Unsupported size metric.');
    const scoped = model.atoms.filter(item => item.path === focus || item.ancestors.includes(focus));
    const matched = scoped.filter(item => (!group || group.has(item.key)) && predicate(item));
    // Exclusions change only the displayed area. Keep the original scope and matching
    // byte totals available so hidden content cannot resemble recovered disk space.
    const hidden = matched.filter(item => excluded.has(item.key));
    const rows = matched.filter(item => !excluded.has(item.key));
    return {model, focus, metric, rows, total:measured(rows,metric), scopeTotal:measured(scoped,metric), matchedTotal:measured(matched,metric),
      hiddenBytes:measured(hidden,metric), hiddenCount:hidden.length, unknown:rows.filter(item => weight(item,metric) === null).length,
      zero:rows.filter(item => item[metric] === 0).length, aggregateBytes:measured(rows.filter(item => item.aggregate),metric),
      groupedUnknown:rows.filter(item => item.aggregate).reduce((n,item)=>n+(count(item.unknown_entries)||0),0)};
  }
  function ancestors(model, key, focus = model.root) {
    const atom = model.byKey.get(key), item = atom || model.index.get(key);
    if (!item || key === focus) return [];
    let paths;
    if (atom) paths = atom.ancestors;
    else {
      paths = []; let parent = model.index.get(item.parentPath);
      while (parent) {
        if (paths.length > 64) throw Error('Recorded folder nesting exceeds the supported limit.');
        paths.unshift(parent.path); parent = model.index.get(parent.parentPath);
      }
    }
    const at = paths.indexOf(focus);
    return at < 0 ? [] : paths.slice(at);
  }
  function reveal(model, key, expanded = new Set(), focus = model.root) {
    const result = new Set(expanded);
    for (const path of ancestors(model,key,focus)) result.add(path);
    return result;
  }
  function siblingOrder(sort, direction) {
    if (!['name','category','size','allocated_size','files','modified_at'].includes(sort) || ![1,-1].includes(direction)) throw Error('Unsupported tree sort.');
    return (a,b) => {
      let left = a[sort], right = b[sort], numeric = ['size','allocated_size','files','modified_at'].includes(sort);
      if (sort === 'modified_at') { left = Date.parse(left); right = Date.parse(right); }
      if (numeric) {
        const leftKnown = sort === 'modified_at' ? Number.isFinite(left) : number(left), rightKnown = sort === 'modified_at' ? Number.isFinite(right) : number(right);
        if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
        if (leftKnown && left !== right) return (left-right)*direction;
      } else {
        const difference = String(left || '').localeCompare(String(right || ''));
        if (difference) return difference*direction;
      }
      return String(a.key || a.path).localeCompare(String(b.key || b.path));
    };
  }
  // Only matching atoms contribute bytes. Folders provide context and never add
  // their recorded totals a second time; expansion changes rows, not accounting.
  function tree(view, {expanded = new Set(), sort = 'size', direction = -1, includeRoot = false, expandMatches = false} = {}) {
    const order = siblingOrder(sort,direction), branches = new Map(), metric = view.metric || 'size';
    function branch(key, item, context) {
      if (!branches.has(key)) branches.set(key,{item,key,parentKey:null,context,children:new Set(),
        matchedTotal:0,matchedLogical:0,matchedAllocated:0,unknown:0,logicalUnknown:0,allocatedUnknown:0,retainedFiles:0});
      const node = branches.get(key);
      if (!context) { node.item = item; node.context = false; }
      return node;
    }
    branch(view.focus,view.model.index.get(view.focus),true);
    for (const item of view.rows) {
      const route = [...ancestors(view.model,item.key,view.focus),item.key];
      let parent = null;
      for (let i = 0; i < route.length; i++) {
        const key = route[i], leaf = i === route.length-1;
        const node = branch(key,leaf ? item : view.model.index.get(key),!leaf);
        if (parent) { parent.children.add(key); node.parentKey = parent.key; }
        node.matchedTotal += weight(item,metric) || 0;
        node.matchedLogical += weight(item,'size') || 0;
        node.matchedAllocated += weight(item,'allocated_size') || 0;
        node.unknown += weight(item,metric) === null ? 1 : 0;
        node.logicalUnknown += weight(item,'size') === null ? 1 : 0;
        node.allocatedUnknown += weight(item,'allocated_size') === null ? 1 : 0;
        node.retainedFiles += !item.isDir && !item.aggregate ? 1 : 0;
        parent = node;
      }
    }
    const rows = [], stack = [{node:branches.get(view.focus),depth:includeRoot ? 0 : -1}];
    while (stack.length) {
      const {node,depth} = stack.pop(), hasChildren = node.children.size > 0;
      const opened = hasChildren && (node.key === view.focus || expandMatches || expanded.has(node.key));
      if (includeRoot || node.key !== view.focus) {
        const {children,...row} = node;
        rows.push({...row,depth,hasChildren,expanded:opened});
      }
      if (opened) {
        const children = [...node.children].map(key=>branches.get(key)).sort((a,b)=>order(a.item,b.item));
        for (let i = children.length-1; i >= 0; i--) stack.push({node:children[i],depth:depth+1});
      }
    }
    return {rows,total:view.total,matchedTotal:view.matchedTotal,scopeTotal:view.scopeTotal,hiddenBytes:view.hiddenBytes,hiddenCount:view.hiddenCount,
      unknown:view.unknown,zero:view.zero,aggregateBytes:view.aggregateBytes,groupedUnknown:view.groupedUnknown};
  }
  function types(view, {sort = 'size', direction = -1} = {}) {
    const order = siblingOrder(sort,direction), groups = new Map(), metric = view.metric || 'size';
    for (const item of view.rows) {
      const kind = item.aggregate ? 'grouped' : item.isDir ? 'folders' : 'extension';
      const extension = kind === 'extension' ? String(item.extension ?? (item.name.match(/\.[^.]+$/)?.[0] || '')).toLowerCase() : null;
      const key = kind === 'extension' ? 'extension:'+JSON.stringify(extension) : kind;
      if (!groups.has(key)) groups.set(key,{key,extension,kind,name:kind === 'grouped' ? 'Grouped contents' : kind === 'folders' ? 'Empty or unknown folders' : extension || '(no extension)',
        category:kind === 'extension' ? item.category : kind === 'folders' ? 'Folder' : 'Grouped',members:[],size:0,allocated_size:0,allocated_known_bytes:0,total:0,
        unknown:0,logicalUnknown:0,allocatedUnknown:0,files:0,hardlinkAliases:0,groupedUnknown:0,size_partial:false,actionable:false});
      const row = groups.get(key);
      row.members.push(item.key); row.size += weight(item,'size') || 0;
      row.allocated_known_bytes += weight(item,'allocated_size') || 0;
      row.total += weight(item,metric) || 0;
      row.logicalUnknown += weight(item,'size') === null ? 1 : 0;
      row.allocatedUnknown += weight(item,'allocated_size') === null ? 1 : 0;
      row.unknown += weight(item,metric) === null ? 1 : 0;
      row.files += kind === 'extension' ? 1 : 0;
      row.hardlinkAliases += item.hardlink_duplicate ? 1 : 0;
      row.groupedUnknown += item.aggregate ? count(item.unknown_entries) || 0 : 0;
      row.size_partial = row.size_partial || item.size_partial === true || weight(item,'size') === null;
    }
    const rows = [...groups.values()];
    for (const row of rows) row.allocated_size = row.allocatedUnknown ? null : row.allocated_known_bytes;
    rows.sort(order);
    return {rows,total:view.total,retainedFiles:rows.reduce((n,row)=>n+row.files,0),unknown:view.unknown,groupedBytes:view.aggregateBytes,groupedUnknown:view.groupedUnknown};
  }
  function hierarchy(view, maxLeaves = 240) {
    if (!Number.isSafeInteger(maxLeaves) || maxLeaves < 2 || maxLeaves > 500) throw Error('Invalid map display limit.');
    const metric = view.metric || 'size';
    const positive = view.rows.filter(item => weight(item,metric) > 0).sort((a,b) => b[metric]-a[metric] || a.key.localeCompare(b.key));
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
      parent.children.push({name:item.name,weight:item[metric],item});
    }
    if (omitted.length) {
      const item = {key:'display-remainder',path:null,parentPath:view.focus,name:'Other mapped entries',size:sum(omitted),
        category:'Grouped',synthetic:true,aggregate:true,actionable:false,entries:omitted.length,members:omitted.map(n=>n.key),
        allocated_size:omitted.every(row => number(row.allocated_size)) ? measured(omitted,'allocated_size') : null,
        reason:'Grouped for display only. Open this group to inspect its retained entries; no files are selected.'};
      tree.children.push({name:item.name,weight:measured(omitted,metric),item});
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
  return Object.freeze({build,view,tree,types,ancestors,reveal,hierarchy,layout,sum,weight});
});
