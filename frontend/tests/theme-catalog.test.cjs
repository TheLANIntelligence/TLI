const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, '../js/theme-catalog.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../themes.css'), 'utf8');

function load(saved, { body = true, brokenStorage = false } = {}) {
  const events = [], handlers = {}, classes = new Set();
  const html = { dataset: {}, style: {} };
  const document = {
    documentElement: html,
    body: body ? { classList: { toggle(name, yes) { yes ? classes.add(name) : classes.delete(name); } } } : null,
    querySelector() { return null; },
    addEventListener(name, fn) { handlers[name] = fn; },
  };
  const window = { dispatchEvent(e) { events.push(e); } };
  const context = { window, document,
    localStorage: { getItem(key) { assert.equal(key, 'tli_settings'); if (brokenStorage) throw new Error('Denied'); return saved; }, setItem() { assert.fail('Applying appearance must not save preferences'); } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  };
  vm.runInNewContext(code, context);
  return { ...context, api: window.TLIThemes, html, classes, events, handlers };
}

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
