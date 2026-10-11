/* Disposable desktop document QA. NODE_PATH must expose Playwright.
 * Every URL is intercepted; no backend, model or household files are used.
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts', 'desktop-workflows', 'documents-' + new Date().toISOString().replace(/[:.]/g, '-'));
const read = file => fs.readFileSync(path.join(root, 'frontend', file), 'utf8');
const shell = read('index.html'), app = read('app.js');
const chatStart = shell.indexOf('<section class="panel-container active" id="panel-main">');
assert.ok(chatStart >= 0);
const chat = shell.slice(chatStart, shell.indexOf('</section>', chatStart) + '</section>'.length);
const send = app.slice(app.indexOf('async function sendChat()'), app.indexOf('// Shelly Chat Helpers', app.indexOf('async function sendChat()')));
const stream = app.slice(app.indexOf('async function tliBundledChatStream('), app.indexOf('function clearChatWithPlaceholder', app.indexOf('async function tliBundledChatStream(')));
const fixture = `
const $=id=>document.getElementById(id);
const mode=document.createElement('select');mode.id='mode-select';mode.hidden=true;mode.append(new Option('Default','default'));document.body.append(mode);
let _chatImageB64=null,_chatImageMime=null,_chatImageReadVersion=0,_chatImageReading=false,lastSendTs=0,inFlightController=null,currentConversationId=null,currentDeviceId='fixture-browser',_currentPanelId='panel-main';
const AIStatus={local:{},lan:{available:false}},IntelligenceSource={LAN_LLM:'lan',NONE:'none'};
window.TLIIntelligence={getContext:()=>({}),showMeta:()=>{}};
const readSettings=()=>({defaultBrain:'bundled'}),isTeachingMode=()=>false,tliSearchIsEnabled=()=>true,tliShouldGateForSearch=()=>{throw Error('Unexpected search');};
const resolveIntelligenceRoute=async()=>({source:'local'}),tliFetchBundledStatus=async()=>({ok:true});
const showToast=(text)=>{document.getElementById('fixture-status').textContent=text;};
const setModelStatus=()=>{},debugLog=()=>{},_attachSpeakBtn=()=>{},chatHistoryAdd=()=>{},tliSpeak=()=>{},saveConversation=()=>{},addPreviousPrompt=()=>{};
const buildContextWrappedMessage=({latestUserMessage})=>latestUserMessage;
const renderAssistantHTML=text=>{const d=document.createElement('div');d.textContent=text;return d.innerHTML;};
const appendMessage=(role,text)=>{const b=document.createElement('div');b.className='chat-bubble';b.textContent=text||'';document.getElementById('chat-output').append(b);return b;};
${stream}\n${send}
document.getElementById('chat-send-btn').addEventListener('click',sendChat);
document.getElementById('abort-chat-btn').addEventListener('click',()=>inFlightController?.abort());
`;
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const results = [];
  try {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      const errors = [], requests = []; let failed = false;
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://tli-desktop.test') return route.abort();
        const allowed = { '/style.css': 'style.css', '/document-context.css': 'document-context.css', '/js/document-context.js': 'js/document-context.js' };
        if (allowed[url.pathname]) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript', body: read(allowed[url.pathname]) });
        if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'application/javascript', body: fixture });
        if (url.pathname === '/api/ai/documents/capabilities') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, protocol: 'tli-document-questions-v1' }) });
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/document-context.css"></head><body><main style="padding:16px;max-width:1100px;margin:auto"><p id="fixture-status" role="status"></p>' + chat + '</main><script src="/js/document-context.js"></script><script src="/fixture.js"></script></body></html>' });
        if (url.pathname === '/api/ai/chat/stream') {
          const body = route.request().postDataJSON(); requests.push(body);
          const metadata = { documents: body.documents.map(d => ({ name: d.name, sha256: createHash('sha256').update(d.text).digest('hex'), chars: [...d.text].length, line_count: d.text.split('\n').length })), actions_performed: false };
          const frames = [{ type: 'meta', provider: 'bundled', model: 'Fixture only' }, { type: 'delta', text: 'The setup file says to keep the spare SSD in the studio drawer. [setup.md:L2-L2]' }];
          if (!failed) frames.push({ type: 'meta', document_context: metadata }, { type: 'done' });
          return route.fulfill({ contentType: 'text/event-stream', body: frames.map(f => 'data: ' + JSON.stringify(f) + '\n\n').join('') });
        }
        return route.fulfill({ status: 404, body: 'Fixture has no such endpoint' });
      });
      await page.goto('http://tli-desktop.test/');
      await page.locator('#documents-open').click();
      await page.locator('#documents-input').setInputFiles({ name: 'setup.md', mimeType: 'text/markdown', buffer: Buffer.from('# Studio setup\nThe spare SSD is in the studio drawer.\n<fixture-tag> is plain text.') });
      await page.getByText('Preview setup.md', { exact: true }).click();
      await page.locator('#documents-use:not([disabled])').waitFor();
      assert.equal(requests.length, 0);
      assert.equal(await page.locator('fixture-tag').count(), 0);
      const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth > innerWidth, dialog: document.querySelector('#documents-dialog').scrollWidth > document.querySelector('#documents-dialog').clientWidth + 1 }));
      assert.equal(overflow.dialog, false);
      await page.screenshot({ path: path.join(output, viewport.width + '-review.png'), fullPage: true, animations: 'disabled' });
      await page.getByRole('button', { name: 'Use in chat', exact: true }).click();
      await page.locator('#chat-input').fill('Where is the spare SSD?');
      failed = true; await page.locator('#chat-send-btn').click();
      try { await page.getByText(/Request failed:.*response was interrupted/).waitFor({ timeout: 5000 }); }
      catch (error) { console.error(JSON.stringify({ errors, requests: requests.length, chat: await page.locator('#chat-output').innerText(), notice: await page.locator('#fixture-status').innerText() })); throw error; }
      assert.equal(await page.locator('#chat-input').inputValue(), 'Where is the spare SSD?');
      assert.equal(await page.locator('#documents-selected').isVisible(), true);
      assert.equal(requests.length, 1);
      failed = false; await page.locator('#chat-send-btn').click();
      await page.getByText('Documents provided to AI', { exact: true }).waitFor();
      assert.equal(await page.locator('#documents-selected').isVisible(), false);
      assert.equal(requests.length, 2);
      await page.screenshot({ path: path.join(output, viewport.width + '-receipt.png'), fullPage: true, animations: 'disabled' });
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'emeraldLight'));
      await page.screenshot({ path: path.join(output, viewport.width + '-receipt-light.png'), fullPage: true, animations: 'disabled' });
      await page.locator('#documents-open').click();
      await page.keyboard.press('Escape'); assert.equal(await page.locator('#documents-dialog').isVisible(), false);
      assert.deepEqual(errors, []);
      results.push({ viewport, status: 'passed', checks: ['local review', 'inert text', 'dialog containment', 'failed SSE retains selection and question', 'explicit retry', 'confirmed receipt', 'Escape cancel'], pageOverflow: overflow.page });
      await page.close();
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ source: 'current working tree', fixture: 'intercepted URLs, synthetic text and provider only', results }, null, 2));
  console.log(JSON.stringify({ output, results }, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
