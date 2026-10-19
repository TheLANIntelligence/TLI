/* Explicit, session-scoped model selection on reviewed TLI computers. */
(function () {
  'use strict';
  const protocol = 'tli-peer-inference-v1';
  let generation = 0, epoch = 0, locked = document.getElementById('tli-lock-screen')?.getAttribute?.('aria-hidden') === 'false', busy = false;
  let historyReady = !locked;
  let selection = null, checked = null, peers = [], ui = null, pending = null;
  const node = (tag, text) => { const el = document.createElement(tag); if (text != null) el.textContent = text; return el; };
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
  const revision = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const current = ticket => !locked && ticket === epoch;
  const historyAvailable = () => !locked && historyReady && window.TLIConversationLoad?.canRead?.() !== false;
  function denyHistory() { historyReady = false; reset(true); window.dispatchEvent(new CustomEvent('tli-session-locked')); }
  const selectionFields = value => ({ peer_id: value.peer_id, trust_revision: value.trust_revision,
    resource_id: value.resource_id, resource_revision: value.resource_revision });

  function option(value, label) { const el = node('option', label); el.value = value; return el; }
  function notice(value) { if (ui) ui.notice.textContent = value; }
  function changed() {
    const banner = document.getElementById('tli-no-ai-banner');
    if (banner) banner.style.display = selection ? 'none' : '';
    window.dispatchEvent(new CustomEvent('tli-lan-inference-changed'));
  }
  function render() {
    if (!ui) return;
    ui.summary.textContent = selection ? `AI: ${selection.peer_name} · ${selection.label}` : 'AI: Local / current setup';
    ui.load.disabled = locked || busy;
    ui.peer.disabled = locked || busy || !peers.length;
    ui.check.disabled = locked || busy || !peers.some(peer => peer.id === ui.peer.value);
    ui.resource.disabled = locked || busy || !checked?.resources.length;
    ui.use.disabled = locked || busy || !checked?.resources.some(resource => resource.id === ui.resource.value);
    ui.local.disabled = locked;
  }
  function invalidate() { epoch++; pending?.abort(); pending = null; busy = false; }
  function clearChecked() {
    checked = null;
    ui?.resource.replaceChildren(option('', 'Check a computer to see its models'));
    if (ui) ui.resource.value = '';
  }
  function reset(isLocked = locked) {
    generation++; invalidate(); locked = isLocked; selection = null; peers = []; clearChecked();
    if (ui) { ui.peer.replaceChildren(option('', 'Choose a trusted computer')); ui.peer.value = ''; ui.details.open = false; }
    notice(locked ? 'Unlock TLI to choose a computer.' : 'Your current AI setup is selected. No computer has been contacted.'); render(); changed();
  }
  async function api(path, body, ticket) {
    const controller = new AbortController(); pending = controller;
    const response = await fetch('/api/ai/lan/' + path, {
      method: body ? 'POST' : 'GET', cache: 'no-store', signal: controller.signal,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    if (!current(ticket)) return null;
    if (response.status === 401) { reset(true); window.dispatchEvent(new CustomEvent('tli-session-locked')); return null; }
    const data = await response.json();
    if (!current(ticket)) return null;
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : data.detail?.message || `Computer request failed (${response.status}).`);
    if (data.protocol !== protocol) throw new Error('Update both TLI computers before using LAN inference. Your AI choice has not changed.');
    return data;
  }
  async function run(work) {
    if (locked || busy) return;
    const ticket = ++epoch; busy = true; render();
    try { await work(ticket); }
    catch (error) { if (current(ticket)) notice(error.message || 'The computer could not be checked.'); }
    finally { if (current(ticket)) { pending = null; busy = false; render(); } }
  }
  function loadPeers() {
    return run(async ticket => {
      notice('Reading the reviewed computer list from this TLI host…');
      const data = await api('peers', null, ticket); if (!data) return;
      if (!Array.isArray(data.peers) || data.peers.length > 256 || data.peers.some(peer => !text(peer.id) || !text(peer.name)) || new Set(data.peers.map(peer => peer.id)).size !== data.peers.length) throw new Error('The host returned an invalid computer list.');
      peers = data.peers; clearChecked();
      ui.peer.replaceChildren(option('', 'Choose a trusted computer'), ...peers.map(peer => option(peer.id, `${peer.name} · ${peer.id.slice(0, 12)}`)));
      ui.peer.value = '';
      notice(peers.length ? 'Choose a computer, then check its models. Listing computers does not contact them.' : 'No computer has reviewed inference access. Open Computers and review computer trust on both hosts, enabling inference.');
    });
  }
  function checkModels() {
    const peer = peers.find(value => value.id === ui.peer.value); if (!peer) return Promise.resolve();
    return run(async ticket => {
      clearChecked(); notice(`Checking models on ${peer.name}…`);
      const data = await api('models', { peer_id: peer.id }, ticket); if (!data) return;
      if (data.peer?.id !== peer.id || !text(data.peer.name) || !revision(data.trust_revision) ||
          !Array.isArray(data.resources) || data.resources.length > 64 ||
          data.resources.some(resource => !revision(resource.id) || !revision(resource.revision) || !text(resource.model_id) || !text(resource.label)) ||
          new Set(data.resources.map(resource => resource.id)).size !== data.resources.length) throw new Error('The computer returned an invalid model list. Check it again before choosing a model.');
      checked = data;
      ui.resource.replaceChildren(option('', 'Choose a checked model'), ...data.resources.map(resource => option(resource.id, resource.label)));
      ui.resource.value = '';
      notice(data.resources.length ? `Models checked on ${data.peer.name}. Select a model and choose Use this model to share future questions with it.` : `No supported running model was found on ${data.peer.name}. Your current AI choice is unchanged.`);
    });
  }
  async function persistChoice(value, ticket) {
    const id = window.currentConversationId;
    const navigation = window.TLIConversationLoad?.generation;
    const allowed = () => current(ticket) && window.currentConversationId === id && window.TLIConversationLoad?.generation === navigation && !window.TLIConversationLoad?.loading;
    const assertCurrent = () => { if (!allowed()) throw Error('The conversation or session changed. Reopen it to review its AI selection.'); };
    assertCurrent();
    if (!id || !window.TLIWorkspace) return;
    if (!historyAvailable()) throw Error('Unlock TLI and verify access before reading conversation settings.');
    const supported = await window.TLIWorkspace.supported();
    assertCurrent();
    if (!supported) return;
    const path = '/api/ai/conversations/' + encodeURIComponent(id) + '/settings';
    const existing = await fetch(path, {cache:'no-store'});
    assertCurrent();
    if (existing.status === 401 || existing.status === 403) { denyHistory(); throw Error('Unlock TLI and verify access before reading conversation settings.'); }
    const settings = await existing.json();
    assertCurrent();
    if (!existing.ok) throw Error(settings.detail || 'Could not check conversation settings.');
    if (!Number.isInteger(settings.settings_revision) || settings.settings_revision < 0) throw Error('The conversation settings are invalid. Reload the conversation before choosing AI.');
    const response = await fetch(path, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({compute_selection:value ? selectionFields(value) : null,expected_settings_revision:settings.settings_revision})});
    const saved = await response.json();
    assertCurrent();
    if (!response.ok) throw Error(saved.detail || 'The conversation AI choice could not be saved.');
  }
  async function prepareConversation(id, options = {}) {
    if (!historyAvailable()) return () => false;
    invalidate(); const ticket = epoch;
    const allowed = () => current(ticket) && historyAvailable() && options.current?.() !== false;
    if (!allowed()) return () => false;
    busy = true; render();
    try {
      if (!window.TLIWorkspace) return () => allowed();
      const supported = await window.TLIWorkspace.supported();
      if (!allowed()) return () => false;
      if (!supported) return () => allowed();
      const controller = new AbortController(); pending = controller;
      const response = await fetch('/api/ai/conversations/' + encodeURIComponent(id) + '/settings', {cache:'no-store',signal:controller.signal});
      if (!allowed()) return () => false;
      if (response.status === 401 || response.status === 403) { denyHistory(); return () => false; }
      const value = await response.json();
      if (!allowed()) return () => false;
      if (!response.ok) throw Error(value.detail || 'Could not load the conversation AI choice.');
      const saved = value.compute_selection;
      if (!Number.isInteger(value.settings_revision) || value.settings_revision < 0 || saved !== null && (!saved || !text(saved.peer_id) || !revision(saved.trust_revision) || !revision(saved.resource_id) || !revision(saved.resource_revision))) throw Error('The saved AI selection is invalid.');
      return () => {
        if (!allowed()) return false;
        selection = saved ? {...saved, peer_name:saved.peer_id, label:'Saved LAN model'} : null;
        clearChecked(); render(); changed();
        notice(selection ? 'This conversation uses its saved LAN model. Trust and resource versions are checked when sending.' : 'This conversation uses the current local AI setup.');
        return true;
      };
    } catch (error) {
      if (allowed() && (error.status === 401 || error.status === 403)) { denyHistory(); return () => false; }
      throw error;
    } finally { if (current(ticket)) { pending = null; busy = false; render(); } }
  }
  async function choose() {
    if (locked || busy || !checked || checked.peer.id !== ui.peer.value) return;
    const resource = checked.resources.find(value => value.id === ui.resource.value); if (!resource) return;
    const next = { peer_id: checked.peer.id, trust_revision: checked.trust_revision,
      resource_id: resource.id, resource_revision: resource.revision, peer_name: checked.peer.name, label: resource.label };
    const ticket = epoch; busy = true; render();
    try { await persistChoice(next, ticket); if (!current(ticket)) return; selection = next; }
    catch (error) { if (current(ticket)) notice(error.message); return; }
    finally { if (current(ticket)) { busy = false; render(); } }
    notice(`Future text questions use ${selection.label} on ${selection.peer_name}. History and saved notes follow your Context choices. Shelly and other device actions stay on this TLI host.`);
    render(); changed();
  }
  async function useLocal() {
    if (locked) return;
    invalidate(); const ticket = epoch; busy = true; render();
    try { await persistChoice(null, ticket); if (!current(ticket)) return; selection = null; clearChecked(); }
    catch (error) { if (current(ticket)) notice(error.message); return; }
    finally { if (current(ticket)) { busy = false; render(); } }
    notice('Your current AI setup is selected. No LAN model will be selected by this control.'); render(); changed();
  }
  function capture() { return { generation, selection: selection ? selectionFields(selection) : null }; }
  function isCurrent(ticket) { return !locked && ticket?.generation === generation; }
  function request(ticket, context = {}, options = {}) {
    if (!isCurrent(ticket)) throw new Error('Your TLI session changed. Choose the computer again before sending.');
    if (!ticket.selection) return null;
    if (options.image || context.note_refs?.length || context.documents?.length || context.case_ref || context.diagnostic_id || context.target_id || context.screenshot || context.screenshot_id || /\[vault:/i.test(options.message || '')) {
      throw new Error('LAN inference currently accepts ordinary text with your conversation and saved-note settings. Remove attached or selected context, or choose Local / current setup. Nothing was sent.');
    }
    return selectionFields(ticket.selection);
  }
  function annotateReply(bubble, metadata) {
    const model = metadata?.model || metadata?.model_used;
    const host = metadata?.inference_host?.name || (typeof metadata?.host === 'string' ? metadata.host : metadata?.host?.name || metadata?.host?.node_name);
    if (!bubble || !text(model) || !text(host)) return;
    const receipt = node('div', `AI model: ${model} · ${host}`);
    receipt.className = 'memory-meta'; bubble.append(receipt);
  }
  function install() {
    const mount = document.getElementById('chat-lan-inference'); if (!mount || ui) return;
    const details = node('details'), summary = node('summary', 'AI: Local / current setup');
    details.className = 'chat-options'; summary.style.overflowWrap = 'anywhere'; details.append(summary);
    const body = node('div'); Object.assign(body.style, { display: 'grid', gap: '8px', padding: '10px 0', maxWidth: '100%', overflowWrap: 'anywhere', fontSize: '13px' });
    const button = (id, label, action) => { const el = node('button', label); el.id = id; el.type = 'button'; el.className = 'chip-button'; el.addEventListener('click', action); return el; };
    const row = () => { const el = node('div'); Object.assign(el.style, { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', minWidth: '0' }); body.append(el); return el; };
    const field = (parent, label, id) => { const wrap = node('label'), el = node('select'); el.id = id; el.style.maxWidth = '100%'; Object.assign(wrap.style, { minWidth: '0', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px' }); wrap.append(node('span', label), el); parent.append(wrap); return el; };
    const local = button('lan-inference-local', 'Use Local / current setup', useLocal);
    const load = button('lan-inference-load', 'List trusted computers', loadPeers); row().append(local, load);
    const computerRow = row(), peer = field(computerRow, 'Computer ', 'lan-inference-peer'); peer.append(option('', 'Choose a trusted computer'));
    const check = button('lan-inference-check', 'Check this computer’s models', checkModels); computerRow.append(check);
    const modelRow = row(), resource = field(modelRow, 'Model ', 'lan-inference-resource'); resource.append(option('', 'Check a computer to see its models'));
    const use = button('lan-inference-use', 'Use this model', choose); modelRow.append(use);
    const disclosure = node('p', 'Choosing a LAN model shares your question and any history or saved notes enabled in Context with that computer. Text only; attached images, documents and selected reports are not supported yet. The model generates replies; Shelly and other device actions remain on this TLI host.');
    disclosure.className = 'muted'; body.append(disclosure);
    const status = node('p'); status.id = 'lan-inference-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); body.append(status);
    details.append(body); mount.append(details);
    ui = { details, summary, load, local, peer, check, resource, use, notice: status };
    peer.addEventListener('change', () => { if (locked || busy) return; invalidate(); clearChecked(); notice('Check the selected computer before choosing a model. Your current AI choice is unchanged.'); render(); });
    resource.addEventListener('change', render);
    notice('Your current AI setup is selected. No computer has been contacted.'); render();
  }
  window.TLILanInference = { capture, isCurrent, request, annotateReply, prepareConversation,
    display: () => !locked && selection ? { peer_name: selection.peer_name, label: selection.label } : null };
  window.addEventListener('tli-session-locked', () => { historyReady = false; reset(true); });
  window.addEventListener('tli-session-unlocked', () => reset(false));
  for (const event of ['tli-user-changed', 'tli-account-changed', 'pagehide']) window.addEventListener(event, () => { historyReady = false; reset(true); });
  window.addEventListener('tli-private-observation-ready', () => { if (!locked) historyReady = true; });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
})();
