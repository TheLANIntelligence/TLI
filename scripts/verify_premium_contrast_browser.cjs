/* Computed accessibility checks against actual premium controls. Synthetic host only. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
if (!process.argv.includes('--label')) process.argv.push('--label', 'premium-contrast');
const { makePage, out } = require('./verify_anniversary_ui_browser.cjs');
const { contrast } = require('./verify_anniversary_themes_browser.cjs');
const report = { synthetic: true, checks: [], help: [], errors: [], limitations: [
  'Computed text contrast, resolved control colors and focus styles in Edge; not a screen-reader or Windows High Contrast certification.',
  'Native select popup painting is owned by Windows and is not captured; selected-control, option colors and color-scheme are checked.',
  'Disabled controls are excluded from WCAG text contrast. No live TLI services or devices contacted.'
] };
function visibleScript() {
  window.__themeAuditVisible = el => {
    if (el.closest('[hidden],.hidden,[aria-hidden="true"]') || !el.getClientRects().length || getComputedStyle(el).visibility !== 'visible') return false;
    for (let parent = el; parent; parent = parent.parentElement) {
      if (Number(getComputedStyle(parent).opacity) === 0) return false;
      if (parent !== el && parent.tagName === 'DETAILS' && !parent.open && !parent.querySelector(':scope > summary')?.contains(el)) return false;
    }
    return true;
  };
}
async function check(page, theme, name, selector) {
  const result = await contrast(page, selector);
  report.checks.push({ theme, name, selector, ...result });
}
async function main() {
 const browser = await chromium.launch({ channel: 'msedge', headless: true });
 try {
  const run = await makePage(browser, 1440, 'emeraldLight', { preserveSettingsOnReload: true });
  const page = run.page; await page.evaluate(visibleScript);
  assert.equal(await page.locator('html').getAttribute('data-experience'), 'premium');
  const themes = await page.evaluate(() => window.TLIThemes.themes.map(({id,tone}) => ({id,tone})));
  const before = await page.evaluate(() => localStorage.getItem('tli_settings'));
  for (const theme of themes) {
   await page.evaluate(id => { window.TLIThemes.apply(id); switchPanel('panel-main'); }, theme.id);
   await check(page, theme.id, 'conversation', '#panel-main');
   await check(page, theme.id, 'sidebar', '.app-shell > .sidebar');
   await check(page, theme.id, 'placeholder', '#chat-input');
   const selected = page.locator('.app-shell > .sidebar .side-nav-button.active').first();
   await selected.hover(); await check(page, theme.id, 'selected-nav-hover', '.app-shell > .sidebar');
   await page.locator('#chat-input').fill('A draft stays here while appearance changes.');
   await check(page, theme.id, 'composer-text', '#chat-input');
   await check(page, theme.id, 'send-button', '#chat-send-btn');
   await page.locator('#chat-input').fill('');
   await page.evaluate(() => { switchPanel('panel-settings'); window.TLISettingsWorkspace.open('general','settings-section-appearance'); });
   await check(page, theme.id, 'theme-dropdown', '#settings-theme');
   const native = await page.locator('#settings-theme').evaluate(el => ({ scheme:getComputedStyle(el).colorScheme, fg:getComputedStyle(el).color, bg:getComputedStyle(el).backgroundColor, optionFg:getComputedStyle(el.options[0]).color, optionBg:getComputedStyle(el.options[0]).backgroundColor }));
   assert.equal(native.scheme, theme.tone);
   report.checks.push({ theme:theme.id, name:'native-dropdown-colors', ...native, findings:[], review:[], gradientChecks:[] });
   // Reveal existing PIN UI only; no authentication or lock endpoint is called.
   await page.evaluate(() => { const lock=document.getElementById('tli-lock-screen'); lock.hidden=false; lock.classList.remove('hidden'); lock.setAttribute('aria-hidden','false'); document.getElementById('tli-lock-error').textContent='The PIN was not accepted. Try again.'; });
   await check(page, theme.id, 'PIN-dialog-and-error', '#tli-lock-screen');
   await page.locator('#tli-lock-submit').hover(); await check(page, theme.id, 'unlock-button-hover', '#tli-lock-submit');
   await page.locator('#tli-lock-input').focus();
   const focus = await page.locator('#tli-lock-input').evaluate(el => ({ style:getComputedStyle(el).outlineStyle, width:getComputedStyle(el).outlineWidth, color:getComputedStyle(el).outlineColor }));
   assert.ok(focus.style !== 'none' && parseFloat(focus.width) >= 2);
   report.checks.push({ theme:theme.id, name:'PIN-keyboard-focus', ...focus, findings:[], review:[], gradientChecks:[] });
   await page.evaluate(() => { const lock=document.getElementById('tli-lock-screen'); lock.classList.add('hidden'); lock.setAttribute('aria-hidden','true'); document.getElementById('tli-lock-error').textContent=''; });
  }
  assert.equal(await page.evaluate(() => localStorage.getItem('tli_settings')), before);
  // Standalone Help must respond to OS changes in System mode without writes.
  await page.evaluate(() => localStorage.setItem('tli_settings', JSON.stringify({ defaultTheme:'pacific', appearanceMode:'system' })));
  const manual=await run.context.newPage(); manual.on('pageerror', e=>report.errors.push(e.stack||e.message));
  await manual.emulateMedia({ colorScheme:'dark', reducedMotion:'reduce' });
  await manual.goto('http://tli-ui.test/manual.html',{waitUntil:'load'});
  const helpSaved=await manual.evaluate(() => localStorage.getItem('tli_settings'));
  for (const [scheme, id] of [['dark','midnight'],['light','emeraldLight'],['dark','midnight']]) {
   await manual.emulateMedia({ colorScheme:scheme, reducedMotion:'reduce' });
   await manual.waitForFunction(({scheme,id}) => document.documentElement.dataset.helpTone===scheme && document.documentElement.dataset.theme===id,{scheme,id});
   assert.equal(await manual.evaluate(() => localStorage.getItem('tli_settings')),helpSaved);
   report.help.push({ scheme,id,followed:true,noWrites:true });
  }
  await manual.close(); report.errors.push(...run.errors);
  report.operations=run.calls.filter(call=>!['GET','HEAD'].includes(call.method));
  await run.context.close();
 } finally { await browser.close(); }
 report.summary={ checks:report.checks.length, findings:report.checks.reduce((n,c)=>n+c.findings.length,0), review:report.checks.reduce((n,c)=>n+c.review.length,0), helpChanges:report.help.length, errors:report.errors.length, operations:report.operations.length };
 fs.writeFileSync(path.join(out,'premium-contrast-report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({out,...report.summary}));
 assert.equal(report.summary.findings,0,'Computed text contrast failures');
 assert.equal(report.summary.errors,0,'Browser errors'); assert.equal(report.summary.operations,0,'Unexpected operations');
}
main().catch(error => {fs.writeFileSync(path.join(out,'premium-contrast-error.txt'),error.stack); console.error(error); process.exitCode=1;});
