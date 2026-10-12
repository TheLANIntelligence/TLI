/* Real SPA, synthetic public cards and intercepted requests only. No LAN traffic. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {makePage, layout, fixtures, source, fingerprintFiles} = require('./verify_anniversary_ui_browser.cjs');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build_work', 'connected-computers',
  'peer-trust-setup-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(output, {recursive:true});
const origin = 'https://192.168.2.10:8443';
const otherOrigin = 'https://192.168.3.10:8443';
// These are display-only public-card fixtures; cryptographic validation belongs
// to the isolated backend tests. There are no real keys or computer identities.
const localCard = {
  protocol:'tli-peer-trust-v1', node_id:'fixture-studio', name:'Studio', origin,
  public_key:'a'.repeat(64), identity_fingerprint:'aaaa:bbbb:cccc:dddd:eeee:ffff:0000:1111',
  certificate_der:'synthetic-public-certificate', certificate_sha256:'b'.repeat(64),
  capabilities:['system_observation_v1','coordination_v1','messages_v1'],
  issued_at:'2026-10-01T00:00:00Z', signature:'c'.repeat(128),
};
const ready = {
  ok:true, node:{id:'fixture-studio',name:'Studio'}, ready:true, code:'ready', reason:null,
  origins:[origin], selected_origin:origin, card:localCard,
};
fixtures['/mesh/chat/messages'] = {messages:[]};
const report = {
  synthetic:true, source, checks:[], screenshots:[], layouts:[], sessions:[],
  limitations:['All network requests are intercepted. No peer was contacted, trusted, or messaged.',
    'Public-card rendering is tested here; signature, certificate and endpoint validation are backend concerns.'],
};
const json = (route, body, status=200) => route.fulfill({status, contentType:'application/json', body:JSON.stringify(body)});
const safeOperations = new Set(['/mesh/trust/setup', '/mesh/trust/card', '/api/companion/v1/setup']);
const publicLabel = 'Your public computer card; contains no private key';
const addressLabel = 'This computer’s HTTPS LAN IPv4 address and port';

async function snapshot(page, mode, name, width) {
  await page.setViewportSize({width, height:1000});
  const measured = await layout(page, 'tli-peer-trust-dialog');
  assert.deepEqual(measured.overflow, [], name + ': no controls overflow');
  assert.equal(measured.duplicateIds.length, 0, name + ': unique control IDs');
  assert.ok(measured.documentWidth <= width + 2, name + ': no horizontal page overflow');
  report.layouts.push({mode,name,...measured});
  const file = path.join(output, `${name}-${mode}-${width}.png`);
  await page.screenshot({path:file, fullPage:true});
  report.screenshots.push(file);
}

async function main() {
  const initialHashes = fingerprintFiles(source);
  const browser = await chromium.launch({channel:'msedge', headless:true});
  try {
    for (const mode of ['modern','classic']) {
      const run = await makePage(browser, 1440, 'emeraldLight');
      const page = run.page;
      const operations = [];
      let setupResponse = {body:ready};
      let companionResponse = {body:{detail:'Not Found'}, status:404};
      let cardResponse = null;
      let holdSetup = null;
      await page.route('**/mesh/trust/**', async route => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        const call = {method:request.method(), path:pathname};
        if (request.postData()) call.body = request.postDataJSON();
        operations.push(call);
        if (pathname === '/mesh/trust/setup') {
          if (holdSetup) return holdSetup(route);
          return json(route, setupResponse.body, setupResponse.status || 200);
        }
        if (pathname === '/mesh/trust/card') {
          if (cardResponse) return json(route, cardResponse.body, cardResponse.status || 200);
          return json(route, {ok:true,card:{...localCard,origin:call.body.origin}});
        }
        return json(route, {detail:'Unexpected operation in public-card setup test'}, 409);
      });
      await page.route('**/api/companion/v1/setup', route => {
        operations.push({method:route.request().method(),path:'/api/companion/v1/setup'});
        return json(route, companionResponse.body, companionResponse.status || 200);
      });
      const dialog = page.locator('#tli-peer-trust-dialog');
      const cardOutput = () => dialog.getByLabel(publicLabel, {exact:true});
      const address = () => dialog.getByLabel(addressLabel);
      const open = () => page.evaluate(() => TLIPeerTrust.open());
      const close = () => dialog.getByRole('button', {name:'Close',exact:true}).click();
      const waitCard = async card => {
        await page.waitForFunction(({label,card}) => {
          const field = [...document.querySelectorAll('#tli-peer-trust-dialog label')]
            .find(labelNode => labelNode.querySelector('span')?.textContent === label)?.querySelector('textarea');
          try {return JSON.stringify(JSON.parse(field?.value)) === JSON.stringify(card);} catch {return false;}
        }, {label:publicLabel,card});
      };
      const statuses = () => dialog.locator('#tli-peer-card-status');
      try {
        await page.evaluate(mode => {TLIInterface.set(mode); switchPanel('panel-mesh');}, mode);
        await open();
        await waitCard(localCard);
        assert.equal(await address().inputValue(), origin);
        assert.equal(await statuses().getAttribute('role'), 'status');
        assert.equal(await dialog.locator('#tli-peer-local-card').getByLabel(publicLabel,{exact:true}).count(), 1);
        assert.equal(await dialog.locator('#tli-peer-local-card #tli-peer-card-status').count(), 1);
        assert.equal(await dialog.getByRole('button',{name:'Copy card',exact:true}).isDisabled(), false);
        assert.deepEqual(operations, [{method:'GET',path:'/mesh/trust/setup'}]);
        assert.equal(await dialog.locator('input[type="checkbox"]:checked').count(), 0);
        await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
          configurable:true,value:{writeText:async text => {window.__copiedPublicCard=text;}}
        }));
        await dialog.getByRole('button',{name:'Copy card',exact:true}).click();
        await page.waitForFunction(() => typeof window.__copiedPublicCard === 'string');
        assert.deepEqual(JSON.parse(await page.evaluate(() => window.__copiedPublicCard)), localCard);
        for (const width of [1440,390]) await snapshot(page,mode,'public-card-ready',width);
        report.checks.push(`${mode}: public address/card load automatically; copy works; permissions remain explicit; desktop/mobile fit`);
        await close();

        setupResponse = {body:{...ready,ready:false,code:'https_unavailable',
          reason:'HTTPS is not active. Restart TLI with HTTPS enabled before exchanging cards.',
          origins:[],selected_origin:null,card:null}};
        await open();
        await statuses().filter({hasText:'HTTPS is not active.'}).waitFor();
        assert.equal(await cardOutput().inputValue(), '');
        assert.equal(await dialog.getByRole('button',{name:'Copy card',exact:true}).isDisabled(), true);
        assert.equal(await dialog.getByRole('button',{name:'Reload card',exact:true}).isDisabled(), false);
        await snapshot(page,mode,'https-unavailable',390);
        // Reload must recover from the failed setup without closing the review.
        setupResponse = {body:ready};
        await dialog.getByRole('button',{name:'Reload card',exact:true}).click();
        await waitCard(localCard);
        report.checks.push(`${mode}: HTTPS failure explains the empty card, disables copy, and recovers through reload`);
        await close();

        setupResponse = {body:{...ready,ready:false,code:'identity_unavailable',card:null,
          reason:'This computer’s public identity is unavailable. Restart TLI before exchanging cards.'}};
        let start = operations.length;
        await open();
        await statuses().filter({hasText:'public identity is unavailable'}).waitFor();
        assert.equal(await cardOutput().inputValue(), '');
        assert.deepEqual(operations.slice(start), [{method:'GET',path:'/mesh/trust/setup'}]);
        report.checks.push(`${mode}: unavailable identity cannot trigger public-card generation despite a selected origin`);
        await close();

        setupResponse = {body:{detail:'Not Found'},status:404};
        companionResponse = {body:{tls_enabled:true,lan_enabled:true,origins:[origin],
          node:{id:'fixture-studio',name:'Studio'},reason:null}};
        start = operations.length;
        await open();
        await waitCard(localCard);
        assert.deepEqual(operations.slice(start), [
          {method:'GET',path:'/mesh/trust/setup'},
          {method:'GET',path:'/api/companion/v1/setup'},
          {method:'POST',path:'/mesh/trust/card',body:{origin}},
        ]);
        report.checks.push(`${mode}: older healthy backend obtains a public card through read-only setup compatibility`);
        await close();

        companionResponse = {body:{detail:'Not Found'},status:404};
        await open();
        await statuses().filter({hasText:/restart/i}).waitFor();
        assert.equal(await cardOutput().inputValue(), '');
        assert.equal(await dialog.getByRole('button',{name:'Copy card',exact:true}).isDisabled(), true);
        assert.equal(await dialog.getByRole('button',{name:'Reload card',exact:true}).isDisabled(), false);
        report.checks.push(`${mode}: unsupported setup endpoint provides a visible restart instruction`);
        await close();

        setupResponse = {body:{...ready,ready:false,code:'choose_address',
          reason:'Choose this computer’s HTTPS LAN address for the other computer.',
          origins:[origin,otherOrigin],selected_origin:null,card:null}};
        start = operations.length;
        await open();
        await address().locator('option').filter({hasText:otherOrigin}).waitFor({state:'attached'});
        assert.equal(await address().inputValue(), '');
        assert.equal(await cardOutput().inputValue(), '');
        assert.deepEqual(operations.slice(start), [{method:'GET',path:'/mesh/trust/setup'}]);
        await snapshot(page,mode,'choose-lan-address',390);
        await address().selectOption(otherOrigin);
        await waitCard({...localCard,origin:otherOrigin});
        assert.deepEqual(operations.slice(start).filter(call=>call.method==='POST'), [
          {method:'POST',path:'/mesh/trust/card',body:{origin:otherOrigin}},
        ]);
        report.checks.push(`${mode}: multiple LAN addresses require explicit choice before public-card generation`);
        cardResponse = {status:409,body:{detail:'This HTTPS certificate does not cover the selected address. Restart TLI and reload this card.'}};
        await address().selectOption(origin);
        await statuses().filter({hasText:'does not cover the selected address'}).waitFor();
        assert.equal(await cardOutput().inputValue(), '');
        assert.equal(await dialog.getByRole('button',{name:'Copy card',exact:true}).isDisabled(), true);
        report.checks.push(`${mode}: failed card generation clears stale output and explains the failure beside the card`);
        cardResponse = null;
        await close();

        // A response for a closed review cannot overwrite a newly opened review.
        let pendingRoute, resolveHeld, notifyHeld;
        const held = new Promise(resolve => {notifyHeld=resolve;});
        holdSetup = route => new Promise(resolve => {
          pendingRoute=route; resolveHeld=resolve; notifyHeld();
        });
        await open();
        await held;
        await close();
        holdSetup = null;
        setupResponse = {body:{...ready,card:{...localCard,name:'New review'}}};
        await open();
        await waitCard(setupResponse.body.card);
        await json(pendingRoute, ready); resolveHeld();
        await page.waitForTimeout(80);
        assert.deepEqual(JSON.parse(await cardOutput().inputValue()), setupResponse.body.card);
        report.checks.push(`${mode}: late response after close cannot overwrite a newer review`);
        await close();

        const lockedHeld = new Promise(resolve => {notifyHeld=resolve;});
        holdSetup = route => new Promise(resolve => {
          pendingRoute=route; resolveHeld=resolve; notifyHeld();
        });
        await open();
        await lockedHeld;
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('tli-session-locked')));
        await json(pendingRoute, ready); resolveHeld();
        await page.waitForTimeout(80);
        assert.equal(await dialog.isVisible(), false);
        assert.equal(await dialog.locator('textarea,input,select').count(), 0);
        report.checks.push(`${mode}: locking clears the dialog and discards the pending public card`);

        assert.deepEqual(operations.filter(call => !safeOperations.has(call.path)), []);
        assert.deepEqual(run.calls.filter(call => !['GET','HEAD'].includes(call.method)), []);
        assert.deepEqual(run.errors, []);
        report.sessions.push({mode,operations,errors:run.errors});
      } finally {await run.context.close();}
    }
    report.sourceUnchanged = JSON.stringify(initialHashes) === JSON.stringify(fingerprintFiles(source));
    assert.equal(report.sourceUnchanged, true, 'Frontend changed during browser verification; rerun current source.');
    report.frontendHashes = initialHashes;
    report.passed = true;
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({output,checks:report.checks.length,passed:report.passed || false}));
  }
}
main().catch(error => {
  fs.writeFileSync(path.join(output,'error.txt'),error.stack);
  console.error(error);
  process.exitCode=1;
});
