/* Shared shell behavior. Existing panels, routes and action handlers remain owners. */
(function () {
  'use strict';
  document.addEventListener('DOMContentLoaded', () => {
    const el = id => document.getElementById(id);
    const trigger = el('tli-activity-trigger');
    const panel = el('tli-activity-panel');
    const deviceTrigger = el('tli-device-trigger');
    const devicePanel = el('tli-device-popover');
    const tabs = [el('tli-alerts-tab'), el('tli-events-tab')];
    const feed = el('nd-feed');
    const feedHome = feed.parentNode;
    const feedAnchor = document.createComment('Live feed home');
    feed.before(feedAnchor);
    let selected = 0;
    let alerts = [];
    let polling = null;
    let mutating = null;
    let revision = 0;
    let mutationGeneration = 0;
    let sessionEpoch = 0;
    let locked = el('tli-lock-screen')?.getAttribute('aria-hidden') === 'false';
    let accessReady = !locked, available = false, uncertain = false;

    function isActivityVisible() { return !panel.hidden && selected === 1; }
    window.TLIShell = { isActivityVisible, alertOperations: {
      capture: () => ({epoch:sessionEpoch, generation:mutationGeneration}),
      isCurrent: context => alertContextCurrent(context) && !mutating && !uncertain, canBegin: canBeginDismissal,
      begin: beginDismissal, current: request => current(request,mutating), settle: settleDismissal,
    } };

    function updateFeed() {
      if (isActivityVisible()) {
        el('tli-events-content').append(feed);
        document.dispatchEvent(new CustomEvent('tli-activity-viewed'));
      } else if (feed.parentNode !== feedHome) {
        feedAnchor.after(feed);
      }
      el('tli-events-empty').hidden = feed.children.length > 0;
    }
    new MutationObserver(() => {
      el('tli-events-empty').hidden = feed.children.length > 0;
    }).observe(feed, { childList: true });

    function selectTab(index, focus = false) {
      selected = index;
      tabs.forEach((tab, i) => {
        tab.setAttribute('aria-selected', String(i === index));
        tab.tabIndex = i === index ? 0 : -1;
        el(tab.getAttribute('aria-controls')).hidden = i !== index;
      });
      updateFeed();
      if (focus) tabs[index].focus();
    }
    function closeActivity(focus = false) {
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      updateFeed();
      if (focus) trigger.focus();
    }
    function closeDevice(focus = false) {
      const wasOpen = !devicePanel.hidden;
      devicePanel.hidden = true;
      deviceTrigger.setAttribute('aria-expanded', 'false');
      if (wasOpen) document.dispatchEvent(new CustomEvent('tli-device-menu-closed'));
      if (focus) deviceTrigger.focus();
    }
    trigger.addEventListener('click', () => {
      if (!panel.hidden) return closeActivity();
      closeDevice();
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      selectTab(alerts.length ? 0 : selected, true);
      if (!locked && !accessReady) window.EventInterpreter?.retry?.();
      pollAlerts(true);
    });
    el('tli-activity-close').addEventListener('click', () => closeActivity(true));
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => selectTab(index));
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        selectTab(event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index, true);
      });
    });
    deviceTrigger.addEventListener('click', () => {
      if (!devicePanel.hidden) return closeDevice();
      closeActivity();
      devicePanel.hidden = false;
      deviceTrigger.setAttribute('aria-expanded', 'true');
      el('rename-device-btn').focus();
    });
    document.addEventListener('click', event => {
      if (!event.target.closest('.tli-activity-wrap')) closeActivity();
      if (!event.target.closest('.tli-device-menu')) closeDevice();
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      if (!panel.hidden) { event.preventDefault(); closeActivity(true); }
      if (!devicePanel.hidden) { event.preventDefault(); closeDevice(true); }
    });
    document.addEventListener('focusin', event => {
      if (!event.target.closest('.tli-activity-wrap')) closeActivity();
      if (!event.target.closest('.tli-device-menu')) closeDevice();
    });
    const search = el('tli-search-launcher');
    search.addEventListener('click', () => window.TLICmdPalette?.open());
    search.querySelector('kbd').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl+K';

    function syncNavigation() {
      document.querySelectorAll('.sidebar-nav [data-panel-target], .tli-bottom-nav [data-panel-target], .tli-more-item[data-panel-target]').forEach(button => {
        const current = document.querySelector('.panel-container:not([hidden])')?.id;
        const active = window.TLIUI?.isActive ? window.TLIUI.isActive(button.dataset.panelTarget, current) : !!el(button.dataset.panelTarget) && !el(button.dataset.panelTarget).hidden;
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
    }
    document.addEventListener('tli-panel-switched', () => {
      closeActivity(); closeDevice(); syncNavigation();
    });
    syncNavigation();

    function renderAlertList(list) {
      list.replaceChildren();
      if (!alerts.length || uncertain) {
        const empty = document.createElement('p');
        empty.className = 'tli-shell-empty';
        empty.textContent = locked || !accessReady ? 'Unlock TLI and check access to read alerts.' : uncertain
          ? 'The dismissal is not confirmed. Check saved alerts before another dismissal.'
          : available ? 'No alerts need attention.' : 'Alerts are unavailable. Check alerts to try a fresh read.';
        list.append(empty);
      }
      const renderedEpoch = sessionEpoch, renderedRevision = revision;
      alerts.forEach(alert => {
        const row = document.createElement('div');
        row.className = 'tli-alert-row';
        if (alert.severity === 'critical') row.classList.add('tli-alert-critical');
        const icon = document.createElement('span');
        icon.textContent = alert.severity === 'critical' ? '🔴' : alert.severity === 'warn' ? '🟡' : '🔵';
        icon.setAttribute('aria-hidden', 'true');
        const message = document.createElement('span');
        message.className = 'tli-alert-msg';
        message.textContent = alert.message || 'System alert';
        if (alert.detail) {
          const detail = document.createElement('small');
          detail.className = 'tli-alert-detail';
          detail.textContent = alert.detail;
          message.append(detail);
        }
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.className = 'tli-alert-x';
        dismiss.textContent = '✕';
        dismiss.setAttribute('aria-label', 'Dismiss ' + (alert.message || 'alert'));
        dismiss.disabled = locked || !accessReady || !available || uncertain || !!polling || !!mutating || !alert.id;
        dismiss.addEventListener('click', () => { if (alert.id) return dismissAlerts(alert.id, renderedEpoch, renderedRevision); });
        row.append(icon, message, dismiss);
        list.append(row);
      });
    }
    function renderAlerts() {
      const badge = el('tli-alert-badge');
      badge.hidden = alerts.length === 0;
      badge.textContent = alerts.length > 99 ? '99+' : String(alerts.length);
      trigger.setAttribute('aria-label', available ? `Activity, ${alerts.length} alerts need attention` : 'Activity, alerts not confirmed');
      renderAlertList(el('tli-alert-list'));
      renderAlertList(el('tli-drawer-alert-list'));
      el('tli-drawer-alerts').hidden = locked || !accessReady || (available && alerts.length === 0);
      el('tli-bn-alert-dot').hidden = alerts.length === 0;
      for (const id of ['tli-alert-dismiss-all','tli-drawer-dismiss-all']) {
        const button = el(id);
        button.textContent = uncertain ? 'Check saved alerts' : available ? 'Dismiss all' : 'Check alerts';
        button.disabled = locked || !accessReady || !!polling || !!mutating || (available && !uncertain && alerts.length === 0);
      }
    }
    function setError(message) {
      const error = el('tli-alert-error');
      error.textContent = message;
      error.hidden = !message;
    }
    function current(request, owner) {
      return owner === request && request.epoch === sessionEpoch && request.revision === revision && !locked && accessReady;
    }
    function validAlerts(data) {
      return data && Array.isArray(data.alerts) && data.alerts.every(alert => alert && typeof alert === 'object' && !Array.isArray(alert) &&
        (!Object.hasOwn(alert,'id') || (typeof alert.id === 'string' && !!alert.id.trim())) &&
        ['message','detail','severity'].every(key => !Object.hasOwn(alert,key) || typeof alert[key] === 'string') &&
        (!Object.hasOwn(alert,'dismissed') || typeof alert.dismissed === 'boolean')) &&
        new Set(data.alerts.filter(alert => Object.hasOwn(alert,'id')).map(alert => alert.id)).size === data.alerts.filter(alert => Object.hasOwn(alert,'id')).length;
    }
    function alertContextCurrent(context) {
      return context && context.epoch === sessionEpoch && context.generation === mutationGeneration && !locked && accessReady;
    }
    function canBeginDismissal(context) { return alertContextCurrent(context) && available && !uncertain && !mutating; }
    function beginDismissal(context) {
      if (!canBeginDismissal(context)) return null;
      const request = {epoch:sessionEpoch, revision:++revision};
      mutationGeneration++; polling = null; mutating = request; uncertain = true;
      renderAlerts();
      window.dispatchEvent(new CustomEvent('tli-alert-operation', {detail:{phase:'started'}}));
      return request;
    }
    async function settleDismissal(request, confirmed = false) {
      if (!current(request,mutating)) return;
      mutating = null; renderAlerts();
      window.dispatchEvent(new CustomEvent('tli-alert-operation', {detail:{phase:'settled'}}));
      if (confirmed) await pollAlerts(true);
    }
    async function pollAlerts(explicit = false) {
      if (locked || !accessReady || polling || mutating || (uncertain && !explicit)) return;
      const request = {epoch:sessionEpoch, revision:++revision}; polling = request;
      renderAlerts();
      try {
        const response = await fetch('/status/alerts', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) });
        if (!current(request, polling)) return;
        if (response.status === 401 || response.status === 403) { window.dispatchEvent(new CustomEvent('tli-session-locked')); return; }
        if (!response.ok) throw new Error('Alerts unavailable');
        const data = await response.json();
        if (!current(request, polling)) return;
        if (!validAlerts(data)) throw new Error('Invalid alerts');
        alerts = data.alerts.filter(alert => !alert.dismissed); available = true; uncertain = false;
        setError('');
        window.dispatchEvent(new CustomEvent('tli-alert-operation', {detail:{phase:'observed'}}));
      } catch {
        if (!current(request, polling)) return;
        alerts = []; available = false;
        setError('Could not refresh alerts. Reopen Activity to retry.');
        window.dispatchEvent(new CustomEvent('tli-alert-operation', {detail:{phase:'unavailable'}}));
      } finally { if (polling === request) { polling = null; renderAlerts(); } }
    }
    async function dismissAlerts(id, capturedEpoch = sessionEpoch, capturedRevision = revision) {
      if (capturedEpoch !== sessionEpoch || capturedRevision !== revision || locked || !accessReady || mutating) return;
      if (uncertain || !available) { if (!id) return pollAlerts(true); return; }
      if (!alerts.length || (id && !alerts.some(alert => alert.id === id))) return;
      const request = beginDismissal({epoch:sessionEpoch,generation:mutationGeneration});
      if (!request) return;
      let confirmed = false;
      try {
        const endpoint = id ? `/status/alerts/${encodeURIComponent(id)}/dismiss` : '/status/alerts/dismiss-all';
        const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(10000) });
        if (!current(request, mutating)) return;
        if (response.status === 401 || response.status === 403) { window.dispatchEvent(new CustomEvent('tli-session-locked')); return; }
        if (!response.ok) throw new Error('Dismiss failed');
        const result = await response.json();
        if (!current(request, mutating)) return;
        if (result?.ok !== true || (id ? result.dismissed !== id : !Number.isInteger(result.dismissed) || result.dismissed < 0)) throw new Error('Dismissal not confirmed');
        alerts = id ? alerts.filter(alert => alert.id !== id) : [];
        confirmed = true;
        setError('');
      } catch {
        if (!current(request, mutating)) return;
        uncertain = true;
        setError('Dismissal not confirmed; it may have completed. Check saved alerts before another dismissal.');
        if (panel.hidden) window.showToast?.('Dismissal not confirmed. Check saved alerts before another dismissal.', 'error');
      } finally {
        if (current(request,mutating)) {
          if (!panel.hidden) tabs[0].focus();
          await settleDismissal(request,confirmed);
        }
      }
    }
    el('tli-alert-dismiss-all').addEventListener('click', () => dismissAlerts());
    el('tli-drawer-dismiss-all').addEventListener('click', () => dismissAlerts());
    for (const event of ['tli-session-locked','tli-account-changed','tli-user-changed']) window.addEventListener(event, () => {
      if (mutating) uncertain = true;
      sessionEpoch++; revision++; mutationGeneration++; locked = true; accessReady = false; polling = null; mutating = null;
      alerts = []; available = false; closeActivity(); setError(''); renderAlerts();
    });
    window.addEventListener('tli-session-unlocked', () => { locked = false; renderAlerts(); });
    window.addEventListener('tli-private-observation-ready', () => {
      if (locked || accessReady) return;
      accessReady = true; renderAlerts(); pollAlerts(true);
    });
    renderAlerts();
    setTimeout(pollAlerts, 2000);
    setInterval(pollAlerts, 60000);
  });
})();
