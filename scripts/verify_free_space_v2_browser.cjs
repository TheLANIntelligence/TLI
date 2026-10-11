/* Actual SPA, intercepted synthetic inventories only. No host server or disk scan. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {ready} = require('./verify_free_space_rebuild_browser.cjs');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv.includes('--output') ? process.argv[process.argv.indexOf('--output') + 1] : path.join(root, 'build_work/free-space-v2/browser-focused'));
const scanPath = 'C:\\Users\\Demo\\Downloads', GiB = 1024 ** 3, MiB = 1024 ** 2;
const now = new Date().toISOString(), previous = new Date(Date.now() - 86400000).toISOString();
const filters = {max_seconds:15,max_entries:50000,max_depth:18,excluded_names:['AppData'],follow_links:false,hardlink_accounting:'first_observed_identity_v1'};
const summary = (id, at, total, free) => ({id,version:1,root:scanPath,scanned_at:at,host:{id:'fixture-studio',name:'Studio'},drive:{status:'known',fingerprint:'a'.repeat(64)},coverage:{complete:true,reasons:[]},filters,total_bytes:total,direct_file_bytes:4*MiB,capacity:{total:500*GiB,used:500*GiB-free,free,root_is_volume:false}});
const current = summary('1'.repeat(32), now, GiB + 504*MiB, 15*GiB);
const baseline = summary('2'.repeat(32), previous, 804*MiB, 20*GiB);
const file = (name,size,allocated,category,extra={}) => ({name,path:scanPath+'\\'+name,kind:'file',size,logical_size:size,size_known:true,size_partial:false,allocated_size:allocated,allocated_known_bytes:allocated||0,allocated_partial:allocated===null,extension:path.extname(name),category,files:1,modified_at:now,created_at:previous,...extra});
const children = [file('Local model.gguf',GiB,GiB,'models'),file('Family photo.raw',500*MiB,null,'images'),file('App log.txt',4*MiB,8192,'documents'),file('Model hardlink.gguf',0,0,'models',{logical_size:GiB,hardlink_duplicate:true})];
const result = {tree:{name:'Downloads',path:scanPath,kind:'directory',size:current.total_bytes,size_known:true,size_partial:false,allocated_size:null,allocated_known_bytes:GiB+8192,allocated_partial:true,files:4,children},largest:children.slice(0,3),meta:{root:scanPath,files:4,dirs:0,entries_seen:4,seconds:.1,partial:false,denied:0,skipped:0,hardlinks_skipped:1,allocation_unknown:1,scan_filters:filters,scanner:{engine:'scandir',mft:false,limitations:['Direct NTFS MFT scanning is not implemented.']},saved_scan:{protocol:'storage-history-v1',available:true,version:1,scan_id:current.id,summary:current,expires_at:Date.now()/1000+1800}}};
const defaults = {enabled:false,schedule_enabled:false,sample_interval_seconds:300,warn_percent:85,critical_percent:95,sudden_bytes:10*GiB,window_hours:12,cooldown_hours:12,scan_interval_hours:24};
const report = {synthetic:true,checks:[],screenshots:[],errors:[],requests:[],limitations:['Intercepted synthetic APIs, no live scan or cleanup.','Browser layout checks do not establish full-drive scanning performance.']};

async function run(){
 fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const session=await ready(browser),{page}=session;
 const calls=[];
 let monitor={...defaults};
 const job={id:'3'.repeat(32),host:current.host,operation:'scan',profile:'quick',include_excluded:false,path:scanPath,status:'completed',result_available:true,started_at:now,updated_at:now,finished_at:now,worker_stopped:true,progress:{phase:'complete'},error:null};
 const capture=async name=>{const target=path.join(output,name+'.png');
  const selector=name.startsWith('monitor')?'#fs-monitor':name.startsWith('history')?'#storage-history-timeline':name.startsWith('local-investigation')?'#fs-investigation':'#storage-results';
  await page.locator(selector).evaluate(element=>element.scrollIntoView({block:'start'}));
  await page.screenshot({path:target,fullPage:true});report.screenshots.push(target);};
 const check=async(name,fn)=>{try{await fn();report.checks.push({name,passed:true});}catch(error){report.checks.push({name,passed:false,error:error.stack});throw error;}};
 await page.route('**/visualizer/**',route=>{
  const request=route.request(),url=new URL(request.url()),body=request.method()==='GET'?null:request.postDataJSON();
  if(!['/visualizer/investigate','/visualizer/monitor','/visualizer/history','/visualizer/history/compare','/visualizer/history/retention','/visualizer/history/maintenance'].includes(url.pathname)&&!url.pathname.startsWith('/visualizer/jobs'))return route.fallback();
  calls.push({path:url.pathname,method:request.method(),body});
  let response;
  if(url.pathname.startsWith('/visualizer/jobs'))response={ok:true,protocol:'storage-jobs-v1',job,...(url.pathname.endsWith('/results')?{result}: {})};
  else if(url.pathname==='/visualizer/investigate')response={ok:true,protocol:'storage-investigation-v1',local_only:true,evidence:{root:scanPath,job_id:job.id},reply:'The recorded local model accounts for 1 GB of logical file bytes. Photo allocation is unavailable. No files were deleted.',recommendations:[{path:children[0].path,classification:'requires_review',reason:'AI model file, identified from its extension.',consequence:'Removing it makes the corresponding local model unavailable.',size_bytes:GiB}]};
  else if(url.pathname==='/visualizer/monitor'){if(request.method()==='PUT')monitor={...monitor,...body};response={ok:true,settings:monitor,active:monitor.enabled,findings:[{message:'Capacity sample found 15 GB free; file attribution requires a scan.'}],schedule_scope:monitor.schedule_enabled?scanPath:null};}
  else if(url.pathname==='/visualizer/history')response={ok:true,protocol:'storage-history-v1',snapshots:[current,baseline],limit:20};
  else if(url.pathname==='/visualizer/history/compare')response={ok:true,protocol:'storage-history-v1',comparable:true,point_in_time:true,baseline,current,reasons:[],totals:{before_bytes:baseline.total_bytes,after_bytes:current.total_bytes,delta_bytes:current.total_bytes-baseline.total_bytes,direct_file_delta_bytes:0},folders:[],files:[{path:'Local model.gguf',status:'grew',before_bytes:512*MiB,after_bytes:GiB,delta_bytes:512*MiB}],file_comparison:{available:true,complete:true}};
  else if(url.pathname==='/visualizer/history/maintenance')response={ok:true,protocol:'storage-history-v1',removed_count:0,removed_ids:[]};
  else response={ok:true,protocol:'storage-history-v1',max_snapshots:10,max_age_days:90,auto_prune:true,...(body||{})};
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(response)});
 });
 try{
  await check('Metadata, hard-link alias and unknown allocation render in bounded explorer',async()=>{
   assert.equal(calls.length,0);
   await page.locator('#visualizerPathInput').fill(scanPath);await page.locator('#visualizerScanBtn').click();
   await page.waitForFunction(()=>TLIFreeSpace.getState().observation);
   assert.equal(await page.locator('.fs-tree-row').count(),4);
   assert.match(await page.locator('#visualizerTableBody').innerText(),/unknown/i);
   assert.equal(await page.locator('#fs-table-wrap thead th').count(),8);
   await page.locator('#fs-explorer-filters').evaluate(e=>e.open=true);
   await page.locator('#fs-extension-filter').fill('.gguf');assert.equal(await page.locator('.fs-tree-row').count(),2);
   await page.locator('#fs-extension-filter').fill('');await page.locator('#fs-size-metric').selectOption('allocated_size');
   assert.match(await page.locator('#vis4-treemap-container').innerText(),/known allocated/);
   await capture('allocation-map-desktop');
  });
  await check('Investigation uses explicit current job and renders recommendations without executing cleanup',async()=>{
   await page.locator('#fs-investigation').evaluate(e=>e.open=true);
   await page.locator('#fs-investigation-question').fill('What is taking up space?');await page.locator('#fs-investigate').click();
   await page.waitForFunction(()=>document.getElementById('fs-investigation-status').textContent.includes('ready'));
   const requests=calls.filter(row=>row.path==='/visualizer/investigate');
   assert.equal(requests.length,1);assert.equal(requests[0].body.job_id,job.id);
   assert.match(await page.locator('#fs-investigation-result').innerText(),/Requires review/);
   assert.equal(calls.some(row=>row.path.includes('/cleanup/')),false);await capture('local-investigation-desktop');
  });
  await check('History timeline and retention remain explicit',async()=>{
   await page.locator('#visualizerTableBody .fs-file-name').filter({hasText:'Local model.gguf'}).click();await page.locator('#fs-show-changes').click();
   assert.equal(calls.filter(row=>row.path==='/visualizer/history').length,0);
   assert.match(await page.locator('#storage-history-selection').innerText(),/Comparison unavailable/);
   await page.locator('#storage-history-load').click();await page.waitForFunction(()=>document.querySelectorAll('.storage-history-point').length===2);
   assert.match(await page.locator('#storage-history-timeline').innerText(),/20 GB free/);
   await page.locator('#storage-history-compare').click();await page.waitForFunction(()=>document.getElementById('storage-history-selection').textContent.includes('changed by'));
   assert.match(await page.locator('#storage-history-selection').innerText(),/512 MB/);
   await page.locator('[data-fs-tab="explore"]').click();await page.locator('#visualizerTableBody .fs-file-name').filter({hasText:'Family photo.raw'}).click();await page.locator('#fs-show-changes').click();
   assert.match(await page.locator('#storage-history-selection').innerText(),/Comparison unavailable.*Missing entries are not evidence of no change/s);assert.equal(calls.filter(row=>row.path==='/visualizer/history/compare').length,1);
   await page.locator('.storage-history-settings').evaluate(e=>e.open=true);
   await page.getByRole('button',{name:'Load retention settings',exact:true}).click();await page.waitForFunction(()=>document.getElementById('storage-retention-count').value==='10');
   await page.locator('#storage-retention-count').fill('8');await page.getByRole('button',{name:'Save retention settings',exact:true}).click();
   await page.waitForFunction(()=>document.getElementById('storage-history-status').textContent.includes('settings saved'));
   assert.equal(calls.find(row=>row.path.endsWith('/retention')&&row.method==='PUT').body.max_snapshots,8);
   await capture('history-desktop');
  });
  await check('Monitoring requires explicit save and binds scheduled scope to reviewed job',async()=>{
   await page.locator('#fs-monitor').evaluate(e=>e.open=true);
   assert.equal(calls.filter(row=>row.path==='/visualizer/monitor').length,0);
   await page.locator('#fs-monitor-load').click();await page.waitForFunction(()=>document.getElementById('fs-monitor-status').textContent.includes('inactive'));
   await page.locator('#fs-monitor-enabled').check();await page.locator('#fs-monitor-schedule_enabled').check();await page.locator('#fs-monitor-save').click();
   await page.waitForFunction(()=>document.getElementById('fs-monitor-status').textContent.includes('is active'));
   const saved=calls.find(row=>row.path==='/visualizer/monitor'&&row.method==='PUT');assert.equal(saved.body.job_id,job.id);
   assert.equal(calls.filter(row=>row.path==='/visualizer/jobs'&&row.method==='POST').length,1);
   await capture('monitor-desktop');
  });
  await check('Narrow viewport contains new disclosures and lock clears private findings',async()=>{
   await page.setViewportSize({width:390,height:1000});await page.evaluate(()=>TLIThemes.apply('midnight'));
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+2));
   await capture('monitor-phone');
   await page.locator('[data-fs-tab="explore"]').click();await capture('allocation-phone');
   await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));
   assert.equal(await page.locator('#fs-investigation-result').innerText(),'');assert.equal(await page.locator('#fs-monitor-readings').innerText(),'');
   assert.equal(await page.locator('#visualizerPathInput').inputValue(),'');
  });
 }finally{
  report.errors.push(...session.errors);report.requests=calls;report.passed=report.checks.length===5&&report.checks.every(row=>row.passed)&&!report.errors.length;
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await session.context.close();await browser.close();
 }
 console.log(JSON.stringify({output,passed:report.passed,checks:report.checks,errors:report.errors}));process.exitCode=report.passed?0:1;
}
run().catch(error=>{console.error(error);process.exitCode=1;});
