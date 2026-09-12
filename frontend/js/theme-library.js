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
    const cards = new Map();
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
      if (Array.from(select.options).some(option => option.value === selected)) select.value = selected;
      currentLabel.textContent = theme ? `Current theme: ${theme.name}` : 'Your current theme is unchanged.';
      for (const [id, card] of cards) {
        const active = id === selected;
        card.button.setAttribute('aria-pressed', String(active));
        card.selected.hidden = !active;
      }
    }

    function applyFilter(next) {
      if (!['all', 'light', 'dark', 'new'].includes(next)) return;
      filter = next;
      let visible = 0;
      for (const theme of themes) {
        const match = filter === 'all' || (filter === 'new' ? theme.collection === 'new' : theme.tone === filter);
        cards.get(theme.id).button.hidden = !match;
        if (match) visible += 1;
      }
      for (const button of filters) button.setAttribute('aria-pressed', String(button.dataset.themeFilter === filter));
      count.textContent = `${visible} ${filter === 'all' ? '' : filter + ' '}theme${visible === 1 ? '' : 's'}`;
    }

    for (const theme of themes) {
      const button = make('button', 'tli-theme-card');
      button.type = 'button';
      button.dataset.themeChoice = theme.id;
      button.setAttribute('aria-label', `Use ${theme.name} theme, ${theme.tone}${theme.collection === 'new' ? ', new' : ''}`);
      button.setAttribute('aria-pressed', 'false');
      const preview = make('span', 'tli-theme-preview');
      preview.dataset.theme = theme.id;
      preview.setAttribute('aria-hidden', 'true');
      const sidebar = make('span', 'tli-theme-preview-sidebar');
      sidebar.append(make('span', 'tli-theme-preview-mark', 'TLI'), make('span', 'tli-theme-preview-nav active'), make('span', 'tli-theme-preview-nav'), make('span', 'tli-theme-preview-nav'));
      const workspace = make('span', 'tli-theme-preview-workspace');
      const header = make('span', 'tli-theme-preview-header');
      header.append(make('span', 'tli-theme-preview-heading'), make('span', 'tli-theme-preview-dot'));
      const stats = make('span', 'tli-theme-preview-stats');
      for (let i = 0; i < 2; i += 1) {
        const stat = make('span', 'tli-theme-preview-stat');
        stat.append(make('span', 'tli-theme-preview-line'), make('span', 'tli-theme-preview-number'));
        stats.append(stat);
      }
      const chat = make('span', 'tli-theme-preview-chat');
      chat.append(make('span', 'tli-theme-preview-message'), make('span', 'tli-theme-preview-line'), make('span', 'tli-theme-preview-line short'));
      workspace.append(header, stats, chat);
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
      if (theme.collection === 'new') tags.append(make('span', 'tli-theme-new', 'New'));
      caption.append(tags);
      button.append(preview, caption);
      button.addEventListener('click', () => {
        if (selecting || select.disabled || currentTheme() === theme.id) return;
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
      grid.append(button);
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
