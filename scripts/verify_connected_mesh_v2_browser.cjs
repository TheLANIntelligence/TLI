/* Intercepted SPA acceptance. No real peers, credentials or LAN traffic. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {makePage,layout}=require('./verify_anniversary_ui_browser.cjs');
const output=path.resolve(__dirname,'../build_work/connected-computers/v2-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(output,{recursive:true});
async function main(){
  const browser=await chromium.launch({channel:'msedge',headless:true});const report={synthetic:true,checks:[],screenshots:[]};
  try{for(const width of [1440,390]){for(const nodePair of [false,true]){
    const grants=nodePair?['inference']:['inference','messages','observe'];
    const run=await makePage(browser,width,'emeraldLight'),page=run.page;let current=[],remote=false,invalidGrant=false,windowClosed=false;const mutations=[];
    await page.route('**/mesh/pairing/**',async route=>{
      const request=route.request(),pathname=new URL(request.url()).pathname,body=request.postData()?request.postDataJSON():undefined;
      const json=value=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});
      if(pathname.endsWith('/requests'))return json({ok:true,supported:true,protocols:['tli-message-pairing-v1','tli-computer-pairing-v2'],requests:current});
      mutations.push({path:pathname,body});
      if(pathname.endsWith('/start')){
        assert.deepEqual(body,{device_id:'synthetic-peer',version:2,grants,review_update:true});
        if(windowClosed)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({detail:{code:'pairing_update_required',message:'Peer has no pairing endpoint.'}})});
        current=[{request_id:'synthetic-request-v2',direction:'outgoing',peer:{id:'synthetic-peer',name:'Workshop',origin:'https://workshop.local:8443',profile:nodePair?'inference_node':'full_host'},
          code:'ABCD-EF12-3456',expires_at:new Date(Date.now()+300000).toISOString(),state:'comparing',local_confirmed:false,remote_confirmed:false,grants:invalidGrant?['coordinate']:grants,protocol:'tli-computer-pairing-v2',review_update:true}];
      }else if(pathname.endsWith('/confirm')){
        assert.deepEqual(body,{code:'ABCD-EF12-3456',allow_messages:true,grants});current[0]={...current[0],local_confirmed:true,state:'waiting'};
      }else if(pathname.endsWith('/refresh'))current[0]={...current[0],remote_confirmed:remote,state:remote?'connected':current[0].state};
      else throw Error('Unexpected mutation '+pathname);
      return json({ok:true,request:current[0]});
    });
    await page.waitForFunction(()=>!!window.TLIPeerPairing);
    await page.evaluate(({grants,nodePair})=>TLIPeerPairing.open({deviceId:'synthetic-peer',name:'Workshop',reviewUpdate:true,node:nodePair,grants:nodePair?['messages','coordinate']:grants}),{grants,nodePair});
    const dialog=page.locator('#tli-peer-pairing-dialog');
    if(nodePair){await dialog.getByText(/Start the Node with run --pair/).waitFor();assert.equal(await dialog.locator('input[type=checkbox]').count(),0);await dialog.getByText(/run --pair --review-update/).waitFor();}
    else{await dialog.getByText('Explicitly selected AI compute',{exact:true}).waitFor();assert.equal(await dialog.locator('input[type=checkbox]:checked').count(),3);}
    assert.equal(mutations.length,0);
    await dialog.getByRole('button',{name:'Request connection',exact:true}).click();
    await dialog.getByText('ABCD-EF12-3456',{exact:true}).waitFor();
    if(nodePair)await dialog.getByText('Compare this entire code with the Node terminal. Approve inference there and on this computer.',{exact:true}).waitFor();
    const confirm=dialog.getByRole('button',{name:'Codes match — connect',exact:true});
    assert.equal(await confirm.isDisabled(),true);
    await dialog.locator('#peer-pairing-code-match').check();await dialog.locator('#peer-pairing-messages').check();
    await confirm.click();await dialog.getByText(/Permissions saved here/).waitFor();
    remote=true;await dialog.getByRole('button',{name:'Refresh status',exact:true}).click();
    await dialog.getByText(/Both computers confirmed/).waitFor();
    const measured=await layout(page,'tli-peer-pairing-dialog');assert.deepEqual(measured.overflow,[]);assert.equal(measured.duplicateIds.length,0);
    const screenshot=path.join(output,'connected-'+(nodePair?'node':'host')+'-'+width+'.png');await page.screenshot({path:screenshot,fullPage:true});report.screenshots.push(screenshot);
    if(nodePair){
      current=[];invalidGrant=true;
      await page.evaluate(()=>{TLIPeerPairing.close();TLIPeerPairing.open({deviceId:'synthetic-peer',name:'Workshop',reviewUpdate:true,node:true});});
      await dialog.getByRole('button',{name:'Request connection',exact:true}).click();
      await dialog.getByText(/incomplete connection details/).waitFor();
      assert.equal(await dialog.getByRole('button',{name:'Codes match — connect',exact:true}).count(),0);
      assert.equal(mutations.filter(value=>value.path.endsWith('/confirm')).length,1);
      windowClosed=true;current=[];
      await dialog.getByRole('button',{name:'Request connection',exact:true}).click();
      await dialog.getByText(/Start the Node locally with run --pair/).waitFor();
      assert.equal(await dialog.getByRole('button',{name:'Codes match — connect',exact:true}).count(),0);
    }
    report.checks.push({width,nodePair,invalidNodeGrantRejected:nodePair,mutations:mutations.map(x=>x.path),layout:measured});await page.close();
  }}}finally{await browser.close();fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));}
  console.log(JSON.stringify({output,checks:report.checks.length}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
