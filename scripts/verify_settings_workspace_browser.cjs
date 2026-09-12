/* Isolated Settings acceptance with its Phone Companion handoff.
 * --anniversary remains a supported no-op argument. The real Settings,
 * recovery, Notebook and Companion controllers use synthetic fixtures; this does
 * not start TLI, models, downloads, devices, updates or an HTTP server. */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const anniversary = true;
const bodyAttributes = ' data-tli-ui="anniversary"';
const output = path.join(root, 'build_work', ...(anniversary ? ['anniversary-ui'] : []), 'settings-workspace-browser-' + (anniversary ? 'anniversary-' : '') + new Date().toISOString().replace(/[:.]/g, '-'));
const read = file => fs.readFileSync(path.join(root, 'frontend', file), 'utf8');
const shell = read('index.html'), appSource = read('app.js'), app = appSource.replace(/\r/g, '');
function panelFrom(html, id) {
  const start = html.search(new RegExp('<section\\b[^>]*\\bid="' + id + '"[^>]*>'));
  assert.ok(start >= 0, id + ' exists');
  const re = /<\/?section\b[^>]*>/g; re.lastIndex = start;
  let depth = 0, match;
  while ((match = re.exec(html))) { depth += match[0].startsWith('</') ? -1 : 1; if (depth === 0) return html.slice(start, re.lastIndex); }
  throw new Error('Unclosed ' + id);
}
const panel = panelFrom(shell, 'panel-settings').replace(/\s+hidden(?=\s|>)/, '').replace('class="panel-container"', 'class="panel-container active"');
const companionPanel = panelFrom(shell, 'panel-companion');
const extract = (first, last) => {
  const a = app.indexOf(first), b = app.indexOf(last, a);
  assert.ok(a >= 0 && b > a, 'Source fixture boundary: ' + first); return app.slice(a, b);
};
const styles = ['style.css', 'themes.css', 'settings_enhanced.css', 'shell-refinement.css', 'intelligence.css', 'notebook.css', 'data-recovery.css', 'native-companion.css', 'settings-workspace.css'];
const scripts = ['js/settings.js', 'settings_enhanced.js', 'js/vault.js', 'js/tli-search.js', 'js/tli-update.js', 'js/intelligence.js', 'js/notebook.js', 'js/data-recovery.js', 'js/native-companion.js', 'js/settings-workspace.js'];
if (anniversary) { styles.push('ui-foundation.css'); scripts.unshift('js/chat-format.js'); scripts.push('js/ui-foundation.js'); }
const sources = { 'index.html': shell, 'app.js': appSource, ...Object.fromEntries([...styles, ...scripts].map(file => [file, read(file)])) };
const beforePath = path.join(root, 'build_work', 'settings-refresh', 'index.before.html');
assert.ok(fs.existsSync(beforePath), 'Pre-change Settings shell snapshot is required');
const beforeShell = fs.readFileSync(beforePath, 'utf8');
const fixture = `
const $=id=>document.getElementById(id), DEFAULT_THEME=document.documentElement.dataset.theme;
const previousPromptsKey='tli_previous_prompts',previousConversationsKey='tli_previous_conversations';
let currentDeviceId='fixture-browser';
window.fixtureToasts=[];window.fixtureModelManagerOpened=0;window.fixtureNavigation=[];
const showToast=(text,type='info')=>{window.fixtureToasts.push({text,type});$('fixture-status').textContent=text;};
const debugLog=()=>{},loadPreviousPrompts=()=>{},applyTheme=theme=>{document.documentElement.dataset.theme=theme;};
const switchPanel=id=>{window.fixtureNavigation.push(id);if(!['panel-settings','panel-companion'].includes(id))return;for(const key of ['panel-settings','panel-companion'])$(key).hidden=key!==id;if(id==='panel-companion')return window.TLICompanion?.onOpen();window.TLICompanion?.onClose();};
window.switchPanel=switchPanel;
window.tliOpenModelManagerModal=()=>{window.fixtureModelManagerOpened++;};
window.TLIPinLock={showRecovery:message=>{window.fixturePinRecovery=message;}};
${extract('function makeCollapsible(card)', '// ---------- sidebar panels')}
localStorage.setItem('tli_settings',JSON.stringify({defaultBrain:'bundled',defaultTemp:'0.7',defaultMax:'768',defaultTheme:DEFAULT_THEME,searchEnabled:false,searxUrl:'https://search.example.invalid',unrelatedFixtureSetting:'keep-me'}));
document.addEventListener('DOMContentLoaded',()=>{
  loadSettingsPanel();setupSettingsPanel();setupSettingsPanel();setupSettingsVault();
  document.querySelectorAll('.collapsible-card').forEach(makeCollapsible);
  const dashboard=document.createElement('section');dashboard.hidden=true;dashboard.id='fixture-dashboard';
  const narrator=document.createElement('details');narrator.id='narrator-preferences';
  const title=document.createElement('summary');title.textContent='Existing Narrator settings';narrator.append(title);dashboard.append(narrator);document.body.append(dashboard);
});
`;
const startup = { ok: true, configured: true, saved: { host: '127.0.0.1', port: 8450, https: true }, effective_next: { host: '127.0.0.1', port: 8450, https: true }, running: { host: '127.0.0.1', port: 8450, https: true }, restart_required: false, environment_overrides: [] };
const dataHealth = { schema_version: 1, checked_at: '2026-09-07T19:00:00Z', host: { id: 'fixture-host', name: 'Studio test host' }, scope: 'Only this synthetic account’s saved notes, conversations and diagnostic reports were checked.',
  checks: [ { id: 'notebook', label: 'Saved notes', status: 'readable', detail: 'Synthetic notes can be read.' }, { id: 'conversations', label: 'AI conversations', status: 'readable', detail: 'Synthetic conversations can be read.' }, { id: 'diagnostics', label: 'Diagnostic reports', status: 'not_created', detail: 'No synthetic reports saved yet.' } ],
  backup: { status: 'unknown', detail: 'This check does not verify a backup archive.' }, guidance: { summary: 'Create and verify an archive separately.', steps: ['Review the included stores.'], limitations: ['Whole-installation recovery is not verified by this check.'] } };
const syntheticNote = { id: 'fixture-note', revision: 'a'.repeat(64), title: 'Studio backup location', text: 'The spare backup drive is kept in the studio drawer.', source: 'user', category: 'general', updated_at: '2026-09-07T19:00:00Z', created_at: '2026-09-06T19:00:00Z', device_id: null };
const categories = ['general', 'ai', 'access', 'data', 'app'];
const mutations = requests => requests.filter(r => !['GET', 'HEAD', 'OPTIONS'].includes(r.method));

async function reveal(page, category, sectionId) {
  await page.evaluate(({ category, sectionId }) => {window.switchPanel('panel-settings');window.TLISettingsWorkspace.open(category, sectionId);}, { category, sectionId });
  if(sectionId==='native-companion-settings'){
    await page.waitForFunction(()=>!document.getElementById('panel-companion').hidden&&!document.getElementById('native-companion-refresh').disabled);
    await page.locator('#native-companion-startup-details').evaluate(detail=>{detail.open=true;});
  }else await page.waitForFunction(id => !document.getElementById('settings-group-' + id).hidden, category);
}
async function layout(page, label) {
  const result = await page.evaluate(() => {
    const panel = document.querySelector('.panel-container:not([hidden])'), viewport = document.documentElement.clientWidth;
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    return { viewport, document: document.documentElement.scrollWidth,
      outside: [...panel.querySelectorAll('button,input,select,textarea')].filter(visible).map(el => ({id:el.id, text:el.textContent.trim().slice(0,45), left:el.getBoundingClientRect().left, right:el.getBoundingClientRect().right})).filter(r=>r.left < -1 || r.right > viewport + 1),
      scrollContainers: [...panel.querySelectorAll('*')].filter(el => visible(el) && ['auto','scroll'].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0).map(el => ({id:el.id,class:el.className,height:el.clientHeight,scrollHeight:el.scrollHeight})),
      duplicateIds: [...document.querySelectorAll('[id]')].map(el=>el.id).filter((id,i,ids)=>ids.indexOf(id)!==i) };
  });
  assert.ok(result.document <= result.viewport + 1, label + ': page overflow ' + JSON.stringify(result));
  assert.deepEqual(result.outside, [], label + ': controls offscreen');
  assert.deepEqual(result.scrollContainers.filter(el => el.id !== 'debug-log'), [], label + ': nested settings scroll');
  assert.deepEqual(result.duplicateIds, [], label + ': duplicate IDs');
  return {label,...result};
}


async function anniversaryScope(page, before, after, featureId) {
  const result = await page.evaluate(({before, after, featureId}) => {
    const old = new DOMParser().parseFromString(before, 'text/html'), current = new DOMParser().parseFromString(after, 'text/html');
    const oldPanels = [...old.querySelectorAll('section[id^="panel-"]')].map(el => el.id);
    const missingPanels = oldPanels.filter(id => current.querySelectorAll('[id="' + id + '"]').length !== 1);
    const oldControls = [...old.getElementById(featureId).querySelectorAll('button[id],input[id],select[id],textarea[id]')].map(el => el.id);
    const missingControls = oldControls.filter(id => document.querySelectorAll('[id="' + id + '"]').length !== 1);
    return {status: missingPanels.length || missingControls.length ? 'failed' : 'passed', checkedPanels: oldPanels.length, checkedControls: oldControls.length, missingPanels, missingControls};
  }, {before, after, featureId});
  assert.equal(result.status, 'passed', 'Existing full-shell panel IDs and feature control IDs survive exactly once: ' + JSON.stringify(result));
  return {...result, mode: 'anniversary', boundary: 'Whole-app UI refresh explicitly authorized; outside-panel HTML equality is obsolete for this mode.',
    coverage: 'This harness verifies feature interactions with current shared styles and renderer. The separate verify_anniversary_ui_browser.cjs covers all panels and shell viewports; verify_anniversary_search_browser.cjs covers integrated search and modal navigation.'};
}

(async () => {
  fs.mkdirSync(output, {recursive:true});
  const results=[], browser=await chromium.launch({channel:'msedge',headless:true});
  let sourceScope;
  try {
    for (const viewport of [{width:1440,height:1000},{width:390,height:844},{width:320,height:740}]) for (const theme of ['emeraldLight','midnight']) {
      const page=await browser.newPage({viewport});page.setDefaultTimeout(8000);
      const errors=[], requests=[], unexpected=[], checks=[], layouts=[];
      let startupMissing=true, setupReady=false, failMeshSave=false, failUpdateSave=false, failHealth=false;
      page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/*',async route=>{
        const req=route.request(),url=new URL(req.url());
        const json=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
        if(url.origin!=='https://tli-settings.test'){unexpected.push(url.origin+url.pathname);return route.abort();}
        if(url.pathname==='/fixture.js')return route.fulfill({contentType:'application/javascript',body:fixture});
        const asset=[...styles,...scripts].find(file=>'/'+file===url.pathname);
        if(asset)return route.fulfill({contentType:asset.endsWith('.css')?'text/css':'application/javascript',body:sources[asset]});
        if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><html lang="en" data-theme="'+theme+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+styles.map(file=>'<link rel="stylesheet" href="/'+file+'">').join('')+'<style>body{margin:0;min-width:0}.fixture-top{padding:16px 20px;border-bottom:1px solid var(--border-subtle);color:var(--text-main);font:600 14px system-ui}.fixture-main{padding:16px;max-width:1500px;margin:auto;min-width:0}#fixture-status{display:none;position:fixed;left:8px;bottom:4px;max-width:90vw;font:12px system-ui;color:var(--text-main);z-index:40;pointer-events:none}@media(max-width:500px){.fixture-main{padding:8px}}</style></head><body' + bodyAttributes + '><header class="fixture-top">TheLANIntelligence · LAN Console</header><main class="fixture-main">'+panel+companionPanel+'</main><div hidden id="fixture-chat"><div class="chat-input-row"></div><div class="chat-actions-row"><div></div></div><input id="temperature-input"><input id="max-tokens-input"></div><p id="fixture-status" role="status"></p><script src="/fixture.js"></script>'+scripts.map(file=>'<script src="/'+file+'"></script>').join('')+'</body></html>'});
        const record={method:req.method(),path:url.pathname};requests.push(record);
        if(req.postData())try{record.body=req.postDataJSON();}catch{record.body='Non-JSON fixture payload';}
        if(url.pathname==='/system/profile')return json({ok:true,current:'balanced',profiles:{balanced:{label:'Balanced'}},ui_defaults:{temp:'0.7',max_tokens:'768'}});
        if(url.pathname==='/system/probe')return json({cpu_cores:8,cpu_threads:16,ram_total_gb:32,suggested_profile:'balanced'});
        if(url.pathname==='/models/available')return json({models:[],server_url:'http://localhost:1234/v1/models',compat:{ok:false,error:'Synthetic provider unavailable'}});
        if(url.pathname==='/mesh/node')return json({display_name:'Studio test host',role:'standalone',node_id:'fixture-host'});
        if(url.pathname==='/identity')return json({fingerprint:'a'.repeat(64),public_key:'b'.repeat(88),created_at:'2026-09-07T19:00:00Z'});
        if(url.pathname==='/api/ai/mesh/preference')return req.method()==='POST' && failMeshSave ? json({detail:'Synthetic save failure'},503) : json({ok:true,prefer_mesh_ai:record.body?.prefer_mesh_ai??false,mesh_ai_cpu_threshold:record.body?.mesh_ai_cpu_threshold??80});
        if(url.pathname==='/system/pin/status')return json({enabled:true});
        if(url.pathname==='/api/ai/models/presets')return json({presets:[{id:'standard',name:'Qwen fixture',installed:true,selected:true,running:false}],active:'standard'});
        if(url.pathname==='/api/ai/model/progress')return json({status:'idle',in_progress:false});
        if(url.pathname==='/license/status')return json({tier:'free',valid:true,features:{mesh:true,vault:true}});
        if(url.pathname==='/update/status')return json({state:'idle',current_version:'fixture',update_url:'https://updates.example.invalid/manifest.json',auto_check:false});
        if(url.pathname==='/update/settings')return failUpdateSave ? json({detail:'Synthetic update setting failure'},503) : json({ok:true,update_url:record.body.update_url,auto_check:record.body.auto_check});
        if(url.pathname==='/api/intelligence/images')return json({images:[]});
        if(url.pathname==='/api/intelligence/models')return json({models:[],note:'No provider is confirmed available in this isolated fixture.'});
        if(url.pathname==='/api/intelligence/memory')return json({facts:[syntheticNote]});
        if(url.pathname==='/api/intelligence/devices')return json({node:{id:'fixture-host',name:'Studio test host'},devices:[],scope:'Synthetic test host only.'});
        if(url.pathname==='/api/intelligence/data-health')return failHealth ? json({detail:'Synthetic saved-data read failure'},503) : json(dataHealth);
        if(url.pathname==='/api/companion/v1/startup')return startupMissing ? json({detail:'Not Found'},404) : json(startup);
        if(url.pathname==='/api/companion/v1/setup')return json({pairing_ready:setupReady,pin_enabled:true,tls_enabled:setupReady,lan_enabled:setupReady,certificate_ready:setupReady,origins:setupReady?['https://192.0.2.10:8450']:[]});
        if(url.pathname==='/api/companion/v1/paired-devices')return json({devices:[]});
        if(url.pathname==='/dashboard/narrator/settings')return json({scope:'host',mode:'balanced',narrator:{explanations:[]}});
        unexpected.push(url.pathname);return json({detail:'No endpoint exists in this isolated fixture'},404);
      });
      try {
        await page.goto('https://tli-settings.test/');
        await page.waitForFunction(()=>window.TLISettingsWorkspace && document.querySelectorAll('#settings-category-nav button[data-settings-category]').length===5);
        await page.waitForFunction(()=>document.getElementById('native-companion-settings') && document.getElementById('data-recovery-settings'));
        assert.equal(await page.locator('#settings-theme').inputValue(),theme,'The fixture uses a selectable theme and displays its saved value');
        if(!sourceScope && anniversary){
          sourceScope=await anniversaryScope(page,beforeShell,shell,'panel-settings');
        }else if(!sourceScope){
          sourceScope=await page.evaluate(({before,after})=>{
            const normalize=html=>{const d=new DOMParser().parseFromString(html,'text/html');d.querySelectorAll('#panel-settings,script,link[rel="stylesheet"]').forEach(el=>el.remove());return d.documentElement.outerHTML.replace(/\s+/g,' ').trim();};
            const a=normalize(before),b=normalize(after);let diff=0;while(diff<a.length&&a[diff]===b[diff])diff++;
            return {status:a===b?'passed':'failed',excluded:['Settings panel','stylesheet links','script tags'],...(a===b?{}:{before:a.slice(Math.max(0,diff-100),diff+300),after:b.slice(Math.max(0,diff-100),diff+300)})};
          },{before:beforeShell,after:shell});
          assert.equal(sourceScope.status,'passed','Only Settings markup changes: '+JSON.stringify(sourceScope));
        }
        const preserved=await page.evaluate(before=>{
          const old=new DOMParser().parseFromString(before,'text/html').getElementById('panel-settings');
          return [...old.querySelectorAll('[id]')].map(el=>el.id).filter(id=>document.querySelectorAll('[id="'+id+'"]').length!==1);
        },beforeShell);
        assert.deepEqual(preserved,[],'Every existing Settings ID survives exactly once');
        checks.push(anniversary ? 'Existing Settings IDs and full-shell panel IDs preserved; shared anniversary presentation loaded' : 'Existing Settings IDs preserved; body markup outside Settings unchanged');
        const beforeNavigate=mutations(requests).length;
        for(const category of categories){await page.locator('#settings-category-nav button[data-settings-category="'+category+'"]').click();layouts.push(await layout(page,category));}
        const beforeSearchReads=requests.length;
        await page.locator('#settings-search').fill('port');
        await page.waitForFunction(()=>document.querySelectorAll('#settings-search-results button[data-settings-result]').length>0);
        assert.ok(await page.locator('#settings-search-status').textContent(),'Search announces its result');
        assert.equal(requests.length,beforeSearchReads,'Typing search performs no server reads or writes');
        await page.locator('#settings-search').fill('qzxy-no-setting');
        await page.waitForFunction(()=>/no/i.test(document.getElementById('settings-search-status').textContent));
        await page.locator('#settings-find-clear').click();
        assert.equal(await page.locator('#settings-search').inputValue(),'');
        assert.equal(mutations(requests).length,beforeNavigate,'Category navigation/search never writes settings');
        await reveal(page,'access','settings-section-node-identity');
        await page.locator('#settings-node-name').fill('private-fixture-value-zq71');
        await page.locator('#settings-search').fill('private-fixture-value-zq71');
        await page.waitForFunction(()=>/no/i.test(document.getElementById('settings-search-status').textContent));
        assert.equal(await page.locator('#settings-search-results button[data-settings-result]').count(),0,'Settings search excludes private form values');
        await page.locator('#settings-find-clear').click();
        checks.push('Five categories and search reveal controls with no mutation requests');
        await reveal(page,'general');layouts.push(await layout(page,'general-final'));
        await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(output,`general-${viewport.width}-${theme}.png`),fullPage:true,animations:'disabled'});
        const profileHeading=page.locator('#settings-section-host-profile .settings-section-header');
        if(await profileHeading.count()){
          await profileHeading.focus();await profileHeading.press('Enter');
          assert.equal(await profileHeading.getAttribute('aria-expanded'),'true');
          await profileHeading.press('Space');assert.equal(await profileHeading.getAttribute('aria-expanded'),'false');
          checks.push('Accordion controls open and close once through keyboard interaction');
        }
        if(await page.locator('#settings-open-narrator').count()){
          const priorNavigation=requests.length;await page.locator('#settings-open-narrator').click();
          assert.equal(await page.evaluate(()=>window.fixtureNavigation.at(-1)),'panel-dashboard2');
          assert.equal(requests.length,priorNavigation,'Narrator shortcut navigates without changing host settings');
          checks.push('Narrator shortcut opens existing Dashboard without duplicated controls');
        }
        await reveal(page,'ai','settings-section-chat');
        await page.locator('#settings-temp').selectOption('0.4');
        await page.locator('#settings-save').click();
        const preferences=await page.evaluate(()=>JSON.parse(localStorage.getItem('tli_settings')));
        assert.equal(preferences.defaultTemp,'0.4');assert.equal(preferences.unrelatedFixtureSetting,'keep-me');assert.equal(preferences.searxUrl,'https://search.example.invalid');
        checks.push('Chat save preserves independent browser settings');
        await reveal(page,'ai','settings-section-intelligence');
        const routing=page.locator('#settings-section-intelligence');
        assert.deepEqual(await routing.locator('fieldset.settings-routing-group legend').allTextContents(),['This browser','TLI host'],'Routing groups explain the scope of each setting');
        const routingSwitch=routing.locator('#settings-prefer-mesh-ai');
        assert.equal(await routingSwitch.getAttribute('type'),'checkbox','Routing switch retains native checkbox behavior');
        assert.ok(await routingSwitch.getAttribute('aria-label'),'Routing switch has an accessible name');
        const beforeToggle=mutations(requests).length,wasChecked=await routingSwitch.isChecked();
        await routingSwitch.focus();await routingSwitch.press('Space');
        assert.equal(await routingSwitch.isChecked(),!wasChecked,'One keyboard press toggles routing exactly once');
        assert.equal(mutations(requests).length,beforeToggle,'Changing routing switch only edits the draft until Save');
        layouts.push(await layout(page,'routing-draft'));
        checks.push('Routing has separate browser/host groups; native switch toggles once by keyboard without saving');
        failMeshSave=true;let prior=mutations(requests).length;
        await page.locator('#settings-mesh-ai-save').click();
        await page.waitForFunction(()=>!document.getElementById('settings-mesh-ai-save').disabled);
        assert.equal(mutations(requests).length,prior+1,'One failed mesh save request');
        assert.match((await page.evaluate(()=>window.fixtureToasts.at(-1))).text,/failed|could not|not saved/i);
        failMeshSave=false;prior=mutations(requests).length;
        await page.locator('#settings-mesh-ai-save').click();
        await page.waitForFunction(()=>!document.getElementById('settings-mesh-ai-save').disabled);
        assert.equal(mutations(requests).length,prior+1,'One successful mesh save request');
        assert.match((await page.evaluate(()=>window.fixtureToasts.at(-1))).text,/saved/i);
        checks.push('Real save handlers execute once and distinguish failure/success');
        layouts.push(await layout(page,'ai-settings'));
        await routing.screenshot({path:path.join(output,`routing-${viewport.width}-${theme}.png`),animations:'disabled'});
        await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(output,`ai-${viewport.width}-${theme}.png`),fullPage:true,animations:'disabled'});
        await reveal(page,'app','settings-section-updates');
        await page.locator('#settings-update-url').fill('https://updates.example.invalid/reviewed.json');
        failUpdateSave=true;prior=mutations(requests).length;
        await page.locator('#settings-update-url-save').click();
        await page.waitForFunction(()=>!document.getElementById('settings-update-url-save').disabled);
        assert.equal(mutations(requests).length,prior+1,'One rejected update-settings save');
        assert.doesNotMatch(await page.locator('#settings-update-url-save').textContent(),/saved/i);
        failUpdateSave=false;prior=mutations(requests).length;
        await page.locator('#settings-update-url-save').click();
        await page.waitForFunction(()=>!document.getElementById('settings-update-url-save').disabled);
        assert.equal(mutations(requests).length,prior+1,'One accepted update-settings save');
        checks.push('Update-setting failure never presents Saved; retry remains explicit');
        await reveal(page,'access','native-companion-settings');
        await page.waitForFunction(()=>/unavailable|older|not supported|restart|does not provide/i.test(document.getElementById('native-startup-status').textContent));
        assert.equal(await page.locator('#native-startup-save').isVisible(),false,'Unavailable startup hides save');
        layouts.push(await layout(page,'startup-unavailable'));
        await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(output,`connection-unavailable-${viewport.width}-${theme}.png`),fullPage:true,animations:'disabled'});
        startupMissing=false;setupReady=true;
        await page.getByRole('button',{name:'Refresh connection setup',exact:true}).click();
        await page.waitForFunction(()=>document.getElementById('native-startup-mode')?.value==='local' && !document.getElementById('native-startup-mode').closest('.native-companion-startup-form').hidden);
        await page.locator('#native-startup-port').fill('8451');
        const beforeDraftNav=mutations(requests).length;
        await reveal(page,'data','data-recovery-settings');
        await reveal(page,'access','native-companion-settings');
        assert.equal(await page.locator('#native-startup-port').inputValue(),'8451','Navigation preserves unsaved startup draft');
        assert.equal(mutations(requests).length,beforeDraftNav,'Navigation does not save startup or generate pairing');
        assert.equal(await page.locator('#native-startup-review-box').isVisible(),false);
        checks.push('Startup 404 is explicit; ready state uses actual controls; draft survives navigation without save/restart/pairing');
        await reveal(page,'data','data-recovery-settings');
        assert.match(await page.locator('#data-recovery-settings').textContent(),/notes,? (?:AI )?(?:chats|conversations).*reports/i);
        await page.locator('#data-recovery-check').click();
        await page.waitForFunction(()=>!document.getElementById('data-recovery-check').disabled && !document.getElementById('data-recovery-report').hidden);
        assert.match(await page.locator('#data-recovery-status').textContent(),/backup has not been verified/i);
        failHealth=true;await page.locator('#data-recovery-check').click();
        await page.waitForFunction(()=>!document.getElementById('data-recovery-check').disabled && document.getElementById('data-recovery-status').classList.contains('error'));
        assert.match(await page.locator('#data-recovery-status').textContent(),/previous results.*out of date/i);
        layouts.push(await layout(page,'data-check-failure'));
        await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(output,`data-${viewport.width}-${theme}.png`),fullPage:true,animations:'disabled'});
        checks.push('Saved-data checks retain and label earlier results after failure; backup scope stays explicit');
        await reveal(page,'data','settings-section-memory-images');
        const openNotes=page.getByRole('button',{name:/Open (?:saved notes|Notes & fixes|Household Notebook|Notebook)/i});
        if(await openNotes.count()){
          const beforeNotes=mutations(requests).length;await openNotes.first().click();
          await page.waitForFunction(()=>document.getElementById('notebook-dialog')?.open && document.getElementById('notebook-list')?.textContent.includes('Studio backup location'));
          assert.equal(mutations(requests).length,beforeNotes,'Opening notes does not save or attach information');
          assert.deepEqual(await page.evaluate(()=>window.TLINotebook.describeContext()),[]);
          await page.getByRole('button',{name:'Close notes',exact:true}).click();
          checks.push('Saved-notes entry opens existing Notebook without selecting chat context');
        }
        assert.equal(requests.filter(r=>r.path.includes('/startup')&&r.method!=='GET').length,0,'No startup writes');
        assert.equal(requests.filter(r=>/reset|pairings|backups\/(create|verify)|update\/(apply|check)/.test(r.path)&&r.method!=='GET').length,0,'No destructive, pairing, backup, or update operations');
        assert.deepEqual(unexpected,[],'All requests have explicit isolated fixtures');assert.deepEqual(errors,[],'No browser exceptions');
        results.push({viewport,theme,status:'passed',checks,layouts,requests});
      }catch(error){results.push({viewport,theme,status:'failed',error:error.stack,checks,layouts,requests,errors,unexpected});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(output,`failure-${viewport.width}-${theme}.png`),fullPage:true}).catch(()=>{});throw error;}
      finally{await page.close();}
    }
  }catch(error){process.exitCode=1;console.error(error.stack);}
  finally{
    await browser.close();
    const sourceHashes=Object.fromEntries(Object.entries(sources).map(([file,text])=>['frontend/'+file,crypto.createHash('sha256').update(text).digest('hex')]));
    const changedDuringRun=Object.entries(sourceHashes).filter(([file,hash])=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')!==hash).map(([file])=>file);
    if(changedDuringRun.length)process.exitCode=1;
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({created_at:new Date().toISOString(),scope:'Isolated Settings UI using intercepted synthetic responses',mode:anniversary?'anniversary':'settings-only',sourceScope,sourceHashes,changedDuringRun,results,limitations:['Viewport checks are not physical-phone acceptance.','No real startup, model, device, backup, restore or update operation was performed.']},null,2));
    console.log(JSON.stringify({output,passed:results.filter(r=>r.status==='passed').length,failed:results.filter(r=>r.status==='failed').length,changedDuringRun},null,2));
  }
})();
