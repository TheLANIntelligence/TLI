/* Current SPA with intercepted synthetic APIs only. Never starts or removes TLI. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {makePage, fixtures, layout, unexpectedRequests} = require('./verify_anniversary_ui_browser.cjs');
const output = path.join(__dirname, '..', 'build_work', 'uninstall', 'browser');
const report = {synthetic:true, checks:[], layouts:[], screenshots:[], sessions:[], limitations:[
  'Every browser request is intercepted. No live host, file browser, backup export, uninstaller or operating-system action is used.',
  'This verifies discovery, text layout, read-only metadata and navigation; native Windows removal is tested separately.'
]};
const registered = {platform:'Windows', supported:true, registered:true, installation_path:'C:\\Users\\Demo\\Applications\\The Legato Intelligence - Family Computer', entrypoint:'C:\\Users\\Demo\\Applications\\The Legato Intelligence - Family Computer\\Uninstall_TLI.bat', reason:'Run the uninstaller on the computer hosting this TLI.'};
fixtures['/system/uninstall'] = registered;
const capture = async (page, width, name) => {
  const file = path.join(output, `${width}-${name}.png`);
  if (width >= 700) await page.locator('#settings-section-uninstall').screenshot({path:file, animations:'disabled'});
  else {
    // The mobile SPA uses a scrolling content pane. Capture visible viewports,
    // not an element image clipped by that pane's fixed height.
    await page.locator('#settings-section-uninstall .settings-section-title').scrollIntoViewIfNeeded();
    await page.screenshot({path:file, animations:'disabled'});
    if (await page.locator('#tli-uninstall-guide').isVisible()) {
      for (const [part, selector] of [['middle', '#tli-uninstall-guide li:nth-child(3)'], ['end', '#tli-uninstall-guide > p:last-child']]) {
        const target = page.locator(selector);
        await target.scrollIntoViewIfNeeded();
        const bounds = await target.boundingBox();
        assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 950, name + ': ' + part + ' content is reachable above mobile navigation');
        const sectionFile = path.join(output, `${width}-${name}-${part}.png`);
        await page.screenshot({path:sectionFile, animations:'disabled'}); report.screenshots.push(sectionFile);
      }
    }
  }
  report.screenshots.push(file);
};
async function inspect(page, width, name) {
  const result = await layout(page, 'panel-settings');
  report.layouts.push({width, name, ...result});
  assert.deepEqual(result.overflow, [], name + ': visible controls must fit');
  assert.ok(result.documentWidth <= result.width + 2, name + ': document must fit');
  const card = await page.locator('#settings-section-uninstall').evaluate(el => ({client:el.clientWidth, scroll:el.scrollWidth}));
  assert.ok(card.scroll <= card.client + 2, name + ': uninstall card must fit');
}
async function run() {
  fs.mkdirSync(output, {recursive:true});
  const browser = await chromium.launch({channel:'msedge', headless:true});
  try {
    for (const [width, theme] of [[1440, 'emeraldLight'], [390, 'midnight']]) {
      fixtures['/system/uninstall'] = registered;
      const session = await makePage(browser, width, theme), {page} = session;
      page.setDefaultTimeout(8000);
      const check = async (name, fn) => { await fn(); report.checks.push({width, name, passed:true}); };
      try {
        await page.waitForFunction(() => window.TLISettingsWorkspace && document.getElementById('data-recovery-settings') && document.getElementById('vault-backups'));
        await page.evaluate(() => switchPanel('panel-settings'));
        await check('Settings search discovers uninstall without loading host metadata', async () => {
          await page.locator('#settings-search').fill('uninstall');
          await page.locator('[data-settings-result="settings-section-uninstall"]').click();
          assert.equal(await page.locator('#settings-section-uninstall').isVisible(), true);
          assert.equal(await page.locator('[data-settings-category="app"]').getAttribute('aria-current'), 'page');
          assert.equal(session.calls.filter(call => call.path === '/system/uninstall').length, 0);
          await inspect(page, width, 'discovery');
          await capture(page, width, 'discovery');
        });
        await check('registered Windows instructions display exact host folder and clear data choices', async () => {
          await page.locator('#tli-uninstall-show').click();
          await page.waitForFunction(() => !document.getElementById('tli-uninstall-guide').hidden);
          const guide = await page.locator('#tli-uninstall-guide').innerText();
          assert.match(guide, /Installed apps/); assert.match(guide, /matching this installation folder/);
          assert.ok(guide.includes(registered.entrypoint));
          assert.match(guide, /keep all files.*retaining the installation/s);
          assert.match(guide, /permanently delete this installation folder.*saved data and downloaded models/s);
          assert.match(guide, /Python.*Visual C\+\+ runtime/s);
          assert.match(await page.locator('#settings-section-uninstall').innerText(), /phone or another browser.*that computer/s);
          assert.equal(session.calls.filter(call => call.path === '/system/uninstall').length, 1);
          await inspect(page, width, 'registered'); await capture(page, width, 'registered');
        });
        await check('backup buttons open existing Saved work and Vault workflows without preparing archives', async () => {
          await page.locator('#tli-uninstall-saved-work').click();
          assert.equal(await page.locator('#data-recovery-settings').isVisible(), true);
          assert.equal(await page.locator('#data-recovery-settings').getAttribute('open'), '');
          await page.evaluate(() => TLISettingsWorkspace.open('app', 'settings-section-uninstall'));
          await page.locator('#tli-uninstall-vault').click();
          assert.equal(await page.locator('#panel-vault').isVisible(), true);
          assert.equal(await page.locator('#vault-backups').getAttribute('open'), '');
          assert.equal(await page.locator('#vb-create').isVisible(), true);
          await page.evaluate(() => { switchPanel('panel-settings'); TLISettingsWorkspace.open('app', 'settings-section-uninstall'); });
        });
        await check('portable and source-copy guidance avoids claiming Windows registration', async () => {
          fixtures['/system/uninstall'] = {...registered, registered:false};
          await page.locator('#tli-uninstall-show').click();
          await page.waitForFunction(() => document.getElementById('tli-uninstall-guide').textContent.includes('File Explorer'));
          assert.doesNotMatch(await page.locator('#tli-uninstall-guide').innerText(), /Installed apps/);
          fixtures['/system/uninstall'] = {...registered, registered:false, supported:false, entrypoint:null, reason:'Automatic folder deletion is unavailable for a source checkout.'};
          await page.locator('#tli-uninstall-show').click();
          await page.waitForFunction(() => document.getElementById('tli-uninstall-guide').textContent.includes('source checkout'));
          assert.match(await page.locator('#tli-uninstall-guide').innerText(), /Remove its files manually.*preserve any work/s);
          await inspect(page, width, 'manual'); await capture(page, width, 'manual');
        });
        await check('lock clears the host path and prevents any further guidance requests', async () => {
          await page.evaluate(() => window.dispatchEvent(new Event('tli-session-locked')));
          assert.equal(await page.locator('#tli-uninstall-guide').isVisible(), false);
          assert.equal(await page.locator('#tli-uninstall-show').isDisabled(), true);
          assert.equal(await page.locator('#tli-uninstall-guide').textContent(), '');
        });
        assert.deepEqual(unexpectedRequests(session.calls), [], 'No mutating API calls or inference actions');
        assert.deepEqual(session.errors, [], 'No uncaught browser errors');
        report.sessions.push({width, theme, errors:session.errors, mutationCalls:unexpectedRequests(session.calls), uninstallRequests:session.calls.filter(call => call.path === '/system/uninstall')});
      } finally { await session.context.close(); }
    }
    report.passed = true;
  } catch (error) { report.passed = false; report.error = error.stack; throw error; }
  finally { fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser.close(); }
  console.log(JSON.stringify({output, passed:report.passed, checks:report.checks.length, screenshots:report.screenshots}));
}
run().catch(error => { console.error(error); process.exitCode = 1; });
