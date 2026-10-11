import test from 'node:test';
import assert from 'node:assert/strict';
import { PALETTES, paletteById, mixColors } from '../src/theme';
import { createAppearanceStore, DEFAULT_APPEARANCE, effectiveTheme, migrateAppearance, parseAppearance, type AppearancePreference } from '../src/appearance-model';

const luminance = (hex: string) => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255)
  .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

test('all 23 companion palettes retain desktop IDs, light/dark counts and true black OLED canvases', () => {
  assert.equal(PALETTES.length, 23);
  assert.equal(new Set(PALETTES.map(palette => palette.id)).size, 23);
  assert.equal(PALETTES.filter(palette => !palette.dark).length, 9);
  assert.equal(PALETTES.filter(palette => palette.dark).length, 14);
  assert.equal(paletteById('cloud').id, 'cloudLight');
  assert.equal(paletteById('emeraldDark').id, 'midnight');
  assert.equal(paletteById('unknown').id, 'emeraldLight');
  for (const id of ['oled', 'ultraLavenderOLED']) {
    assert.equal(paletteById(id).background, '#000000');
    assert.equal(paletteById(id).nav, '#000000');
  }
});

test('native reading, hero, navigation and button colors meet AA contrast in every palette', () => {
  for (const p of PALETTES) for (const [ink, surface, label] of [
    [p.text, p.background, 'canvas'], [p.text, p.card, 'card'], [p.muted, p.card, 'secondary reading'],
    [p.heroText, p.hero, 'hero'], [p.heroMuted, p.hero, 'hero detail'], [p.navText, p.nav, 'navigation'],
    [p.navMuted, p.nav, 'inactive navigation'], [p.glow, p.navSelected, 'selected navigation'],
    [p.contrast, p.accent, 'primary button'], [p.accent, p.soft, 'secondary button'], [p.danger, p.dangerSoft, 'error notice'],
    [p.hero, p.glow, 'hero primary button'], [p.heroText, mixColors(p.glow, p.hero, 0.12), 'hero secondary button'],
    [p.heroWarning, p.hero, 'hero warning'], [p.heroDanger, p.hero, 'hero danger'],
    [p.heroSuccess, p.hero, 'hero success'], [p.heroInfo, p.hero, 'hero information'],
  ] as const) assert.ok(contrast(ink, surface) >= 4.5, `${p.id} ${label}: ${contrast(ink, surface).toFixed(2)}`);
});

test('new installations default to Emerald Light while existing phone appearance migrates', () => {
  assert.deepEqual(migrateAppearance(false, 'system'), DEFAULT_APPEARANCE);
  assert.deepEqual(migrateAppearance(true, 'light'), DEFAULT_APPEARANCE);
  assert.equal(migrateAppearance(true, 'dark').palette, 'midnight');
  assert.equal(migrateAppearance(true, 'system').mode, 'system');
  assert.equal(migrateAppearance(true, undefined).palette, 'emeraldLight');
});

test('System follows light/dark without overwriting the explicitly saved palette', () => {
  const preference: AppearancePreference = { version: 1, mode: 'system', palette: 'lavenderLite' };
  assert.equal(effectiveTheme(preference, false).id, 'emeraldLight');
  assert.equal(effectiveTheme(preference, true).id, 'midnight');
  assert.equal(preference.palette, 'lavenderLite');
  assert.equal(effectiveTheme({ ...preference, mode: 'palette' }, true).id, 'lavenderLite');
});

test('local selection survives reload and later server pairing/preferences cannot replace it', async () => {
  let raw: string | null = null, writes = 0;
  const storage = { get: async () => raw, set: async (value: string) => { raw = value; writes++; } };
  const store = createAppearanceStore(storage);
  await Promise.all([store.initialize(DEFAULT_APPEARANCE), store.initialize(migrateAppearance(true, 'dark'))]);
  assert.equal(writes, 1);
  assert.equal(await store.save({ version: 1, mode: 'palette', palette: 'pacific' }), true);
  await store.initialize(migrateAppearance(true, 'system'));
  assert.equal(store.getSnapshot().preference.palette, 'pacific');
  const reload = createAppearanceStore(storage);
  await reload.initialize(DEFAULT_APPEARANCE);
  assert.deepEqual(reload.getSnapshot().preference, { version: 1, mode: 'palette', palette: 'pacific' });
  assert.equal(writes, 2);
});

test('failed saves retain the previous palette and can be retried without a connection', async () => {
  let fail = false, raw: string | null = null;
  const store = createAppearanceStore({ get: async () => raw, set: async value => { if (fail) throw Error('Storage denied'); raw = value; } });
  await store.initialize(DEFAULT_APPEARANCE);
  fail = true;
  assert.equal(await store.save({ version: 1, mode: 'palette', palette: 'oled' }), false);
  assert.equal(store.getSnapshot().preference.palette, 'emeraldLight');
  assert.equal(parseAppearance(raw)?.palette, 'emeraldLight');
  assert.match(store.getSnapshot().error, /previous appearance/);
  fail = false;
  assert.equal(await store.save({ version: 1, mode: 'palette', palette: 'oled' }), true);
  assert.equal(store.getSnapshot().preference.palette, 'oled');
  assert.equal(store.getSnapshot().error, '');
});

test('a pending save preserves the rendered palette and rejects overlapping changes', async () => {
  let finish: (() => void) | undefined;
  const store = createAppearanceStore({ get: async () => JSON.stringify(DEFAULT_APPEARANCE), set: () => new Promise<void>(resolve => { finish = resolve; }) });
  await store.initialize(DEFAULT_APPEARANCE);
  const save = store.save({ version: 1, mode: 'palette', palette: 'pacific' });
  assert.equal(store.getSnapshot().saving, true);
  assert.equal(store.getSnapshot().preference.palette, 'emeraldLight');
  assert.equal(await store.save({ version: 1, mode: 'palette', palette: 'oled' }), false);
  finish!();
  await save;
  assert.equal(store.getSnapshot().preference.palette, 'pacific');
});

test('storage read failures do not overwrite an unread saved preference', async () => {
  let writes = 0;
  const store = createAppearanceStore({ get: async () => { throw Error('Read denied'); }, set: async () => { writes++; } });
  await store.initialize(migrateAppearance(true, 'dark'));
  assert.equal(writes, 0);
  assert.equal(store.getSnapshot().preference.palette, 'midnight');
  assert.match(store.getSnapshot().error, /could not be read/);
  assert.equal(parseAppearance('{broken'), null);
  assert.equal(parseAppearance('{"version":1,"mode":"palette","palette":"injected"}'), null);
});
