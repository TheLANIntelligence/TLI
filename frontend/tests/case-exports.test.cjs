const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto, createHash } = require('node:crypto');
const code = fs.readFileSync(path.join(__dirname, '../js/case-exports.js'), 'utf8');
const hash = raw => createHash('sha256').update(raw).digest('hex');
const row = () => ({id:'case-'+'a'.repeat(32),revision:'b'.repeat(64),title:'Private printer issue',evidence:[
  {kind:'note',id:'note-one',revision:'c'.repeat(64),label:'Private cable fix',availability:'current'},
  {kind:'report',id:'report-one',revision:'d'.repeat(64),label:'Yesterday',availability:'changed'}]});
const packet = (body='Reviewed private fix', format='html') => ({ok:true,protocol:'tli-case-export-v1',actions_performed:false,source_unchanged:true,
  checked_at:'2026-09-08T12:00:00Z',format,preview:body,bytes:Buffer.byteLength(body),preview_sha256:hash(body),review_token:'e'.repeat(64),expires_in_seconds:600,
  filename:'tli-troubleshooting.'+({html:'html',text:'txt',json:'json'}[format])});
function walk(n){return n.children.flatMap(c=>[c,...walk(c)]);}
function fixture(){
  const events={},calls=[],downloads=[],urls=[];let response=async()=>({json:packet()});let doc;
  function el(tag){const n={tag,children:[],dataset:{},attrs:{},handlers:{},value:'',checked:false,disabled:false,hidden:false,textContent:'',open:false,
    classList:{toggle(){}},append(...rows){for(const r of rows){r.parent=this;this.children.push(r)}},replaceChildren(...rows){this.children=[];this.append(...rows)},
    addEventListener(k,f){(this.handlers[k]||=[]).push(f)},fire(k,e={}){return Promise.all((this.handlers[k]||[]).map(f=>f(e)))},click(){if(this.tag==='a'){downloads.push({href:this.href,name:this.download});return Promise.resolve()}return this.disabled?Promise.resolve():this.fire('click')},
    remove(){this.parent.children=this.parent.children.filter(x=>x!==this)},focus(){doc.activeElement=this},setAttribute(k,v){this.attrs[k]=v},
    showModal(){this.open=true},close(){this.open=false;this.fire('close')},
    querySelectorAll(s){return walk(this).filter(n=>s==='[data-export-content]'?n.dataset.exportContent:s.split(',').includes(n.tag))}};return n;}
  const body=el('body');doc={body,activeElement:null,hidden:false,createElement:el,getElementById:id=>walk(body).find(n=>n.id===id),addEventListener:(k,f)=>(events[k]||=[]).push(f)};
  const win={addEventListener:doc.addEventListener,dispatchEvent:e=>(events[e.type]||[]).forEach(f=>f(e))};
  vm.runInNewContext(code,{window:win,document:doc,crypto:webcrypto,TextEncoder,Uint8Array,Blob,AbortController,
    URL:{createObjectURL:b=>{urls.push(b);return 'blob:synthetic-'+urls.length},revokeObjectURL(){}},setTimeout:()=>0,CustomEvent:class{constructor(type){this.type=type}},
    fetch:async(url,options)=>{calls.push({url,options,body:JSON.parse(options.body)});const data=await response(url,options);return{
      ok:!data.status,status:data.status||200,json:async()=>data.json,headers:{get:k=>data.headers?.[k]||null},arrayBuffer:async()=>Uint8Array.from(Buffer.from(data.bytes||'')).buffer}}});
  return{doc,win,calls,downloads,urls,api:win.TLICaseExport,n:id=>doc.getElementById(id),handler:f=>response=f,
    fire:name=>Promise.all((events[name]||[]).map(f=>f())),text:()=>walk(body).map(n=>n.textContent||'').join(' ')};
}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function ready(f){f.api.open(row());await f.n('case-export-preview-button').click();}

test('opening only shows explicit selection; notes and bodies start excluded; stale bodies disabled',()=>{
  const f=fixture();f.api.open(row());assert.equal(f.calls.length,0);assert.equal(f.n('case-export-choose-0').checked,false);
  assert.equal(f.n('case-export-content-0').checked,false);assert.equal(f.n('case-export-content-1').disabled,true);
  assert.equal(f.n('case-export-identifiers').checked,true);assert.equal(f.n('case-export-download').disabled,true);
});
test('preview strictly captures opt-in evidence and literal terms, without downloading or interpreting HTML',async()=>{
  const f=fixture();f.api.open(row());f.n('case-export-content-0').checked=true;await f.n('case-export-content-0').fire('change');
  f.n('case-export-terms').value='A literal name\nprivate phrase';await f.n('case-export-preview-button').click();
  assert.deepEqual(f.calls[0].body.evidence,[{kind:'note',id:'note-one',revision:'c'.repeat(64),include_content:true}]);
  assert.deepEqual(f.calls[0].body.redactions.terms,['A literal name','private phrase']);assert.equal(f.calls[0].options.redirect,'error');
  const frame=f.n('case-export-output').children[0];assert.equal(frame.tag,'iframe');assert.equal(frame.attrs.sandbox,'');assert.equal(frame.srcdoc,'Reviewed private fix');assert.equal(f.downloads.length,0);
});
test('duplicate preview is coalesced and a reviewed download matches the exact checksum',async()=>{
  const f=fixture();f.api.open(row());let resolve;f.handler(()=>new Promise(r=>resolve=r));
  const p=f.n('case-export-preview-button').fire('click');await turn();await f.n('case-export-preview-button').fire('click');assert.equal(f.calls.length,1);
  resolve({json:packet()});await p;f.n('case-export-reviewed').checked=true;await f.n('case-export-reviewed').fire('change');
  let downloadResolve;f.handler(()=>new Promise(r=>downloadResolve=r));const d=f.n('case-export-download').fire('click');await turn();await f.n('case-export-download').fire('click');assert.equal(f.calls.length,2);
  downloadResolve({bytes:'Reviewed private fix',headers:{'X-TLI-Export-SHA256':hash('Reviewed private fix')}});await d;
  assert.equal(f.downloads.length,1);assert.equal(f.downloads[0].name,'tli-troubleshooting.html');assert.equal(f.calls[1].body.reviewed,true);assert.deepEqual(f.calls[1].body.selection,f.calls[0].body);
  assert.match(f.n('case-export-status').textContent,/offered.*Confirm the file was saved/);
});
test('selection changes invalidate consent and keep previous preview visible for review',async()=>{
  const f=fixture();await ready(f);f.n('case-export-reviewed').checked=true;await f.n('case-export-reviewed').fire('change');
  f.n('case-export-terms').value='new secret';await f.n('case-export-terms').fire('input');
  assert.equal(f.n('case-export-download').disabled,true);assert.equal(f.n('case-export-reviewed').checked,false);
  assert.equal(f.n('case-export-output').children[0].srcdoc,'Reviewed private fix');
  f.handler(async()=>({status:409,json:{detail:'Changed source'}}));await f.n('case-export-preview-button').click();
  assert.match(f.n('case-export-status').textContent,/Changed source.*retained/);assert.equal(f.n('case-export-terms').value,'new secret');assert.equal(f.n('case-export-download').disabled,true);
});
test('failed download retains preview and never replays or claims saved file',async()=>{
  const f=fixture();await ready(f);f.n('case-export-reviewed').checked=true;await f.n('case-export-reviewed').fire('change');
  f.handler(async()=>({status:409,json:{detail:'The evidence revision changed'}}));await f.n('case-export-download').click();
  assert.match(f.n('case-export-status').textContent,/revision changed.*no request was replayed/);assert.equal(f.downloads.length,0);assert.equal(f.calls.length,2);
  assert.equal(f.n('case-export-output').children[0].srcdoc,'Reviewed private fix');
});
test('checksum mismatch and malformed preview cannot enable or produce a download',async()=>{
  const f=fixture();f.api.open(row());f.handler(async()=>({json:{...packet(),preview_sha256:'0'.repeat(64)}}));await f.n('case-export-preview-button').click();
  assert.equal(f.n('case-export-download').disabled,true);assert.match(f.n('case-export-status').textContent,/checksum/);
  f.handler(async()=>({json:packet()}));await f.n('case-export-preview-button').click();f.n('case-export-reviewed').checked=true;await f.n('case-export-reviewed').fire('change');
  f.handler(async()=>({bytes:'unexpected bytes',headers:{'X-TLI-Export-SHA256':hash('Reviewed private fix')}}));await f.n('case-export-download').click();
  assert.equal(f.downloads.length,0);assert.match(f.n('case-export-status').textContent,/differ/);
});
test('session lock clears all private content and ignores a late preview',async()=>{
  const f=fixture();await ready(f);let resolve;f.handler(()=>new Promise(r=>resolve=r));const p=f.n('case-export-preview-button').click();await turn();
  await f.fire('tli-session-locked');resolve({json:packet('LATE PRIVATE')});await p;
  assert.equal(f.n('case-export-dialog').open,false);assert.equal(f.text().includes('Private'),false);assert.equal(f.text().includes('LATE'),false);
  f.api.open(row());assert.equal(f.n('case-export-dialog').open,false);
});
test('backgrounding or closing ignores in-flight download and never creates a file',async()=>{
  const f=fixture();await ready(f);f.n('case-export-reviewed').checked=true;await f.n('case-export-reviewed').fire('change');let resolve;
  f.handler(()=>new Promise(r=>resolve=r));const p=f.n('case-export-download').click();await turn();f.doc.hidden=true;await f.fire('visibilitychange');
  resolve({bytes:'Reviewed private fix',headers:{'X-TLI-Export-SHA256':hash('Reviewed private fix')}});await p;
  assert.equal(f.downloads.length,0);assert.equal(f.n('case-export-dialog').children.length,0);
});
test('401 clears the view and the current-case guard prevents opening or accepting stale data',async()=>{
  const f=fixture();f.api.open(row(),{current:()=>false});assert.equal(f.n('case-export-dialog'),undefined);
  f.api.open(row());f.handler(async()=>({status:401,json:{detail:'Locked'}}));await f.n('case-export-preview-button').click();assert.equal(f.n('case-export-dialog').children.length,0);
});
test('no download before explicit consent; direct edits cannot reuse reviewed selection',async()=>{
  const f=fixture();await ready(f);await f.n('case-export-download').fire('click');assert.equal(f.calls.length,1);
  f.n('case-export-reviewed').checked=true;await f.n('case-export-reviewed').fire('change');f.n('case-export-terms').value='different';await f.n('case-export-download').fire('click');assert.equal(f.calls.length,1);
  assert.equal(f.downloads.length,0);assert.equal(f.n('case-export-reviewed').checked,false);
});

test('a queued native close from the previous export cannot clear a replacement review',async()=>{
  const f=fixture();f.api.open(row());const dialog=f.n('case-export-dialog');
  // Browsers queue the close event; reopening can happen before it is delivered.
  dialog.close=function(){this.open=false};f.api.close();
  f.api.open({...row(),title:'Replacement export'});
  await dialog.fire('close');
  assert.equal(dialog.open,true);assert.match(f.text(),/Replacement export/);
  assert.equal(f.calls.length,0);assert.equal(f.downloads.length,0);
});

test('a stale export authentication response cannot lock the replacement view',async()=>{
  const f=fixture();f.api.open(row());let finish;f.handler(()=>new Promise(r=>finish=r));
  const pending=f.n('case-export-preview-button').click();await turn();
  f.api.close();f.api.open({...row(),title:'Replacement export'});
  finish({status:401,json:{detail:'Old session expired'}});await pending;
  assert.equal(f.n('case-export-dialog').open,true);assert.match(f.text(),/Replacement export/);
  assert.equal(f.downloads.length,0);
});
