/* Compiled Expo-web acceptance only. No native transport or real TLI is contacted. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const repository = path.resolve(__dirname, '../..');
function option(name, fallback) { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at + 1]; }
const exported = path.resolve(option('--export', ''));
const source = path.resolve(option('--source', repository));
const output = path.resolve(option('--output', path.join(repository, 'build_work/companion-chat-first', `browser-${new Date().toISOString().replace(/[:.]/g, '-')}`)));
const baseline = process.argv.includes('--before');
const geometryOnly = process.argv.includes('--geometry-only');
assert.ok(process.argv.includes('--export') && fs.existsSync(path.join(exported, 'index.html')), '--export must name a compiled Expo web export');
assert.ok(fs.existsSync(path.join(source, 'mobile/app/(tabs)/ask.tsx')), '--source must name the matching source root');
assert.ok(!fs.existsSync(path.join(output, 'report.json')), 'Preserve earlier evidence: use a fresh output path');
fs.mkdirSync(output, { recursive: true });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function hashes(directory) {
  const rows = {};
  function visit(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
    if (['node_modules','.expo','dist','build-inspect','__pycache__'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Unexpected source/export symlink: ${file}`);
    if (entry.isDirectory()) visit(file); else rows[path.relative(directory, file).replaceAll('\\','/')] = sha(fs.readFileSync(file));
  } }
  visit(directory); return rows;
}
const report = { schema:1, mode:baseline ? 'before_observation' : geometryOnly ? 'geometry_subset' : 'acceptance', started_at:new Date().toISOString(),
  scope:'Actual React Native screens compiled by Expo for web, synthetic in-memory transport. All network restricted to the owned static export server. Browser viewport reduction simulates available keyboard space; physical Android/iOS, IME, pairing, external services and model acceptance are not run.',
  source, export:exported, verifier:{path:__filename,sha256:sha(fs.readFileSync(__filename))},
  source_files:hashes(path.join(source,'mobile')), export_files:hashes(exported), checks:[], layouts:[], screenshots:[], errors:[], blocked_requests:[] };
function check(name, details) { report.checks.push({name,passed:true,...(details ? {details}: {})}); }
async function geometry(page) {
  return page.evaluate(() => {
    const inspect = element => {
      if (!element) return {present:false,fully_visible:false};
      const rect = element.getBoundingClientRect();
      let clip = {left:0,top:0,right:innerWidth,bottom:innerHeight};
      const ancestors=[];
      for (let node=element.parentElement; node; node=node.parentElement) {
        const style=getComputedStyle(node), box=node.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {clip.left=Math.max(clip.left,box.left);clip.right=Math.min(clip.right,box.right);}
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {clip.top=Math.max(clip.top,box.top);clip.bottom=Math.min(clip.bottom,box.bottom);}
        if(node.scrollTop || node.scrollLeft) ancestors.push({tag:node.tagName,scrollTop:node.scrollTop,scrollLeft:node.scrollLeft});
      }
      const within=rect.width>0 && rect.height>0 && rect.left>=clip.left-1 && rect.top>=clip.top-1 && rect.right<=clip.right+1 && rect.bottom<=clip.bottom+1;
      const hit = document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
      const unobscured=!!hit && (hit===element || element.contains(hit));
      return {present:true,bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height,bottom:rect.bottom,right:rect.right},clip,within,unobscured,fully_visible:within&&unobscured,ancestors_scrolled:ancestors};
    };
    const field=document.querySelector('[aria-label="Message to TLI"]');
    const send=[...document.querySelectorAll('[role="button"],button')].find(n=>/^(Send|Send message|Send photo|Send message and photo|Stop|Stop waiting)$/.test(n.getAttribute('aria-label')||n.textContent.trim()));
    const navigation=[...document.querySelectorAll('[role="tab"]')].map(node=>({label:node.getAttribute('aria-label'),text:node.textContent,...inspect(node),texts:[...node.querySelectorAll('*')].filter(el=>[...el.childNodes].some(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim())).map(el=>{const style=getComputedStyle(el),range=document.createRange();range.selectNodeContents(el);const glyph=range.getBoundingClientRect();return {text:el.textContent,fontSize:style.fontSize,lineHeight:style.lineHeight,overflow:style.overflow,glyph_bounds:{top:glyph.top,bottom:glyph.bottom,height:glyph.height},...inspect(el)};})}));
    return {viewport:{width:innerWidth,height:innerHeight},page_scroll:{x:scrollX,y:scrollY},horizontal_overflow:document.documentElement.scrollWidth>innerWidth+1,field:inspect(field),send:inspect(send),navigation};
  });
}
async function main() {
  const server=http.createServer((req,res)=>{
    let route;try{route=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400).end();return;}
    let file=path.resolve(exported,'.'+route);
    if(file!==exported&&!file.startsWith(exported+path.sep)){res.writeHead(403).end();return;}
    if(!fs.existsSync(file)||fs.statSync(file).isDirectory())file=path.join(exported,'index.html');
    res.setHeader('Content-Type',({'.html':'text/html','.js':'application/javascript','.css':'text/css','.ttf':'font/ttf','.png':'image/png','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser=await chromium.launch({channel:'msedge',headless:true});
    const open=async ({width,height,theme,route='/ask',connection=''})=>{
      const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce',colorScheme:theme});
      page.setDefaultTimeout(15000);
      await page.addInitScript(()=>{globalThis.__TLI_PREVIEW_VERIFY__=true;});
      page.on('pageerror',error=>report.errors.push(error.message));
      page.on('dialog',dialog=>void dialog.accept());
      await page.route('**/*',request=>{if(new URL(request.request().url()).origin===origin)return request.continue(); report.blocked_requests.push(request.request().url());return request.abort();});
      await page.goto(`${origin}${route}?sample_theme=${theme}${connection?`&sample_connection=${connection}`:''}`);
      await page.getByRole('tab').first().waitFor();
      if(route==='/ask'||!baseline)await page.getByLabel('Message to TLI',{exact:true}).waitFor();
      await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(150);
      return page;
    };
    const requests=page=>page.evaluate(()=>globalThis.__TLI_PREVIEW_REQUESTS__||[]);
    const writes=async page=>(await requests(page)).filter(r=>!['GET','HEAD'].includes(r.method));
    const capture=async(page,name,requireComposer=true)=>{
      const measured=await geometry(page);report.layouts.push({name,url:new URL(page.url()).pathname,...measured});
      const file=name+'.png';await page.screenshot({path:path.join(output,file),fullPage:false});
      report.screenshots.push({path:file,sha256:sha(fs.readFileSync(path.join(output,file)))});
      if(!baseline){
        if(measured.horizontal_overflow)report.errors.push(`${name}: page overflow`);
        if(requireComposer){
          if(!measured.field.fully_visible)report.errors.push(`${name}: field clipped or obscured`);
          if(!measured.send.fully_visible)report.errors.push(`${name}: Send clipped or obscured`);
          const labels=measured.navigation.flatMap(tab=>tab.texts.filter(text=>/^(Chat|Today|Home)$/.test(text.text)));
          if(labels.length!==3)report.errors.push(`${name}: missing navigation label`);
          for(const label of labels){
            if(!label.fully_visible||label.glyph_bounds.top<label.bounds.y-1||label.glyph_bounds.bottom>label.bounds.bottom+1)report.errors.push(`${name}: ${label.text} navigation glyph clipped`);
          }
        }
      }
      return measured;
    };
    for(const width of [390,320])for(const height of [844,640])for(const theme of ['light','dark']) {
      for(const route of baseline?['/','/ask']:['/']) {
        const page=await open({width,height,theme,route});
        const label=`${baseline?'before':'after'}-${width}x${height}-${theme}-${route==='/'?'default':'chat'}`;
        assert.equal((await writes(page)).length,0,'Opening screen performs no mutation or inference');
        if(!baseline)assert.equal(new URL(page.url()).pathname,'/ask','Default entry is Chat');
        await capture(page,label);await page.close();
      }
    }
    if(!baseline) {
      check('Default Chat entry and unscrolled field/Send visible at both phone widths, normal/short heights, light/dark');
      if(geometryOnly) {
        for(const width of [390,320])for(const theme of ['light','dark'])for(const height of [420,360]) {
          const page=await open({width,height:844,theme});
          await page.getByLabel('Message to TLI',{exact:true}).fill('A draft while a keyboard takes screen space');
          await page.getByLabel('Message to TLI',{exact:true}).focus();
          await page.setViewportSize({width,height});await page.waitForTimeout(100);
          await capture(page,`${width}-${theme}-simulated-keyboard-${height}`);await page.close();
        }
      } else await acceptance({open,capture,requests,writes,check,browser,origin});
    }
    assert.equal(report.errors.length,0,`${report.errors.length} verification issues; see report.json`);assert.deepEqual(report.blocked_requests,[]);
    report.source_unchanged=JSON.stringify(report.source_files)===JSON.stringify(hashes(path.join(source,'mobile')));
    report.export_unchanged=JSON.stringify(report.export_files)===JSON.stringify(hashes(exported));
    assert.ok(report.source_unchanged&&report.export_unchanged,'Source/export changed during verification');
    report.status=baseline?'observed':'passed';
  } catch(error) {report.status='failed';report.errors.push(error.stack||String(error));throw error;}
  finally {
    if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
    report.source_unchanged=JSON.stringify(report.source_files)===JSON.stringify(hashes(path.join(source,'mobile')));
    report.export_unchanged=JSON.stringify(report.export_files)===JSON.stringify(hashes(exported));
    report.finished_at=new Date().toISOString();fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
  }
  console.log(JSON.stringify({output,status:report.status,checks:report.checks.length,layouts:report.layouts.length,screenshots:report.screenshots.length,errors:report.errors.length,sha256:sha(fs.readFileSync(path.join(output,'report.json')))}));
}
async function acceptance({open,capture,writes,check}) {
  const input=page=>page.getByLabel('Message to TLI',{exact:true});
  const send=page=>page.getByRole('button',{name:'Send message',exact:true});
  const context=page=>page.getByRole('button',{name:/^(Add context|Context · \d+)$/});
  const closeContext=page=>page.getByRole('button',{name:'Close message context',exact:true});
  const streamWrites=async page=>(await writes(page)).filter(r=>r.path==='/api/ai/chat/stream');
  const largeText=async page=>page.evaluate(()=>{
    // React Native Web fixes Dimensions.fontScale at 1. Scale actual Chat text
    // and its explicit sheets; do not pretend this exercises native OS scaling
    // of the navigator, which has a separately computed fontScale height.
    const scopes=[...document.querySelectorAll('[data-testid="chat-screen"],[data-testid="chat-context-sheet"],[data-testid="chat-status-sheet"]')];
    const original=[...new Set(scopes.flatMap(scope=>[...scope.querySelectorAll('*')]))].filter(el=>!el.dataset.chatTestEnlarged && (
      ['INPUT','TEXTAREA','BUTTON'].includes(el.tagName)||[...el.childNodes].some(node=>node.nodeType===Node.TEXT_NODE&&node.textContent.trim()))
    ).map(el=>({el,font:parseFloat(getComputedStyle(el).fontSize),line:parseFloat(getComputedStyle(el).lineHeight)}));
    for(const {el,font,line} of original){el.dataset.chatTestEnlarged='true';el.style.fontSize=`${font*2}px`;if(Number.isFinite(line))el.style.lineHeight=`${line*2}px`;}
  });
  for(const width of [390,320])for(const theme of ['light','dark']) {
    const label=`${width}-${theme}`;
    let page=await open({width,height:640,theme,route:'/'});
    await input(page).fill('Unsent draft kept while I inspect context');
    await context(page).click();
    await page.getByTestId('chat-context-sheet').waitFor();
    await closeContext(page).focus();await page.keyboard.press('Enter');
    await page.getByTestId('chat-context-sheet').waitFor({state:'hidden'});
    assert.equal(await input(page).inputValue(),'Unsent draft kept while I inspect context');
    assert.equal((await writes(page)).length,0);
    await context(page).click();
    await page.getByLabel('Use saved notes',{exact:true}).uncheck();
    await page.getByLabel('Use earlier conversation',{exact:true}).uncheck();
    await page.setViewportSize({width,height:420});
    await page.getByRole('button',{name:'Troubleshooting cases',exact:true}).scrollIntoViewIfNeeded();
    const sheetScroll=await page.getByTestId('chat-context-sheet').evaluate(sheet=>[...sheet.querySelectorAll('*')].some(n=>n.scrollTop>0));
    assert.equal(sheetScroll,true,'Optional context scrolls inside the explicit sheet at short height');
    await capture(page,`${label}-context-scroll`,false);
    await closeContext(page).click();
    await page.setViewportSize({width,height:640});
    assert.equal(await input(page).inputValue(),'Unsent draft kept while I inspect context');
    assert.equal((await writes(page)).length,0);
    await capture(page,`${label}-context-closed-draft`);
    check(`${label}: optional context scroll, keyboard close and selection preserve draft with zero writes`);
    await page.getByRole('button',{name:'Connection details',exact:true}).click();
    await page.getByRole('button',{name:'Close connection details',exact:true}).click();
    await page.getByRole('button',{name:'History',exact:true}).click();
    await page.getByText('Your conversations',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Close chooser',exact:true}).click();
    for(const tab of ['Today','Home','Chat']) await page.getByRole('tab',{name:new RegExp(`${tab}$`)}).click();
    assert.equal(await input(page).inputValue(),'Unsent draft kept while I inspect context');
    assert.equal((await writes(page)).length,0);
    check(`${label}: status/history/tab navigation preserves draft and creates no mutation or inference`);
    await input(page).fill('Explain this synthetic printer warning with its evidence');
    await send(page).evaluate(button=>{button.click();button.click();});
    await page.getByRole('button',{name:'Message options',exact:true}).first().waitFor();
    assert.equal((await streamWrites(page)).length,1);
    assert.equal((await streamWrites(page))[0].body.use_saved_memory,false);
    assert.equal((await streamWrites(page))[0].body.use_conversation_history,false);
    assert.equal(await input(page).inputValue(),'');
    await context(page).click();assert.equal(await page.getByLabel('Use earlier conversation',{exact:true}).isChecked(),true);await closeContext(page).click();
    await capture(page,`${label}-completed-answer`);
    check(`${label}: one explicit Send uses reviewed context flags; only completion clears draft and resets per-question history`);
    for(let n=0;n<4;n++){
      await input(page).fill(`Synthetic printer history item ${n+1}: what can the available record tell us?`);
      await send(page).click();
      await page.waitForFunction(()=>document.querySelector('[aria-label="Message to TLI"]')?.value==='');
    }
    const messages=await page.getByTestId('chat-messages').evaluate(el=>({client:el.clientHeight,scroll:el.scrollHeight}));
    assert.ok(messages.scroll>messages.client*2,'History actually overflows its own scroll area');
    await capture(page,`${label}-long-history`);
    const originalGeometry=await geometry(page);
    await page.getByTestId('chat-messages').evaluate(el=>{el.scrollTop=0;});
    const afterScroll=await geometry(page);
    assert.deepEqual(afterScroll.field.bounds,originalGeometry.field.bounds,'Message history scrolling must not move composer');
    await input(page).fill('simulate slow printer response');await send(page).click();
    await page.getByRole('button',{name:'Stop waiting',exact:true}).waitFor();
    await page.waitForTimeout(700);
    await capture(page,`${label}-streaming-stop`);
    await page.getByRole('button',{name:'Stop waiting',exact:true}).click();
    await page.getByText(/Stopped waiting on this phone/).first().waitFor();
    assert.equal(await input(page).inputValue(),'simulate slow printer response');
    const stoppedCount=(await streamWrites(page)).length;
    await page.waitForTimeout(700);assert.equal((await streamWrites(page)).length,stoppedCount);
    await capture(page,`${label}-stopped-draft`);
    await input(page).fill('simulate failure');await send(page).click();
    await page.getByText(/Sample vision provider unavailable/i).first().waitFor();
    assert.equal(await input(page).inputValue(),'simulate failure');
    assert.equal((await streamWrites(page)).length,stoppedCount+1);
    await capture(page,`${label}-failed-draft`);
    check(`${label}: overflowing history leaves composer fixed; Stop and failed response retain draft without replay`);
    await page.close();
    for(const connection of ['ai_unavailable','unreachable']){
      page=await open({width,height:640,theme,connection});
      await input(page).fill('Keep this draft until the host and AI are ready');
      assert.equal(await send(page).isDisabled(),connection==='unreachable');
      assert.equal((await streamWrites(page)).length,0);
      const status=await page.getByTestId('chat-status').innerText();
      assert.match(status,connection==='ai_unavailable'?/AI unavailable/:/Connection unavailable/);
      await capture(page,`${label}-${connection}`);
      await page.close();
    }
    check(`${label}: unavailable AI and unreachable host keep accessible composer and draft without sending`);
    for(const height of [420,360]){
      page=await open({width,height:844,theme});
      await input(page).fill('A draft while a keyboard takes screen space');
      await input(page).focus();await page.setViewportSize({width,height});await page.waitForTimeout(100);
      await capture(page,`${label}-simulated-keyboard-${height}`);
      await page.close();
    }
    page=await open({width,height:640,theme});
    await largeText(page);await page.waitForTimeout(100);
    await capture(page,`${label}-large-text-200`);
    await input(page).fill('Line one\nLine two\nLine three\nLine four\nLine five\nLine six\nLine seven\nLine eight');
    await capture(page,`${label}-large-text-multiline`);
    await context(page).click();await largeText(page);await page.getByRole('button',{name:'Troubleshooting cases',exact:true}).scrollIntoViewIfNeeded();
    await capture(page,`${label}-large-text-context`,false);
    await closeContext(page).click();assert.match(await input(page).inputValue(),/Line eight/);
    await page.close();
    check(`${label}: simulated keyboard space and 200% Chat text retain visible field and Send; multiline draft is bounded (native navigator font scaling not simulated)`);
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
