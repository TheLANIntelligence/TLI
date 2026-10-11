/* Compact presentation of existing observations. No probes or feature controllers. */
(() => {
  'use strict';
  function init() {
    const header = document.querySelector('.main-region > header');
    if (!header || !window.TLIHeaderStatusFacts) return;
    const make = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
    const bar = make('div', 'premium-status-bar'); bar.id = 'premium-status-bar';
    bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'At a glance');
    const dialog = make('dialog', 'premium-status-dialog'); dialog.id = 'premium-status-dialog';
    dialog.setAttribute('aria-labelledby', 'premium-status-title');
    const heading = make('div', 'premium-status-heading');
    const title = make('h2'); title.id = 'premium-status-title';
    const close = make('button', 'premium-status-close', 'Close'); close.type = 'button';
    close.addEventListener('click', () => dialog.close()); heading.append(title, close);
    const description = make('p', 'premium-status-description');
    const rows = make('dl', 'premium-status-facts');
    const action = make('button', 'btn-primary'); action.type = 'button';
    dialog.append(heading, description, rows, action); document.body.append(dialog);
    header.querySelector('.header-left').after(bar);
    const config = {
      storage: {title:'Storage', icon:'storage', action:'Open Free Space'},
      devices: {title:'Smart devices', icon:'home', action:'Open Smart home'},
      ai: {title:'AI availability', icon:'chat', action:'Choose AI'},
    };
    const chips = {};
    let facts, selected = null, opener = null, locked = window.TLIHostIdentity?.get?.().status === 'locked';
    let frame = null, ageTimer = null, rowsKey = '';
    const premium = () => document.documentElement.dataset.experience === 'premium';
    const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
    for (const [key, item] of Object.entries(config)) {
      const button = make('button', 'premium-status-chip'); button.type = 'button'; button.id = 'premium-status-' + key;
      button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', dialog.id); button.setAttribute('aria-expanded', 'false');
      const icon = window.TLIUI?.icon(item.icon); if (icon) button.append(icon);
      const label = make('span'); button.append(label); bar.append(button); chips[key] = {button, label};
      button.addEventListener('click', () => {
        if (locked) return;
        selected = key; opener = button; render();
        positionDialog(); dialog.showModal(); button.setAttribute('aria-expanded', 'true');
      });
    }
    function positionDialog() {
      const rect = header.getBoundingClientRect();
      dialog.style.setProperty('--status-top', Math.min(rect.bottom + 8, Math.max(8, innerHeight - 300)) + 'px');
    }
    function renderDetail() {
      if (!selected || !facts) return;
      const fact = facts[selected], item = config[selected];
      setText(title, item.title); setText(description, fact.detail);
      dialog.dataset.tone = fact.tone;
      const nextRows = JSON.stringify(fact.rows);
      if (rowsKey !== nextRows) {
        rowsKey = nextRows;
        rows.replaceChildren(...fact.rows.map(([name, value]) => {
          const row = make('div'); row.append(make('dt', '', name), make('dd', '', value)); return row;
        }));
      }
      setText(action, item.action);
      action.disabled = locked || (selected === 'storage' && !fact.target);
    }
    function render() {
      if (ageTimer !== null) { clearTimeout(ageTimer); ageTimer = null; }
      facts = window.TLIHeaderStatusFacts.build({
        observation: window.TLIPresence?.getObservation?.() || {},
        ai: window.TLIAISource?.getSnapshot?.() || {},
        host: window.TLIHostIdentity?.get?.() || {}, locked,
      });
      bar.hidden = !premium();
      for (const [key, {button, label}] of Object.entries(chips)) {
        const fact = facts[key];
        const text = key === 'ai' ? 'AI · ' + fact.label : key === 'storage' ? 'Storage · ' + fact.label : fact.label;
        setText(label, text); button.title = fact.detail; button.dataset.tone = fact.tone;
        button.setAttribute('aria-label', config[key].title + ': ' + fact.label + '. ' + fact.detail);
        button.disabled = locked;
      }
      renderDetail();
      if (!locked && (premium() || dialog.open) && facts.nextChangeAt) {
        ageTimer = setTimeout(queue, Math.max(1, facts.nextChangeAt - Date.now() + 1));
      }
    }
    function queue() {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => { frame = null; render(); });
    }
    action.addEventListener('click', () => {
      if (locked || action.disabled) return;
      const key = selected, path = facts?.storage.target;
      opener = null;
      dialog.close();
      if (key === 'storage' && path) window.TLIStorageWorkspace?.prepare?.({view:'space', root:path, source:'header'});
      else if (key === 'devices') window.switchPanel?.('panel-homeauto');
      else if (key === 'ai') document.getElementById('ai-source-pill')?.click();
    });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    dialog.addEventListener('close', () => {
      Object.values(chips).forEach(({button}) => button.setAttribute('aria-expanded', 'false'));
      if (!locked && opener?.isConnected && !bar.hidden) opener.focus({preventScroll:true});
      selected = null; rowsKey = '';
    });
    for (const event of ['tli-system-observation', 'tli-ai-source-changed', 'tli:host-identity', 'tli:experience-change']) window.addEventListener(event, queue);
    window.addEventListener('tli-session-locked', () => { locked = true; if (dialog.open) dialog.close(); render(); });
    window.addEventListener('tli-session-unlocked', () => { locked = false; queue(); });
    window.addEventListener('resize', () => { if (dialog.open) positionDialog(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) queue(); });
    document.addEventListener('tli-panel-switched', () => { if (dialog.open) { opener = null; dialog.close(); } });
    document.body.dataset.headerStatusReady = 'true'; render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true}); else init();
})();
