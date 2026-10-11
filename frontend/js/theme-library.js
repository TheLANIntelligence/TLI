/* A local theme gallery. The existing Settings select owns all persistence. */
(() => {
  'use strict';
  const make = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  };

  function init() {
    const library = document.getElementById('tli-theme-library');
    const select = document.getElementById('settings-theme');
    const grid = document.getElementById('tli-theme-grid');
    const currentLabel = document.getElementById('tli-theme-current');
    const count = document.getElementById('tli-theme-count');
    if (!library || !select || !grid || !currentLabel || !count || library.dataset.bound) return;
    const source = Array.isArray(window.TLIThemes) ? window.TLIThemes : window.TLIThemes?.themes;
    if (!Array.isArray(source)) return;
    const seen = new Set();
    const themes = source.slice(0, 64).filter(theme => {
      if (!theme || typeof theme.id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(theme.id)
        || typeof theme.name !== 'string' || !theme.name.trim() || !['light', 'dark'].includes(theme.tone)
        || seen.has(theme.id)) return false;
      seen.add(theme.id);
      return true;
    });
    if (!themes.length) return;
    library.dataset.bound = '1';
    let filter = 'all';
    let selecting = false;
    const cards = new Map(), groups = new Map();
    const filters = Array.from(library.querySelectorAll('[data-theme-filter]'));

    // Rebuild labels from the same catalog while retaining every existing identifier.
    const oldOptions = Array.from(select.options).map(option => ({ id: option.value, name: option.textContent }));
    const appliedOnLoad = document.documentElement.getAttribute('data-theme');
    const initialValue = seen.has(appliedOnLoad) ? appliedOnLoad : select.value;
    select.replaceChildren();
    for (const tone of ['dark', 'light']) {
      const group = make('optgroup');
      group.label = tone === 'light' ? 'Light' : 'Dark';
      for (const theme of themes.filter(item => item.tone === tone)) {
        const option = make('option', '', theme.name);
        option.value = theme.id;
        group.appendChild(option);
      }
      if (group.children.length) select.appendChild(group);
    }
    const retainedOptions = oldOptions.filter(option => option.id && !seen.has(option.id));
    if (retainedOptions.length) {
      const group = make('optgroup');
      group.label = 'Other saved themes';
      for (const old of retainedOptions) {
        const option = make('option', '', old.name);
        option.value = old.id;
        group.appendChild(option);
      }
      select.appendChild(group);
    }
    select.value = initialValue;

    function currentTheme() {
      const applied = document.documentElement.getAttribute('data-theme');
      return applied || select.value;
    }

    function sync() {
      const selected = currentTheme();
      const theme = themes.find(item => item.id === selected);
      const mode = document.documentElement.getAttribute('data-appearance-mode') === 'system' ? 'system' : 'theme';
      const modeSelect = document.getElementById('settings-appearance-mode');
      if (modeSelect) modeSelect.value = mode;
      if (Array.from(select.options).some(option => option.value === selected)) select.value = selected;
      currentLabel.textContent = theme ? `${mode === 'system' ? 'Following system' : 'Current theme'}: ${theme.name}` : 'Your current theme is unchanged.';
      for (const [id, card] of cards) {
        const active = id === selected;
        card.button.setAttribute('aria-pressed', String(active));
        card.selected.hidden = !active;
      }
    }

    function applyFilter(next) {
      if (!['all', 'light', 'dark'].includes(next)) return;
      filter = next;
      const totals = { light: 0, dark: 0 };
      for (const theme of themes) {
        const match = filter === 'all' || theme.tone === filter;
        cards.get(theme.id).button.hidden = !match;
        if (match) totals[theme.tone] += 1;
      }
      for (const [tone, group] of groups) {
        group.section.hidden = totals[tone] === 0;
        group.count.textContent = `${totals[tone]} theme${totals[tone] === 1 ? '' : 's'}`;
      }
      for (const button of filters) button.setAttribute('aria-pressed', String(button.dataset.themeFilter === filter));
      const visible = totals.light + totals.dark;
      count.textContent = `${visible} ${filter === 'all' ? '' : filter + ' '}theme${visible === 1 ? '' : 's'}`;
    }

    for (const tone of ['light', 'dark']) {
      const section = make('section', 'tli-theme-group'); section.dataset.themeTone = tone;
      const heading = make('div', 'tli-theme-group-heading'), title = make('h4', '', tone === 'light' ? 'Light' : 'Dark');
      title.id = 'tli-theme-group-' + tone; section.setAttribute('aria-labelledby', title.id);
      const groupCount = make('span', 'tli-theme-group-count'); heading.append(title, groupCount);
      const choices = make('div', 'tli-theme-group-grid'); section.append(heading, choices); grid.append(section);
      groups.set(tone, {section, count: groupCount, choices});
    }

    for (const theme of themes) {
      const button = make('button', 'tli-theme-card');
      button.type = 'button';
      button.dataset.themeChoice = theme.id;
      button.setAttribute('aria-label', `Use ${theme.name} theme, ${theme.tone}`);
      button.setAttribute('aria-pressed', 'false');
      const preview = make('span', 'tli-theme-preview');
      preview.dataset.theme = theme.id;
      preview.setAttribute('aria-hidden', 'true');
      const sidebar = make('span', 'tli-theme-preview-sidebar');
      sidebar.append(make('span', 'tli-theme-preview-mark', 'TLI'), make('span', 'tli-theme-preview-nav active', 'Ask'), make('span', 'tli-theme-preview-nav', 'Create'), make('span', 'tli-theme-preview-nav', 'Files'), make('span', 'tli-theme-preview-nav', 'Home'));
      const workspace = make('span', 'tli-theme-preview-workspace');
      const header = make('span', 'tli-theme-preview-header');
      header.append(make('span', 'tli-theme-preview-host', 'A space to think'), make('span', 'tli-theme-preview-dot'));
      const canvas = make('span', 'tli-theme-preview-canvas');
      const welcome = make('span', 'tli-theme-preview-welcome');
      welcome.append(make('span', 'tli-theme-preview-heading', 'What’s on your mind?'), make('span', 'tli-theme-preview-body', 'Ask, imagine, make something.'));
      canvas.append(welcome);
      const composer = make('span', 'tli-theme-preview-composer');
      composer.append(make('span', 'tli-theme-preview-prompt', 'Ask anything…'), make('span', 'tli-theme-preview-action', '↑'));
      const recent = make('span', 'tli-theme-preview-recent');
      recent.append(make('span', 'tli-theme-preview-label', 'Pick up where you left off'), make('span', 'tli-theme-preview-work', 'Weekend ideas'));
      canvas.append(composer, recent); workspace.append(header, canvas);
      preview.append(sidebar, workspace);
      const caption = make('span', 'tli-theme-caption');
      const title = make('span', 'tli-theme-title');
      title.append(make('span', 'tli-theme-name', theme.name));
      const selected = make('span', 'tli-theme-selected', '✓');
      selected.hidden = true;
      selected.setAttribute('aria-hidden', 'true');
      title.append(selected);
      caption.append(title, make('span', 'tli-theme-description', typeof theme.description === 'string' ? theme.description : `${theme.tone === 'light' ? 'Light' : 'Dark'} appearance`));
      const tags = make('span', 'tli-theme-tags');
      tags.append(make('span', 'tli-theme-tone', theme.tone === 'light' ? 'Light' : 'Dark'));
      caption.append(tags);
      button.append(preview, caption);
      button.addEventListener('click', () => {
        if (selecting || select.disabled || (currentTheme() === theme.id && document.documentElement.getAttribute('data-appearance-mode') !== 'system')) return;
        selecting = true;
        try {
          select.value = theme.id;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        } finally {
          selecting = false;
          // Let the existing save handler finish, including a failed-save rollback.
          queueMicrotask(sync);
        }
      });
      cards.set(theme.id, { button, selected });
      groups.get(theme.tone).choices.append(button);
    }
    for (const button of filters) button.addEventListener('click', () => applyFilter(button.dataset.themeFilter));
    select.addEventListener('change', () => queueMicrotask(sync));
    window.addEventListener('tli-theme-applied', sync);
    sync();
    applyFilter(filter);
    library.hidden = false;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
