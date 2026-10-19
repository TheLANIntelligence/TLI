/* Explicit setting trials and user-entered comparisons. No inference or setting writes. */
(function (root) {
  'use strict';
  function compareReadings(before, after, metric) {
    if (!['fps', 'low-fps', 'frame-time'].includes(metric)) throw Error('Choose a measurement type.');
    const limit = metric === 'frame-time' ? 10000 : 1000;
    const values = [before, after].map(value => {
      if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) throw Error('Enter both readings.');
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0.01 || number > limit) throw Error(`Enter readings from 0.01 to ${limit}.`);
      return number;
    });
    const delta = values[1] - values[0], percent = delta / values[0] * 100;
    return {before: values[0], after: values[1], delta, percent,
      direction: delta === 0 ? 'unchanged' : delta > 0 ? 'higher' : 'lower',
      improved: delta !== 0 && (metric === 'frame-time' ? delta < 0 : delta > 0), unit: metric === 'frame-time' ? 'ms' : 'FPS'};
  }
  if (typeof module === 'object' && module.exports) module.exports = {compareReadings};
  if (typeof document === 'undefined') return;
  const $ = id => document.getElementById(id);
  const make = (tag, text, cls) => { const el = document.createElement(tag); if (text) el.textContent = text; if (cls) el.className = cls; return el; };
  const bounded = (value, max = 1600) => typeof value === 'string' && value.length > 0 && value.length <= max;
  let epoch = 0, controller = null, busy = false, selected = null, comparison = '', manual = {}, custom = [], controls = [], mode = null;
  let locked = $('tli-lock-screen')?.getAttribute('aria-hidden') === 'false', ready = !locked;
  const available = () => !locked && ready;
  const status = message => { if ($('go-plan-status')) $('go-plan-status').textContent = message; };
  function comparisonClear() {
    selected = null; comparison = ''; $('go-comparison').hidden = true; $('go-compare-setting').textContent = ''; $('go-compare-result').replaceChildren();
    $('go-copy-comparison').hidden = true;
    for (const id of ['go-compare-scene', 'go-compare-before', 'go-compare-after']) $(id).value = '';
    $('go-compare-same').checked = false;
  }
  function empty() {
    const box = $('go-trial-cards'); box.replaceChildren();
    const panel = make('div', null, 'game-trial-empty');
    panel.append(make('span', '↔', 'game-trial-symbol'), make('h4', 'A clear before and after'),
      make('p', 'Choose your game and current settings. Build a small set of trials, then compare one change in the same scene.'));
    box.append(panel);
  }
  function invalidate(message, clearInputs = false) {
    epoch++; controller?.abort(); controller = null; busy = false;
    comparisonClear(); empty();
    if (clearInputs) { manual = {}; custom = []; controls = []; mode = null; $('go-trial-values').replaceChildren(); }
    const button = $('go-plan-btn'); button.disabled = !available(); button.textContent = mode ? 'Build my trial plan →' : 'Choose settings to compare →';
    if (message) status(message);
  }
  function validate(value, game) {
    if (value?.protocol !== 'tli-game-plan-v1' || value.source !== 'setting-trials' || value.applied !== false || value.game_name !== game ||
        !['reader-vocabulary', 'manual'].includes(value.mode) || !Array.isArray(value.controls) || value.controls.length > 12 ||
        !Array.isArray(value.settings_plan) || value.settings_plan.length > 3 || !Array.isArray(value.needs_current) || value.needs_current.length > 12 ||
        !bounded(value.text, 20000) || !Array.isArray(value.comparison_steps) || value.comparison_steps.length > 12 || value.comparison_steps.some(step => !bounded(step))) throw Error('The trial plan could not be validated. No settings were changed.');
    const keys = new Set();
    for (const item of value.controls) {
      if (!bounded(item.key, 80) || !bounded(item.label, 160) || keys.has(item.key) || !Array.isArray(item.values) || !item.values.length || item.values.length > 12 || item.values.some(option => !bounded(option, 80))) throw Error('The current-setting choices could not be validated.');
      keys.add(item.key);
    }
    const planKeys = new Set();
    for (const item of value.settings_plan) {
      if (!bounded(item.id, 200) || !bounded(item.key, 80) || planKeys.has(item.key) || !bounded(item.label, 160) || !bounded(item.current, 80) ||
          !bounded(item.suggested, 80) || item.current === item.suggested || !['read', 'user'].includes(item.current_source) || !bounded(item.reason) || !bounded(item.tradeoff) || !bounded(item.scope, 160)) throw Error('A setting trial is incomplete. Check the current values and try again.');
      planKeys.add(item.key);
    }
    return value;
  }
  function renderInputs(context) {
    const box = $('go-trial-values'); box.replaceChildren();
    box.append(make('h4', mode === 'manual' ? 'Use the exact options in your game' : 'Your current settings'));
    box.append(make('p', mode === 'manual' ? 'Name a setting, its current value, and the value you want to test. Options such as On / Off or 100 / 90 are fine.' : 'Choose values you can confirm in your game. Leave unknown values blank. Reader vocabulary can differ between game versions.', 'small-meta'));
    if (mode !== 'manual') {
      const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const grid = make('div', null, 'game-current-grid');
      for (const control of controls) {
        const read = context.current_settings.find(item => norm(item.key) === norm(control.key) || norm(item.label) === norm(control.label));
        const value = Object.prototype.hasOwnProperty.call(manual, control.key) ? manual[control.key] : context.manual_values[control.key] ?? read?.value ?? '';
        const wrap = make('label', control.label), select = make('select'); select.className = 'field-select'; select.setAttribute('aria-label', `${control.label} for trial plan`);
        for (const optionValue of ['', ...control.values]) { const option = make('option', optionValue || 'Choose current value'); option.value = optionValue; select.append(option); }
        select.value = control.values.find(option => option.toLowerCase() === String(value).trim().toLowerCase()) || '';
        select.addEventListener('change', () => { if (!available() || !select.isConnected) return; manual[control.key] = select.value; invalidate('Current values changed. Build a new plan to use them.'); });
        const entered = Object.prototype.hasOwnProperty.call(manual, control.key) || Object.prototype.hasOwnProperty.call(context.manual_values, control.key);
        wrap.append(select, make('small', read && select.value && !entered ? 'From the saved settings read' : 'Confirm this value in the game', 'small-meta')); grid.append(wrap);
      }
      box.append(grid);
      box.append(make('p', 'Different menu options? Add the exact setting and values below. Your explicit trials appear first and replace a matching dropdown suggestion.', 'small-meta'));
    } else if (!custom.length) {
      custom = [{label:'',current:'',suggested:''}];
    }
    custom.forEach((trial, index) => {
      const group = make('div', null, 'game-manual-trial');
      for (const [key, label, placeholder] of [['label', 'Setting', 'Name in the game menu'], ['current', 'Current value', 'For example: On'], ['suggested', 'Trial value', 'For example: Off']]) {
        const wrap = make('label', label), input = make('input'); input.className = 'field-input'; input.maxLength = 80; input.value = trial[key]; input.placeholder = placeholder;
        input.setAttribute('aria-label', `${label} for trial ${index + 1}`);
        input.addEventListener('input', () => { if (!available() || !input.isConnected) return; trial[key] = input.value; invalidate('Values changed. Build a new plan before comparing.'); });
        wrap.append(input); group.append(wrap);
      }
      const remove = make('button', 'Remove setting', 'btn-outline game-remove-setting'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove setting ${index + 1}`);
      remove.addEventListener('click', () => {
        if (!available() || !remove.isConnected) return;
        custom.splice(index, 1); invalidate('Setting removed. Build a new plan to use the remaining values.');
        renderInputs(context); $('go-plan-btn').focus();
      });
      group.append(remove); box.append(group);
    });
    if (custom.length < 3) {
      const add = make('button', custom.length ? '+ Add another setting' : '+ Use exact menu options', 'btn-outline'); add.type = 'button';
      add.addEventListener('click', () => {
        if (!available() || busy || !add.isConnected) return;
        custom.push({label:'',current:'',suggested:''}); renderInputs(context);
        box.querySelectorAll('.game-manual-trial input')[3 * (custom.length - 1)]?.focus();
      }); box.append(add);
    }
  }
  function choose(item, game, generation) {
    if (!available() || generation !== epoch || $('go-game-input').value.trim() !== game) return;
    comparisonClear(); selected = {item: {...item}, game, epoch};
    $('go-compare-setting').textContent = `${game} · ${item.label}: ${item.current} → ${item.suggested}`;
    $('go-comparison').hidden = false; $('go-comparison').scrollIntoView({behavior:'smooth',block:'nearest'}); $('go-compare-scene').focus();
  }
  function renderPlan(value) {
    const generation = epoch, box = $('go-trial-cards'); box.replaceChildren();
    if (!value.settings_plan.length) {
      box.append(make('h4', mode === 'manual' ? 'Define one change to test' : value.needs_current.length ? 'Add a current value first' : 'No further step for this goal'), make('p', value.text, 'small-meta')); return;
    }
    for (const [index, item] of value.settings_plan.entries()) {
      const card = make('article', null, 'game-setting-trial'), heading = make('div', null, 'game-trial-heading');
      heading.append(make('span', String(index + 1).padStart(2, '0'), 'game-step'), make('h4', item.label));
      const values = make('div', null, 'game-trial-change');
      values.append(make('span', item.current), make('span', '→', 'game-trial-arrow'), make('strong', item.suggested));
      card.append(heading, values, make('p', item.reason), make('p', item.tradeoff, 'small-meta'),
        make('p', item.current_source === 'read' ? 'Current value from the saved settings you read.' : 'Current value entered by you.', 'small-meta'));
      const button = make('button', 'Compare this setting', 'btn-outline'); button.type = 'button'; button.addEventListener('click', () => choose(item, value.game_name, generation));
      card.append(button); box.append(card);
    }
    const steps = make('ol', null, 'game-comparison-steps'); value.comparison_steps.forEach(step => steps.append(make('li', step))); box.append(steps);
  }
  async function build() {
    const context = root.TLIGames?.trialContext?.();
    if (!available() || busy || !context || context.locked || context.busy) return;
    const game = $('go-game-input').value.trim();
    if (!game) { status('Enter a game name first.'); $('go-game-input').focus(); return; }
    const labels = new Set();
    for (const [index, row] of custom.entries()) {
      const {label, current, suggested} = Object.fromEntries(Object.entries(row).map(([key,value]) => [key,value.trim()]));
      if (!label && !current && !suggested) continue;
      let problem = '';
      if (!label || !current || !suggested) problem = `Complete all three fields for setting ${index + 1}, or remove it.`;
      else if (current.toLowerCase() === suggested.toLowerCase()) problem = `Choose a different trial value for ${label}.`;
      else if (labels.has(label.toLowerCase())) problem = `Use only one trial for ${label}, or remove the duplicate.`;
      if (problem) { status(problem); $('go-trial-values').querySelectorAll('.game-manual-trial input')[3 * index]?.focus(); return; }
      labels.add(label.toLowerCase());
    }
    comparisonClear(); empty(); const generation = ++epoch; controller = new AbortController(); busy = true; $('go-plan-btn').disabled = true;
    status('Building setting trials…');
    try {
      const response = await fetch('/games/plan', {method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},signal:controller.signal,
        body:JSON.stringify({game_name:game,preset:context.preset,current_settings:context.current_settings,config_game_name:context.config_game_name,
          manual_values:{...context.manual_values,...manual},custom_trials:custom.filter(row => row.label.trim()).map(row => Object.fromEntries(Object.entries(row).map(([key,value]) => [key,value.trim()])))})});
      if (generation !== epoch || !available() || $('go-game-input').value.trim() !== game) return;
      if ([401,403].includes(response.status)) { root.dispatchEvent(new CustomEvent('tli-session-locked')); return; }
      const value = await response.json();
      if (generation !== epoch || !available() || $('go-game-input').value.trim() !== game) return;
      if (!response.ok) throw Error(typeof value.detail === 'string' ? value.detail : 'The trial plan is unavailable. Check your inputs and try again.');
      validate(value, game); mode = value.mode; controls = value.controls;
      renderInputs(context); renderPlan(value);
      status(value.settings_plan.length ? 'Your plan is ready. Change one setting in the game, then compare your readings.' : mode === 'manual' ? 'Enter an exact current → trial change from your game menu, then build your plan.' : value.needs_current.length ? 'Choose at least one current value above, then build your trial plan.' : 'Your entered values are already at the end of this range. Choose another goal or add an exact menu option.');
    } catch (error) {
      if (generation === epoch && available()) { empty(); status(error.name === 'AbortError' ? 'Stopped. Build a plan again when ready.' : error.message); }
    } finally {
      if (generation === epoch) { busy = false; controller = null; $('go-plan-btn').disabled = !available(); $('go-plan-btn').textContent = 'Build my trial plan →'; }
    }
  }
  function calculate() {
    if (!available() || !selected || selected.epoch !== epoch || $('go-game-input').value.trim() !== selected.game) return;
    const result = $('go-compare-result'); result.replaceChildren(); comparison = ''; $('go-copy-comparison').hidden = true;
    try {
      const scene = $('go-compare-scene').value.trim();
      if (!scene || !$('go-compare-same').checked) throw Error('Name your test scene and confirm you kept the comparison conditions the same.');
      const value = compareReadings($('go-compare-before').value, $('go-compare-after').value, $('go-compare-metric').value);
      const amount = Math.abs(value.percent).toFixed(1), metric = $('go-compare-metric').selectedOptions[0].textContent;
      const title = value.direction === 'unchanged' ? 'No difference in these readings' : `${amount}% ${value.direction} ${metric.toLowerCase()}`;
      const detail = value.direction === 'unchanged' ? 'This run did not show a difference. Compare again before deciding.' : value.improved ? 'Your entered metric moved in the favorable direction. Check consistency and image quality before keeping the change.' : 'Your entered metric moved in the unfavorable direction. Recheck the run or restore the previous setting; consider whether the visual tradeoff was worth it.';
      result.append(make('strong',title),make('p',`${value.before} → ${value.after} ${value.unit}. ${detail}`));
      comparison = `${selected.game}\n${selected.item.label}: ${selected.item.current} → ${selected.item.suggested}\nScene: ${scene}\n${metric}: ${value.before} → ${value.after} ${value.unit}\n${title}\n${detail}\nUser-entered readings; not a TLI benchmark. No settings were applied by TLI.`;
      $('go-copy-comparison').hidden = false;
    } catch (error) { result.textContent = error.message; }
  }
  function install() {
    if (!$('go-plan-btn')) return;
    $('go-plan-btn').addEventListener('click', build); $('go-compare-btn').addEventListener('click', calculate);
    $('go-copy-comparison').addEventListener('click', async () => {
      if (!available() || !selected || selected.epoch !== epoch || $('go-game-input').value.trim() !== selected.game || !comparison) return;
      const generation = epoch;
      try { await navigator.clipboard.writeText(comparison); if (generation === epoch && available()) root.showToast?.('Comparison copied.', 'success'); }
      catch { if (generation === epoch && available()) $('go-compare-result').textContent = 'Copy failed. Your comparison remains here.'; }
    });
    for (const id of ['go-compare-scene','go-compare-metric','go-compare-before','go-compare-after','go-compare-same']) $(id).addEventListener('input', () => { comparison = ''; $('go-compare-result').replaceChildren(); $('go-copy-comparison').hidden = true; });
    $('go-game-input').addEventListener('input', () => invalidate('Game changed. Choose settings for this game.', true));
    document.querySelectorAll('.go-preset[data-preset]').forEach(button => button.addEventListener('click', () => invalidate('Goal changed. Build a new plan to use it.')));
    for (const event of ['tli-session-locked','tli-account-changed','tli-user-changed','pagehide']) root.addEventListener(event, () => { locked = true; ready = false; invalidate('Verify access before building a trial plan.', true); });
    root.addEventListener('tli-session-unlocked', () => { locked = false; });
    root.addEventListener('tli-private-observation-ready', () => { if (!locked) { ready = true; $('go-plan-btn').disabled = false; } });
    document.addEventListener('tli-panel-switched', event => { if (event.detail?.panelId && event.detail.panelId !== 'panel-games') invalidate('Choose settings to start a new comparison.', true); });
    $('go-plan-btn').disabled = !available();
  }
  root.TLIGameTrials = {compareReadings,settingsChanged: () => { if (available()) invalidate('Game details changed. Choose settings for a fresh comparison.', true); }};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
})(typeof window === 'undefined' ? globalThis : window);
