const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, '../js/theme-catalog.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../themes.css'), 'utf8');

function load(saved, { body = true, brokenStorage = false, dark = false } = {}) {
  const events = [], handlers = {}, classes = new Set();
  const html = { dataset: {}, style: {} };
  const document = {
    documentElement: html,
    body: body ? { classList: { toggle(name, yes) { yes ? classes.add(name) : classes.delete(name); } } } : null,
    querySelector() { return null; },
    addEventListener(name, fn) { handlers[name] = fn; },
  };
  const media = { matches: dark, addEventListener(name, fn) { assert.equal(name, 'change'); this.change = fn; } };
  const window = { dispatchEvent(e) { events.push(e); }, matchMedia(query) { assert.equal(query, '(prefers-color-scheme: dark)'); return media; } };
  const context = { window, document,
    localStorage: { getItem(key) { assert.equal(key, 'tli_settings'); if (brokenStorage) throw new Error('Denied'); return saved; }, setItem() { assert.fail('Applying appearance must not save preferences'); } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  };
  vm.runInNewContext(code, context);
  return { ...context, api: window.TLIThemes, html, classes, events, handlers, media };
}

test('System follows the OS without ever saving over an explicit colored palette', () => {
  const saved = { defaultTheme: 'lavenderLite', appearanceMode: 'system', searchEnabled: true };
  const r = load(JSON.stringify(saved), { dark: true, body: false });
  assert.equal(r.html.dataset.theme, 'midnight'); assert.equal(r.html.dataset.appearanceMode, 'system');
  r.handlers.DOMContentLoaded();
  r.media.matches = false; r.media.change();
  assert.equal(r.html.dataset.theme, 'emeraldLight'); assert.equal(r.html.dataset.appearanceMode, 'system');
  assert.equal(r.events.length, 1);
  r.api.applyPreference({ ...saved, appearanceMode: 'theme' });
  assert.equal(r.html.dataset.theme, 'lavenderLite');
  r.media.matches = true; r.media.change();
  assert.equal(r.html.dataset.theme, 'lavenderLite'); assert.equal(r.events.length, 2);
});

test('an explicit theme selection exits active System appearance and survives DOM readiness', () => {
  const r = load('{"defaultTheme":"copper","appearanceMode":"system"}', { dark: false, body: false });
  r.api.apply('pacific'); r.handlers.DOMContentLoaded();
  r.media.matches = true; r.media.change();
  assert.equal(r.html.dataset.theme, 'pacific'); assert.equal(r.html.dataset.appearanceMode, 'theme');
  assert.equal(r.events.length, 1);
});

test('every historical saved theme and legacy alias reopens without a write', () => {
  const oldIds = ['midnight','dusk','oled','neon','lavenderMidnight','violetNeon','purpleTerminal','blueTerminal','ultraLavenderOLED','horizon','terminal','emeraldLight','emeraldLite','cloudLight','sandLight','lavenderLite'];
  for (const id of oldIds) {
    const r = load(JSON.stringify({ defaultTheme: id, teachingOn: true }));
    assert.equal(r.html.dataset.theme, id);
    assert.equal(r.events.length, 0);
  }
  assert.equal(load('{"defaultTheme":"cloud"}').html.dataset.theme, 'cloudLight');
  assert.equal(load('{"defaultTheme":"emeraldDark"}').html.dataset.theme, 'midnight');
});

test('missing, malformed, unknown and inaccessible preferences have a readable default', () => {
  for (const saved of [null, 'invalid JSON', 'null', '{"defaultTheme":"not-installed"}', '{"defaultTheme":"__proto__"}']) {
    assert.equal(load(saved).html.dataset.theme, 'emeraldLight');
  }
  assert.equal(load(null, { brokenStorage: true }).html.dataset.themeTone, 'light');
});

test('declared tone drives new theme controls rather than theme-name spelling', () => {
  const r = load('{}');
  for (const id of ['arctic', 'roseQuartz', 'porcelainLight']) {
    r.api.apply(id);
    assert.equal(r.html.dataset.themeTone, 'light');
    assert.equal(r.html.style.colorScheme, 'light');
    assert.equal(r.classes.has('theme-dark'), false);
  }
  r.api.apply('pacific');
  assert.equal(r.classes.has('theme-dark'), true);
  assert.equal(r.events.at(-1).type, 'tli-theme-applied');
  assert.equal(r.events.at(-1).detail.theme, 'pacific');
});

test('early appearance works without a body and does not undo a later selection', () => {
  const r = load('{"defaultTheme":"midnight"}', { body: false });
  r.api.apply('arctic');
  r.document.body = { classList: { toggle(_name, yes) { assert.equal(yes, false); } } };
  r.handlers.DOMContentLoaded();
  assert.equal(r.html.dataset.theme, 'arctic');
  assert.equal(r.events.length, 1);
});

test('the original native picker can apply a saved choice if the catalog fails to load', () => {
  const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function applyTheme(theme)'), app.indexOf('// ---------- version + About modal'));
  const attrs = {}, classes = new Set();
  const root = { setAttribute(k,v) { attrs[k]=v; }, style: { removeProperty(key) { assert.equal(key, 'color-scheme'); } } };
  const ctx = { window: {}, DEFAULT_THEME: 'emeraldLight', document: { documentElement: root, body: { classList: { toggle(k,on) { on ? classes.add(k) : classes.delete(k); } } } },
    getComputedStyle() { return { colorScheme: attrs['data-theme']==='midnight' ? 'dark' : 'light' }; } };
  vm.createContext(ctx); vm.runInContext(fn,ctx);
  ctx.applyTheme('midnight');
  assert.equal(attrs['data-theme'], 'midnight');
  assert.equal(attrs['data-theme-tone'], 'dark');
  assert.equal(classes.has('theme-dark'), true);
  ctx.applyTheme('roseQuartz');
  assert.equal(attrs['data-theme'], 'roseQuartz');
  assert.equal(attrs['data-theme-tone'], 'light');
  assert.equal(classes.has('theme-dark'), false);
});

function luminance(hex) {
  const c = hex.slice(1).match(/../g).map(v => parseInt(v,16)/255).map(v => v <= .04045 ? v / 12.92 : ((v+.055)/1.055)**2.4);
  return c[0]*.2126+c[1]*.7152+c[2]*.0722;
}
function contrast(a,b) { const x=luminance(a), y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); }
test('complete palettes keep text, status and primary buttons readable on their surfaces', () => {
  const themes = load('{}').api.themes;
  assert.equal(themes.filter(t => t.collection === 'new').length, 6);
  for (const theme of themes) {
    const block = css.match(new RegExp(`:root\\[data-theme="${theme.id}"\\], \\.tli-theme-preview\\[data-theme="${theme.id}"\\] \\{([^}]+)\\}`));
    assert.ok(block, `One shared palette for ${theme.id}`);
    const tokens = Object.fromEntries([...block[1].matchAll(/--([\w-]+):([^;]+);/g)].map(m=>[m[1],m[2].trim()]));
    for (const surface of ['bg-main','bg-panel','bg-elevated','bg-elevated-alt','bg-sidebar','bg-header']) {
      for (const text of ['text-main','text-muted','text-soft','accent','success','danger','warning','info']) {
        const ratio=contrast(tokens[text],tokens[surface]);
        assert.ok(ratio>=4.5, `${theme.id} ${text} on ${surface}: ${ratio.toFixed(2)}`);
      }
    }
    for (const surface of ['accent','accent-strong']) assert.ok(contrast(tokens['on-accent'],tokens[surface])>=4.5, `${theme.id} button on ${surface}`);
    assert.ok(contrast(tokens['accent'],tokens['accent-soft'])>=4.5, `${theme.id} accent on selected surface`);
  }
});

test('the eight signature themes are additive metadata, retaining every identifier, order and collection', () => {
  const r = load('{}'), ids = ['emeraldLight','midnight','classicTli','porcelainLight','pacific','copper','roseQuartz','arctic','graphite','emeraldLite','cloudLight','sandLight','lavenderLite','dusk','oled','neon','lavenderMidnight','violetNeon','purpleTerminal','blueTerminal','ultraLavenderOLED','horizon','terminal'];
  assert.deepEqual(Array.from(r.api.themes, theme => theme.id), ids);
  assert.ok(r.api.themes.every(theme => typeof theme.signature === 'boolean' && Object.isFrozen(theme)));
  assert.deepEqual(Array.from(r.api.themes.filter(theme => theme.signature), theme => theme.id).sort(), ['emeraldLight','lavenderLite','porcelainLight','roseQuartz','pacific','copper','graphite','terminal'].sort());
  assert.equal(r.api.themes.filter(theme => theme.signature && theme.tone === 'light').length, 4);
  assert.equal(r.api.themes.filter(theme => theme.signature && theme.tone === 'dark').length, 4);
  assert.deepEqual(Array.from(r.api.themes.filter(theme => theme.collection === 'new'), theme => theme.id), ['porcelainLight','pacific','copper','roseQuartz','arctic','graphite']);
  assert.equal(r.api.resolve('classicTli').collection, 'anniversary'); assert.equal(r.api.resolve('emeraldLight').collection, 'classic');
  assert.equal(r.html.dataset.theme, 'emeraldLight'); assert.equal(r.events.length, 0);
});

test('Lavender keeps its saved identifier and historical aliases retain their original destinations', () => {
  const r = load('{"defaultTheme":"lavenderLite","defaultTemp":0.4}');
  assert.equal(r.html.dataset.theme, 'lavenderLite'); assert.equal(r.api.resolve('lavenderLite').name, 'Lavender');
  assert.equal(r.api.resolve('cloud').id, 'cloudLight'); assert.equal(r.api.resolve('emeraldDark').id, 'midnight');
  assert.equal(r.api.resolve('cloud').signature, false); assert.equal(r.api.resolve('emeraldDark').signature, false);
  assert.equal(r.events.length, 0);
});

test('signature chrome preserves semantic text contrast at every gradient extreme', () => {
  for (const theme of load('{}').api.themes.filter(t => t.signature)) {
    const blocks = [...css.matchAll(new RegExp(`:root\\[data-theme="${theme.id}"\\], \\.tli-theme-preview\\[data-theme="${theme.id}"\\] \\{([^}]+)\\}`, 'g'))];
    const tokens = Object.assign({}, ...blocks.map(m => Object.fromEntries([...m[1].matchAll(/--([\w-]+):([^;]+);/g)].map(v => [v[1], v[2].trim()]))));
    const surfaces = ['theme-canvas-image','theme-sidebar-image','theme-header-image'].flatMap(key => tokens[key].match(/#[0-9a-f]{6}/g) || []);
    // Both perpendicular grid lines may overlap. Bound their maximum combined
    // alpha over Terminal's canvas; the rest of the interface has solid panels.
    if (theme.id === 'terminal') {
      const a = 1 - (1 - .025) ** 2, base = tokens['bg-main'].slice(1).match(/../g).map(v => parseInt(v,16));
      surfaces.push('#' + base.map((v,i) => Math.round(v * (1-a) + [120,221,140][i] * a).toString(16).padStart(2,'0')).join(''));
    }
    for (const bg of surfaces) for (const foreground of ['text-main','text-muted','text-soft','accent','success','warning','danger','info']) {
      assert.ok(contrast(tokens[foreground],bg) >= 4.5, `${theme.id}: ${foreground} on chrome ${bg}`);
    }
  }
});
