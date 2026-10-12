/* Real SPA against synthetic discovery records. No peers contacted or altered. */
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {makePage,layout,fixtures,source,fingerprintFiles}=require('./verify_anniversary_ui_browser.cjs');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'build_work','connected-computers','computer-duplicates-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(output,{recursive:true});
const latest='fixture-dell-current-identity';
const older='fixture-dell-previous-identity';
const oldest='fixture-dell-oldest-identity';
const stamp=new Date().toISOString();
const pending={available:false,code:'peer_pending',message:'Review this computer before allowing LAN messages.'};
const self={node_id:'fixture-studio',peer_id:'fixture-studio',node_name:'FOX',is_self:true,online:true,ip:'192.168.2.10',port:8000};
const discovered=(id,lastSeen,extra={})=>({id,device_id:id,peer_id:id,node_id:id,name:'TheLegatoDell',node_name:'TheLegatoDell',display_name:'TheLegatoDell',
  ip:'192.168.2.20',port:8000,tli_port:8000,last_seen:lastSeen,is_self:false,online:id===latest,
  status:'pending',trust_state:'review_required',connection_state:'review_required',pairing_available:true,messaging:pending,...extra});
const records=[discovered(older,'2020-01-01T00:00:00Z'),discovered(latest,stamp),discovered(oldest,'2019-01-01T00:00:00Z')];
fixtures['/mesh/chat/messages']={messages:[]};
fixtures['/mesh/pairing/requests']={ok:true,supported:true,requests:[]};
const report={synthetic:true,source,checks:[],screenshots:[],layouts:[],sessions:[],
  limitations:['All network requests are intercepted. No real identities, drafts, trust permissions or peers are changed.']};

function useFixtures(backend,extra=[]) {
  const all=records.concat(extra);
  const historical=all.map(record=>backend==='current'&&[older,oldest].includes(record.id)?{...record,previous_discovery:true,superseded_by:latest}:record);
  fixtures['/mesh/directory']={mode:'standalone',this_device_id:self.node_id,devices:all};
  fixtures['/api/lan/peers']={self_id:self.node_id,peers:historical};
  const visible=backend==='current'?all.filter(record=>![older,oldest].includes(record.id)):
    all.map(({last_seen,...record})=>record);
  fixtures['/api/mesh/health']={ok:true,nodes:[self,...visible],
    ...(backend==='current'?{previous_discoveries:[{device_id:older,superseded_by:latest},{device_id:oldest,superseded_by:latest}]}:{})};
}

async function screenshot(page,mode,backend,panel,name,width) {
  await page.setViewportSize({width,height:1000});
  if(panel==='panel-mesh'&&width<600) await page.locator('#mcd-grid').scrollIntoViewIfNeeded();
  const measured=await layout(page,panel);
  assert.deepEqual(measured.overflow,[],name+': controls fit');
  assert.equal(measured.duplicateIds.length,0,name+': unique IDs');
  assert.ok(measured.documentWidth<=width+2,name+': no horizontal overflow');
  report.layouts.push({mode,backend,name,...measured});
  const file=path.join(output,`${backend}-${mode}-${name}-${width}.png`);
  await page.screenshot({path:file,fullPage:true});report.screenshots.push(file);
}

async function main() {
  const hashes=fingerprintFiles(source);
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    for(const backend of ['legacy','current']) for(const mode of ['modern','classic']) {
      useFixtures(backend);
      const run=await makePage(browser,1440,'emeraldLight'),page=run.page;
      try {
        await page.evaluate(mode=>{TLIInterface.set(mode);switchPanel('panel-mesh');},mode);
        await page.locator(`[data-pairing-device-id="${latest}"]`).waitFor();
        assert.equal(await page.locator('#mcd-grid .mcd-node').count(),2,'Three unreviewed discoveries become one current Dell plus FOX');
        assert.equal(await page.locator('#mcd-grid .mcd-node-name').filter({hasText:'TheLegatoDell'}).count(),1);
        assert.equal(await page.locator(`[data-pairing-device-id="${older}"],[data-pairing-device-id="${oldest}"]`).count(),0);
        for(const width of [1440,390]) await screenshot(page,mode,backend,'panel-mesh','current-computers',width);
        await page.setViewportSize({width:1440,height:1000});
        await page.evaluate(()=>{
          const open=TLIPeerPairing.open;
          TLIPeerPairing.open=options=>{window.__duplicatePairingSelection=options;return open(options);};
        });
        await page.locator(`[data-pairing-device-id="${latest}"]`).click();
        const dialog=page.locator('#tli-peer-pairing-dialog');
        await dialog.getByRole('heading',{name:'TheLegatoDell',exact:true}).waitFor();
        await dialog.getByRole('button',{name:'Request connection',exact:true}).waitFor();
        assert.deepEqual(await page.evaluate(()=>window.__duplicatePairingSelection),{deviceId:latest,name:'TheLegatoDell'});
        assert.equal(run.calls.some(call=>call.method==='POST'),false,'Opening the newest connection cannot send a request');
        await dialog.getByRole('button',{name:'Close',exact:true}).click();
        const access=page.locator('details').filter({has:page.getByText('Reviewed computer access',{exact:true})});
        await access.locator('summary').click();
        const registry=page.locator('#tli-peer-trust-list');
        await registry.getByText('ID: '+latest,{exact:true}).waitFor();
        for(const id of [latest,older,oldest]) assert.ok((await registry.innerText()).includes(id),'Advanced access retains '+id);
        assert.equal(await registry.locator(':scope > div').count(),3);
        await access.locator('summary').click();
        report.checks.push(`${backend}/${mode}: one current Dell card, exact newest connection entry and all prior identity records retained`);
        if(backend==='legacy') {
          assert.deepEqual(run.calls.filter(call=>!['GET','HEAD'].includes(call.method)),[]);
          assert.deepEqual(run.errors,[]);report.sessions.push({mode,backend,errors:run.errors});
          continue;
        }

        await page.evaluate(()=>switchPanel('panel-tli-chat'));
        const buddies=page.locator('.tli-chat-buddy');
        await buddies.first().waitFor();
        const previous=page.locator('details').filter({has:page.getByText('Previous discoveries (2)',{exact:true})});
        await previous.locator('summary').waitFor();
        assert.equal(await previous.evaluate(el=>el.open),false,'Previous discoveries start collapsed');
        assert.equal(await page.locator('.tli-chat-buddy:visible').count(),1,'Messages initially shows just the current Dell');
        const buddy=id=>page.locator(`.tli-chat-buddy[data-node-id="${id}"]`);
        await buddy(latest).click();
        const input=page.locator('#tli-chat-input');
        await input.fill('Draft for the current Dell identity');
        assert.equal(await page.locator('#tli-chat-send-btn').isDisabled(),true);
        await input.press('Enter');
        await previous.locator('summary').click();
        await buddy(older).click();
        assert.equal(await input.inputValue(),'','An older identity never inherits the current draft');
        await input.fill('Draft for the previous Dell identity');
        await buddy(oldest).click();assert.equal(await input.inputValue(),'');
        await input.fill('Draft for the oldest Dell identity');
        await buddy(latest).click();assert.equal(await input.inputValue(),'Draft for the current Dell identity');
        await buddy(older).click();assert.equal(await input.inputValue(),'Draft for the previous Dell identity');
        await buddy(oldest).click();assert.equal(await input.inputValue(),'Draft for the oldest Dell identity');
        assert.equal(run.calls.some(call=>call.path==='/mesh/chat/send'),false);
        for(const width of [1440,390]) {
          await page.setViewportSize({width,height:1000});
          if(width<600) await page.evaluate(()=>document.querySelector('.tli-chat-shell').dataset.mobileView='buddies');
          await screenshot(page,mode,backend,'panel-tli-chat','previous-discoveries',width);
        }
        report.checks.push(`${backend}/${mode}: previous discoveries require an explicit disclosure and each exact identity retains its own draft`);
        assert.deepEqual(run.calls.filter(call=>!['GET','HEAD'].includes(call.method)),[],'No trust, pairing, messages or directory records change');
        assert.deepEqual(run.errors,[]);report.sessions.push({mode,backend,errors:run.errors});
      } finally {await run.context.close();}

    }

    const protectedRecords=[
      discovered('fixture-reviewed-identity','2018-01-01T00:00:00Z',{status:'allowed',trust_state:'verified',peer_trust:{},pairing_available:false,node_name:'Reviewed computer'}),
      discovered('fixture-blocked-identity','2017-01-01T00:00:00Z',{status:'blocked',pairing_available:false,node_name:'Blocked computer'}),
      discovered('fixture-inference-identity','2016-01-01T00:00:00Z',{peer_profile:'inference_node',pairing_available:false,node_name:'Compute Node'}),
      discovered('fixture-other-port','2015-01-01T00:00:00Z',{port:8443,tli_port:8443}),
      discovered('fixture-other-address','2014-01-01T00:00:00Z',{ip:'192.168.2.30'})
    ];
    for(const backend of ['legacy','current']) {
      useFixtures(backend,protectedRecords);
      const run=await makePage(browser,1440,'emeraldLight'),page=run.page;
      try {
        await page.evaluate(()=>switchPanel('panel-mesh'));
        await page.locator(`[data-pairing-device-id="${latest}"]`).waitFor();
        assert.equal(await page.locator('#mcd-grid .mcd-node').count(),7,'Reviewed, blocked, inference and distinct endpoints stay separate');
        for(const name of ['Reviewed computer','Blocked computer','Compute Node']) assert.equal(await page.locator('#mcd-grid .mcd-node-name').filter({hasText:name}).count(),1);
        for(const id of ['fixture-other-port','fixture-other-address']) assert.equal(await page.locator(`[data-pairing-device-id="${id}"]`).count(),1);
        assert.deepEqual(run.calls.filter(call=>!['GET','HEAD'].includes(call.method)),[]);
        assert.deepEqual(run.errors,[]);
        report.checks.push(`${backend}: reviewed, blocked and inference identities plus different ports and same names on different addresses never collapse`);
      } finally {await run.context.close();}
      useFixtures(backend);
      const approved=record=>record.id===latest?{...record,status:'allowed',trust_state:'verified',peer_trust:{reviewed:true},pairing_available:false}:record;
      fixtures['/mesh/directory'].devices=fixtures['/mesh/directory'].devices.map(approved);
      fixtures['/api/mesh/health'].nodes=fixtures['/api/mesh/health'].nodes.map(approved);
      const approvedRun=await makePage(browser,1440,'emeraldLight'),approvedPage=approvedRun.page;
      try {
        await approvedPage.evaluate(()=>switchPanel('panel-mesh'));
        await approvedPage.locator('#mcd-grid .mcd-node-name').getByText('TheLegatoDell',{exact:true}).waitFor();
        assert.equal(await approvedPage.locator('#mcd-grid .mcd-node').count(),2,'Approving the newest identity cannot resurrect its older pending discoveries');
        assert.equal(await approvedPage.locator('[data-pairing-device-id]').count(),0);
        assert.deepEqual(approvedRun.calls.filter(call=>!['GET','HEAD'].includes(call.method)),[]);
        assert.deepEqual(approvedRun.errors,[]);
        report.checks.push(`${backend}: approving the newest computer keeps its older pending discoveries out of the current Computers list`);
      } finally {await approvedRun.context.close();}
    }
    report.sourceUnchanged=JSON.stringify(hashes)===JSON.stringify(fingerprintFiles(source));
    assert.equal(report.sourceUnchanged,true,'Frontend changed during verification; rerun current source');
    report.frontendHashes=hashes;report.passed=true;
  } finally {
    await browser.close();fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({output,checks:report.checks.length,passed:report.passed||false}));
  }
}
main().catch(error=>{fs.writeFileSync(path.join(output,'error.txt'),error.stack);console.error(error);process.exitCode=1;});
