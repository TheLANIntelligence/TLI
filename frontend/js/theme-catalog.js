/* Built-in appearance only: applying a theme never saves settings or contacts a host. */
(() => {
  'use strict';
  const definitions = [
    ['emeraldLight', 'Emerald Light', 'light', 'Fresh sage, forest ink and confident emerald.'],
    ['midnight', 'Midnight', 'dark', 'Quiet charcoal, soft mint and room to focus.'],
    ['classicTli', 'Classic Mint', 'light', 'The early mint-and-teal palette. Use it with either the Classic or Modern interface.', 'anniversary'],
    ['porcelainLight', 'Porcelain', 'light', 'Warm paper, indigo ink and a quiet blue accent.', 'new'],
    ['pacific', 'Pacific', 'dark', 'Layered ocean blue with luminous aqua edges.', 'new'],
    ['copper', 'Copper', 'dark', 'Warm charcoal, copper accents and inset detail.', 'new'],
    ['roseQuartz', 'Rose Quartz', 'light', 'Soft mineral pink, plum ink and rose details.', 'new'],
    ['arctic', 'Arctic', 'light', 'Crisp ice blue and clear cobalt.', 'new'],
    ['graphite', 'Graphite', 'dark', 'Neutral charcoal, silver highlights and cool gray.', 'new'],
    ['emeraldLite', 'Emerald Lite', 'light', 'A softer mint canvas with forest-green details.'],
    ['cloudLight', 'Cloud Light', 'light', 'Cool gray, open white and a calm blue accent.'],
    ['sandLight', 'Sand Light', 'light', 'Parchment warmth with grounded bronze details.'],
    ['lavenderLite', 'Lavender', 'light', 'Cool lilac, violet ink and silver-lit surfaces.'],
    ['dusk', 'Dusk', 'dark', 'Twilight slate with a touch of warm coral.'],
    ['oled', 'OLED', 'dark', 'True-black canvas with clean emerald highlights.'],
    ['neon', 'Neon', 'dark', 'Dark graphite with an energetic lime accent.'],
    ['lavenderMidnight', 'Lavender Midnight', 'dark', 'Velvety aubergine and soft lavender.'],
    ['violetNeon', 'Violet Neon', 'dark', 'Inky violet with a bright orchid accent.'],
    ['purpleTerminal', 'Purple Terminal', 'dark', 'Deep purple with restrained lilac details.'],
    ['blueTerminal', 'Blue Terminal', 'dark', 'Midnight navy and electric sky blue.'],
    ['ultraLavenderOLED', 'Ultra Lavender OLED', 'dark', 'A black canvas with luminous lavender.'],
    ['horizon', 'Horizon', 'dark', 'Deep blue with the warmth of a golden sunrise.'],
    ['terminal', 'Terminal', 'dark', 'Forest black and crisp phosphor-green accents.'],
  ];
  const signatureIds = new Set(['emeraldLight', 'lavenderLite', 'porcelainLight', 'roseQuartz', 'pacific', 'copper', 'graphite', 'terminal']);
  const themes = Object.freeze(definitions.map(([id, name, tone, description, collection = 'classic']) =>
    Object.freeze({ id, name, tone, description, collection, signature: signatureIds.has(id) })));
  const aliases = Object.freeze({ cloud: 'cloudLight', emeraldDark: 'midnight' });
  const byId = new Map(themes.map(theme => [theme.id, theme]));
  const systemColor = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  let appearanceMode = 'theme';
  function resolve(id) { return byId.get(id) || byId.get(aliases[id]) || byId.get('emeraldLight'); }
  function apply(id, { notify = true, preserveMode = false } = {}) {
    if (!preserveMode) appearanceMode = 'theme';
    const theme = resolve(id);
    const root = document.documentElement;
    root.dataset.theme = theme.id;
    root.dataset.themeTone = theme.tone;
    root.dataset.appearanceMode = appearanceMode;
    root.style.colorScheme = theme.tone;
    document.body?.classList.toggle('theme-dark', theme.tone === 'dark');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && typeof getComputedStyle === 'function') {
      const color = getComputedStyle(root).getPropertyValue('--bg-header').trim();
      if (color) meta.setAttribute('content', color);
    }
    if (notify) window.dispatchEvent(new CustomEvent('tli-theme-applied', { detail: { theme: theme.id, tone: theme.tone } }));
    return theme.id;
  }
  function applyPreference(settings = {}, options = {}) {
    appearanceMode = settings?.appearanceMode === 'system' ? 'system' : 'theme';
    const id = appearanceMode === 'system' ? (systemColor?.matches ? 'midnight' : 'emeraldLight') : settings?.defaultTheme;
    return apply(id, { ...options, preserveMode: true });
  }
  const systemChanged = () => {
    if (appearanceMode === 'system') apply(systemColor?.matches ? 'midnight' : 'emeraldLight', { preserveMode: true });
  };
  if (systemColor?.addEventListener) systemColor.addEventListener('change', systemChanged);
  else if (systemColor?.addListener) systemColor.addListener(systemChanged);
  window.TLIThemes = Object.freeze({ themes, resolve, apply, applyPreference });
  let initial = {};
  try { initial = JSON.parse(localStorage.getItem('tli_settings') || '{}'); } catch {}
  applyPreference(initial, { notify: false });
  // The script runs in the head to avoid a flash. Do not re-read saved preferences
  // here: another deliberate selection may already have been applied by startup.
  document.addEventListener('DOMContentLoaded', () => apply(document.documentElement.dataset.theme, { notify: false, preserveMode: true }), { once: true });
})();
