const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const code=fs.readFileSync(require('node:path').join(__dirname,'../js/vault-backups.js'),'utf8');
const caps={ok:true,protocol:'tli-vault-backup-v1',limits:{archive_bytes:4400000000},recovery_available:true};
const result=()=>({ok:true,protocol:caps.protocol,checked_at:'2026-09-08T12:00:00Z',counts:{file:2,note:1,secrets:3,logins:1},checks:{archive_authenticated:true,all_entries_readable:true,entry_hashes:true},restored:false});
function fixture(){
  const nodes={},events={},calls=[];let handler=async()=>caps;
  function element(tag){
    const el={tag,children:[],dataset:{},attrs:{},handlers:{},value:'',checked:false,files:[],textContent:'',hidden:false,disabled:false,
      append(...items){this.children.push(...items)},setAttribute(k,v){this.attrs[k]=v},removeAttribute(k){delete this.attrs[k];delete this[k]},
      addEventListener(type,fn){(this.handlers[type]||=[]).push(fn)},
      fire(type,event={}){return Promise.all((this.handlers[type]||[]).map(fn=>fn(event)))},click(){return this.disabled?Promise.resolve():this.fire('click',{preventDefault(){}})}};
    Object.defineProperty(el,'id',{set(value){nodes[value]=el},get(){return Object.keys(nodes).find(k=>nodes[k]===el)}});return el;
  }
  nodes['vault-backups-mount']=element('div');
  const location={protocol:'https:',hostname:'tli.test'};
  const document={readyState:'complete',hidden:false,createElement:element,getElementById:id=>nodes[id],addEventListener(type,fn){(events[type]||=[]).push(fn)}};
  const context={document,location,Date,AbortController,FormData,crypto:webcrypto,window:{addEventListener:document.addEventListener},
    fetch:async(url,options)=>{calls.push({url,options});const value=await handler(url,options);return{status:value.http_status||200,ok:value.http_status?value.http_status<400:true,json:async()=>value}}};
  vm.runInNewContext(code,context);
  return{nodes,events,calls,location,handler(fn){handler=fn},emit(type,detail){return Promise.all((events[type]||[]).map(fn=>fn({detail})))},
    async ready(){await nodes['vb-refresh'].click();await this.emit('tli-vault-state-changed',{state:'unlocked'})},
    create(){nodes['vb-create-password'].value=nodes['vb-create-confirm'].value='synthetic-archive-password';nodes['vb-scope-confirm'].checked=true;return nodes['vb-create'].click()},
    archive(){nodes['vb-file'].files=[new File(['encrypted'],'fixture.tlivaultbackup')];nodes['vb-archive-password'].value='synthetic-archive-password'}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('mounting and navigation never create or check a Vault backup',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);assert.equal(f.nodes['vb-create'].disabled,true);
  await f.emit('tli-panel-switched',{panelId:'panel-main'});assert.equal(f.calls.length,0);
});
test('forced create cannot bypass scope, Vault lock or private transport checks',async()=>{
  const f=fixture();await f.ready();f.calls.length=0;
  await f.nodes['vb-create'].fire('click');assert.equal(f.calls.length,0);
  await f.emit('tli-vault-state-changed',{state:'locked'});await f.nodes['vb-create'].fire('click');assert.equal(f.calls.length,0);
  await f.emit('tli-vault-state-changed',{state:'unlocked'});f.location.protocol='http:';await f.nodes['vb-create'].fire('click');assert.equal(f.calls.length,0);assert.match(f.nodes['vb-error'].textContent,/No password was sent/);
});
test('one explicit source check has one POST and never claims to create an archive',async()=>{
  const f=fixture();await f.ready();f.handler(async()=>({...result(),checked:true,source_unchanged:true,archive_created:false}));await f.nodes['vb-check'].click();
  assert.equal(f.calls.filter(c=>c.options.method==='POST').length,1);assert.match(f.nodes['vb-check-result'].textContent,/No backup was created/);
});
test('duplicate create clicks cannot start two requests; completion only offers a prepared download',async()=>{
  const f=fixture();await f.ready();let done;f.handler(()=>new Promise(resolve=>done=resolve));const promise=f.create();await tick();await f.nodes['vb-create'].fire('click');
  assert.equal(f.calls.filter(c=>c.options.method==='POST').length,1);
  done({...result(),download_url:'/vault/backups/download/'+'a'.repeat(40),downloaded:false});await promise;
  assert.equal(f.nodes['vb-download'].hidden,false);assert.match(f.nodes['vb-create-result'].textContent,/not confirmed a saved copy/);assert.equal(f.nodes['vb-create-password'].value,'');
  await f.nodes['vb-download'].click();assert.match(f.nodes['vb-create-result'].textContent,/cannot confirm/);
});
test('late create after lock never exposes a download and clears entered passwords',async()=>{
  const f=fixture();await f.ready();let done;f.handler(()=>new Promise(resolve=>done=resolve));const promise=f.create();await tick();await f.emit('tli-session-locked');
  done({...result(),download_url:'/vault/backups/download/'+'a'.repeat(40),downloaded:false});await promise;
  assert.equal(f.nodes['vb-download'].hidden,true);assert.equal(f.nodes['vb-create-password'].value,'');assert.equal(f.nodes['vb-create-result'].textContent,'');
});
test('invalid download destinations and truthy fake verification cannot be presented as successful',async()=>{
  const f=fixture();await f.ready();f.handler(async()=>({...result(),download_url:'https://evil.invalid/',downloaded:false}));await f.create();assert.equal(f.nodes['vb-download'].hidden,true);
  f.archive();f.handler(async()=>({...result(),checks:{archive_authenticated:'yes',all_entries_readable:true,entry_hashes:true}}));await f.nodes['vb-verify'].click();assert.match(f.nodes['vb-error'].textContent,/not confirmed/);assert.equal(f.nodes['vb-verify-result'].textContent,'');
});
test('failed replacement verification retains the previous observed result',async()=>{
  const f=fixture();await f.ready();f.archive();f.handler(async()=>result());await f.nodes['vb-verify'].click();const before=f.nodes['vb-verify-result'].textContent;
  f.handler(async()=>({ok:false,http_status:422,detail:'Wrong archive password'}));await f.nodes['vb-verify'].click();assert.equal(f.nodes['vb-verify-result'].textContent,before);assert.match(f.nodes['vb-error'].textContent,/Wrong archive password/);
});
test('changing an archive, password or path invalidates the reviewed recovery destination',async()=>{
  const f=fixture();await f.ready();f.archive();f.nodes['vb-destination'].value='J:\\Synthetic\\copy';f.handler(async()=>({...result(),review_token:'r'.repeat(40),destination:'J:\\Synthetic\\copy'}));await f.nodes['vb-review'].click();assert.equal(f.nodes['vb-recover'].disabled,false);
  f.nodes['vb-destination'].value='J:\\Synthetic\\changed';await f.nodes['vb-destination'].fire('input');assert.equal(f.nodes['vb-recover'].disabled,true);
});
test('recovery requires complete current-reader confirmation, not just a created flag',async()=>{
  const f=fixture();await f.ready();f.archive();f.nodes['vb-destination'].value='J:\\Synthetic\\copy';f.handler(async()=>({...result(),review_token:'r'.repeat(40),destination:'J:\\Synthetic\\copy'}));await f.nodes['vb-review'].click();
  f.nodes['vb-new-password'].value=f.nodes['vb-new-confirm'].value='synthetic-vault-password';f.nodes['vb-recovery-confirm'].checked=true;
  f.handler(async()=>({...result(),created:true,destination:'J:\\Synthetic\\copy',readback:{ok:true,reader:'current-application',checks:{}}}));await f.nodes['vb-recover'].click();
  assert.match(f.nodes['vb-error'].textContent,/not both confirmed/);assert.equal(f.nodes['vb-recover-result'].textContent,'');
});

test('explicit prepared lookup retrieves an existing encrypted receipt with no mutation',async()=>{
  const f=fixture();await f.ready();f.calls.length=0;
  f.handler(async()=>({...result(),prepared:true,download_url:'/vault/backups/download/'+'a'.repeat(40),downloaded:false}));
  await f.nodes['vb-prepared'].click();assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.method,'GET');assert.equal(f.nodes['vb-download'].hidden,false);
  await f.emit('tli-panel-switched',{panelId:'panel-home'});assert.equal(f.nodes['vb-download'].hidden,true);
  f.handler(async()=>({ok:true,protocol:caps.protocol,prepared:false}));await f.nodes['vb-prepared'].click();assert.match(f.nodes['vb-create-result'].textContent,/No prepared download/);
});

test('verified separate recovery clears sensitive inputs and does not claim live restoration',async()=>{
  const f=fixture();await f.ready();f.archive();f.nodes['vb-destination'].value='J:\\Synthetic\\copy';
  f.handler(async()=>({...result(),review_token:'r'.repeat(40),destination:'J:\\Synthetic\\copy'}));await f.nodes['vb-review'].click();
  f.nodes['vb-new-password'].value=f.nodes['vb-new-confirm'].value='synthetic-vault-password';f.nodes['vb-recovery-confirm'].checked=true;
  f.handler(async()=>({...result(),created:true,destination:'J:\\Synthetic\\copy',readback:{ok:true,reader:'current-application',checks:Object.fromEntries(['passphrase_authenticated','current_readers','exact_content','owner_mapping','locked_without_sessions','files_unchanged'].map(k=>[k,true]))}}));
  await f.nodes['vb-recover'].click();assert.match(f.nodes['vb-recover-result'].textContent,/starts locked/);assert.match(f.nodes['vb-recover-result'].textContent,/not replaced/);assert.equal(f.nodes['vb-new-password'].value,'');assert.equal(f.nodes['vb-recover'].disabled,true);
});

test('stopping wait ignores late verification and allows only deliberate retry',async()=>{
  const f=fixture();await f.ready();f.archive();let done;f.handler(()=>new Promise(resolve=>done=resolve));const work=f.nodes['vb-verify'].click();await tick();await f.nodes['vb-stop'].click();
  done(result());await work;assert.equal(f.nodes['vb-verify-result'].textContent,'');assert.match(f.nodes['vb-error'].textContent,/Server work may still finish/);
  assert.equal(f.calls.filter(c=>c.options.method==='POST').length,1);
});

test('backup access rejection clears passwords, reviewed intent and previous download authority immediately',async()=>{
  for(const status of [401,403]) {
    const f=fixture();await f.ready();
    f.handler(async()=>({...result(),download_url:'/vault/backups/download/'+'a'.repeat(40),downloaded:false}));await f.create();
    f.archive();f.nodes['vb-destination'].value='J:\\Synthetic\\copy';
    f.handler(async()=>({...result(),review_token:'r'.repeat(40),destination:'J:\\Synthetic\\copy'}));await f.nodes['vb-review'].click();
    f.handler(async()=>({ok:false,http_status:status,detail:'Access expired'}));await f.create();
    for(const id of ['vb-create-password','vb-create-confirm','vb-archive-password','vb-destination'])assert.equal(f.nodes[id].value,'');
    assert.equal(f.nodes['vb-download'].hidden,true);assert.equal(f.nodes['vb-create-result'].textContent,'');assert.equal(f.nodes['vb-review-result'].textContent,'');
    assert.equal(f.nodes['vb-create'].disabled,true);assert.equal(f.nodes['vb-recover'].disabled,true);
    assert.match(f.nodes['vb-error'].textContent,/Private inputs were cleared/);
  }
});

test('a late forbidden reply from an invalidated request cannot clear a newer view',async()=>{
  const f=fixture();await f.ready();let done;f.handler(()=>new Promise(resolve=>done=resolve));const pending=f.create();await tick();
  await f.emit('tli-panel-switched',{panelId:'panel-main'});
  f.nodes['vb-create-password'].value='new-in-memory-draft';
  done({ok:false,http_status:403,detail:'Old request expired'});await pending;
  assert.equal(f.nodes['vb-create-password'].value,'new-in-memory-draft');assert.equal(f.nodes['vb-error'].textContent,'');
});
