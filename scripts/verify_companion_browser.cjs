/* Isolated pairing-panel browser QA. Never connects to a live TLI installation.
 * NODE_PATH must expose playwright; screenshots go to ignored build artifacts.
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build_work', 'section-clarity', 'companion-browser-' + new Date().toISOString().replace(/[:.]/g, '-'));
const assets = ['style.css', 'themes.css', 'ui-foundation.css', 'native-companion.css', 'js/native-companion.js','assets/companion-install.svg'];
const sources = Object.fromEntries(assets.map(file => [file, fs.readFileSync(path.join(root, 'frontend', file), 'utf8')]));

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 960 } });
  const errors = [], calls = [];
  let ready = true, revoked = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'companion.test') throw new Error('Unexpected external request');
    const file = assets.find(file => '/' + file === url.pathname);
    if (file) return route.fulfill({ contentType: file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.css') ? 'text/css' : 'application/javascript', body: sources[file] });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" }, body: '<!doctype html><html lang="en" data-theme="emeraldLight"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">'+assets.filter(file=>file.endsWith('.css')).map(file=>'<link rel="stylesheet" href="/'+file+'">').join('')+'</head><body data-tli-ui="anniversary" style="padding:20px;margin:0;min-width:0"><main id="panel-companion"></main><script src="/js/native-companion.js"></script></body></html>' });
    calls.push([route.request().method(), url.pathname]);
    let data;
    if (url.pathname.endsWith('/setup')) data = { tls_enabled: ready, lan_enabled: ready, pin_enabled: true, certificate_ready: ready, pairing_ready: ready, origins: ready ? ['https://192.168.1.12:8000'] : [], node: { id: 'test', name: 'Test TLI' } };
    else if (url.pathname.endsWith('/startup')) data = {ok:true,configured:true,saved:{host:'0.0.0.0',port:8000,https:true},running:{host:'0.0.0.0',port:8000,https:ready},effective_next:{host:'0.0.0.0',port:8000,https:true},restart_required:!ready,environment_overrides:[]};
    else if (url.pathname.endsWith('/pairings')) {
      assert.deepEqual(route.request().postDataJSON(), { origin: 'https://192.168.1.12:8000' });
      const expires_at = new Date(Date.now() + 300000).toISOString();
      data = { bundle: JSON.stringify({version:1,origin:'https://192.168.1.12:8000',token:'preview-only',certificate_der:'public-test',node_id:'test',node_name:'Test TLI',expires_at}), expires_at, qr: 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="white"/><path d="M8 8h40v40H8z M80 8h40v40H80z M8 80h40v40H8z M64 64h24v24H64z M96 96h24v24H96z" fill="black"/></svg>').toString('base64') };
    } else if (route.request().method() === 'DELETE') { revoked = true; data = { ok: true }; }
    else if (url.pathname.endsWith('/paired-devices')) data = { devices: revoked ? [] : [{ id: 'phone-1', name: '<img src=x onerror=alert(1)>', platform: 'ios', created_at: '2026-09-06T12:00:00Z' }] };
    else throw new Error('Unexpected API path: ' + url.pathname);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  try {
    await page.goto('https://companion.test/');
    await page.evaluate(()=>window.TLICompanion.open({step:'pair'}));
    await page.locator('#native-companion-status').filter({ hasText: 'Ready to pair securely.' }).waitFor();
    await page.locator('#native-companion-installed').click();
    assert.equal(calls.filter(([method])=>method!=='GET').length,0,'Opening the page does not create an invitation');
    assert.equal(await page.locator('.native-companion-device img').count(), 0);
    await page.getByRole('button', { name: 'Create pairing QR', exact: true }).evaluate(button => { button.dispatchEvent(new Event('click')); button.dispatchEvent(new Event('click')); });
    await page.getByRole('heading', { name: 'Scan inside the TLI Android app' }).waitFor();
    assert.equal(calls.filter(([method, url]) => method === 'POST' && url.endsWith('/pairings')).length, 1);
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'desktop-pairing.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'phone-pairing.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('#native-companion-management').evaluate(e=>{e.open=true});
    await page.locator('.native-companion-device-actions button').first().click();
    assert.equal(revoked, false);
    await page.locator('.native-companion-device-actions button').first().click();
    await page.getByText('No native phones paired yet.', { exact: true }).waitFor();
    ready = false;
    await page.getByRole('button', { name: 'Refresh connection setup' }).click();
    await page.waitForFunction(()=>document.getElementById('native-companion-connection-copy').textContent.includes('Use Connect phone'));
    assert.equal(await page.locator('#native-companion-generate').isDisabled(), true);
    assert.equal(await page.locator('.native-companion-pairing').isVisible(), false);
    await page.screenshot({ path: path.join(output, 'setup-guidance.png'), fullPage: true });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({status:'passed',scope:'Dedicated Phone Companion controller with synthetic intercepted responses',calls,sourceHashes:Object.fromEntries(Object.entries(sources).map(([file,source])=>[file,crypto.createHash('sha256').update(source).digest('hex')])),limitations:['No native app, physical phone, live pairing or host restart was tested.']},null,2));
    console.log('Phone Companion: CSP loading, safe labels, deliberate pairing, forced duplicate clicks, revocation, HTTPS guidance and 390px layout passed.');
    console.log(output);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
