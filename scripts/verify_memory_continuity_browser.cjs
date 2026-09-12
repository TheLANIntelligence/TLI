/* Isolated browser acceptance: all URLs intercepted; no server or model starts. */
const { chromium } = require('playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build_work', 'memory-chat-browser-' + new Date().toISOString().replace(/[:.]/g, '-'));
const read = file => fs.readFileSync(path.join(root, 'frontend', file), 'utf8');
const app = read('app.js'), shell = read('index.html');
const panelStart = shell.indexOf('<section class="panel-container active" id="panel-main">');
assert.ok(panelStart >= 0);
const panel = shell.slice(panelStart, shell.indexOf('</section>', panelStart) + 10);
const extract = (first, last) => app.slice(app.indexOf(first), app.indexOf(last, app.indexOf(first)));
const fixture = `
const $=id=>document.getElementById(id);
if(!$('mode-select')){const mode=document.createElement('select');mode.id='mode-select';mode.hidden=true;mode.append(new Option('Default','default'));document.body.append(mode);}
let _chatImageB64=null,_chatImageMime=null,_chatImageReadVersion=0,_chatImageReading=false,lastSendTs=0,inFlightController=null,currentDeviceId='fixture-browser',_currentPanelId='panel-main';
let chatHistory=[];const CHAT_HISTORY_DRAFT_ID='__draft__';
const AIStatus={local:{},lan:{available:false}},IntelligenceSource={LAN_LLM:'lan',NONE:'none'};
window.TLIIntelligence={getContext:()=>({}),showMeta:()=>{}};window.fixtureBrain='bundled';
const readSettings=()=>({defaultBrain:window.fixtureBrain}),isTeachingMode=()=>false,tliSearchIsEnabled=()=>false;
const resolveIntelligenceRoute=async()=>({source:'local'}),tliFetchBundledStatus=async()=>({ok:true});
const showToast=text=>{$('fixture-status').textContent=text;};
const setModelStatus=()=>{},debugLog=()=>{},_attachSpeakBtn=()=>{},tliSpeak=()=>{},saveConversation=()=>{},addPreviousPrompt=()=>{};
const chatHistoryAdd=(role,content)=>chatHistory.push({role,content}),resetChatHistory=()=>{chatHistory=[];};
const formatModelOutput=text=>text,renderAssistantHTML=text=>{const d=document.createElement('div');d.textContent=text;return d.innerHTML;};
const appendMessage=(role,text)=>{const b=document.createElement('div');b.className='chat-bubble';b.dataset.role=role;b.textContent=text||'';$('chat-output').append(b);return b;};
const clearChatWithPlaceholder=text=>{$('chat-output').replaceChildren();$('fixture-status').textContent=text;};
${extract('let currentConversationId = null;', 'let meshDirectoryCache')}
${extract('async function tliBundledChatStream(', 'function clearChatWithPlaceholder')}
${extract('async function sendChat()', '// Shelly Chat Helpers')}
$('chat-send-btn').addEventListener('click',sendChat);$('abort-chat-btn').addEventListener('click',()=>inFlightController?.abort());
`;
const revision = 'a'.repeat(64), source = { conversation_id: 'fixture-conversation', message_index: 1, revision };
const note = { id: 'f-fixture', title: 'Studio backup location', text: 'Use the spare drive kept in the studio drawer.', revision, source: 'user_memory', category: 'general', updated_at: '2026-09-07T12:00:00Z', device_id: null };
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); const results = [];
  try {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport }); const errors = [], requests = []; let fail = false, expired = false;
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url()), json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (url.origin !== 'http://tli-memory.test') return route.abort();
        const assets = { '/style.css': 'style.css', '/memory-continuity.css': 'memory-continuity.css', '/js/memory-continuity.js': 'js/memory-continuity.js' };
        if (assets[url.pathname]) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript', body: read(assets[url.pathname]) });
        if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'application/javascript', body: fixture });
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/memory-continuity.css"></head><body data-theme="emeraldLight"><main style="padding:16px;max-width:1100px;margin:auto"><p id="fixture-status" role="status"></p>' + panel + '</main><script src="/fixture.js"></script><script src="/js/memory-continuity.js"></script></body></html>' });
        if (url.pathname.endsWith('/memory/capabilities')) { requests.push({ kind: 'capability' }); return json(expired ? { detail: 'Session expired' } : { ok: true, protocol: 'tli-memory-continuity-v1' }, expired ? 401 : 200); }
        if (url.pathname === '/chat' || url.pathname === '/api/ai/chat/stream') {
          const body = route.request().postDataJSON(); requests.push({ kind: 'generation', endpoint: url.pathname, body });
          const metadata = { session_id: source.conversation_id, conversation_id: source.conversation_id, source_ref: source, user_source_ref: { ...source, message_index: 0 },
            memory_context: { use_saved_memory: body.use_saved_memory, status: body.use_saved_memory ? 'included' : 'disabled', notes: body.use_saved_memory ? [{ ...note, text: undefined }] : [], omitted_for_budget: 0 },
            conversation_context: { status: 'limited', included_messages: 12, included_exchanges: 6, omitted_messages: 8, character_budget: 12000 } };
          if (url.pathname === '/chat') return json({ ...metadata, reply: 'The saved note points to the studio drawer.' });
          const frames = [{ type: 'meta', session_id: source.conversation_id }, { type: 'delta', text: 'The saved note points to the studio drawer.' }];
          if (!fail) frames.push({ type: 'meta', ...metadata }, { type: 'done' });
          return route.fulfill({ contentType: 'text/event-stream', body: frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') });
        }
        return json({ detail: 'No fixture endpoint' }, 404);
      });
      await page.goto('http://tli-memory.test/');
      await page.locator('#chat-input').fill('Where is the studio backup?'); await page.locator('#chat-send-btn').click();
      await page.locator('.memory-context-receipt').waitFor({ timeout: 5000 }).catch(async error => {
        console.error(JSON.stringify({ errors, requests, chat: await page.locator('#chat-output').innerText() })); throw error;
      });
      await page.locator('.memory-context-receipt summary').click();
      assert.match(await page.locator('.memory-context-receipt').textContent(), /Studio backup location.*12 earlier chat messages.*8 earlier messages/s);
      assert.equal(await page.getByRole('button', { name: 'Save to Notebook…' }).count(), 2);
      await page.screenshot({ path: path.join(output, `context-${viewport.width}.png`), fullPage: true });
      await page.locator('#memory-use-saved').uncheck();
      await page.locator('#chat-input').fill('Explain without saved memory.'); await page.locator('#chat-send-btn').click();
      await page.waitForFunction(() => document.querySelectorAll('.memory-context-receipt').length === 2);
      assert.match(await page.locator('.memory-context-receipt').last().textContent(), /retrieval was off/);
      fail = true;
      await page.locator('#chat-input').fill('Keep this draft if interrupted.'); await page.locator('#chat-send-btn').click();
      await page.waitForFunction(() => document.getElementById('chat-input').value === 'Keep this draft if interrupted.');
      assert.equal(await page.locator('.memory-context-receipt').count(), 2);
      fail = false; await page.evaluate(() => { window.fixtureBrain = 'lmstudio'; });
      await page.locator('#chat-input').fill('Continue using LM Studio.'); await page.locator('#chat-send-btn').click();
      await page.waitForFunction(() => document.querySelectorAll('.memory-context-receipt').length === 3);
      assert.equal(requests.filter(r => r.kind === 'generation').at(-1).endpoint, '/chat');
      const before = requests.filter(r => r.kind === 'generation').length; expired = true;
      await page.locator('#chat-input').fill('Expired session must not send.'); await page.locator('#chat-send-btn').click();
      await page.waitForFunction(() => !document.getElementById('chat-send-btn').disabled && document.getElementById('chat-input').value === '');
      assert.equal(requests.filter(r => r.kind === 'generation').length, before);
      assert.equal(await page.locator('.memory-context-receipt').count(), 0);
      assert.deepEqual(errors, []);
      results.push({ viewport, result: 'passed', checks: ['actual SSE/JSON adapters', 'merged final receipts', 'user and assistant save controls', 'fresh opt-out handshake', 'interrupted draft/no receipt', 'LM routing', 'expired session cleanup/no generation'], requests: requests.map(r => ({ kind: r.kind, endpoint: r.endpoint, use_saved_memory: r.body?.use_saved_memory })), errors });
      await page.close();
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ live_backend_used: false, results }, null, 2));
    process.stdout.write(output + '\n');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
