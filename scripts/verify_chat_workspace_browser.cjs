/* Isolated AI Chat acceptance; --anniversary includes the shared UI refresh.
 * The default retains the historical Chat-only scope. No app, model,
 * device or microphone is started. The real send/SSE/render/history and context
 * modules run against synthetic fixtures. */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const harnessSnapshot = fs.readFileSync(__filename);
const premium = process.argv.includes('--premium');
const anniversary = premium || process.argv.includes('--anniversary');
// Default retains the original single-panel boundary. The anniversary mode
// permits the authorized shared shell refresh and retains panel/control contracts.
const bodyAttributes = anniversary ? ' data-tli-ui="anniversary"' : '';
const output = path.join(root, 'build_work', ...(anniversary ? ['anniversary-ui'] : []), 'chat-workspace-browser-' + (premium ? 'premium-' : anniversary ? 'anniversary-' : '') + new Date().toISOString().replace(/[:.]/g, '-'));
const read = file => fs.readFileSync(path.join(root, 'frontend', file), 'utf8');
const appSource = read('app.js'), app = appSource.replace(/\r/g, ''), shell = read('index.html');
const start = shell.search(/<section\b[^>]*\bid="panel-main"[^>]*>/);
assert.ok(start >= 0, 'AI Chat panel must exist');
const panel = shell.slice(start, shell.indexOf('</section>', start) + '</section>'.length);
const extract = (first, last) => {
  const a = app.indexOf(first), b = app.indexOf(last, a);
  assert.ok(a >= 0 && b > a, 'Source fixture boundary: ' + first);
  return app.slice(a, b);
};
const styles = ['style.css', 'themes.css', 'chat_enhanced.css', 'shell-refinement.css', 'intelligence.css', 'notebook.css', 'memory-continuity.css', 'document-context.css', 'chat-workspace.css'];
const scripts = ['chat_history.js', 'chat_enhanced.js', 'js/intelligence.js', 'js/screenshot-help.js', 'js/notebook.js', 'js/memory-continuity.js', 'js/document-context.js', 'js/chat-workspace.js'];
if (anniversary) { styles.push('ui-foundation.css'); scripts.unshift('js/chat-format.js'); scripts.push('js/ui-foundation.js'); }
if (premium) {
  styles.push('theme-library.css', 'premium-chat.css');
  scripts.unshift('js/theme-catalog.js','js/premium-presentation.js','js/interface-style.js');
}
const sourceSnapshot = { 'app.js': appSource, 'index.html': shell, ...Object.fromEntries([...styles, ...scripts].map(file => [file, read(file)])) };
const beforePath = path.join(root, 'build_work', 'chat-refresh', 'index.before.html');
const beforeShell = fs.existsSync(beforePath) ? fs.readFileSync(beforePath, 'utf8') : null;
const fixture = `
const $=id=>document.getElementById(id);
if(!$('mode-select')){const mode=document.createElement('select');mode.id='mode-select';mode.hidden=true;mode.append(new Option('Default','default'));document.body.append(mode);}
let _chatImageB64=null,_chatImageMime=null,_chatImageReadVersion=0,_chatImageReading=false,_chatImagePickerTicket=null,_chatImageReader=null,_chatImageDecoder=null,_chatImageReadTimer=null,lastSendTs=0,inFlightController=null,currentDeviceId='fixture-browser',_currentPanelId='panel-main',chatHistory=[];
const CHAT_HISTORY_DRAFT_ID='__draft__';
const AIStatus={local:{},lan:{available:false}},IntelligenceSource={LAN_LLM:'lan',NONE:'none'};
window.fixtureBrain='bundled';
const readSettings=()=>({defaultBrain:window.fixtureBrain}),isTeachingMode=()=>false,tliSearchIsEnabled=()=>false;
const resolveIntelligenceRoute=async()=>{if(window.fixtureHoldRoute)await new Promise(resolve=>{window.fixtureResumeRoute=()=>{window.fixtureHoldRoute=false;window.fixtureResumeRoute=null;resolve();};});return {source:'local'};},tliFetchBundledStatus=async()=>({ok:true});
const showToast=text=>{$('fixture-status').textContent=text;};
const setModelStatus=()=>{},debugLog=()=>{},_attachSpeakBtn=()=>{},tliSpeak=()=>{},tliSpeakBubble=()=>{},_refreshNoAiBanner=()=>{},_setupVoiceInput=()=>{},_setupTTSToggle=()=>{};
const switchPanel=id=>{window.fixtureNavigation=id;};
window.fixtureModelManagerOpened=0;window.tliOpenModelManagerModal=()=>{window.fixtureModelManagerOpened++;};
// route.fulfill supplies the synthetic response, then this wrapper gates its
// body to exercise the production SSE reader between first token and done.
const fixtureFetch=window.fetch.bind(window);
window.fetch=async(...args)=>{
  const response=await fixtureFetch(...args);
  if(!window.fixtureGateStream || new URL(String(args[0]),location.href).pathname!=='/api/ai/chat/stream')return response;
  window.fixtureGateStream=false;
  const text=await response.text(), blocks=text.split('\\n\\n').filter(Boolean), encoder=new TextEncoder(), signal=args[1]?.signal;
  const stream=new ReadableStream({start(controller){
    let first=false,ended=false;
    const write=frames=>controller.enqueue(encoder.encode(frames.join('\\n\\n')+'\\n\\n'));
    window.fixtureResponseControl={
      first(){if(first||ended)return;first=true;write(blocks.slice(0,2));},
      finish(){if(ended)return;if(!first){first=true;write(blocks.slice(0,2));}ended=true;write(blocks.slice(2));controller.close();},
    };
    signal?.addEventListener('abort',()=>{if(!ended){ended=true;controller.error(new DOMException('Aborted synthetic response','AbortError'));}},{once:true});
  }});
  return new Response(stream,{status:response.status,headers:response.headers});
};
${extract('function renderAssistantHTML(', 'function tliLSSet(')}
${extract('function formatModelOutput(', 'function runTitleTypeAnimation(')}
${extract('let currentConversationId = null;', 'let meshDirectoryCache')}
${extract('function appendMessage(', '// -------- Header Integration Health')}
${extract('async function sendChat()', '// Shelly Chat Helpers')}
${extract('function _stopChatImageRead()', '// Existing Chat entry points delegate to one browser-local voice controller.')}
${extract('async function loadPreviousPrompts()', '// ---------- status ----------')}
// The real shell activates the selected panel before use. This isolated fixture
// does not run shell navigation, and Dashboard is now the installed entry panel.
document.addEventListener('DOMContentLoaded',()=>{const panel=$('panel-main');panel.hidden=false;panel.classList.add('active');setupChat();loadPreviousPrompts();});
`;
const revision = 'a'.repeat(64);
const source = { conversation_id: 'fixture-conversation', message_index: 1, revision };
const note = { id: 'f-fixture', title: 'Studio backup location', text: 'Use the spare drive kept in the studio drawer.', revision, source: 'user_memory', category: 'general', updated_at: '2026-09-07T12:00:00Z', device_id: null };
const conversations = [{ id: 'fixture-conversation', title: 'Find the studio backup', message_count: 4, last_updated: '2026-09-07T12:00:00Z' }, { id: 'fixture-long', title: 'Review the computer report and next steps', message_count: 12, last_updated: '2026-09-06T12:00:00Z' }];
const longReply = `## What the saved note tells us

The studio drawer is the recorded location. This is a saved note, not a fresh check of the drive.

- Review the drive label before using it.
- Compare the backup date with the files you need.
- If it is unavailable, tell me what you can see.

| Item | Recorded information |
| --- | --- |
| Location | Studio drawer |
| Availability | Not checked |

\`\`\`text
example-folder/${'long-file-name-'.repeat(18)}.txt
\`\`\`

${'This explanation keeps the next step clear without claiming a repair has run. '.repeat(8)}`;
const frames = (body, complete = true) => {
  const meta = { session_id: source.conversation_id, conversation_id: source.conversation_id, source_ref: source, user_source_ref: { ...source, message_index: 0 },
    memory_context: { use_saved_memory: body.use_saved_memory, status: body.use_saved_memory ? 'included' : 'disabled', notes: body.use_saved_memory ? [{ ...note, text: undefined }] : [], omitted_for_budget: 0 },
    conversation_context: { status: 'limited', included_messages: 12, included_exchanges: 6, omitted_messages: 8, character_budget: 12000 } };
  return [{ type: 'meta', session_id: source.conversation_id }, { type: 'delta', text: longReply }, ...(complete ? [{ type: 'meta', ...meta }, { type: 'done' }] : [])].map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('');
};
const waitIdle = page => page.waitForFunction(() => !document.getElementById('chat-send-btn').disabled && document.getElementById('abort-chat-btn').disabled);
async function revealOptions(page) {
  const details = page.locator('#chat-options');
  if (await details.count() && await details.evaluate(el => el.tagName === 'DETAILS' && !el.open)) await details.locator('summary').first().click();
}
async function revealMemory(page) {
  if (premium && await page.locator('#chat-context-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#chat-context-toggle').click();
}
async function layout(page, label) {
  const result = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const selectors = ['#panel-main', '#chat-output', '#chat-composer-shell', '#chat-input', '#chat-send-btn', '#chat-context-toggle', '#chat-context-summary', '#chat-header-actions', '#chat-response-status'];
    return { viewport: width, document: document.documentElement.scrollWidth,
      controls: selectors.map(selector => { const el = document.querySelector(selector), r = el?.getBoundingClientRect(); return { selector, visible: !!r && r.width > 0 && r.height > 0, left: r?.left, right: r?.right }; }),
      duplicateIds: [...document.querySelectorAll('[id]')].map(el => el.id).filter((id, i, ids) => ids.indexOf(id) !== i) };
  });
  assert.ok(result.document <= result.viewport + 1, `${label}: horizontal page overflow: ${JSON.stringify(result)}`);
  assert.deepEqual(result.duplicateIds, [], `${label}: duplicate controls`);
  for (const c of result.controls) if (c.visible) assert.ok(c.left >= -1 && c.right <= result.viewport + 1, `${label}: offscreen ${JSON.stringify(c)}`);
  return result;
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
  fs.mkdirSync(output, { recursive: true });
  const results = [], browser = await chromium.launch({ channel: 'msedge', headless: true });
  let sourceScope = { status: 'not run', reason: 'Pre-change shell snapshot unavailable.' };
  try {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
      for (const theme of ['emeraldLight', 'midnight']) {
        const page = await browser.newPage({ viewport });
        page.setDefaultTimeout(8000);
        const errors = [], requests = [], unexpected = [], checks = [], layouts = [];
        let incomplete = false, hold = false, release = null, signalHeld;
        const heldReady = new Promise(resolve => { signalHeld = resolve; });
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', async route => {
          const url = new URL(route.request().url());
          const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
          if (url.origin !== 'http://tli-chat.test') { unexpected.push(url.origin + url.pathname); return route.abort(); }
          if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'application/javascript', body: fixture });
          const asset = [...styles, ...scripts].find(file => '/' + file === url.pathname);
          if (asset) return route.fulfill({ contentType: asset.endsWith('.css') ? 'text/css' : 'application/javascript', body: sourceSnapshot[asset] });
          if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="en" data-theme="' + theme + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + styles.map(file => '<link rel="stylesheet" href="/' + file + '">').join('') + '<style>body{margin:0;min-width:0}.fixture-top{padding:16px 20px;border-bottom:1px solid var(--border-subtle);color:var(--text-main);font:600 14px system-ui}.fixture-main{padding:16px;width:100%;max-width:1500px;margin:auto;min-width:0}#fixture-status{position:fixed;left:8px;bottom:4px;max-width:90vw;font:12px system-ui;color:var(--text-main);z-index:40;pointer-events:none}@media(max-width:500px){.fixture-main{padding:8px}}</style></head><body' + bodyAttributes + '><header class="fixture-top">TheLANIntelligence · LAN Console</header><main class="fixture-main">' + panel + '</main><p id="fixture-status" role="status"></p><script src="/fixture.js"></script>' + scripts.map(file => '<script src="/' + file + '"></script>').join('') + '</body></html>' });
          requests.push({ method: route.request().method(), path: url.pathname });
          if (url.pathname === '/api/intelligence/devices') return json({ node: { name: 'Studio host', id: 'fixture-host' }, devices: [{ id: 'fixture-pc', name: 'Studio computer', kind: 'computer', room: 'Studio' }], scope: 'Synthetic host fixture' });
          if (url.pathname === '/api/intelligence/memory') return json({ facts: [note] });
          if (url.pathname === '/api/intelligence/memory/capabilities') return json({ ok: true, protocol: 'tli-memory-continuity-v1' });
          if (url.pathname === '/api/intelligence/screenshots/context') return json({ host: { id: 'fixture-host', name: 'Studio host' }, computers: [{ id: 'fixture-pc', node_id: 'fixture-host', name: 'Studio computer' }], checked_at: '2026-09-07T12:00:00Z', provider: { provider: 'bundled', model: 'Synthetic vision model', key: revision, destination: 'this synthetic host', note: 'Fixture provider only.' } });
          if (url.pathname === '/api/ai/conversations') return json({ conversations });
          if (url.pathname.startsWith('/api/ai/conversations/')) return json({ messages: [{ role: 'user', content: 'Where is the studio backup?' }, { role: 'assistant', content: longReply }] });
          if (url.pathname === '/api/intelligence/conversation-search/capabilities') return json({ ok: true, protocol: 'conversation-search-v1' });
          if (url.pathname === '/api/intelligence/conversation-search') return json({ ok: true, protocol: 'conversation-search-v1', query: url.searchParams.get('q') || '', next_cursor: null,
            items: conversations.map(c => ({ ...c, provider: 'bundled', snippet: 'Synthetic saved conversation.', match: { source: 'title', at: c.last_updated }, truncated: false })),
            coverage: { complete: true, text_limited: false, more_to_search: false, scanned_conversations: 2, owned_conversations: 2, limits: { messages_per_conversation: 100, characters_per_message: 12000 } } });
          if (url.pathname === '/api/ai/chat/stream') {
            const body = route.request().postDataJSON(); requests.at(-1).body = body;
            if (hold) await new Promise(resolve => { release = resolve; signalHeld(); });
            return route.fulfill({ contentType: 'text/event-stream', body: frames(body, !incomplete) }).catch(() => {});
          }
          unexpected.push(url.pathname); return json({ detail: 'Endpoint not present in isolated fixture' }, 404);
        });
        try {
          await page.goto('http://tli-chat.test/');
          if (premium) await page.evaluate(theme => { window.TLIPresentation.set('premium'); window.TLIThemes.apply(theme, {notify:false}); }, theme);
          if (beforeShell && results.length === 0 && anniversary) {
            sourceScope = await anniversaryScope(page, beforeShell, shell, 'panel-main');
          } else if (beforeShell && results.length === 0) {
            sourceScope = await page.evaluate(({ before, after }) => {
              const normalize = html => {
                const doc = new DOMParser().parseFromString(html, 'text/html');
                doc.querySelectorAll('#panel-main,script,link[rel="stylesheet"]').forEach(el => el.remove());
                return doc.documentElement.outerHTML.replace(/\s+/g, ' ').trim();
              };
              const a = normalize(before), b = normalize(after);
              let difference = 0; while (difference < a.length && a[difference] === b[difference]) difference++;
              return { status: a === b ? 'passed' : 'failed', excluded: ['AI Chat panel', 'stylesheet links', 'script tags'], ...(a === b ? {} : { before: a.slice(Math.max(0, difference - 100), difference + 300), after: b.slice(Math.max(0, difference - 100), difference + 300) }) };
            }, { before: beforeShell, after: shell });
            assert.equal(sourceScope.status, 'passed', 'Existing shell and other panels unchanged: ' + JSON.stringify(sourceScope));
          }
          await page.locator('#memory-use-saved').waitFor({ state: 'attached' });
          assert.equal(await page.locator('#chat-response-status').isVisible(), false, 'Response status starts hidden');
          const lifecycle = await page.evaluate(() => {
            const api = window.TLIChatWorkspace, status = document.getElementById('chat-response-status');
            const snapshot = () => ({ hidden: status.hidden, text: status.textContent.trim() });
            const first = api.beginResponse(), second = api.beginResponse();
            first.responding(); first.finish(); const staleFirst = snapshot();
            second.responding(); const currentSecond = snapshot();
            second.finish(); const finished = snapshot();
            const conversation = api.beginResponse(); window.dispatchEvent(new CustomEvent('tli-conversation-changed'));
            conversation.responding(); const changed = snapshot();
            const newChat = api.beginResponse(); document.getElementById('new-chat-btn').click();
            newChat.responding(); newChat.finish(); const reset = snapshot();
            return { staleFirst, currentSecond, finished, changed, reset };
          });
          assert.equal(lifecycle.staleFirst.hidden, false); assert.match(lifecycle.staleFirst.text, /Waiting for a reply…/);
          assert.equal(lifecycle.currentSecond.hidden, false); assert.match(lifecycle.currentSecond.text, /Receiving the reply…/);
          assert.equal(lifecycle.finished.hidden, true); assert.equal(lifecycle.changed.hidden, true); assert.equal(lifecycle.reset.hidden, true);
          checks.push('superseded response handles cannot alter current state; New Chat and conversation changes invalidate stale handles');
          await page.waitForFunction(() => document.querySelectorAll('#recent-chats-list .recent-chat-btn').length === 2);
          assert.equal(await page.locator('#panel-main').isVisible(), true, 'Isolated Chat panel is activated as shell navigation would activate it');
          assert.equal(await page.locator('#chat-input').isVisible(), true, 'Draft and focus acceptance exercises a visible composer');
          layouts.push(await layout(page, 'initial'));
          if (premium) {
            const changed = await page.evaluate(() => {
              const $ = id => document.getElementById(id), input = $('chat-input'), memory = $('memory-use-saved');
              const tracked = ['chat-input','chat-send-btn','chat-mic-btn','chat-runtime-button','memory-use-saved','recent-chats-list'];
              const originals = tracked.map($);
              input.value = 'Keep this unsent draft'; input.focus(); input.setSelectionRange(5,9);
              const wasChecked = memory.checked;
              const switchTo = value => window.TLIPresentation.set(value);
              switchTo('legacy');
              const legacy = $('chat-runtime-button').parentElement.id === 'chat-header-actions' && $('chat-memory-slot').parentElement.classList.contains('chat-context-toolbar');
              switchTo('premium');
              const result = { legacy, identities: tracked.every((id,index) => $(id) === originals[index]), draft: input.value,
                focused: document.activeElement === input, selection: [input.selectionStart,input.selectionEnd], memory: memory.checked === wasChecked,
                memoryInContext: $('chat-memory-slot').parentElement.id === 'chat-context-details',
                runtimeInComposer: $('chat-runtime-button').closest('#chat-composer-shell') !== null,
                recentInBody: $('recent-chats-list').closest('.chat-card-body') !== null };
              input.value = ''; input.dispatchEvent(new Event('input',{bubbles:true})); return result;
            });
            assert.deepEqual(changed, {legacy:true,identities:true,draft:'Keep this unsent draft',focused:true,selection:[5,9],memory:true,memoryInContext:true,runtimeInComposer:true,recentInBody:true});
            assert.equal(requests.filter(r => r.path === '/api/ai/chat/stream').length, 0, 'Appearance changes do not generate');
            checks.push('Premium/legacy round-trip preserves original controls, draft, focus, selection and memory preference; no request');
          }
          await page.screenshot({ path: path.join(output, `empty-${viewport.width}-${theme}.png`), fullPage: true, animations: 'disabled' });
          const beforeStatusRequests = requests.length;
          await page.locator('#chat-runtime-button').click();
          assert.equal(await page.evaluate(() => window.fixtureModelManagerOpened), 1);
          assert.equal(requests.length, beforeStatusRequests, 'Opening model controls does not start a new status or inference request');
          checks.push('runtime shortcut opens existing model manager once without probing or inference');
          await page.locator('#chat-context-toggle').click();
          assert.equal(await page.locator('#chat-context-toggle').getAttribute('aria-expanded'), 'true');
          await page.locator('.tli-int-chat').evaluate(el => { el.open = true; });
          await page.waitForFunction(() => document.querySelector('[data-int-target] option[value="fixture-pc"]'));
          await page.locator('.tli-int-chat [data-int-target]').selectOption('fixture-pc');
          await page.waitForFunction(() => document.querySelector('#chat-context-summary').textContent.includes('Studio computer'));
          await page.locator('#chat-context-summary').getByRole('button', { name: 'Remove Studio computer', exact: true }).click();
          assert.equal(await page.locator('.tli-int-chat [data-int-target]').inputValue(), '');
          await page.locator('#memory-use-saved').uncheck();
          assert.equal(await page.evaluate(() => window.TLIMemory.describeContext()[0].enabled), false);
          await page.locator('#memory-use-saved').check();
          checks.push('real device context review/removal and memory preference');

          await revealOptions(page);
          await page.locator('#notebook-open').click();
          await page.locator('#notebook-list').getByRole('button', { name: 'Use for next question', exact: true }).click();
          await page.waitForFunction(() => document.querySelector('#chat-context-summary').textContent.includes('Studio backup location'));
          await page.locator('#chat-context-summary').getByRole('button', { name: 'Remove Studio backup location', exact: true }).click();
          assert.deepEqual(await page.evaluate(() => window.TLINotebook.describeContext()), []);
          checks.push('real Notebook selection and independent removal');

          await revealOptions(page);
          await page.locator('#documents-open').click();
          await page.locator('#documents-input').setInputFiles({ name: 'studio-notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Studio notes\nSynthetic test content only.') });
          await page.locator('#documents-use').click();
          await page.waitForFunction(() => document.querySelector('#chat-context-summary').textContent.includes('studio-notes.md'));
          await page.locator('#chat-context-summary').getByRole('button', { name: 'Remove studio-notes.md', exact: true }).click();
          assert.deepEqual(await page.evaluate(() => window.TLIDocuments.describeContext()), []);
          checks.push('real document review/attachment and independent removal');
          const imagePicker = page.waitForEvent('filechooser');
          await page.locator('#chat-attach-btn').click();
          await (await imagePicker).setFiles({ name: 'synthetic-screen.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3e0AAAAASUVORK5CYII=', 'base64') });
          await page.waitForFunction(() => document.querySelector('#screenshot-sharing').textContent.includes('Synthetic vision model'));
          assert.equal(requests.filter(r => r.path === '/api/ai/chat/stream').length, 0, 'Context review never sends a question');
          layouts.push(await layout(page, 'image sharing review'));
          await page.locator('#chat-image-remove').click();
          assert.equal(await page.locator('#screenshot-help').isVisible(), false);
          checks.push('real image attachment, destination review and removal without generation');
          layouts.push(await layout(page, 'context review'));
          if (await page.locator('#chat-context-toggle').getAttribute('aria-expanded') === 'true') await page.locator('#chat-context-toggle').click();
          await page.locator('#chat-options').evaluate(el => { if (el.tagName === 'DETAILS') el.open = false; });
          await page.evaluate(() => { window.fixtureHoldRoute = true; window.fixtureGateStream = true; });
          await page.locator('#chat-input').fill('Where is the studio backup?');
          await page.locator('#chat-input').press('Enter');
          await page.waitForFunction(() => typeof window.fixtureResumeRoute === 'function');
          const responseStatus = page.locator('#chat-response-status');
          assert.equal(await responseStatus.isVisible(), true, 'Working indication is visible while route resolution is pending');
          assert.match(await responseStatus.textContent(), /Waiting for a reply…/);
          assert.equal(await responseStatus.getAttribute('role'), 'status');
          assert.equal(await responseStatus.getAttribute('aria-live'), 'polite');
          assert.equal(requests.filter(r => r.path === '/api/ai/chat/stream').length, 0, 'Working indication precedes the network request');
          await page.emulateMedia({ reducedMotion: 'reduce' });
          assert.equal(await responseStatus.locator('.chat-response-dots span').count(), 3, 'The working indicator retains three dots');
          const reducedMotion = await responseStatus.evaluate(el => Array.from(el.querySelectorAll('*')).map(child => ({ tag: child.tagName, animation: getComputedStyle(child).animationName })).filter(child => child.animation !== 'none'));
          assert.deepEqual(reducedMotion, [], 'Reduced motion disables animation in the response indicator');
          layouts.push(await layout(page, 'working before route resolution'));
          await page.screenshot({ path: path.join(output, `working-${viewport.width}-${theme}.png`), fullPage: true, animations: 'disabled' });
          await page.emulateMedia({ reducedMotion: 'no-preference' });
          const animations = await responseStatus.locator('.chat-response-dots span').evaluateAll(nodes => nodes.map(el => getComputedStyle(el).animationName));
          assert.deepEqual(animations, ['tli-chat-response-pulse', 'tli-chat-response-pulse', 'tli-chat-response-pulse'], 'Normal-motion dots animate while working');
          await page.evaluate(() => window.fixtureResumeRoute());
          await page.waitForFunction(() => typeof window.fixtureResponseControl?.first === 'function');
          assert.equal(await responseStatus.isVisible(), true);
          assert.match(await responseStatus.textContent(), /Waiting for a reply…/, 'Still working while the SSE body has no first token');
          await page.evaluate(() => window.fixtureResponseControl.first());
          await page.waitForFunction(() => document.querySelector('#chat-response-status').textContent.includes('Receiving the reply…'));
          assert.equal(await responseStatus.isVisible(), true, 'Responding indication remains visible until completion');
          assert.equal(await page.locator('#chat-send-btn').isDisabled(), true);
          assert.equal(await page.locator('.memory-context-receipt').count(), 0, 'Streaming does not create a completed receipt');
          if (premium) {
            const preserved = await page.evaluate(() => {
              const output = document.getElementById('chat-output'), bubble = output.querySelector('.chat-bubble-ai');
              output.scrollTop = 12;
              const content = bubble?.textContent, beforeScroll = output.scrollTop;
              let legacyScrollable = false;
              for (const experience of ['legacy','premium']) {
                window.TLIPresentation.set(experience);
                if (experience === 'legacy') legacyScrollable = output.scrollHeight > output.clientHeight;
              }
              return {sameBubble:output.querySelector('.chat-bubble-ai') === bubble,content:content === bubble?.textContent,
                busy:document.getElementById('chat-send-btn').disabled,
                // The isolated mobile Legacy fixture expands to its content.
                // Check exact scroll only while both presentations can scroll.
                scroll:!legacyScrollable || output.scrollTop === beforeScroll};
            });
            assert.deepEqual(preserved,{sameBubble:true,content:true,busy:true,scroll:true});
            assert.equal(requests.filter(r => r.path === '/api/ai/chat/stream').length,1);
            checks.push('Premium/legacy changes during a live response preserve stream and original bubble; reader scroll retained where both isolated layouts scroll');
            const themedStream = await page.evaluate(async () => {
              const output = document.getElementById('chat-output'), bubble = output.querySelector('.chat-bubble-ai');
              const nextPaint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              await nextPaint();
              output.scrollTop = 12;
              const content = bubble.textContent, beforeScroll = output.scrollTop;
              const previousTheme = document.documentElement.dataset.theme, observations = [];
              // Exercise the actual catalog and its normal theme event while
              // the production SSE reader is still awaiting its final frames.
              for (const theme of ['emeraldLight','lavenderLite','pacific','oled',previousTheme]) {
                window.TLIThemes.apply(theme);
                await nextPaint();
                observations.push({theme, applied:document.documentElement.dataset.theme === theme,
                  sameBubble:output.querySelector('.chat-bubble-ai') === bubble, content:bubble.textContent === content,
                  busy:document.getElementById('chat-send-btn').disabled, scroll:Math.abs(output.scrollTop - beforeScroll) <= 1});
              }
              return {hasContent:content.length > 0, previousTheme, restored:document.documentElement.dataset.theme === previousTheme, observations};
            });
            assert.equal(themedStream.hasContent, true, 'Theme changes exercise an already rendered streaming reply');
            assert.equal(themedStream.restored, true, 'Streaming theme test restores the original palette');
            assert.deepEqual(themedStream.observations, ['emeraldLight','lavenderLite','pacific','oled',themedStream.previousTheme]
              .map(theme => ({theme,applied:true,sameBubble:true,content:true,busy:true,scroll:true})));
            assert.equal(requests.filter(r => r.path === '/api/ai/chat/stream').length, 1, 'Theme changes during SSE never submit a second inference request');
            checks.push('Actual theme catalog changes through Emerald Light, Lavender, Pacific and OLED during held SSE preserve reply identity, content, busy state and reader scroll; original palette restored without another request');
          }
          layouts.push(await layout(page, 'responding before done'));
          await page.evaluate(() => window.fixtureResponseControl.finish());
          await page.locator('.memory-context-receipt').waitFor({state:'attached'}); await waitIdle(page);
          assert.equal(await responseStatus.isVisible(), false, 'Response indication clears after success');
          checks.push('live Working/Responding states through actual route/send/SSE, reduced motion, and completion cleanup');
          assert.equal(requests.filter(r => r.path === '/api/ai/chat/stream').length, 1, 'One send sends one request');
          if (await page.locator('.chat-answer-details > summary').count()) await page.locator('.chat-answer-details > summary').last().click();
          await page.locator('.memory-context-receipt summary').click();
          assert.match(await page.locator('.memory-context-receipt').textContent(), /Studio backup location.*12 earlier chat messages.*8 earlier messages/s);
          assert.ok(await page.locator('#chat-output .code-block-code').count(), 'Actual enhanced renderer renders code blocks');
          assert.match(await page.locator('#chat-output').textContent(), /Recorded information/, 'Long structured content remains present');
          if (anniversary) {
            assert.equal(await page.locator('#chat-output .ui-chat-table table').count(), 1, 'Shared anniversary renderer produces a semantic table');
            assert.equal(await page.locator('#chat-output .ui-chat-table').getAttribute('aria-label'), 'Answer table');
          }
          layouts.push(await layout(page, 'long reply and receipt'));
          await page.locator('#chat-output').evaluate(el => { el.scrollTop = 0; });
          await page.screenshot({ path: path.join(output, `conversation-${viewport.width}-${theme}.png`), fullPage: true, animations: 'disabled' });
          checks.push('actual Enter/send/SSE/markdown renderer, long code/structured content/receipt, no duplicate request');

          incomplete = true;
          await revealMemory(page);
          await page.locator('#memory-use-saved').uncheck();
          await page.locator('#chat-input').fill('Keep this interrupted draft.'); await page.locator('#chat-send-btn').click(); await waitIdle(page);
          assert.equal(await page.locator('#chat-input').inputValue(), 'Keep this interrupted draft.');
          assert.equal(await page.locator('.memory-context-receipt').count(), 1);
          assert.equal(await responseStatus.isVisible(), false, 'Response indication clears after interrupted response failure');
          assert.equal(requests.filter(r => r.path === '/api/ai/chat/stream').at(-1).body.use_saved_memory, false);
          assert.ok(requests.some(r => r.path === '/api/intelligence/memory/capabilities'), 'Memory opt-out verifies existing backend support');
          await page.locator('#memory-use-saved').check();
          incomplete = false; hold = true;
          await page.locator('#chat-input').fill('Cancel this request.'); await page.locator('#chat-send-btn').click();
          await heldReady;
          await page.waitForFunction(() => !document.getElementById('abort-chat-btn').disabled);
          assert.equal(await responseStatus.isVisible(), true);
          assert.match(await responseStatus.textContent(), /Waiting for a reply…/, 'Response indication is visible while awaiting response headers');
          await page.locator('#abort-chat-btn').click(); await waitIdle(page); release?.(); hold = false;
          assert.equal(await responseStatus.isVisible(), false, 'Response indication clears after cancellation');
          assert.equal(await page.locator('#chat-input').inputValue(), 'Cancel this request.');
          assert.equal(await page.locator('.memory-context-receipt').count(), 1);
          checks.push('interrupted and explicitly aborted requests retain draft without successful receipt or replay');

          await page.locator('#chat-history-btn').click();
          await page.locator('.conversation-search-row').first().waitFor();
          layouts.push(await layout(page, 'history open'));
          await page.screenshot({ path: path.join(output, `history-${viewport.width}-${theme}.png`), fullPage: true, animations: 'disabled' });
          if (viewport.width > 1100 && !premium) {
            await page.locator('#chat-history-close').click();
            await page.locator('#recent-chats-list .recent-chat-btn').first().click();
          } else {
            await page.locator('.conversation-search-row .recent-chat-btn').first().click();
            assert.equal(await page.locator('.chat-companion-column').isVisible(), false);
          }
          await page.waitForFunction(() => document.querySelector('#fixture-status').textContent.startsWith('Resumed:'));
          assert.equal(requests.filter(r => r.path === '/api/ai/chat/stream').length, 3, 'Opening history never sends chat');
          await page.locator('#new-chat-btn').click();
          assert.equal(await page.locator('.memory-context-receipt').count(), 0);
          checks.push('real history browser, recent-chat resume and New Chat without generation');
          const privacyCleanup = await page.evaluate(() => {
            const status = document.getElementById('chat-response-status');
            const lock = window.TLIChatWorkspace.beginResponse();
            window.dispatchEvent(new CustomEvent('tli-session-locked')); lock.responding(); lock.finish();
            const locked = status.hidden;
            window.dispatchEvent(new CustomEvent('tli-session-unlocked'));
            const hiddenPage = window.TLIChatWorkspace.beginResponse();
            window.dispatchEvent(new Event('pagehide')); hiddenPage.responding(); hiddenPage.finish();
            return { locked, pageHidden: status.hidden };
          });
          assert.deepEqual(privacyCleanup, { locked: true, pageHidden: true }, 'Lock/pagehide invalidate stale response handles');
          assert.equal(await page.locator('#chat-input').inputValue(), '');
          assert.equal(await responseStatus.isVisible(), false, 'Response indication remains hidden after locking');
          assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
          results.push({ viewport, theme, result: 'passed', checks, layouts, requests, errors, unexpected });
        } catch (error) {
          release?.();
          await page.screenshot({ path: path.join(output, `failure-${viewport.width}-${theme}.png`), fullPage: true, animations: 'disabled' }).catch(() => {});
          fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ viewport, theme, error: error.stack, errors, unexpected, requests, html: await page.locator('#panel-main').innerHTML().catch(() => '') }, null, 2));
          throw error;
        } finally { await page.close(); }
      }
    }
    const sourceHashes = Object.fromEntries(Object.entries(sourceSnapshot).map(([file, text]) => ['frontend/' + file, crypto.createHash('sha256').update(text).digest('hex')]));
    sourceHashes['scripts/verify_chat_workspace_browser.cjs'] = crypto.createHash('sha256').update(harnessSnapshot).digest('hex');
    const changedDuringRun = Object.entries(sourceHashes).filter(([file, hash]) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') !== hash).map(([file]) => file);
    if (changedDuringRun.length) process.exitCode = 1;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ live_backend_used: false, live_model_used: false, physical_phone_tested: false, mode: premium ? 'premium' : anniversary ? 'anniversary' : 'chat-only', sourceScope, sourceHashes, changedDuringRun, results }, null, 2));
    process.stdout.write(output + '\n');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
