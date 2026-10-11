/* Real browser Companion assets with synthetic identity/data only. Every request
 * is fulfilled locally or rejected; no host, model or device action is invoked. */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const frontend = path.join(root, 'frontend');
const output = path.join(root, 'build_work', 'companion-atmosphere', 'browser-' + new Date().toISOString().replace(/[:.]/g, '-'));
const files = ['companion.html', 'themes.css', 'companion-atmosphere.css', 'js/theme-catalog.js', 'js/companion.js', 'assets/fonts/InterVariable.woff2'];
const snapshots = Object.fromEntries(files.map(file => [file, fs.readFileSync(path.join(frontend, file))]));
const themes = ['emeraldLight', 'lavenderLite', 'pacific', 'oled'];
const report = { output, cases: [], allPaletteContrast: [], errors: [] };
const fixtureId = 'fixture-companion-atmosphere';
const fixtureDevices = [
  { device_id: 'fixture-on', name: 'Studio lamp', vendor: 'shelly', relay: 0, capabilities: ['switch.on', 'switch.off'] },
  { device_id: 'fixture-off', name: 'Reading light', vendor: 'shelly', relay: 0, capabilities: ['switch.on', 'switch.off'] },
  { device_id: 'fixture-unknown', name: 'Window light with a long friendly name', vendor: 'hue', capabilities: ['switch.on', 'switch.off'] },
];
const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function measure(page) {
  return page.evaluate(() => {
    const rect = selector => {
      const e = document.querySelector(selector), r = e.getBoundingClientRect();
      return { width: r.width, height: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    const active = document.querySelector('.comp-panel.active');
    return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, activeWidth: active.scrollWidth,
      panelWidth: active.clientWidth, panelLeft:active.getBoundingClientRect().left, send: rect('#chat-send'), input: rect('#chat-input'), tabBar: rect('#tab-bar'),
      targets: [...document.querySelectorAll('#chat-chips button,#tab-bar button')].map(e => ({ width:e.getBoundingClientRect().width, height:e.getBoundingClientRect().height })),
      focusOutline: getComputedStyle(document.querySelector('#chat-input')).outlineStyle,
      inactiveVisible: [...document.querySelectorAll('.comp-panel:not(.active)')].some(e => getComputedStyle(e).visibility !== 'hidden') };
  });
}
async function contrasts(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    function rgba(value) { ctx.clearRect(0,0,1,1); ctx.fillStyle=value; ctx.fillRect(0,0,1,1); return [...ctx.getImageData(0,0,1,1).data]; }
    function luminance(c) { return c.slice(0,3).map(v => v/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4).reduce((s,v,i) => s+v*[.2126,.7152,.0722][i],0); }
    const rows = [];
    function pair(name, fg, bg, minimum=4.5) {
      const f=rgba(fg), b=rgba(bg), l=[luminance(f),luminance(b)].sort((a,b)=>b-a);
      rows.push({ name, ratio:(l[0]+.05)/(l[1]+.05), alpha:b[3], minimum });
    }
    function actual(name, textSelector, backgroundSelector=textSelector) {
      pair(name,getComputedStyle(document.querySelector(textSelector)).color,getComputedStyle(document.querySelector(backgroundSelector)).backgroundColor);
    }
    const vars=getComputedStyle(document.documentElement), value=name=>vars.getPropertyValue(name).trim();
    actual('Welcome heading','.comp-chat-welcome h1','.comp-chat-welcome');
    actual('Welcome copy','.comp-chat-welcome p','.comp-chat-welcome');
    pair('Welcome glow edge',getComputedStyle(document.querySelector('.comp-chat-welcome p')).color,`color-mix(in srgb,${value('--theme-glow')} 18%,${value('--theme-hero-bg')})`);
    actual('Chip','.chat-chip');
    actual('Composer','#chat-input');
    actual('Send','#chat-send');
    actual('Navigation active','.comp-tab.active');
    actual('Navigation inactive','.comp-tab:not(.active)','#tab-bar');
    pair('Placeholder',getComputedStyle(document.querySelector('#chat-input'),'::placeholder').color,getComputedStyle(document.querySelector('#chat-input')).backgroundColor);
    pair('Muted on card',value('--text-muted'),value('--bg-panel'));
    pair('Danger badge',value('--danger'),value('--danger-soft'));
    pair('Success badge',value('--success'),value('--success-soft'));
    pair('User bubble',value('--text-main'),`color-mix(in srgb,${value('--accent')} 11%,${value('--bg-panel')})`);
    return rows;
  });
}
(async () => {
  fs.mkdirSync(output,{recursive:true});
  const browser = await chromium.launch({ headless:true });
  try {
    for (const width of [320,390]) for (const theme of themes) {
      const context = await browser.newContext({ viewport:{width,height:width===320?740:844}, deviceScaleFactor:1, reducedMotion:'reduce', serviceWorkers:'block' });
      const page = await context.newPage(), requests=[], errors=[], unexpected=[];
      page.on('pageerror', e=>errors.push(String(e)));
      await context.addInitScript(({theme,fixtureId}) => {
        localStorage.setItem('sat_node_id',fixtureId);
        localStorage.setItem('sat_secret','synthetic-secret-not-a-credential');
        localStorage.setItem('sat_name','My phone');
        localStorage.setItem('tli_settings',JSON.stringify({defaultTheme:theme}));
      }, {theme,fixtureId});
      await context.route('**/*',async route=>{
        const request=route.request(), url=new URL(request.url()), p=url.pathname, method=request.method();
        requests.push(method+' '+p);
        if(url.origin!=='https://companion-atmosphere.test') { unexpected.push(request.url()); return route.abort(); }
        const file=p==='/companion'?'companion.html':p.slice(1);
        if(snapshots[file]) return route.fulfill({status:200,body:snapshots[file],contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'application/javascript':file.endsWith('.woff2')?'font/woff2':'text/html'});
        const json=data=>route.fulfill({status:200,json:data});
        if(p==='/mesh/satellite/heartbeat'&&method==='POST') return json({ok:true});
        if(method==='GET'&&p==='/homepower/devices') return json({devices:fixtureDevices});
        if(method==='GET'&&/^\/homepower\/devices\/fixture-.+\/status$/.test(p)) return json(p.includes('unknown')?{ok:false}:{ok:true,on:p.includes('fixture-on')});
        if(method==='GET'&&p==='/homepower/scenes') return json({scenes:[{scene_id:'fixture-evening',name:'Evening',description:'Warm lights for a quieter evening.'},{scene_id:'fixture-focus',name:'Focus',description:'A comfortable place to work.'}]});
        if(method==='GET'&&p==='/vault/status') return json({initialized:true,unlocked:false});
        if(method==='GET'&&p==='/system/summary') return json({ai:{status:'running'},devices:{count:3},node:{name:'Studio TLI'}});
        if(p==='/favicon.ico') return route.fulfill({status:204});
        unexpected.push(method+' '+p); return route.abort();
      });
      const item={width,theme,requests,errors,unexpected}; report.cases.push(item);
      await page.goto('https://companion-atmosphere.test/companion');
      await page.locator('.comp-chat-welcome h1').waitFor();
      await page.evaluate(()=>document.fonts.ready); await frame(page);
      assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),theme);
      item.initial=await measure(page);
      assert.ok(item.initial.documentWidth<=width && item.initial.activeWidth<=item.initial.panelWidth+1,JSON.stringify(item.initial));
      assert.ok(item.initial.send.width>=44 && item.initial.send.height>=44 && item.initial.input.height>=44,'Comfortable composer controls');
      assert.ok(item.initial.send.bottom<=item.initial.tabBar.top,'Composer remains above navigation');
      assert.ok(item.initial.targets.every(r=>r.width>=44 && r.height>=44),'Chip and navigation targets');
      assert.equal(item.initial.inactiveVisible,false,'Inactive panels are hidden from keyboard navigation');
      await page.screenshot({path:path.join(output,`${theme}-${width}-ask.png`)});
      item.contrast=await contrasts(page);
      for(const row of item.contrast) assert.ok(row.ratio>=row.minimum && row.alpha===255,`${theme}: ${JSON.stringify(row)}`);
      const draft='Plan a quiet weekend with friends — keep this draft.';
      await page.locator('#chat-input').fill(draft);
      await page.locator('#chat-input').focus();
      await page.evaluate(()=>{window.fixtureInput=document.querySelector('#chat-input');window.fixtureOutput=document.querySelector('#chat-output');window.fixtureInput.setSelectionRange(5,14);window.fixturePanel=document.querySelector('#panel-chat');});
      const readCount=requests.length;
      for(const next of [...themes,theme]) {
        await page.evaluate(theme=>TLIThemes.apply(theme),next); await frame(page);
        const continuity=await page.evaluate(()=>({sameInput:fixtureInput===document.querySelector('#chat-input'),sameOutput:fixtureOutput===document.querySelector('#chat-output'),samePanel:fixturePanel===document.querySelector('#panel-chat'),draft:fixtureInput.value,focused:document.activeElement===fixtureInput,start:fixtureInput.selectionStart,end:fixtureInput.selectionEnd,outline:getComputedStyle(fixtureInput).outlineStyle}));
        assert.deepEqual(continuity,{sameInput:true,sameOutput:true,samePanel:true,draft,focused:true,start:5,end:14,outline:'solid'});
      }
      assert.equal(requests.length,readCount,'Theme changes are local and request-free');
      item.themeDraftContinuity=true;
      for(const tab of ['devices','scenes','vault','status','vault','scenes','devices','chat']) {
        await page.locator(`[data-panel="panel-${tab}"]`).click();
        await page.waitForFunction(id=>document.querySelector(`#panel-${id}`).classList.contains('active'),tab);
        if(tab==='devices') await page.waitForFunction(()=>document.querySelectorAll('.device-row').length===3&&!document.querySelector('#devices-list').textContent.includes('Checking state'));
        if(tab==='vault') await page.locator('#vault-pw').waitFor();
        await frame(page);
        const dimensions=await measure(page);
        assert.ok(dimensions.documentWidth<=width&&dimensions.activeWidth<=dimensions.panelWidth+1&&Math.abs(dimensions.panelLeft)<1,`${theme}/${width}/${tab}: ${JSON.stringify(dimensions)}`);
        if(['devices','vault'].includes(tab)) await page.screenshot({path:path.join(output,`${theme}-${width}-${tab}.png`)});
      }
      item.backwardNavigation=await page.evaluate(()=>({sameInput:fixtureInput===document.querySelector('#chat-input'),sameOutput:fixtureOutput===document.querySelector('#chat-output'),value:fixtureInput.value}));
      assert.deepEqual(item.backwardNavigation,{sameInput:true,sameOutput:true,value:draft});
      await page.locator('#chat-input').focus();
      item.keyboard=[];
      for(let i=0;i<14;i++) { await page.keyboard.press('Tab'); item.keyboard.push(await page.evaluate(()=>({id:document.activeElement.id||document.activeElement.dataset.panel||document.activeElement.className,panel:document.activeElement.closest('.comp-panel')?.id||null}))); }
      assert.ok(item.keyboard.every(e=>!e.panel||e.panel==='panel-chat'),'Keyboard cannot enter an inactive panel');
      if(width===390&&theme==='emeraldLight') {
        const ids=await page.evaluate(()=>TLIThemes.themes.map(t=>t.id));
        for(const id of ids) {
          await page.evaluate(id=>TLIThemes.apply(id),id); await frame(page);
          const checks=await contrasts(page); report.allPaletteContrast.push({id,checks});
          for(const row of checks) assert.ok(row.ratio>=row.minimum&&row.alpha===255,`${id}: ${JSON.stringify(row)}`);
        }
        await page.evaluate(theme=>TLIThemes.apply(theme),theme);
      }
      assert.deepEqual(errors,[]); assert.deepEqual(unexpected,[]);
      assert.ok(requests.filter(r=>r.startsWith('POST ')).every(r=>r==='POST /mesh/satellite/heartbeat'),'No chat, device, scene, vault or desktop-send action');
      await context.close();
    }
    for(const file of files) assert.ok(fs.readFileSync(path.join(frontend,file)).equals(snapshots[file]),'Source stayed stable: '+file);
    report.assets=Object.fromEntries(files.map(file=>[file,crypto.createHash('sha256').update(snapshots[file]).digest('hex')]));
    report.passed=true;
  } catch(error) { report.errors.push(String(error.stack||error)); process.exitCode=1; }
  finally { await browser.close(); fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify({passed:!!report.passed,cases:report.cases.length,palettes:report.allPaletteContrast.length,output,errors:report.errors},null,2)); }
})();
