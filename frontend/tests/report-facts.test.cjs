const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../js/report-facts.js'),'utf8');
const keys={host_cpu_percent:['Host CPU','host','percent',88],host_ram_percent:['Host RAM','host','percent',50],host_ram_used_bytes:['Host RAM used','host','bytes',8589934592],host_ram_total_bytes:['Host RAM total','host','bytes',17179869184],process_cpu_percent:['Selected process CPU (whole host capacity)','selected_process','percent',52],process_rss_bytes:['Selected process resident memory','selected_process','bytes',536870912]};
function facts(){return {version:1,report_id:'recorded-one',kind:'performance',basis:'saved_report',host:{id:'host-one',name:'Studio'},target:null,process:{name:'Sketch',pid:73,create_time:1700000000},recorded_at:'2026-09-08T10:00:17Z',started_at:'2026-09-08T10:00:00Z',finished_at:'2026-09-08T10:00:17Z',duration_seconds:17,requested_duration_seconds:30,status:'stopped',status_label:'Observation stopped',recorded_samples:17,expected_samples:30,checks:[],omitted_checks:0,measurements:Object.entries(keys).map(([key,[label,scope,unit,value]])=>({key,label,scope,unit,valid_samples:17,mean:value,minimum:value,maximum:value})),limitations:['Sampling completion does not prove the app task finished.']};}
function fixture(){
  const create=tag=>({tag,textContent:'',children:[],attributes:{},append(...n){this.children.push(...n);},setAttribute(k,v){this.attributes[k]=v;}});
  const ctx=vm.createContext({Date,window:{},document:{createElement:create},fetch:()=>assert.fail('Facts must not fetch'),setInterval:()=>assert.fail('Facts must not poll')});vm.runInContext(source,ctx);
  return ctx.window.TLIReportFacts;
}
const all=n=>[n,...n.children.flatMap(all)],content=n=>all(n).map(n=>n.textContent).join(' ').trim();

test('host and selected-process values keep independent scope, units and stopped coverage',()=>{
  const api=fixture(),r=facts();assert.equal(api.validate(r,{reportId:r.report_id,hostId:'host-one',targetId:null}),true);
  const rendered=api.render(r);const text=content(rendered);
  assert.match(text,/Observation stopped.*Executing TLI host.*Studio.*host-one.*Sketch.*PID 73/s);
  assert.match(text,/17 recorded.*30 planned/);assert.match(text,/17 s observed.*30 s requested/);
  const rows=all(rendered).filter(n=>n.tag==='tr');
  assert.match(content(rows.find(n=>content(n).startsWith('Host CPU'))),/88%/);
  assert.match(content(rows.find(n=>content(n).startsWith('Selected process CPU'))),/52%/);
  assert.match(content(rows.find(n=>content(n).startsWith('Selected process resident memory'))),/512 MiB/);
  assert.doesNotMatch(text,/healthy|repair succeeded|PASS/);
});

test('full sampling is labelled sampling completion rather than application success',()=>{
  const api=fixture(),r=facts();r.status='completed';r.recorded_samples=30;r.measurements.forEach(m=>m.valid_samples=30);
  assert.equal(api.validate(r),true);assert.match(content(api.render(r)),/Planned sampling completed/);
  r.measurements[0].valid_samples=29;assert.equal(api.validate(r),false);
});

test('Chat summary keeps subject, status and coverage visible while details require deliberate expansion',()=>{
  const rendered=fixture().render(facts(),{}, {compact:true});
  const details=rendered.children.find(n=>n.className==='report-facts-expanded');
  assert.ok(details); assert.notEqual(details.open,true);
  const visible=rendered.children.filter(n=>n!==details).map(content).join(' ');
  assert.match(visible,/Observation stopped.*Executing TLI host.*Sketch.*17 recorded.*30 planned/s);
  assert.doesNotMatch(visible,/88%|52%|17 s observed/);
  assert.match(content(details),/17 s observed.*88%.*52%/s);
});

test('unknown measurements remain unknown, never zero or a substituted process',()=>{
  const r=facts();r.status='unknown';r.process={name:null,pid:null,create_time:null};r.measurements[4]={...r.measurements[4],valid_samples:0,mean:null,minimum:null,maximum:null};
  const api=fixture();assert.equal(api.validate(r),true);const text=content(api.render(r));
  assert.match(text,/PID unknown.*no other process is substituted/s);assert.match(text,/Selected process CPU.*Unknown/s);
});

test('malformed counts, scopes, dates and identities cannot produce an authoritative summary',()=>{
  const changes=[r=>r.measurements[0].scope='selected_process',r=>r.measurements[0].unit='bytes',r=>r.measurements[0].mean=101,r=>r.measurements[0].minimum=99,r=>r.measurements[0].valid_samples=18,r=>r.measurements.push({...r.measurements[0]}),r=>r.recorded_at='not-time',r=>r.recorded_samples=-1,r=>r.process.pid=Number.MAX_SAFE_INTEGER+1];
  const api=fixture();for(const change of changes){const r=facts();change(r);assert.equal(api.validate(r),false);assert.match(content(api.render(r)),/structured report summary is unavailable/);assert.doesNotMatch(content(api.render(r)),/88%|52%/);}
  assert.equal(api.validate(facts(),{reportId:'other'}),false);assert.equal(api.validate(facts(),{hostId:'other'}),false);assert.equal(api.validate(facts(),{targetId:'other'}),false);
  assert.equal(api.validate(facts(),{hostId:null}),false);
});

test('untrusted labels remain literal text and extreme process timestamps do not crash',()=>{
  const r=facts();r.host.name='<img src=x onerror=run()> ';r.process.create_time=1e100;r.limitations=['</li><script>run()</script>'];
  const tree=fixture().render(r);assert.match(content(tree),/<img src=x/);assert.match(content(tree),/date outside displayable range/);
  assert.ok(!all(tree).some(n=>['img','script','button','a','form'].includes(n.tag)));
});

test('a device with no recorded target stays unknown instead of becoming the host',()=>{
  const r=facts();Object.assign(r,{kind:'device',process:null,measurements:[],recorded_samples:null,expected_samples:null,status:'partial',checks:[{id:'tcp',label:'Reachability',status:'unavailable',detail:null,scope:'host_to_device'}]});
  const api=fixture();assert.equal(api.validate(r),true);assert.match(content(api.render(r)),/Subject not recorded; no different target is assumed/);assert.match(content(api.render(r)),/host-to-device reachability/);
});
