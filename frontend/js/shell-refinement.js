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
    let polling = false;
    let mutating = false;
    let revision = 0;

    function isActivityVisible() { return !panel.hidden && selected === 1; }
    window.TLIShell = { isActivityVisible };

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
      pollAlerts();
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
        const active = !el(button.dataset.panelTarget)?.hidden;
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
      if (!alerts.length) {
        const empty = document.createElement('p');
        empty.className = 'tli-shell-empty';
        empty.textContent = 'No alerts need attention.';
        list.append(empty);
      }
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
        dismiss.disabled = mutating || !alert.id;
        dismiss.addEventListener('click', () => dismissAlerts(alert.id));
        row.append(icon, message, dismiss);
        list.append(row);
      });
    }
    function renderAlerts() {
      const badge = el('tli-alert-badge');
      badge.hidden = alerts.length === 0;
      badge.textContent = alerts.length > 99 ? '99+' : String(alerts.length);
      trigger.setAttribute('aria-label', `Activity, ${alerts.length} alerts need attention`);
      renderAlertList(el('tli-alert-list'));
      renderAlertList(el('tli-drawer-alert-list'));
      el('tli-drawer-alerts').hidden = alerts.length === 0;
      el('tli-bn-alert-dot').hidden = alerts.length === 0;
      el('tli-alert-dismiss-all').disabled = mutating || alerts.length === 0;
      el('tli-drawer-dismiss-all').disabled = mutating || alerts.length === 0;
    }
    function setError(message) {
      const error = el('tli-alert-error');
      error.textContent = message;
      error.hidden = !message;
    }
    async function pollAlerts() {
      if (polling || mutating) return;
      polling = true;
      const requestRevision = revision;
      try {
        const response = await fetch('/status/alerts', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('Alerts unavailable');
        const data = await response.json();
        if (!Array.isArray(data.alerts)) throw new Error('Invalid alerts');
        if (!mutating && requestRevision === revision) {
          alerts = data.alerts.filter(alert => !alert.dismissed);
          renderAlerts();
          setError('');
        }
      } catch {
        setError('Could not refresh alerts. Reopen Activity to retry.');
      } finally { polling = false; }
    }
    async function dismissAlerts(id) {
      if (mutating) return;
      mutating = true;
      revision++;
      renderAlerts();
      try {
        const endpoint = id ? `/status/alerts/${encodeURIComponent(id)}/dismiss` : '/status/alerts/dismiss-all';
        const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('Dismiss failed');
        alerts = id ? alerts.filter(alert => alert.id !== id) : [];
        setError('');
      } catch {
        setError('Could not dismiss alerts. Please try again.');
        if (panel.hidden) window.showToast?.('Could not dismiss alerts. Please try again.', 'error');
      } finally {
        mutating = false;
        renderAlerts();
        if (!panel.hidden) tabs[0].focus();
      }
    }
    el('tli-alert-dismiss-all').addEventListener('click', () => dismissAlerts());
    el('tli-drawer-dismiss-all').addEventListener('click', () => dismissAlerts());
    setTimeout(pollAlerts, 2000);
    setInterval(pollAlerts, 60000);
  });
})();
