/* Atmospheric Premium acceptance. Entire production SPA; intercepted synthetic
 * services only. Never connects to a TLI server, model, or physical device.
 * Run only after the source is stable; --output must name fresh evidence. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const { makePage, layout, fixtures, source, fingerprintFiles } = require('./verify_anniversary_ui_browser.cjs');
const { contrast } = require('./verify_anniversary_themes_browser.cjs');
const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null;
const output = path.resolve(arg('--output') || path.join(__dirname, '../build_work/atmosphere-ui/browser-' + new Date().toISOString().replace(/[:.]/g, '-')));
const tokens = ['--theme-nav-bg', '--theme-nav-ink', '--theme-nav-muted', '--theme-hero-bg', '--theme-hero-ink', '--theme-hero-muted', '--theme-glow', '--theme-surface-border', '--theme-card-shadow'];
const representatives = ['emeraldLight', 'lavenderLite', 'pacific', 'oled'];
const panels = ['panel-dashboard2', 'panel-main', 'panel-homeauto'];
const deviceIPs = ['192.0.2.20', '192.0.2.21', '192.0.2.22'];
const narrator = {type:'status',text:'Your studio is ready. Pick up your work or check a device when you need it.',message:'Your studio is ready. Pick up your work or check a device when you need it.',severity:'info'};
const devices = [
  { id:'atmosphere-lamp', ip:deviceIPs[0], relay:0, name:'Desk lamp' },
  { id:'atmosphere-fan', ip:deviceIPs[1], relay:0, name:'Studio fan' },
  { id:'atmosphere-reading', ip:deviceIPs[2], relay:0, name:'Reading light' },
];
Object.assign(fixtures, {
  '/homeauto/devices': {devices}, '/homepower/devices': {ok:true, devices},
  '/api/intelligence/devices': {devices:devices.map((device, index) => ({id:device.id, kind:'smart_device', vendor:'shelly', address:device.ip, relay:0, name:device.name, room:index === 1 ? 'Living room' : 'Study'}))},
  '/actions/list': {actions:[], triggers:[]}, '/actions/capabilities': {devices:[]},
  '/api/builder/web-apps': {projects:[]},
  '/dashboard/activity-summary': {ok:true, cursor:{sequence:0}, total:0, warning_count:0, group_count:0, coverage:'retained', coverage_note:'Synthetic activity only.', retention_limit:100, groups:[], events:[], checked_at:Math.floor(Date.now()/1000)},
  '/dashboard/command-center': {...fixtures['/dashboard/command-center'],narrator},
  '/dashboard/narrator/current': narrator,
});
const report = {schema_version:1, source, output, synthetic_only:true, themes:[], checks:[], layouts:[], contrast:[], raster:[], tokens:[], previews:[], screenshots:[], sessions:[], errors:[], warnings:[], limitations:[
  'Production HTML, styles and controllers run in Edge with intercepted synthetic services. No live host, inference, files or device actions are used.',
  'Solid backgrounds and supported two-stop RGB gradients are measured by the existing contrast helper. Complex gradients, pseudo-element sheen, blur and opacity need screenshot review; a review warning is not an accessibility pass.',
  'One explicitly clicked Shelly command is held and fulfilled entirely by an intercepted fixture to verify pending presentation. Theme rendering itself must cause no mutations.',
  'The stale-reading fixture ages a successfully parsed synthetic observation past the existing 30-second freshness limit. No production freshness threshold is modified.',
  '320px and 390px are browser viewports. Physical phones, screen readers, OS text scaling, live Shelly equipment and model acceptance are not claimed.',
  'Raster checks preserve colors and all gradient/pseudo-element backgrounds, hide only text ink, and measure every background pixel inside visible text fragment rectangles. Reduced-motion captures, deliberately paused real animation frames, and the separately identified maximum-sheen brightness envelope are distinguished in each surface result. Disabled controls are exempt; unresolved opacity or filters are reported separately.',
]};
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function check(name, work) {
  try { const detail = await work(); report.checks.push({name, passed:true, ...(detail === undefined ? {} : {detail})}); }
  catch (error) { report.checks.push({name, passed:false, error:error.stack || String(error)}); }
}
function visibility() {
  window.__themeAuditVisible = el => {
    if (!el || el.closest('[hidden],.hidden,[aria-hidden="true"]') || !el.getClientRects().length || getComputedStyle(el).visibility !== 'visible') return false;
    for (let parent = el; parent; parent = parent.parentElement) {
      if (Number(getComputedStyle(parent).opacity) === 0) return false;
      if (parent !== el && parent.tagName === 'DETAILS' && !parent.open && !parent.querySelector(':scope > summary')?.contains(el)) return false;
    }
    return true;
  };
}
async function setup(browser, width, theme) {
  const run = await makePage(browser, width, theme, {preserveSettingsOnReload:true});
  const {page} = run; page.setDefaultTimeout(6000); page.setDefaultNavigationTimeout(12000);
  await page.setViewportSize({width, height:width < 500 ? 900 : 1000});
  await page.evaluate(visibility);
  await page.evaluate(() => {
    window.__atmosphereReferences = {
      panels:[...document.querySelectorAll('section[id^="panel-"]')].map(el => [el.id, el]),
      nodes:['nd-attention', 'nd-narrator', 'chat-input', 'chat-composer-shell', 'shellyCards'].map(id => [id, document.getElementById(id)]),
      controllers:{switchPanel, sendChat, sendShellyAction, renderAllShellyCards, TLIDash2:window.TLIDash2, TLIChat:window.TLIChat},
    };
    window.__atmosphereThemeWrites = [];
    const originalSet = Storage.prototype.setItem, originalRemove = Storage.prototype.removeItem;
    Storage.prototype.setItem = function(key,value) { if (this === localStorage && key === 'tli_settings') window.__atmosphereThemeWrites.push({method:'setItem',key}); return originalSet.apply(this,arguments); };
    Storage.prototype.removeItem = function(key) { if (this === localStorage && key === 'tli_settings') window.__atmosphereThemeWrites.push({method:'removeItem',key}); return originalRemove.apply(this,arguments); };
  });
  run.initialSettings = await page.evaluate(() => localStorage.getItem('tli_settings'));
  run.reads = []; run.commands = []; run.states = new Map(deviceIPs.map((ip,index) => [ip, index !== 1]));
  await page.route('**/shelly/status?*', async route => {
    const url = new URL(route.request().url()), ip = url.searchParams.get('ip'), relay = Number(url.searchParams.get('relay'));
    assert.ok(deviceIPs.includes(ip), 'Only explicit synthetic addresses may be read'); assert.equal(relay,0);
    run.reads.push({ip,relay});
    const on = run.states.get(ip);
    await route.fulfill({json:{ok:true, raw:{'switch:0':{output:on, apower:on ? 12.5 : 0, voltage:120, current:on ? .104 : 0}}}});
  });
  await page.route('**/shelly/relay', async route => {
    const body = route.request().postDataJSON(); run.commands.push(body);
    if (!run.allowSyntheticCommand) return route.fulfill({status:409,json:{ok:false,summary:'Unexpected command blocked by atmosphere fixture.'}});
    assert.equal(route.request().method(),'POST'); assert.equal(body.ip,deviceIPs[0]); assert.equal(body.relay,0); assert.equal(body.action,'off');
    if (run.holdCommand) await new Promise(resolve => { run.releaseCommand = resolve; });
    run.states.set(body.ip,false);
    await route.fulfill({json:{ok:true,outcome:'accepted',summary:'Synthetic fixture only.'}});
  });
  assert.equal(await page.locator('html').getAttribute('data-experience'),'premium');
  return run;
}
async function stableShelly(run, {age=true}={}) {
  await run.page.evaluate(async () => { switchPanel('panel-homeauto'); await loadShellyHostRegistry(); await fetchAllShellyStatuses(true); stopShellyAutoRefresh(); });
  if (age) await run.page.evaluate(ip => { shellyDevices[ip+'#0'].status.checkedAt = Date.now()-40000; renderAllShellyCards(); },deviceIPs[2]);
}
async function open(run, panel) {
  if (panel === 'panel-homeauto') return stableShelly(run);
  await run.page.evaluate(id => switchPanel(id),panel);
  if (panel === 'panel-dashboard2') {
    await run.page.evaluate(() => TLIDash2.setEventMessage({type:'status',text:'Your studio is ready. Pick up your work or check a device when you need it.',severity:'info'}));
    await run.page.waitForFunction(() => document.getElementById('nd-statement-text')?.textContent.includes('Your studio is ready') && Number(getComputedStyle(document.getElementById('nd-statement')).opacity) > .99);
  }
}
async function capture(page, name, meta, preserveScroll=false) {
  await page.evaluate(preserve => { document.activeElement?.blur?.(); const scroller=document.querySelector('.main-scroll'); if(scroller&&!preserve)scroller.scrollTop=0; },preserveScroll);
  await page.evaluate(() => document.fonts.ready);
  const file = path.join(output,name+'.png'); await page.screenshot({path:file,fullPage:false});
  report.screenshots.push({...meta,file,sha256:sha(file)});
}
async function colors(page, selector, meta) {
  const value = {...meta,selector,...await contrast(page,selector)}; report.contrast.push(value);
  await check(`${meta.theme} ${meta.width}px ${selector} text contrast`,() => assert.deepEqual(value.findings,[]));
  if (value.review.length) report.warnings.push({kind:'visual_contrast_review',...meta,selector,count:value.review.length});
}
async function dimensions(page, panel, meta) {
  const value = {...meta,panel,...await layout(page,panel)}; report.layouts.push(value);
  await check(`${meta.theme} ${meta.width}px ${panel} fits`,() => { assert.deepEqual(value.overflow,[]); assert.deepEqual(value.duplicateIds,[]); assert.ok(value.documentWidth <= value.width+2); });
}
async function verifyPreserved(run, label) {
  await check(label+' retains panels, controls, controllers and the unsent draft',async () => {
    const result = await run.page.evaluate(() => {
      const refs=window.__atmosphereReferences, controllers={switchPanel,sendChat,sendShellyAction,renderAllShellyCards,TLIDash2:window.TLIDash2,TLIChat:window.TLIChat};
      return {missing:refs.panels.concat(refs.nodes).filter(([id,el]) => !el || document.getElementById(id)!==el).map(([id])=>id),changed:Object.keys(refs.controllers).filter(key=>refs.controllers[key]!==controllers[key]),draft:document.getElementById('chat-input').value,writes:window.__atmosphereThemeWrites,settings:localStorage.getItem('tli_settings')};
    });
    assert.deepEqual(result.missing,[]); assert.deepEqual(result.changed,[]); assert.deepEqual(result.writes,[]); assert.equal(result.settings,run.initialSettings);
    if (run.draft) assert.equal(result.draft,run.draft);
  });
}
async function previewState(page) {
  return page.locator('.tli-theme-preview[data-theme]').evaluateAll((items,tokens) => Object.fromEntries(items.map(el => {
    const vars=Object.fromEntries(tokens.map(key=>[key,getComputedStyle(el).getPropertyValue(key).trim()]));
    const parts=Object.fromEntries(['.tli-theme-preview-sidebar','.tli-theme-preview-header','.tli-theme-preview-canvas','.tli-theme-preview-heading','.tli-theme-preview-body','.tli-theme-preview-composer'].map(selector=>{const target=el.querySelector(selector),style=target&&getComputedStyle(target);return[selector,style?{color:style.color,background:style.backgroundColor,image:style.backgroundImage,shadow:style.boxShadow}:null];}));
    return [el.dataset.theme,{vars,parts}];
  })),tokens);
}
async function matrix(browser) {
  const run=await setup(browser,1440,'emeraldLight'),{page}=run;
  try {
    report.themes=await page.evaluate(()=>TLIThemes.themes.map(({id,name,tone})=>({id,name,tone})));
    assert.equal(report.themes.length,23); assert.equal(new Set(report.themes.map(t=>t.id)).size,23);
    const gallery=await previewState(page); assert.equal(Object.keys(gallery).length,23);
    run.draft='Keep this unfinished idea while changing the atmosphere.';
    await page.evaluate(draft=>{document.getElementById('chat-input').value=draft;},run.draft);
    for (const theme of report.themes) {
      const requestsBefore=run.calls.length,commandsBefore=run.commands.length;
      await page.evaluate(id=>TLIThemes.apply(id),theme.id);
      const vars=await page.evaluate(tokens=>Object.fromEntries(tokens.map(key=>[key,getComputedStyle(document.documentElement).getPropertyValue(key).trim()])),tokens);
      report.tokens.push({theme:theme.id,vars});
      await check(theme.id+' supplies every atmosphere token',()=>assert.ok(Object.values(vars).every(Boolean)));
      await check(theme.id+' does not restyle another theme gallery preview',async()=>assert.deepEqual(await previewState(page),gallery));
      report.previews.push({theme:theme.id,checked:23});
      for (const panel of panels) {
        await open(run,panel); await dimensions(page,panel,{theme:theme.id,width:1440});
        if(panel==='panel-dashboard2') {
          await colors(page,'.app-shell > .sidebar',{theme:theme.id,width:1440,surface:'nav'});
          await colors(page,'.main-region > header',{theme:theme.id,width:1440,surface:'header'});
          await colors(page,'#nd-attention',{theme:theme.id,width:1440,surface:'hero'});
        }
        if(panel==='panel-main') await colors(page,'.chat-welcome',{theme:theme.id,width:1440,surface:'hero'});
        await colors(page,panel,{theme:theme.id,width:1440,surface:'body'});
        if(representatives.includes(theme.id)) await capture(page,`${theme.id}-${panel}-1440`,{theme:theme.id,panel,width:1440});
      }
      if(['oled','ultraLavenderOLED'].includes(theme.id)) await check(theme.id+' keeps black canvas/nav/header without gradients',async()=>{
        const values=await page.evaluate(()=>['body','.main-scroll','.app-shell > .sidebar','.main-region > header'].map(selector=>{const style=getComputedStyle(document.querySelector(selector));return{selector,color:style.backgroundColor,image:style.backgroundImage};}));
        for(const value of values){assert.equal(value.color,'rgb(0, 0, 0)',value.selector);assert.equal(value.image,'none',value.selector);} return values;
      });
      await check(theme.id+' appearance creates no network mutations',()=>{assert.equal(run.commands.length,commandsBefore);assert.deepEqual(run.calls.slice(requestsBefore).filter(c=>!['GET','HEAD'].includes(c.method)),[]);});
      await verifyPreserved(run,theme.id);
    }
    await check('synthetic Shelly registry supplies rooms and on/off/stale states',async()=>{
      assert.deepEqual(await page.locator('.sha-room-heading').allTextContents(),['Living room','Study']);
      const state=await page.locator('.shelly-device-card').evaluateAll(cards=>Object.fromEntries(cards.map(card=>[card.dataset.ip,{state:card.querySelector('.sha-device-state').textContent,button:card.querySelector('.sha-power-control').textContent}])));
      assert.match(state[deviceIPs[0]].state,/On.*verified/);assert.match(state[deviceIPs[1]].state,/Off.*verified/);assert.match(state[deviceIPs[2]].state,/Reading expired/);assert.match(state[deviceIPs[2]].button,/Check state/);return state;
    });
  } finally { await finish(run,'all-theme-desktop'); }
}
async function mobile(browser) {
  for(const width of [390,320]) for(const theme of representatives) {
    const run=await setup(browser,width,theme),{page}=run;
    try {
      for(const panel of panels){await open(run,panel);await dimensions(page,panel,{theme,width});await colors(page,panel,{theme,width,surface:'mobile-body'});await capture(page,`${theme}-${panel}-${width}`,{theme,width,panel});}
      await verifyPreserved(run,theme+' '+width+'px');
      await check(theme+' '+width+'px inspection creates no commands',()=>{assert.deepEqual(run.commands,[]);assert.deepEqual(run.calls.filter(c=>!['GET','HEAD'].includes(c.method)),[]);});
    } finally {await finish(run,theme+'-'+width);}
  }
}
async function sheen(run) {
  return run.page.locator('.shelly-device-card').evaluateAll(cards=>cards.map(card=>{const style=getComputedStyle(card,'::before');return{ip:card.dataset.ip,pending:card.dataset.pending,state:card.querySelector('.sha-device-state').textContent,animation:style.animationName,pointerEvents:style.pointerEvents,content:style.content};}));
}
async function motion(browser) {
  const run=await setup(browser,1440,'emeraldLight'),{page}=run;
  try {
    await stableShelly(run); await page.emulateMedia({reducedMotion:'no-preference'});
    await check('sheen only animates a fresh ON card and cannot intercept input',async()=>{
      const values=await sheen(run),on=values.find(v=>v.ip===deviceIPs[0]);assert.match(on.animation,/tli-device-shimmer/);assert.equal(on.pointerEvents,'none');
      for(const value of values.filter(v=>v.ip!==deviceIPs[0]))assert.equal(value.animation,'none');return values;
    });
    await page.locator(`.shelly-device-card[data-ip="${deviceIPs[0]}"] .shelly-rename-btn`).click();
    await check('rename suppresses sheen without a registry write',async()=>{assert.ok((await sheen(run)).every(v=>v.animation==='none'));assert.deepEqual(run.commands,[]);});
    await page.locator(`.shelly-device-card[data-ip="${deviceIPs[0]}"] .shelly-rename-input`).press('Escape');
    run.allowSyntheticCommand=true;run.holdCommand=true;
    await page.locator(`.shelly-device-card[data-ip="${deviceIPs[0]}"] .sha-power-control`).click();
    await page.waitForFunction(ip=>document.querySelector(`.shelly-device-card[data-ip="${ip}"]`)?.dataset.pending==='true',deviceIPs[0]);
    await check('pending command gates power input and suppresses sheen',async()=>{
      const card=page.locator(`.shelly-device-card[data-ip="${deviceIPs[0]}"]`);assert.equal(await card.locator('.sha-power-control').isDisabled(),true);
      const value=(await sheen(run)).find(v=>v.ip===deviceIPs[0]);assert.equal(value.animation,'none');assert.match(value.state,/Updating device/);assert.equal(run.commands.length,1);return value;
    });
    await page.evaluate(ip=>{window.__pendingAtmosphereCard=document.querySelector(`.shelly-device-card[data-ip="${ip}"]`);window.__pendingAtmosphereControl=window.__pendingAtmosphereCard.querySelector('.sha-power-control');},deviceIPs[0]);
    for(const theme of [...representatives,'ultraLavenderOLED']) {
      await page.evaluate(id=>TLIThemes.apply(id),theme);
      await check(theme+' preserves the original pending card/control and sends no extra POST',async()=>{
        const value=await page.evaluate(ip=>{
          const card=document.querySelector(`.shelly-device-card[data-ip="${ip}"]`),button=card.querySelector('.sha-power-control');
          return {sameCard:card===window.__pendingAtmosphereCard,sameControl:button===window.__pendingAtmosphereControl,pending:card.dataset.pending,disabled:button.disabled,state:card.querySelector('.sha-device-state').textContent,animation:getComputedStyle(card,'::before').animationName};
        },deviceIPs[0]);
        assert.equal(value.sameCard,true);assert.equal(value.sameControl,true);assert.equal(value.pending,'true');assert.equal(value.disabled,true);assert.equal(value.animation,'none');assert.match(value.state,/Updating device/);
        assert.equal(run.commands.length,1);assert.deepEqual(run.calls.filter(c=>!['GET','HEAD'].includes(c.method)),[]);return value;
      });
    }
    run.releaseCommand?.();await page.waitForFunction(ip=>document.querySelector(`.shelly-device-card[data-ip="${ip}"]`)?.dataset.pending==='false',deviceIPs[0]);
    await check('completed command relies on the fresh intercepted state',async()=>assert.match(await page.locator(`.shelly-device-card[data-ip="${deviceIPs[0]}"] .sha-device-state`).textContent(),/Off.*verified/));
    run.states.set(deviceIPs[0],true);await stableShelly(run);
    await page.evaluate(()=>switchPanel('panel-main'));
    await check('hidden Smart home panel has no running sheen',async()=>assert.ok((await sheen(run)).every(v=>v.animation==='none')));
    await stableShelly(run);await page.emulateMedia({reducedMotion:'reduce'});
    await check('reduced-motion removes card sheen and decorative transitions',async()=>{
      assert.equal(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),true);
      assert.ok((await sheen(run)).every(v=>v.animation==='none'));
      const samples=await page.evaluate(()=>['.app-shell > .sidebar','#nd-attention','#chat-composer-shell','.shelly-device-card'].map(selector=>{const el=document.querySelector(selector),style=getComputedStyle(el);return{selector,animation:style.animationName,transition:style.transitionDuration};}));
      for(const sample of samples){assert.equal(sample.animation,'none');assert.ok(sample.transition.split(',').every(v=>parseFloat(v)===0));}return samples;
    });
  } finally {run.releaseCommand?.();await finish(run,'motion-and-pending');}
}
function rgba(color) {
  const values=color.match(/-?[\d.]+/g)?.map(Number);if(!values||values.length<3)return null;
  if(color.startsWith('color(srgb-linear'))for(let i=0;i<3;i++)values[i]=255*(values[i]<=.0031308?values[i]*12.92:1.055*values[i]**(1/2.4)-.055);
  else if(color.startsWith('color(srgb'))for(let i=0;i<3;i++)values[i]*=255;
  return [...values.slice(0,3),values[3]??1];
}
const linear=Array.from({length:256},(_,v)=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});
const luminance=rgb=>rgb.reduce((sum,v,i)=>sum+linear[Math.max(0,Math.min(255,Math.round(v)))]*[.2126,.7152,.0722][i],0);
async function rasterSurface(page,selectors,meta) {
  await page.evaluate(()=>document.fonts.ready);
  const fragments=await page.evaluate(selectors=>{
    const result=[],seen=new Set();
    const name=el=>el.id?'#'+el.id:el.tagName.toLowerCase()+(el.classList.length?'.'+[...el.classList].slice(0,3).join('.'):'');
    for(const selector of selectors)for(const root of document.querySelectorAll(selector))for(const el of [root,...root.querySelectorAll('*')]){
      if(seen.has(el)||!window.__themeAuditVisible(el)||el.disabled||el.closest('button:disabled')||['SCRIPT','STYLE','OPTION','SVG','PATH'].includes(el.tagName))continue;seen.add(el);
      const style=getComputedStyle(el),reasons=[];let clip={left:0,top:0,right:innerWidth,bottom:innerHeight};
      for(let parent=el;parent;parent=parent.parentElement){
        const cs=getComputedStyle(parent),r=parent.getBoundingClientRect();
        if(Number(cs.opacity)<.999)reasons.push('opacity '+cs.opacity+' on '+name(parent));
        if(cs.filter!=='none')reasons.push('filter on '+name(parent));
        if(parent!==el&&/(auto|scroll|hidden|clip)/.test(cs.overflowX)){clip.left=Math.max(clip.left,r.left);clip.right=Math.min(clip.right,r.right);}
        if(parent!==el&&/(auto|scroll|hidden|clip)/.test(cs.overflowY)){clip.top=Math.max(clip.top,r.top);clip.bottom=Math.min(clip.bottom,r.bottom);}
      }
      for(const node of el.childNodes){
        if(node.nodeType!==Node.TEXT_NODE||!/[\p{L}\p{N}]/u.test(node.textContent))continue;
        const range=document.createRange();range.selectNodeContents(node);
        for(const rect of range.getClientRects()){
          const box={left:Math.max(rect.left,clip.left),top:Math.max(rect.top,clip.top),right:Math.min(rect.right,clip.right),bottom:Math.min(rect.bottom,clip.bottom)};
          if(box.right-box.left<1||box.bottom-box.top<1)continue;
          const cover=document.elementFromPoint((box.left+box.right)/2,(box.top+box.bottom)/2);
          if(cover!==el&&!el.contains(cover))continue;
          result.push({root:selector,selector:name(el),text:node.textContent.trim().slice(0,120),foreground:style.webkitTextFillColor||style.color,fontSize:parseFloat(style.fontSize),fontWeight:style.fontWeight,rect:box,reasons});
        }
      }
    }
    return result;
  },selectors);
  const hide=await page.addStyleTag({content:selectors.map(selector=>`${selector}, ${selector} *`).join(',')+' { -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; }'});
  let png;
  try {png=PNG.sync.read(await page.screenshot({fullPage:false}));} finally {await hide.evaluate(el=>el.remove());}
  const samples=[],review=[];
  for(const fragment of fragments){
    const foreground=rgba(fragment.foreground),required=fragment.fontSize>=24||(fragment.fontSize>=18.6667&&Number(fragment.fontWeight)>=700)?3:4.5;
    if(!foreground||fragment.reasons.length){review.push({...fragment,required});continue;}
    let ratio=Infinity,worst=null;
    for(let y=Math.max(0,Math.ceil(fragment.rect.top));y<Math.min(png.height,Math.floor(fragment.rect.bottom));y++)for(let x=Math.max(0,Math.ceil(fragment.rect.left));x<Math.min(png.width,Math.floor(fragment.rect.right));x++){
      const offset=(y*png.width+x)*4,bg=[png.data[offset],png.data[offset+1],png.data[offset+2]],fg=foreground.slice(0,3).map((v,i)=>v*foreground[3]+bg[i]*(1-foreground[3])),a=luminance(fg),b=luminance(bg),current=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
      if(current<ratio){ratio=current;worst={x,y,background:bg};}
    }
    if(!Number.isFinite(ratio))continue;
    samples.push({...fragment,required,minimumContrast:Number(ratio.toFixed(3)),worst,passed:ratio+.005>=required});
  }
  const value={...meta,selectors,samples,review,failures:samples.filter(sample=>!sample.passed)};report.raster.push(value);
  if(value.failures.length){await capture(page,`failure-${meta.theme}-${meta.width}-${meta.surface}`,meta,true);console.log(JSON.stringify({rasterFailure:meta,failures:value.failures.map(v=>({selector:v.selector,text:v.text,ratio:v.minimumContrast,required:v.required}))}));}
  return value;
}
async function rasterMatrix(browser) {
  const chatOnly=process.argv.includes('--affected');
  for(const width of [1440,390,320]){
    const run=await setup(browser,width,'emeraldLight'),{page}=run;
    try {
      if(!report.themes.length)report.themes=await page.evaluate(()=>TLIThemes.themes.map(({id,name,tone})=>({id,name,tone})));
      assert.equal(report.themes.length,23);
      for(const theme of report.themes){
        await page.evaluate(id=>TLIThemes.apply(id),theme.id);
        for(const panel of chatOnly?['panel-main']:panels){
          await open(run,panel);await page.evaluate(()=>{document.activeElement?.blur?.();document.querySelector('.main-scroll').scrollTop=0;});
          const selectors=panel==='panel-dashboard2'?['#nd-attention','.app-shell > .sidebar','.main-region > header','#tli-bottom-nav']:panel==='panel-main'?['.chat-welcome']:['.sha-room-heading','.shelly-device-card'];
          await rasterSurface(page,selectors,{theme:theme.id,width,panel,surface:panel});
          if(representatives.includes(theme.id))await capture(page,`raster-${theme.id}-${panel}-${width}`,{theme:theme.id,width,panel});
          if(panel==='panel-homeauto'&&width<500){
            for(const ip of deviceIPs){
              const selector=`.shelly-device-card[data-ip="${ip}"]`;
              await page.locator(selector).scrollIntoViewIfNeeded();
              await rasterSurface(page,[selector],{theme:theme.id,width,panel,surface:'device-'+ip});
            }
          }
        }
        if(width<500&&!chatOnly){
          await page.locator('#tli-bn-more-btn').click();
          await rasterSurface(page,['#tli-more-drawer'],{theme:theme.id,width,panel:'mobile-navigation',surface:'mobile-navigation'});
          await page.keyboard.press('Escape');
        }
      }
      await verifyPreserved(run,'raster '+width+'px');
      await check('raster '+width+'px uses no commands or network mutations',()=>{assert.deepEqual(run.commands,[]);assert.deepEqual(run.calls.filter(c=>!['GET','HEAD'].includes(c.method)),[]);});
      console.log(JSON.stringify({rasterWidthComplete:width,surfaces:report.raster.length,samples:report.raster.reduce((n,r)=>n+r.samples.length,0),failures:report.raster.reduce((n,r)=>n+r.failures.length,0)}));
      fs.writeFileSync(path.join(output,'raster-progress.json'),JSON.stringify({source,output,source_before:report.source_before,themes:report.themes,raster:report.raster},null,2));
    } finally {await finish(run,'raster-'+width);}
  }
}
async function shimmerRaster(browser) {
  // The real moving gradient peaks at 11% hero ink. Filling the entire pseudo
  // with that exact peak conservatively tests every text position at once.
  // This is an upper-brightness envelope, not a claim to capture one real frame.
  for(const width of [1440,390,320]){
    const run=await setup(browser,width,'emeraldLight'),{page}=run;
    try {
      if(!report.themes.length)report.themes=await page.evaluate(()=>TLIThemes.themes.map(({id,name,tone})=>({id,name,tone})));
      await page.emulateMedia({reducedMotion:'no-preference'});
      const selector=`.shelly-device-card[data-ip="${deviceIPs[0]}"]`;
      const envelope=await page.addStyleTag({content:`html[data-experience="premium"] body[data-tli-ui] #panel-homeauto:not([hidden]) #shellyCards:not(:has(.is-renaming)) ${selector}.sha-card--on[data-pending="false"]::before { background:color-mix(in srgb,var(--theme-hero-ink,#f3faf7) 11%,transparent)!important; transform:none!important; animation:none!important; }`});
      for(const theme of report.themes){
        await page.evaluate(id=>TLIThemes.apply(id),theme.id);await stableShelly(run);await page.locator(selector).scrollIntoViewIfNeeded();
        const style=await page.locator(selector).evaluate(el=>{const s=getComputedStyle(el,'::before');return {image:s.backgroundImage,color:s.backgroundColor,content:s.content,transform:s.transform,animation:s.animationName};});
        assert.equal(style.image,'none');assert.equal(style.transform,'none');assert.equal(style.animation,'none');assert.notEqual(style.content,'none');
        const result=await rasterSurface(page,[selector],{theme:theme.id,width,panel:'panel-homeauto',surface:'maximum-sheen-envelope',envelope:style});
        assert.ok(result.samples.length>=4,'The ON card must have visible measured text');
      }
      await envelope.evaluate(el=>el.remove());
      await check('maximum sheen '+width+'px uses no commands or network mutations',()=>{assert.deepEqual(run.commands,[]);assert.deepEqual(run.calls.filter(c=>!['GET','HEAD'].includes(c.method)),[]);});
      console.log(JSON.stringify({maximumSheenWidthComplete:width,samples:report.raster.filter(r=>r.surface==='maximum-sheen-envelope').reduce((n,r)=>n+r.samples.length,0),failures:report.raster.filter(r=>r.surface==='maximum-sheen-envelope').reduce((n,r)=>n+r.failures.length,0)}));
    } finally {await finish(run,'maximum-sheen-'+width);}
  }
}
async function actualShimmerFrames(browser) {
  for(const width of [390,320]){
    const run=await setup(browser,width,'emeraldLight'),{page}=run;
    try {
      await page.emulateMedia({reducedMotion:'no-preference'});
      const frameThemes=await page.evaluate(()=>TLIThemes.themes.filter(t=>['emeraldLight','lavenderLite'].includes(t.id)).map(({id,name,tone})=>({id,name,tone})));
      if(!report.themes.length)report.themes=frameThemes;
      const selector=`.shelly-device-card[data-ip="${deviceIPs[0]}"]`;
      for(const theme of frameThemes){
        await page.evaluate(id=>TLIThemes.apply(id),theme.id);await stableShelly(run);await page.locator(selector).scrollIntoViewIfNeeded();
        await page.locator(selector).evaluate(el=>{window.__actualSheen=el.getAnimations({subtree:true}).find(a=>a.animationName==='tli-device-shimmer');if(!window.__actualSheen)throw Error('Real sheen animation missing');window.__actualSheen.pause();});
        for(const ms of process.argv.includes('--capture-sheen')?[1050]:[0,300,450,600,750,900,1050,1200,1350,1500,1800]){
          await page.evaluate(async ms=>{window.__actualSheen.currentTime=ms;await new Promise(requestAnimationFrame);},ms);
          const transform=await page.locator(selector).evaluate(el=>getComputedStyle(el,'::before').transform);
          await rasterSurface(page,[selector],{theme:theme.id,width,panel:'panel-homeauto',surface:'real-sheen-'+ms,animationTimeMs:ms,transform});
          if(ms===1050)await capture(page,`corrected-${theme.id}-${width}-real-sheen-1050`,{theme:theme.id,width,panel:'panel-homeauto',animationTimeMs:ms},true);
        }
      }
      await check('real sheen frames '+width+'px use no commands or network mutations',()=>{assert.deepEqual(run.commands,[]);assert.deepEqual(run.calls.filter(c=>!['GET','HEAD'].includes(c.method)),[]);});
    } finally {await finish(run,'real-sheen-'+width);}
  }
}
async function finish(run,label) {
  report.sessions.push({label,reads:run.reads.length,syntheticCommands:run.commands,mutations:run.calls.filter(c=>!['GET','HEAD'].includes(c.method)),unknownPaths:[...new Set(run.unknown)]});
  report.errors.push(...run.errors.map(error=>({label,error})));await run.context.close();
}
async function main() {
  fs.mkdirSync(output,{recursive:true});if(fs.existsSync(path.join(output,'report.json')))throw Error('Use a fresh output directory; prior evidence is preserved.');
  report.method={path:__filename,sha256:sha(__filename)};report.source_before=fingerprintFiles(source);
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {if(process.argv.includes('--sheen-only')){await shimmerRaster(browser);await actualShimmerFrames(browser);}else if(process.argv.includes('--shimmer-frames')||process.argv.includes('--capture-sheen')){await actualShimmerFrames(browser);}else if(process.argv.includes('--affected')){await rasterMatrix(browser);await shimmerRaster(browser);}else if(process.argv.includes('--supplemental')){await rasterMatrix(browser);await motion(browser);}else{await matrix(browser);await mobile(browser);await motion(browser);}}
  catch(error){report.errors.push({label:'harness',error:error.stack||String(error)});}
  finally{
    await browser.close();report.source_after=fingerprintFiles(source);report.source_unchanged=JSON.stringify(report.source_before)===JSON.stringify(report.source_after);
    report.summary={themes:report.themes.length,checks:report.checks.length,failures:report.checks.filter(c=>!c.passed).length,layouts:report.layouts.length,contrastFailures:report.contrast.reduce((n,r)=>n+r.findings.length,0),visualReview:report.contrast.reduce((n,r)=>n+r.review.length,0),rasterSurfaces:report.raster.length,rasterSamples:report.raster.reduce((n,r)=>n+r.samples.length,0),rasterFailures:report.raster.reduce((n,r)=>n+r.failures.length,0),rasterReview:report.raster.reduce((n,r)=>n+r.review.length,0),screenshots:report.screenshots.length,errors:report.errors.length,sourceUnchanged:report.source_unchanged};
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({output,...report.summary,reviewNotice:report.summary.visualReview?'Complex gradients/effects need manual screenshot review; not counted as accessibility passes.':undefined}));
    if(report.summary.failures||report.summary.errors||report.summary.rasterFailures||!report.source_unchanged)process.exitCode=1;
  }
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
// Optional bounded screenshot/pixel review can reuse the identical fixture setup.
module.exports = {setup, open, output};
