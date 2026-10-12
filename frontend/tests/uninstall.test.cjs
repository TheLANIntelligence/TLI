const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/uninstall.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const details = {platform:'Windows', installation_path:'C:\\Apps\\TLI', supported:true, entrypoint:'C:\\Apps\\TLI\\Uninstall_TLI.bat', registered:true};
const text = el => [el.textContent, ...el.children.map(text)].join(' ');
function fixture(handler = async () => details) {
  const nodes = {}, calls = [], events = {}, navigations = [], opened = [];
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.dataset = {}; this.attrs = {}; this.events = {}; this.children = []; this.textContent = ''; this.hidden = false; this.disabled = false; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(k, v) { this.attrs[k] = v; }
    addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
    click() { return this.disabled ? Promise.resolve() : Promise.all((this.events.click || []).map(fn => fn())); }
    scrollIntoView() { this.scrolled = true; }
    querySelector() { return null; }
  }
  for (const match of html.matchAll(/<[^>]+\bid="(tli-uninstall-[^"]+)"[^>]*>/g)) {
    const el = new Element(); el.hidden = /\shidden(?:\s|>)/.test(match[0]); nodes[match[1]] = el;
  }
  nodes['vault-backups'] = new Element('details');
  const window = {addEventListener:(name, fn) => (events[name] ||= []).push(fn), switchPanel:id => navigations.push(id), TLISettingsWorkspace:{open:(...args) => opened.push(args)}};
  const context = vm.createContext({window, document:{readyState:'complete', getElementById:id => nodes[id] || null, createElement:tag => new Element(tag)}, AbortController, setTimeout, clearTimeout,
    fetch:async (url, options) => { calls.push({url, options}); const value = await handler(); return value && typeof value.json === 'function' ? value : {ok:true, json:async () => value}; }});
  vm.runInContext(source, context);
  return {nodes, calls, navigations, opened, show:() => nodes['tli-uninstall-show'].click(), async emit(name) { for (const fn of events[name] || []) await fn(); }};
}

test('removal guidance is explicit read-only host guidance with actual registered and portable entry points', async () => {
  for (const registered of [true, false]) {
    const f = fixture(async () => ({...details, registered}));
    assert.equal(f.calls.length, 0); assert.equal(f.nodes['tli-uninstall-guide'].hidden, true);
    await f.show();
    assert.deepEqual(f.calls.map(call => [call.url, call.options.method]), [['/system/uninstall', 'GET']]);
    assert.equal(f.calls[0].options.credentials, 'same-origin'); assert.equal(f.calls[0].options.redirect, 'error');
    const rendered = text(f.nodes['tli-uninstall-guide']);
    assert.match(rendered, /On the computer hosting TLI/); assert.match(rendered, /C:\\Apps\\TLI\\Uninstall_TLI.bat/);
    assert.match(rendered, /keep all files.*retaining the installation.*permanently delete/s);
    assert.match(rendered, /External files.*models stored elsewhere.*Python/s);
    if (registered) assert.match(rendered, /Installed apps.*matching this installation folder/s);
    else { assert.match(rendered, /File Explorer.*double-click Uninstall_TLI.bat/); assert.doesNotMatch(rendered, /Start → TLI/); }
    assert.equal(f.nodes['tli-uninstall-show'].attrs['aria-expanded'], 'true');
  }
});

test('manual guidance never invents an available Windows uninstaller for unsupported copies', async () => {
  for (const platform of ['Windows', 'Darwin', 'Linux']) {
    const f = fixture(async () => ({...details, platform, supported:false, registered:false, entrypoint:null, reason:'Source checkout.'}));
    await f.show(); const rendered = text(f.nodes['tli-uninstall-guide']);
    assert.match(rendered, /Automatic removal is unavailable.*Source checkout/s);
    assert.match(rendered, /Remove its files manually.*preserve any work/s);
    assert.doesNotMatch(rendered, /Installed apps|double-click Uninstall_TLI.bat/);
  }
});

test('a failed refresh clears stale installation instructions and permits retry', async () => {
  let count = 0;
  const f = fixture(async () => ++count === 1 ? details : {ok:false, json:async () => ({})});
  await f.show(); assert.equal(f.nodes['tli-uninstall-guide'].hidden, false);
  await f.show(); assert.equal(f.nodes['tli-uninstall-guide'].hidden, true);
  assert.equal(text(f.nodes['tli-uninstall-guide']).includes('C:\\Apps'), false);
  assert.match(f.nodes['tli-uninstall-status'].textContent, /could not be loaded/);
  assert.equal(f.nodes['tli-uninstall-show'].disabled, false);
});

test('lock invalidates and aborts an in-flight path read without revealing its late result', async () => {
  let release;
  const f = fixture(() => new Promise(resolve => { release = resolve; }));
  const request = f.show(); await f.emit('tli-session-locked'); release(details); await request;
  assert.equal(f.calls[0].options.signal.aborted, true);
  assert.equal(f.nodes['tli-uninstall-guide'].hidden, true);
  assert.equal(f.nodes['tli-uninstall-guide'].children.length, 0);
  await f.show(); assert.equal(f.calls.length, 1);
  await f.emit('tli-session-unlocked'); assert.equal(f.nodes['tli-uninstall-show'].disabled, false);
  assert.equal(f.calls.length, 1);
});

test('backup entry points navigate to the existing scoped workflows without starting exports', async () => {
  const f = fixture(); await f.nodes['tli-uninstall-saved-work'].click(); await f.nodes['tli-uninstall-vault'].click();
  assert.deepEqual(f.opened, [['data', 'data-recovery-settings']]); assert.deepEqual(f.navigations, ['panel-vault']);
  assert.equal(f.nodes['vault-backups'].open, true); assert.equal(f.calls.length, 0);
  assert.match(html, /Each backup covers the current account/);
});

test('installation paths and host reasons render as text instead of HTML', async () => {
  const f = fixture(async () => ({...details, supported:false, installation_path:'<img src=x onerror=alert(1)>', reason:'<script>bad()</script>'}));
  await f.show(); const guide = f.nodes['tli-uninstall-guide'];
  assert.match(text(guide), /<img src=x onerror=alert\(1\)>/);
  function hasMarkup(el) { return ['IMG', 'SCRIPT'].includes(el.tagName) || el.children.some(hasMarkup); }
  assert.equal(hasMarkup(guide), false);
});
