const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/theme-library.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ selected = 'emeraldLight', themes, retained = [] } = {}) {
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.dataset = {}; this.attrs = {}; this.children = []; this.handlers = {}; this.value = ''; this.hidden = false; this.disabled = false; this.textContent = ''; }
    append(...children) { for (const child of children) this.appendChild(child); }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
    dispatchEvent(event) { event.target = this; for (const fn of this.handlers[event.type] || []) fn(event); return true; }
    click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [...(selector === '[data-theme-filter]' && child.dataset.themeFilter ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    get options() { return this.children.flatMap(child => child.tagName === 'OPTION' ? [child] : child.options); }
  }
  const catalog = themes || [
    { id: 'midnight', name: 'Midnight', tone: 'dark', description: 'Deep ink and quiet blue.', collection: 'classic' },
    { id: 'emeraldLight', name: 'Emerald Light', tone: 'light', description: 'Clear daylight and emerald.', collection: 'classic', signature: true },
    { id: 'pacific', name: 'Pacific', tone: 'dark', description: 'Ocean blue.', collection: 'new', signature: true },
    { id: 'porcelainLight', name: 'Porcelain', tone: 'light', description: 'Soft paper.', collection: 'new', signature: true },
  ];
  const nodes = {};
  for (const id of ['tli-theme-library', 'tli-theme-grid', 'tli-theme-current', 'tli-theme-count', 'settings-theme']) { nodes[id] = new Element(id === 'settings-theme' ? 'select' : 'div'); nodes[id].id = id; }
  nodes['tli-theme-library'].hidden = true;
  const filters = {};
  for (const key of ['all', 'light', 'dark']) { const button = new Element('button'); button.type = 'button'; button.dataset.themeFilter = key; filters[key] = button; nodes['tli-theme-library'].append(button); }
  const select = nodes['settings-theme'];
  for (const [id, name] of [['midnight', 'Midnight (default)'], ['emeraldLight', 'Emerald Light'], ...retained]) { const option = new Element('option'); option.value = id; option.textContent = name; select.append(option); }
  select.value = 'midnight'; // The existing HTML default can differ from the applied browser preference.
  const root = new Element('html'); root.setAttribute('data-theme', selected);
  const events = {}, settings = { defaultTheme: selected, searchEnabled: true, defaultTemp: '0.55', unrelated: { keep: true } };
  const writes = [], changes = [];
  let fail = false;
  select.addEventListener('change', () => {
    changes.push(select.value);
    if (fail) { select.value = settings.defaultTheme; return; }
    settings.defaultTheme = select.value;
    writes.push(JSON.stringify(settings));
    root.setAttribute('data-theme', select.value);
    emit('tli-theme-applied', { theme: select.value });
  });
  const ctx = vm.createContext({ document: { readyState: 'complete', getElementById: id => nodes[id] || null, documentElement: root, createElement: tag => new Element(tag) },
    window: { TLIThemes: { themes: catalog }, addEventListener: (type, fn) => (events[type] ||= []).push(fn) },
    Event: class { constructor(type, options) { this.type = type; Object.assign(this, options); } }, queueMicrotask,
    fetch() { throw new Error('Theme browsing must not use the network'); },
    localStorage: { getItem() { throw new Error('The gallery must use existing settings state'); }, setItem() { throw new Error('Only the existing settings handler may save'); } },
  });
  function emit(type, detail) { for (const fn of events[type] || []) fn({ type, detail }); }
  const start = () => vm.runInContext(source, ctx);
  const groups = () => nodes['tli-theme-grid'].children;
  const cards = () => groups().flatMap(group => group.children.find(child => child.className === 'tli-theme-group-grid').children);
  const card = id => cards().find(item => item.dataset.themeChoice === id);
  return { start, nodes, filters, select, root, settings, writes, changes, cards, card, groups, emit, failWrites() { fail = true; } };
}

test('loading the gallery preserves the applied browser theme and all saved preferences without a save or network call', () => {
  const f = fixture(); f.start();
  assert.equal(f.select.value, 'emeraldLight');
  assert.equal(f.nodes['tli-theme-library'].hidden, false);
  assert.equal(f.card('emeraldLight').getAttribute('aria-pressed'), 'true');
  assert.equal(f.card('midnight').getAttribute('aria-pressed'), 'false');
  assert.equal(f.nodes['tli-theme-current'].textContent, 'Current theme: Emerald Light');
  assert.equal(f.writes.length, 0); assert.equal(f.changes.length, 0);
  assert.deepEqual(f.settings, { defaultTheme: 'emeraldLight', searchEnabled: true, defaultTemp: '0.55', unrelated: { keep: true } });
  assert.equal(f.select.options.find(option => option.value === 'midnight').textContent, 'Midnight');
  assert.equal(f.select.options.length, 4);
});

test('one changed card uses exactly one existing change handler, with no duplicate binding or re-save of the current theme', async () => {
  const f = fixture(); f.start(); f.start();
  f.card('pacific').click(); await tick();
  assert.deepEqual(f.changes, ['pacific']); assert.equal(f.writes.length, 1);
  assert.equal(f.settings.defaultTheme, 'pacific'); assert.equal(f.settings.searchEnabled, true);
  assert.equal(f.settings.defaultTemp, '0.55'); assert.deepEqual(f.settings.unrelated, { keep: true });
  assert.equal(f.card('pacific').getAttribute('aria-pressed'), 'true');
  assert.equal(f.card('pacific').type, 'button');
  assert.equal(f.card('pacific').getAttribute('aria-label'), 'Use Pacific theme, dark');
  f.card('pacific').click(); f.card('midnight').dispatchEvent({ type: 'mouseenter' });
  await tick(); assert.equal(f.changes.length, 1); assert.equal(f.writes.length, 1);
});

test('filters change only visible cards, keep selected state and announce counts without applying a theme', () => {
  const f = fixture(); f.start();
  for (const [filter, expected] of [['dark', ['midnight', 'pacific']], ['light', ['emeraldLight', 'porcelainLight']], ['all', ['emeraldLight', 'porcelainLight', 'midnight', 'pacific']]]) {
    f.filters[filter].click();
    assert.deepEqual(f.cards().filter(card => !card.hidden).map(card => card.dataset.themeChoice), expected);
    assert.equal(f.filters[filter].getAttribute('aria-pressed'), 'true');
    assert.match(f.nodes['tli-theme-count'].textContent, new RegExp(`^${expected.length} `));
    assert.equal(f.card('emeraldLight').getAttribute('aria-pressed'), 'true');
  }
  assert.equal(f.writes.length, 0); assert.equal(f.select.value, 'emeraldLight');
});

test('native selection and an externally applied theme synchronize the gallery without a second save', async () => {
  const f = fixture(); f.start();
  f.select.value = 'midnight'; f.select.dispatchEvent({ type: 'change' }); await tick();
  assert.equal(f.card('midnight').getAttribute('aria-pressed'), 'true'); assert.equal(f.writes.length, 1);
  f.root.setAttribute('data-theme', 'porcelainLight'); f.emit('tli-theme-applied', { theme: 'porcelainLight' });
  assert.equal(f.select.value, 'porcelainLight'); assert.equal(f.card('porcelainLight').getAttribute('aria-pressed'), 'true');
  assert.equal(f.writes.length, 1); assert.equal(f.changes.length, 1);
});

test('a rejected save leaves the saved theme selected; disabled selection cannot bypass the existing control', async () => {
  const f = fixture(); f.start(); f.failWrites();
  f.card('pacific').click(); await tick();
  assert.equal(f.settings.defaultTheme, 'emeraldLight'); assert.equal(f.writes.length, 0);
  assert.equal(f.select.value, 'emeraldLight');
  assert.equal(f.card('emeraldLight').getAttribute('aria-pressed'), 'true'); assert.equal(f.card('pacific').getAttribute('aria-pressed'), 'false');
  assert.equal(f.nodes['tli-theme-current'].textContent, 'Current theme: Emerald Light');
  f.select.disabled = true; f.card('midnight').click(); await tick(); assert.deepEqual(f.changes, ['pacific']);
});

test('catalog omissions retain existing identifiers, reject malformed entries, and keep an uncatalogued current theme unchanged', () => {
  const f = fixture({ selected: 'legacyCustom', retained: [['legacyCustom', 'My retained theme']], themes: [
    { id: 'midnight', name: 'Midnight', tone: 'dark', collection: 'classic' },
    { id: 'midnight', name: 'Duplicate', tone: 'dark' },
    { id: 'broken theme', name: 'Broken', tone: 'light' },
    { id: 'missingTone', name: 'Unknown' },
  ] });
  f.select.value = 'legacyCustom'; f.start();
  assert.equal(f.cards().length, 1); assert.equal(f.select.value, 'legacyCustom');
  assert.equal(f.select.options.some(option => option.value === 'legacyCustom'), true);
  assert.equal(f.card('midnight').getAttribute('aria-pressed'), 'false');
  assert.equal(f.nodes['tli-theme-current'].textContent, 'Your current theme is unchanged.');
  f.filters.light.click(); assert.equal(f.cards().every(card => card.hidden), true);
  assert.equal(f.nodes['tli-theme-count'].textContent, '0 light themes'); assert.equal(f.writes.length, 0);
});

function actualCatalog() {
  const context = {window: {}, document: {documentElement: {dataset: {}, style: {}}, body: null, querySelector() {return null;}, addEventListener() {}}, localStorage: {getItem() {return null;}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/theme-catalog.js'), 'utf8'), context);
  return Array.from(context.window.TLIThemes.themes, theme => ({...theme}));
}
const descendants = root => root.children.flatMap(child => [child, ...descendants(child)]);

test('the production gallery opens all 23 themes with nine light and fourteen dark choices', () => {
  const catalog = actualCatalog(), f = fixture({selected: 'midnight', themes: catalog}); f.start();
  assert.equal(f.filters.all.getAttribute('aria-pressed'), 'true'); assert.equal(f.nodes['tli-theme-count'].textContent, '23 themes');
  assert.equal(f.cards().length, 23); assert.equal(f.cards().filter(card => !card.hidden).length, 23); assert.equal(f.select.options.length, 23);
  for (const group of f.groups()) {
    const expected = group.dataset.themeTone === 'light' ? 9 : 14;
    assert.equal(group.hidden, false); assert.equal(group.children[0].children[1].textContent, `${expected} themes`);
    const visible = group.children[1].children.filter(card => !card.hidden);
    assert.equal(visible.length, expected); assert.ok(visible.every(card => catalog.find(theme => theme.id === card.dataset.themeChoice).tone === group.dataset.themeTone));
  }
  assert.equal(f.select.value, 'midnight'); assert.equal(f.card('midnight').hidden, false); assert.equal(f.card('midnight').getAttribute('aria-pressed'), 'true');
  assert.equal(f.nodes['tli-theme-current'].textContent, 'Current theme: Midnight'); assert.equal(f.writes.length, 0);
});

test('all production themes remain available through filters and the native picker in preserved catalog order', async () => {
  const catalog = actualCatalog(), f = fixture({themes: catalog}); f.start();
  assert.deepEqual(f.select.options.map(option => option.value), ['dark','light'].flatMap(tone => catalog.filter(theme => theme.tone === tone).map(theme => theme.id)));
  for (const tone of ['light','dark']) {
    f.filters[tone].click(); assert.equal(f.cards().filter(card => !card.hidden).length, catalog.filter(theme => theme.tone === tone).length);
    assert.equal(f.groups().find(group => group.dataset.themeTone !== tone).hidden, true);
  }
  f.filters.light.click(); f.select.value = 'lavenderMidnight'; f.select.dispatchEvent({type:'change'}); await tick();
  assert.equal(f.writes.length, 1); assert.equal(f.settings.defaultTheme, 'lavenderMidnight'); assert.equal(f.card('lavenderMidnight').getAttribute('aria-pressed'), 'true');
  assert.equal(f.card('lavenderMidnight').hidden, true, 'Selecting a legacy theme does not silently change the chosen gallery filter');
});

test('previews show the conversation workspace and a noninteractive composer using the same theme ID', () => {
  const f = fixture({themes: actualCatalog()}); f.start();
  for (const card of f.cards()) {
    const preview = card.children[0], items = descendants(preview);
    assert.equal(preview.dataset.theme, card.dataset.themeChoice); assert.equal(preview.getAttribute('aria-hidden'), 'true');
    for (const [cls, text] of [['tli-theme-preview-heading','What’s on your mind?'],['tli-theme-preview-body','Ask, imagine, make something.'],['tli-theme-preview-prompt','Ask anything…'],['tli-theme-preview-action','↑']]) assert.equal(items.find(item => item.className === cls).textContent, text);
    assert.equal(items.some(item => ['BUTTON','INPUT','SELECT','A'].includes(item.tagName)), false, 'The whole card is one deliberate theme-selection button');
    assert.equal(items.some(item => item.className === 'tli-theme-preview-line'), false);
  }
  assert.equal(f.changes.length, 0); assert.equal(f.writes.length, 0);
});

test('preview styles consume shared product tokens without introducing another palette or external assets', () => {
  const css = fs.readFileSync(path.join(__dirname, '../theme-library.css'), 'utf8');
  for (const token of ['font-ui','font-heading','heading-weight','heading-tracking','card-radius','control-radius','card-shadow','control-shadow','canvas-image','sidebar-image','header-image']) assert.ok(css.includes(`var(--theme-${token},`), token);
  assert.doesNotMatch(css, /#[a-f0-9]{3,8}\b|url\(|https?:|@import/i); assert.match(css, /prefers-reduced-motion/);
});

test('a card matching the system appearance can deliberately leave System mode', async () => {
  const f = fixture(); f.root.setAttribute('data-appearance-mode', 'system'); f.start();
  assert.equal(f.nodes['tli-theme-current'].textContent, 'Following system: Emerald Light');
  f.card('emeraldLight').click(); await tick();
  assert.deepEqual(f.changes, ['emeraldLight']); assert.equal(f.writes.length, 1);
});

test('the native HTML fallback lists every built-in theme once and uses the retained Lavender identifier', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8'), select = html.match(/<select id="settings-theme"[\s\S]*?<\/select>/)?.[0];
  assert.ok(select); const options = [...select.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)];
  assert.equal(options.length, 23); assert.deepEqual(options.map(option => option[1]).sort(), actualCatalog().map(theme => theme.id).sort());
  assert.equal(options.find(option => option[1] === 'lavenderLite')[2], 'Lavender');
  const section = html.slice(html.indexOf('<section id="tli-theme-library"'), html.indexOf('<!-- ── Chat Preferences'));
  assert.match(section, /data-theme-filter="all" aria-pressed="true"/);
  assert.doesNotMatch(section, /data-theme-filter="(?:signature|new)"/);
});
