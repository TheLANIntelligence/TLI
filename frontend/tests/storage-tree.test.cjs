const test = require('node:test');
const assert = require('node:assert/strict');
const {performance} = require('node:perf_hooks');
const map = require('../js/storage-map.js');

const ROOT = '/scan';
function file(name,size,extra={}) {
  return {name,size,allocated_size:size,isDir:false,category:'Other',extension:name.match(/\.[^.]+$/)?.[0].toLowerCase() || '',...extra};
}
function folder(name,size,children=[],extra={}) {
  return {name,size,allocated_size:null,isDir:true,category:'Folder',children,...extra};
}
function model(tree) {
  const index = new Map(), pending = [{node:tree,path:ROOT,parentPath:null}];
  while (pending.length) {
    const {node,path,parentPath} = pending.pop(), children = node.children || [];
    index.set(path,{...node,path,parentPath,children:children.map(child=>path+'/'+child.name)});
    for (const child of children) pending.push({node:child,path:path+'/'+child.name,parentPath:path});
  }
  return map.build(index,ROOT);
}
function mixed() {
  return model(folder('Scan',100,[
    folder('Media',70,[file('a.mov',50,{allocated_size:64,category:'Video'}),file('b.JPG',20,{allocated_size:32,category:'Image'})]),
    file('small.txt',10,{allocated_size:16,category:'Document'}),
    file('alias.mov',0,{allocated_size:0,logical_size:50,hardlink_duplicate:true,category:'Video'}),
    file('unreadable.bin',null,{allocated_size:null}),
    file('(+2 more)',12,{synthetic:true,allocated_size:null,collapsed_entries:2,unknown_entries:3,size_partial:true}),
    folder('Restricted',null),folder('Empty',0,[],{allocated_size:0})
  ],{omitted_entries:4}));
}

test('tree expansion sorts siblings, keeps hierarchical order and never adds parent bytes twice',()=>{
  const m=mixed(),v=map.view(m,ROOT),expanded=new Set([ROOT+'/Media']);
  const result=map.tree(v,{expanded,sort:'size',direction:-1});
  assert.equal(result.total,100);
  assert.equal(result.rows.reduce((n,row)=>n+(row.hasChildren?0:row.matchedTotal),0),100);
  assert.deepEqual(result.rows.slice(0,3).map(row=>[row.item.name,row.depth]),[['Media',0],['a.mov',1],['b.JPG',1]]);
  const media=result.rows[0];
  assert.equal(media.context,true);assert.equal(media.expanded,true);assert.equal(media.matchedTotal,70);assert.equal(media.retainedFiles,2);
  assert.equal(result.rows.find(row=>row.item.name==='Restricted').unknown,1);
  assert.equal(result.rows.find(row=>row.item.name==='Empty').hasChildren,false);
  assert.deepEqual([...expanded],[ROOT+'/Media']);
  const collapsed=map.tree(v);
  assert.equal(collapsed.rows.find(row=>row.key===ROOT+'/Media').expanded,false);
  assert.equal(collapsed.rows.some(row=>row.key===ROOT+'/Media/a.mov'),false);
  assert.equal(collapsed.total,result.total);
  const withRoot=map.tree(v,{includeRoot:true});
  assert.equal(withRoot.rows[0].key,ROOT);assert.equal(withRoot.rows[0].depth,0);assert.equal(withRoot.rows[1].depth,1);
});

test('filtered leaf matches retain only their ancestors and can expand matches without changing saved expansion',()=>{
  const m=mixed(),expanded=new Set(),v=map.view(m,ROOT,item=>item.extension==='.jpg');
  const result=map.tree(v,{expanded,expandMatches:true});
  assert.deepEqual(result.rows.map(row=>row.key),[ROOT+'/Media',ROOT+'/Media/b.JPG']);
  assert.equal(result.rows[0].matchedTotal,20);assert.equal(result.rows[0].item.size,70);
  assert.equal(result.total,20);assert.equal(result.scopeTotal,100);assert.equal(expanded.size,0);
  assert.equal(map.tree(v,{expanded}).rows.length,1);
  const scoped=map.view(m,ROOT+'/Media',item=>item.category==='Video');
  const nested=map.tree(scoped,{expandMatches:true});
  assert.deepEqual(nested.rows.map(row=>[row.key,row.depth]),[[ROOT+'/Media/a.mov',0]]);
  assert.equal(nested.scopeTotal,70);assert.equal(nested.total,50);
  assert.deepEqual(map.tree(map.view(m,ROOT,()=>false),{expandMatches:true}).rows,[]);
});

test('group membership and exclusions affect tree and map together while retaining original denominator',()=>{
  const m=mixed(),members=new Set([ROOT+'/Media/a.mov',ROOT+'/Media/b.JPG',ROOT+'/small.txt']);
  const excluded=new Set([ROOT+'/Media/b.JPG']),v=map.view(m,ROOT,()=>true,members,excluded);
  const result=map.tree(v,{expandMatches:true});
  assert.deepEqual(result.rows.map(row=>row.key),[ROOT+'/Media',ROOT+'/Media/a.mov',ROOT+'/small.txt']);
  assert.equal(result.total,60);assert.equal(result.matchedTotal,80);assert.equal(result.scopeTotal,100);
  assert.equal(result.hiddenBytes,20);assert.equal(result.hiddenCount,1);
  assert.equal(map.hierarchy(v).total,result.total);
});

test('unknown metrics sort last in either direction, preserving zero and unknown leaves',()=>{
  const m=mixed(),v=map.view(m,ROOT,()=>true,null,new Set(),'allocated_size');
  for(const direction of [1,-1]) {
    const rows=map.tree(v,{sort:'allocated_size',direction,expandMatches:true}).rows.filter(row=>row.depth===0);
    const firstUnknown=rows.findIndex(row=>row.item.allocated_size===null);
    assert.ok(firstUnknown>=0);assert.ok(rows.slice(firstUnknown).every(row=>row.item.allocated_size===null));
  }
  assert.equal(v.total,112);assert.equal(v.unknown,4);assert.equal(v.zero,2);
  const result=map.tree(v,{expandMatches:true});
  assert.equal(result.total,112);assert.equal(result.unknown,4);
  const media=result.rows.find(row=>row.key===ROOT+'/Media');
  assert.equal(media.matchedTotal,96);assert.equal(media.matchedAllocated,96);assert.equal(media.matchedLogical,70);
  const min=map.tree(map.view(m,ROOT,item=>map.weight(item,'allocated_size')!==null&&item.allocated_size>=1),{expandMatches:true});
  assert.equal(min.rows.some(row=>row.item.name==='Restricted'),false);
  assert.equal(min.rows.some(row=>row.item.name==='alias.mov'),false);
});

test('reveal returns scoped ancestor folders without mutating expansion or inventing paths for aggregate entries',()=>{
  const m=mixed(),expanded=new Set(['/old']);
  assert.deepEqual(map.ancestors(m,ROOT+'/Media/a.mov'),[ROOT,ROOT+'/Media']);
  assert.deepEqual(map.ancestors(m,ROOT+'/Media/a.mov',ROOT+'/Media'),[ROOT+'/Media']);
  assert.deepEqual(map.ancestors(m,ROOT+'/small.txt',ROOT+'/Media'),[]);
  assert.deepEqual(map.ancestors(m,'missing'),[]);assert.deepEqual(map.ancestors(m,ROOT),[]);
  assert.deepEqual([...map.reveal(m,ROOT+'/Media/a.mov',expanded)],['/old',ROOT,ROOT+'/Media']);
  assert.deepEqual([...expanded],['/old']);
  const aggregate=m.atoms.find(item=>item.sourceKey===ROOT+'/(+2 more)');
  assert.equal(aggregate.path,null);assert.equal(aggregate.actionable,false);
  assert.deepEqual(map.ancestors(m,aggregate.key),[ROOT]);
});

test('extension summaries count retained file paths and preserve hardlink accounting, grouped and unknown sizes',()=>{
  const m=mixed(),v=map.view(m,ROOT),summary=map.types(v);
  assert.equal(summary.total,100);assert.equal(summary.rows.reduce((n,row)=>n+row.total,0),100);
  assert.equal(summary.retainedFiles,5);assert.equal(summary.unknown,2);assert.equal(summary.groupedBytes,20);assert.equal(summary.groupedUnknown,3);
  const video=summary.rows.find(row=>row.extension==='.mov');
  assert.equal(video.size,50);assert.equal(video.files,2);assert.equal(video.hardlinkAliases,1);assert.equal(video.allocated_size,64);
  const grouped=summary.rows.find(row=>row.kind==='grouped');
  assert.equal(grouped.extension,null);assert.equal(grouped.size,20);assert.equal(grouped.files,0);assert.equal(grouped.members.length,2);
  assert.equal(grouped.allocated_size,null);assert.equal(grouped.groupedUnknown,3);assert.equal(grouped.actionable,false);
  const unknown=summary.rows.find(row=>row.extension==='.bin');
  assert.equal(unknown.size,0);assert.equal(unknown.logicalUnknown,1);assert.equal(unknown.size_partial,true);
  const dirs=summary.rows.find(row=>row.kind==='folders');
  assert.equal(dirs.extension,null);assert.equal(dirs.files,0);assert.equal(dirs.logicalUnknown,1);assert.equal(dirs.members.length,2);
  const allocations=map.types(map.view(m,ROOT,()=>true,null,new Set(),'allocated_size'),{sort:'allocated_size'});
  assert.equal(allocations.total,112);assert.equal(allocations.rows.reduce((n,row)=>n+row.total,0),112);assert.equal(allocations.unknown,4);
  assert.ok(m.atoms.find(item=>item.hardlink_duplicate).actionable===false);
});

test('no-extension files remain filterable independently of grouped bytes and source records remain unchanged',()=>{
  const m=model(folder('Scan',7,[file('README',3),file('archive.LOG',4,{extension:'.LOG'}),folder('Empty',0)]));
  const before=JSON.stringify([...m.index]),atoms=JSON.stringify(m.atoms);
  const summary=map.types(map.view(m,ROOT),{sort:'name',direction:1});
  assert.equal(summary.rows.find(row=>row.extension==='').size,3);
  assert.equal(summary.rows.find(row=>row.extension==='.log').size,4);
  assert.equal(summary.rows.find(row=>row.extension===null).kind,'folders');
  assert.deepEqual(map.types(map.view(m,ROOT,item=>item.name==='README')).rows.map(row=>row.extension),['']);
  map.tree(map.view(m,ROOT),{expandMatches:true});map.reveal(m,ROOT+'/README');
  assert.equal(JSON.stringify([...m.index]),before);assert.equal(JSON.stringify(m.atoms),atoms);
  assert.throws(()=>map.tree(map.view(m,ROOT),{sort:'arbitrary'}),/sort/);
});

test('25000 indexed entries remain bounded with iterative tree, filter, type and reveal operations',()=>{
  const started=performance.now(),children=[];
  // Root +49 branches with500 files +one branch with449 files =25000 nodes.
  for(let group=0;group<50;group++) {
    const amount=group===49?449:500;
    children.push(folder('dir-'+String(group).padStart(2,'0'),amount,Array.from({length:amount},(_,i)=>file('file-'+i+'.dat',1))));
  }
  const m=model(folder('Scan',24949,children));
  assert.equal(m.index.size,25000);assert.equal(m.atoms.length,24949);
  const view=map.view(m,ROOT),result=map.tree(view,{expandMatches:true});
  assert.equal(result.rows.length,24999);assert.equal(result.total,24949);
  assert.equal(result.rows.filter(row=>!row.hasChildren).reduce((n,row)=>n+row.matchedTotal,0),24949);
  const summary=map.types(view);assert.equal(summary.rows.length,1);assert.equal(summary.retainedFiles,24949);assert.equal(summary.rows[0].size,24949);
  let examined=0;
  const filtered=map.view(m,ROOT,item=>{examined++;return item.name==='file-17.dat';});
  assert.equal(examined,m.atoms.length);
  const found=map.tree(filtered,{expandMatches:true});assert.equal(found.rows.length,100);assert.equal(found.total,50);
  const expanded=map.reveal(m,ROOT+'/dir-49/file-17.dat');
  const narrow=map.tree(view,{expanded});assert.equal(narrow.rows.length,499);
  // Generous guard catches accidental quadratic traversal without timing normal rendering.
  assert.ok(performance.now()-started<5000,'Pure25000-entry explorer operations should complete within5s.');
});

test('malformed repeated child references fail closed instead of traversing without a bound',()=>{
  const index=new Map([[ROOT,{path:ROOT,name:'Scan',parentPath:null,isDir:true,size:2,children:[ROOT+'/x',ROOT+'/x']}],
    [ROOT+'/x',{path:ROOT+'/x',parentPath:ROOT,name:'x',size:1,isDir:false,children:[]}]]);
  assert.throws(()=>map.build(index,ROOT),/more than once/);
});
