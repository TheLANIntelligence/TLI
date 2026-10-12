/* Real SPA with intercepted synthetic computers. No LAN messages are sent. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {makePage, layout, fixtures} = require('./verify_anniversary_ui_browser.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build_work', 'connected-computers');
fs.mkdirSync(output, {recursive:true});
const currentId = 'c8fe3c92-0000-4000-8000-000000000001';
const previousId = '78ac4e14-0000-4000-8000-000000000002';
const pending = {available:false, code:'peer_pending', message:'Trust review needed on this computer. Review its public card and enable LAN messages on both computers.'};
const peers = [
  {id:currentId, name:'TheLegatoDell', ip:'192.168.2.20', port:8443, online:true, last_seen:new Date().toISOString(), status:'pending', trust_state:'review_required', messaging:pending},
  {id:previousId, name:'TheLegatoDell', ip:'192.168.2.20', port:8443, online:false, last_seen:'2020-01-01T00:00:00Z', status:'pending', trust_state:'review_required', messaging:pending},
];
fixtures['/api/lan/peers'] = {self_id:'fixture-studio', peers};
fixtures['/mesh/directory'] = {mode:'standalone', this_device_id:'fixture-studio', devices:peers.map(p=>({...p, device_id:p.id, display_name:p.name, tli_port:p.port}))};
fixtures['/mesh/chat/messages'] = {messages:[]};

(async()=>{
  const browser = await chromium.launch({channel:'msedge', headless:true});
  const report = {synthetic:true, checks:[], screenshots:[]};
  try {
    for (const mode of ['modern', 'classic']) {
      const run = await makePage(browser, 1440, 'emeraldLight');
      const p = run.page;
      try {
        await p.evaluate(mode=>{TLIInterface.set(mode); switchPanel('panel-tli-chat');}, mode);
        const buddies = p.locator('.tli-chat-buddy');
        await buddies.first().waitFor();
        assert.equal(await buddies.count(), 2);
        assert.match(await buddies.first().innerText(), /TheLegatoDell/);
        assert.match(await buddies.first().innerText(), new RegExp(currentId));
        assert.match(await buddies.last().innerText(), new RegExp(previousId));
        await buddies.first().click();
        const input = p.locator('#tli-chat-input');
        await input.fill('Keep this draft for the current Dell identity');
        assert.equal(await p.locator('#tli-chat-send-btn').isDisabled(), true);
        await input.press('Enter');
        assert.equal(run.calls.some(c=>c.path==='/mesh/chat/send'), false);
        await p.locator('#tli-chat-message-readiness').getByRole('button', {name:'Review computer trust'}).click();
        const dialog = p.locator('#tli-peer-trust-dialog');
        assert.match(await dialog.innerText(), new RegExp(currentId));
        await dialog.getByLabel('Paste the other computer’s public card').fill(JSON.stringify({node_id:previousId}));
        await dialog.getByRole('button', {name:'Review selected permissions', exact:true}).click();
        await p.waitForFunction(()=>document.getElementById('tli-peer-trust-dialog').textContent.includes('different computer identity'));
        assert.equal(run.calls.some(c=>c.path==='/mesh/trust/preview'), false);
        await dialog.getByRole('button', {name:'Close', exact:true}).click();
        assert.equal(await input.inputValue(), 'Keep this draft for the current Dell identity');
        await buddies.last().click();
        assert.equal(await input.inputValue(), '');
        await buddies.first().click();
        assert.equal(await input.inputValue(), 'Keep this draft for the current Dell identity');
        for (const width of [1440, 390]) {
          await p.setViewportSize({width, height:1000});
          await p.evaluate(()=>document.querySelector('.tli-chat-shell').dataset.mobileView='thread');
          const measured = await layout(p, 'panel-tli-chat');
          assert.deepEqual(measured.overflow, []);
          assert.equal(measured.duplicateIds.length, 0);
          const file = path.join(output, `lan-message-setup-${mode}-${width}.png`);
          await p.screenshot({path:file, fullPage:true});
          report.screenshots.push(file);
        }
        assert.deepEqual(run.errors, []);
        report.checks.push(`${mode}: name, distinct identities, pending send gate, exact review target, drafts, desktop/mobile layout`);
      } finally { await run.context.close(); }
    }
    fs.writeFileSync(path.join(output, 'lan-message-setup-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error); process.exitCode=1;});
