/* Real SPA with generated public API fixtures. Every request intercepted. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {makePage,layout,fixtures,source,fingerprintFiles}=require('./verify_anniversary_ui_browser.cjs');
const {contrast,textScale}=require('./verify_anniversary_themes_browser.cjs');
const root=path.resolve(__dirname,'..'),quick=process.argv.includes('--quick'),hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const output=path.join(root,'build_work/finish-the-fix','transfer-browser-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(output,{recursive:true});
const apiFile=path.join(root,'build_work/finish-the-fix/transfer-api-fixtures.json'),api=JSON.parse(fs.readFileSync(apiFile));assert.equal(api.synthetic,true);
for(const [file,sha]of Object.entries(api.sources))assert.equal(hash(path.join(source,'backend',file)),sha,'API fixture source drift: '+file);
fixtures['/api/diagnostics/version'].release.capabilities.push('trusted_file_transfer_v1');
const peer={id:api.incoming.peer.id,name:api.incoming.peer.name,ip:'192.168.2.20',port:8443,online:true,last_seen:new Date().toISOString(),status:'allowed',trust_state:'verified',origin:'https://192.168.2.20:8443'};
fixtures['/api/lan/peers']={peers:[peer],self_id:'fixture-studio'};fixtures['/mesh/chat/messages']={messages:[]};
fixtures['/mesh/directory']={mode:'standalone',this_device_id:'fixture-studio',devices:[{...peer,device_id:peer.id,display_name:peer.name,tli_port:8443}]};
const report={synthetic:true,started_at:new Date().toISOString(),source,api_fixture:{path:apiFile,sha256:hash(apiFile)},checks:[],layouts:[],screenshots:[],errors:[],limitations:['All browser traffic intercepted. Synthetic selected file is three bytes; no household files or peer contacted.','Backend signatures/consent/storage are separately tested in ASGI and owned loopback HTTPS. This browser fixture cannot prove physical LAN delivery.','Physical computers, native mobile transfer UI and physical accessibility acceptance remain not run.']};
const json=(r,data,status=200)=>r.fulfill({status,contentType:'application/json',headers:{'Cache-Control':'no-store'},body:JSON.stringify(data)});
async function check(name,fn){try{await fn();report.checks.push({name,passed:true});}catch(error){report.checks.push({name,passed:false,error:error.stack});report.errors.push(error.stack);}fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));}
async function record(p,name,mode,width,theme,screen=false){const value=await layout(p,'peer-files-dialog');report.layouts.push({name,mode,width,theme,...value});assert.deepEqual(value.overflow,[]);assert(value.documentWidth<=width+2);assert.equal(value.duplicateIds.length,0);if(screen){const file=path.join(output,`${name}-${mode}-${width}-${theme}.png`);await p.screenshot({path:file,fullPage:true});report.screenshots.push({file,sha256:hash(file)});}}
async function main(){const before=fingerprintFiles(source),browser=await chromium.launch({channel:'msedge',headless:true});try{
 for(const mode of ['modern','classic']){
  const run=await makePage(browser,1440,'emeraldLight'),p=run.page,operations=[];let records=[structuredClone(api.incoming)],holdAccept=null,holdList=null,lost=true;
  await p.route('**/mesh/files**',async r=>{const url=new URL(r.request().url()),method=r.request().method();operations.push({path:url.pathname,method,body:method==='POST'?r.request().postDataJSON():null});
   if(url.pathname==='/mesh/files'){if(holdList)return holdList(r);return json(r,{ok:true,protocol:api.capabilities.protocol,transfers:records});}
   if(url.pathname.endsWith('/outgoing')){const body=r.request().postDataJSON();const row={...api.prepared,id:'ef'.repeat(16),filename:body.filename,size:body.size,staged_bytes:0};records.push(row);return json(r,row);}
   const id=url.pathname.split('/')[3],action=url.pathname.split('/')[4],row=records.find(x=>x.id===id);
   if(!row)return json(r,{detail:{message:'Synthetic transfer not found'}},404);
   if(action==='review')return json(r,{...api.review,...row});
   if(action==='accept'){if(holdAccept)return holdAccept(r);row.state='accepted';return json(r,row);}
   if(action==='stage'){const body=r.request().postDataJSON(),raw=Buffer.from(body.data,'base64');assert.equal(crypto.createHash('sha256').update(raw).digest('hex'),body.sha256);row.staged_bytes+=raw.length;return json(r,row);}
   if(action==='offer'){row.state='offered';row.sha256=api.received.sha256;return json(r,row);}
   if(action==='peer-status'){row.state='accepted';return json(r,row);}
   if(action==='send-next'){row.acknowledged_bytes=row.size;if(lost){lost=false;row.state='uncertain';row.uncertain_operation='chunk';return json(r,{detail:{message:'Synthetic lost acknowledgment. Check status; no retry was sent.'}},504);}return json(r,row);}
   if(action==='complete'){row.state='delivered';row.verified=true;return json(r,row);}
   if(action==='cancel'){row.state='cancelled';return json(r,row);}
   if(action==='discard'){row.state='discarded';row.verified=false;return json(r,row);}
   return json(r,{detail:{message:'Unsupported synthetic operation'}},409);
  });
  try{
   await p.goto('https://tli-ui.test/',{waitUntil:'load'});await p.waitForFunction(()=>typeof switchPanel==='function'&&window.TLIPeerTransfers);await p.waitForTimeout(450);
   await p.evaluate(mode=>{TLIInterface.set(mode);switchPanel('panel-tli-chat');window.__themeAuditVisible=e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&e.getBoundingClientRect().width>0;},mode);
   await p.locator('#peer-files-inbox').click();const d=p.locator('#peer-files-dialog');await d.getByRole('button',{name:'Review incoming file',exact:true}).waitFor();
   await check(mode+': opening Inbox makes no mutation or peer request',async()=>{assert.equal(operations.filter(x=>x.method==='POST').length,0);assert.equal(run.calls.filter(x=>!['GET','HEAD'].includes(x.method)).length,0);});
   await d.getByRole('button',{name:'Review incoming file',exact:true}).click();await d.getByRole('button',{name:'Receive into TLI Inbox (encrypted on host)',exact:true}).waitFor();
   await check(mode+': exact private offer and separate encrypted destination review',async()=>{const text=await d.innerText();assert.match(text,new RegExp(api.incoming.sha256));assert.match(text,/receiver review|receiver consent/i);assert.match(text,/Download afterward/);assert.equal(operations.filter(x=>x.path.endsWith('/accept')).length,0);});
   for(const width of [1440,390,320])for(const theme of ['emeraldLight','midnight']){await p.setViewportSize({width,height:1000});await p.evaluate(t=>TLIThemes.apply(t),theme);await check(`${mode}: ${width} ${theme} receiver review layout`,()=>record(p,'receiver-review',mode,width,theme,true));}
   const themes=quick?['emeraldLight','midnight']:await p.evaluate(()=>TLIThemes.themes.map(t=>t.id));
   for(const theme of themes){await p.evaluate(t=>TLIThemes.apply(t),theme);await check(`${mode}: ${theme} narrow contrast`,async()=>{await record(p,'review-theme',mode,320,theme);const result=await contrast(p,'peer-files-dialog');assert.deepEqual(result.findings,[]);});}
   await textScale(p,'peer-files-dialog',true);await check(mode+':200 percent review text',()=>record(p,'receiver-enlarged',mode,320,'midnight',true));await textScale(p,'peer-files-dialog',false);
   let pending;holdAccept=r=>new Promise(resolve=>pending={r,resolve});await p.setViewportSize({width:1440,height:1000});
   await check(mode+': double acceptance commits once',async()=>{await d.getByRole('button',{name:'Receive into TLI Inbox (encrypted on host)',exact:true}).dblclick();await p.waitForTimeout(80);assert.equal(operations.filter(x=>x.path.endsWith('/accept')).length,1);records[0]={...api.accepted};await json(pending.r,records[0]);pending.resolve();await d.getByText('This file is accepted for the remaining offer period',{exact:false}).waitFor();});holdAccept=null;
   records=[{...api.received}];await d.getByRole('button',{name:'Refresh this Inbox',exact:true}).click();await d.getByRole('button',{name:'Download verified file',exact:true}).waitFor();await check(mode+': checksum verified Inbox view',()=>record(p,'verified-inbox',mode,1440,'midnight',true));
   records=[{...api.incoming,filename:'<img src=x onerror="window.transferInjected=true">'}];await d.getByRole('button',{name:'Refresh this Inbox',exact:true}).click();
   await check(mode+': filenames are text only',async()=>{await d.getByText(records[0].filename,{exact:true}).waitFor();assert.equal(await d.locator('img,script,iframe').count(),0);assert.equal(await p.evaluate(()=>window.transferInjected),undefined);});
   await d.getByRole('button',{name:'Close',exact:true}).click();records=[];
   await p.locator('.tli-chat-buddy').filter({hasText:peer.name}).click();await p.locator('#tli-chat-share-btn').click();await d.getByRole('button',{name:'Choose one file',exact:true}).waitFor();
   const chooser=p.waitForEvent('filechooser');await d.getByRole('button',{name:'Choose one file',exact:true}).click();await (await chooser).setFiles({name:'synthetic.txt',mimeType:'text/plain',buffer:Buffer.from('abc')});await d.getByRole('button',{name:'Prepare on this host',exact:true}).click();await d.getByRole('button',{name:'Offer file to receiver',exact:true}).waitFor();
   await check(mode+': selected chunks stage locally before a separate metadata offer',async()=>{assert.equal(operations.filter(x=>x.path.endsWith('/stage')).length,1);assert.equal(operations.filter(x=>x.path.endsWith('/offer')).length,0);assert(!operations.some(x=>x.path.startsWith('/mesh/transfer/')));});
   await d.getByRole('button',{name:'Offer file to receiver',exact:true}).click();await d.getByRole('button',{name:'Check receiver status',exact:true}).click();await d.getByRole('button',{name:'Send accepted file',exact:true}).click();
   await check(mode+': lost ack pauses and explicit reconciliation avoids duplicate chunk',async()=>{await d.getByText(/Synthetic lost acknowledgment/).waitFor();assert.equal(operations.filter(x=>x.path.endsWith('/send-next')).length,1);assert.equal(operations.filter(x=>x.path.endsWith('/complete')).length,0);await d.getByRole('button',{name:'Check receiver status',exact:true}).click();await d.getByRole('button',{name:'Send accepted file',exact:true}).click();await d.getByText('The receiver confirmed the complete file checksum in its encrypted TLI Inbox.',{exact:true}).waitFor();assert.equal(operations.filter(x=>x.path.endsWith('/send-next')).length,1);});
   for(const width of [390,320]){await p.setViewportSize({width,height:1000});await check(`${mode}: ${width} delivered receipt`,()=>record(p,'delivered-receipt',mode,width,'midnight',true));}
   let late;holdList=r=>new Promise(resolve=>late={r,resolve});await d.getByRole('button',{name:'Refresh this Inbox',exact:true}).click();await p.waitForTimeout(80);
   await check(mode+': locked late metadata cannot reappear',async()=>{await p.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));await json(late.r,{ok:true,protocol:api.capabilities.protocol,transfers:[api.incoming]});late.resolve();await p.waitForTimeout(100);assert.equal(await d.isVisible(),false);assert.doesNotMatch(await d.innerText(),/private.txt|synthetic.txt/);});
   report.errors.push(...run.errors);
  }finally{await run.context.close();}
 }
}finally{await browser.close();report.finished_at=new Date().toISOString();report.frontend_hashes=before;report.sourceUnchanged=JSON.stringify(before)===JSON.stringify(fingerprintFiles(source));report.api_sources_unchanged=Object.entries(api.sources).every(([file,sha])=>hash(path.join(source,'backend',file))===sha);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,checks:report.checks.length,failures:report.checks.filter(x=>!x.passed).length,errors:report.errors,sourceUnchanged:report.sourceUnchanged}));if(report.errors.length||!report.sourceUnchanged||!report.api_sources_unchanged)process.exitCode=1;}}
main().catch(e=>{report.errors.push(e.stack);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.error(e);process.exitCode=1;});
