/* Local small-app workflow. Generated source runs only in opaque sandbox frames.
 * No source is eval'd in TLI, and browser checks never authorize host actions. */
window.TLIWebApps = (() => {
  'use strict';
  const state = {mounted:false, locked:false, epoch:0, selection:0, busy:false, project:null, revision:0, frames:new Set(), results:[], testing:false};
  const ui = {};
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const button = (text, fn) => { const n = node('button', text, 'btn-outline'); n.type = 'button'; n.addEventListener('click', fn); return n; };
  const message = text => { if (ui.status) ui.status.textContent = text; };
  async function api(path, options) {
    if (state.locked) throw Error('Unlock TLI to use Builder.');
    const epoch = state.epoch;
    const response = await fetch('/api/builder/web-apps' + path, {cache:'no-store', headers:{'Content-Type':'application/json'}, ...options});
    if (response.status === 401) clearPrivate();
    const data = await response.json();
    if (epoch !== state.epoch || state.locked) throw Error('Workspace changed; the response was ignored.');
    if (!response.ok) throw Error(data.detail || 'Builder request failed.');
    return data;
  }
  function clearFrames() { for (const frame of state.frames) { frame.src = 'about:blank'; frame.remove(); } state.frames.clear(); }
  function clearPrivate() {
    state.locked = true; state.epoch++; state.selection++; state.project = null; state.results = []; state.busy = false; state.testing = false;
    clearFrames();
    for (const key of ['brief', 'feedback']) if (ui[key]) ui[key].value = '';
    if (ui.lan) ui.lan.checked = false;
    for (const key of ['source', 'files', 'checks', 'saved', 'versions', 'description', 'preview']) if (ui[key]) ui[key].textContent = '';
    if (ui.workspace) ui.workspace.hidden = true;
    if (ui.empty) ui.empty.hidden = false;
    message('Unlock TLI to open your app library. Unsaved drafts were cleared.'); controls();
  }
  function controls() {
    for (const key of ['build', 'revise', 'refresh', 'test', 'previewButton', 'reset']) if (ui[key]) ui[key].disabled = state.locked || state.busy || state.testing;
    if (ui.saved) ui.saved.disabled = state.locked || state.busy || state.testing;
    if (ui.versions) ui.versions.disabled = state.locked || state.busy || state.testing;
    if (ui.lan) ui.lan.disabled = state.locked || state.busy || state.testing;
    renderCompute();
  }
  function renderCompute() {
    if (!ui.lan) return;
    const selected = window.TLILanInference?.display?.();
    ui.compute.textContent = ui.lan.checked ? (selected ? 'Selected: ' + selected.peer_name + ' · ' + selected.label : 'Choose a reviewed LAN model in Ask TLI before building.') : 'Uses your current local bundled / LM Studio configuration.';
    if (!state.busy) ui.build.textContent = ui.lan.checked ? 'Build with selected LAN model' : 'Build with local AI';
  }
  function setup() {
    if (state.mounted) return true;
    const shell = document.querySelector('#panel-builder .builder-shell');
    if (!shell) return false;
    state.mounted = true;
    // Switching workspaces only changes visibility. Controllers, drafts and
    // sandbox frames stay mounted, including while a request is in progress.
    for (const child of [...shell.children]) child.setAttribute('data-builder-repository', '');
    const experienceHead = node('header', null, 'builder-experience-head');
    const title = node('div'); title.append(node('h2', 'Create'), node('p', 'Build a small browser app, or work on an existing code project.'));
    const modes = node('div', null, 'builder-workspace-switch'); modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', 'Creation workspace');
    const selectMode = mode => {
      shell.setAttribute('data-builder-workspace', mode);
      appMode.setAttribute('aria-pressed', String(mode === 'apps'));
      repoMode.setAttribute('aria-pressed', String(mode === 'repository'));
    };
    const appMode = button('Browser apps', () => selectMode('apps'));
    const repoMode = button('Repository', () => selectMode('repository'));
    appMode.id = 'builder-small-app-mode'; repoMode.id = 'builder-repository-mode';
    modes.append(appMode, repoMode); experienceHead.append(title, modes);
    shell.insertBefore(experienceHead, shell.children[0] || null); selectMode('apps');
    ui.showApps = () => selectMode('apps');
    ui.root = node('section', null, 'builder-web-apps'); ui.root.id = 'builder-web-apps';
    const briefColumn = node('div', null, 'builder-app-brief-column');
    briefColumn.append(node('span', 'HTML · CSS · JAVASCRIPT', 'builder-app-eyebrow'), node('h3', 'Build a small browser app'), node('p', 'Try a calculator, study timer, quiz, counter, or text-formatting tool. Describe how it should work, then build with your local AI.', 'builder-app-intro'));
    const label = node('label', 'What should the app do?', 'field-label'); label.htmlFor = 'builder-app-brief';
    ui.brief = node('textarea', null, 'field-input'); ui.brief.id = 'builder-app-brief'; ui.brief.rows = 3; ui.brief.maxLength = 4000;
    ui.brief.placeholder = 'Build a study timer with start, pause, reset and a clear countdown. It should work without internet.';
    const actions = node('div', null, 'builder-app-actions');
    ui.build = button('Build with local AI', build); ui.build.className = 'btn-primary';
    ui.reset = button('New app', () => { if (state.busy || state.testing || state.locked) return; if (ui.feedback.value.trim()) { message('Your repair draft is retained. Submit or clear it before starting another app.'); return; } state.selection++; state.project = null; state.revision = 0; state.results = []; clearFrames(); ui.workspace.hidden = true; ui.empty.hidden = false; message('Describe your next app. Your saved apps remain in the library.'); ui.brief.focus(); });
    actions.append(ui.build, ui.reset);
    ui.status = node('p', 'Your app files stay on this TLI host. Generation may take a few minutes.', 'builder-app-status'); ui.status.setAttribute('role', 'status');
    const expectations = node('div', null, 'builder-app-expectations');
    const quality = node('p'); quality.append(node('strong', 'Experimental. '), node('span', 'Expect to test and revise the result.'));
    const persistence = node('p'); persistence.append(node('strong', 'App files are saved. '), node('span', 'Data entered in the app resets when it reloads.'));
    expectations.append(quality, persistence);
    const scope = node('details', null, 'builder-app-options');
    scope.append(node('summary', 'Scope & reliability'),
      node('p', 'Creates plain HTML, CSS, and JavaScript with no packages or build tools. This mode does not build native Windows or phone apps, databases, accounts, or connections to websites, your files, or smart devices.', 'builder-app-note'),
      node('p', 'Results depend on the selected model and the task. File validation and AI-written browser checks do not prove the app works correctly. Try your own examples in the preview and describe failures to request a repair.', 'builder-app-note'),
      node('p', 'Already have a code project? Repository opens the separate workflow for reviewing changes to existing source files.', 'builder-app-note'));
    const limits = node('p', 'Builds HTML/CSS/JavaScript apps without package installs or server code. Preview runs separately from TLI with no TLI session or device permissions. Normal resource and fetch requests are blocked; browser sandboxing cannot guarantee zero network traffic from hostile generated code. Review source before previewing sensitive work. App state resets on reload.', 'builder-app-note');
    const options = node('details', null, 'builder-app-options'); options.append(node('summary', 'Model & preview settings'));
    const modelChoice = node('div', null, 'builder-app-note');
    const lanLabel = node('label'); ui.lan = node('input'); ui.lan.type = 'checkbox'; ui.lan.id = 'builder-app-use-lan'; ui.lan.checked = false;
    lanLabel.append(ui.lan, node('span', ' Use the LAN model selected in Ask TLI'));
    ui.compute = node('p'); ui.lan.addEventListener('change', renderCompute);
    modelChoice.append(lanLabel, ui.compute, node('p', 'When enabled, shares this app brief, source, and repair feedback with that reviewed computer; no chat history or saved notes.'));
    options.append(modelChoice, limits);
    const library = node('div', null, 'builder-app-actions');
    const savedLabel = node('label', 'Saved apps'); savedLabel.htmlFor = 'builder-app-library';
    ui.saved = node('select', null, 'field-select'); ui.saved.id = 'builder-app-library';
    ui.saved.addEventListener('change', () => load(ui.saved.value));
    ui.refresh = button('Refresh library', refresh);
    library.append(savedLabel, ui.saved, ui.refresh);
    library.className = 'builder-app-library';
    ui.workspace = node('div', null, 'builder-app-workspace'); ui.workspace.hidden = true;
    ui.description = node('p');
    ui.versions = node('select', null, 'field-select'); ui.versions.id = 'builder-app-version'; ui.versions.setAttribute('aria-label', 'Saved app version');
    ui.versions.addEventListener('change', () => { state.revision = Number(ui.versions.value); state.results = []; renderRevision(); });
    ui.download = node('a', 'Download this version', 'btn-outline');
    const outputActions = node('div', null, 'builder-app-actions');
    ui.previewButton = button('Open isolated preview', preview);
    ui.test = button('Run browser checks', runChecks);
    outputActions.append(ui.versions, ui.download, ui.previewButton, ui.test);
    ui.preview = node('div', null, 'builder-app-preview');
    ui.checks = node('div', null, 'builder-app-checks'); ui.checks.setAttribute('aria-live', 'polite');
    const checksDetails = node('details', null, 'builder-app-verification'); checksDetails.append(node('summary', 'Checks & acceptance'), ui.checks); ui.checksDetails = checksDetails;
    const sourceDetails = node('details', null, 'builder-app-source-details'); sourceDetails.append(node('summary', 'Review app files'));
    ui.files = node('div', null, 'builder-app-actions'); ui.source = node('pre'); ui.source.className = 'builder-app-source';
    sourceDetails.append(ui.files, ui.source);
    const feedbackLabel = node('label', 'What should change, or what did not work?', 'field-label'); feedbackLabel.htmlFor = 'builder-app-feedback';
    ui.feedback = node('textarea', null, 'field-input'); ui.feedback.id = 'builder-app-feedback'; ui.feedback.rows = 2; ui.feedback.maxLength = 3000;
    ui.revise = button('Repair / improve with local AI', revise);
    const repair = node('div', null, 'builder-app-repair'); repair.append(feedbackLabel, ui.feedback, ui.revise);
    ui.workspace.append(ui.description, outputActions, ui.preview, checksDetails, sourceDetails, repair);
    ui.empty = node('div', null, 'builder-app-empty');
    const fileOverview = node('ul', null, 'builder-app-file-overview');
    for (const [filename, purpose] of [['index.html', 'Structure'], ['style.css', 'Appearance'], ['app.js', 'Interaction']]) {
      const file = node('li'); file.append(node('code', filename), node('span', purpose)); fileOverview.append(file);
    }
    ui.empty.append(node('span', 'WHAT YOU GET', 'builder-app-eyebrow'), node('div', 'Three files. Yours to keep.', 'builder-app-empty-title'), fileOverview,
      node('p', 'Review the source, open the preview, and try it. Ask for changes and keep earlier versions.'),
      node('p', 'Download a ZIP, extract it, and open index.html in your browser. No app installation needed.'));
    briefColumn.append(label, ui.brief, actions, ui.status, expectations, scope, options, library);
    ui.root.append(briefColumn, ui.empty, ui.workspace);
    const hero = shell.querySelector('.builder-hero');
    shell.insertBefore(ui.root, hero || null);
    window.addEventListener('tli-session-locked', clearPrivate); window.addEventListener('pagehide', clearPrivate);
    window.addEventListener('tli-user-changed', clearPrivate); window.addEventListener('tli-account-changed', clearPrivate);
    window.addEventListener('tli-lan-inference-changed', renderCompute);
    window.addEventListener('tli-session-unlocked', () => { state.locked = false; controls(); });
    controls(); return true;
  }
  async function refresh() {
    if (!setup() || state.locked || state.busy || state.testing) return;
    try {
      const {projects} = await api(''); ui.saved.textContent = '';
      const first = node('option', 'Choose a saved app'); first.value = ''; ui.saved.append(first);
      for (const project of projects || []) { const option = node('option', project.name + (project.status === 'needs_retry' ? ' — retry available' : '')); option.value = project.id; ui.saved.append(option); }
      ui.saved.value = state.project?.id || '';
    } catch (error) { if (!state.locked) message(error.message); }
  }
  async function load(id) {
    if (!id || state.locked || state.busy || state.testing) return;
    // Do not replace an unsent repair or new brief by opening a saved app.
    if (ui.feedback.value.trim()) { message('Your repair draft is retained. Submit or clear it before switching apps.'); return; }
    const ticket = ++state.selection;
    try { const {project} = await api('/' + encodeURIComponent(id)); if (ticket === state.selection && !state.busy) accept(project); }
    catch (error) { if (!state.locked && ticket === state.selection) message(error.message); }
  }
  async function build() {
    if (state.locked || state.busy || state.testing) return;
    const brief = ui.brief.value.trim(); if (!brief) { message('Describe what your app should do.'); return; }
    await generate('', {brief}, () => { if (ui.brief.value.trim() === brief) ui.brief.value = ''; });
  }
  async function revise() {
    if (!state.project || state.locked || state.busy || state.testing) return;
    if (state.revision !== state.project.revisions.length) { message('Select the latest saved version before repairing. Older versions remain available to preview and download.'); return; }
    const raw = ui.feedback.value;
    const failures = state.results.filter(item => !item.passed).map(item => item.name + ': ' + item.error).join('\n');
    const feedback = (raw + (failures ? '\nObserved browser check failures:\n' + failures : '')).slice(0, 4000);
    if (!feedback.trim() && state.project.status !== 'needs_retry' && state.project.status !== 'generating') { message('Describe the improvement or run browser checks to collect a failure.'); return; }
    await generate('/' + encodeURIComponent(state.project.id) + '/revise', {feedback, expected_revision:state.project.revisions.length}, () => { if (ui.feedback.value === raw) ui.feedback.value = ''; });
  }
  async function generate(path, body, consume) {
    let lan = null, ticket = null, selection = null;
    if (ui.lan.checked) {
      try {
        lan = window.TLILanInference;
        if (!lan) throw Error('LAN model selection is unavailable. Choose Local or reopen Ask TLI.');
        ticket = lan.capture(); selection = lan.request(ticket, {});
        if (!selection) throw Error('Choose a reviewed LAN model in Ask TLI first. Nothing was sent.');
        body = {...body, lan_inference:selection};
      } catch (error) { message(error.message); return; }
    }
    state.busy = true; state.selection++; controls(); const epoch = state.epoch;
    message('Generating with ' + (selection ? 'your selected LAN model' : 'your local model') + '. The brief is saved first; reopening the library recovers the result if this page closes.');
    try {
      const {project} = await api(path, {method:'POST', body:JSON.stringify(body)});
      if (ticket && (!lan.isCurrent(ticket) || JSON.stringify(lan.request(lan.capture(), {})) !== JSON.stringify(selection))) throw Error('The selected computer or model changed. Reopen the saved app from the library to review the result.');
      accept(project); if (project.status !== 'needs_retry') consume();
    } catch (error) { if (!state.locked) message(error.message + ' Your draft is retained. Refresh the library before retrying a request whose result is uncertain.'); }
    finally { if (epoch === state.epoch) { state.busy = false; controls(); await refresh(); } }
  }
  function accept(project) {
    state.project = project; state.revision = project.revisions.length; state.results = []; clearFrames();
    ui.workspace.hidden = false; ui.empty.hidden = true; ui.versions.textContent = '';
    for (const revision of project.revisions) { const option = node('option', 'Version ' + revision.revision); option.value = String(revision.revision); ui.versions.append(option); }
    ui.versions.value = String(state.revision); renderRevision();
    message(project.last_error ? project.last_error + ' The brief and previous versions are saved. Retry explicitly below.' : project.status === 'generating' ? 'Generation is in progress or was interrupted. Refresh the library; retry explicitly if it remains unfinished.' : 'Version saved. Open the preview, run browser checks, and try the manual acceptance steps.');
  }
  function current() { return state.project?.revisions[state.revision - 1]; }
  function renderRevision() {
    clearFrames(); ui.preview.textContent = ''; ui.source.textContent = ''; ui.files.textContent = '';
    const revision = current();
    if (revision) ui.preview.append(node('p', 'Your version is saved. Choose Open isolated preview to try it.', 'builder-app-preview-prompt'));
    ui.description.textContent = state.project.name + ' — ' + (revision?.summary || state.project.brief);
    ui.previewButton.hidden = ui.test.hidden = ui.download.hidden = !revision;
    ui.revise.textContent = state.project.status === 'needs_retry' || state.project.status === 'generating' ? 'Retry with local AI' : 'Repair / improve with local AI';
    if (!revision) { ui.checks.textContent = 'No valid app files yet.'; return; }
    ui.download.href = '/api/builder/web-apps/' + encodeURIComponent(state.project.id) + '/download?revision=' + revision.revision;
    ui.download.setAttribute('download', '');
    for (const [name, content] of Object.entries(revision.files)) ui.files.append(button(name, () => { ui.source.textContent = content; }));
    ui.source.textContent = revision.files['index.html']; renderChecks();
  }
  function renderChecks() {
    const revision = current(); ui.checks.textContent = ''; if (!revision) return;
    ui.checks.append(node('strong', 'Verification'));
    ui.checks.append(node('p', 'Static checks passed: ' + revision.validation.checks.join('; ') + '. Model: ' + revision.backend + '.'));
    ui.checks.append(node('p', state.results.length ? 'Advisory browser smoke checks run with generated code. Their results are not independent proof of correctness or security:' : 'Browser behavior has not been checked for this version. Model-generated smoke checks are advisory; verify the app yourself.'));
    const results = node('ul'); for (const result of state.results) results.append(node('li', (result.passed ? 'PASS — ' : 'FAIL — ') + result.name + (result.error ? ': ' + result.error : ''))); ui.checks.append(results);
    ui.checks.append(node('p', 'Try these acceptance steps yourself:'));
    const manual = node('ol'); for (const step of revision.manual_checks) manual.append(node('li', step)); ui.checks.append(manual);
    if (state.results.some(item => !item.passed)) ui.checks.append(node('p', 'Repair includes these observed failures and your feedback. The previous version stays saved.'));
  }
  function frameFor(revision, check, host) {
    const frame = node('iframe'); frame.title = check ? 'Isolated app check' : 'Generated app preview';
    frame.setAttribute('sandbox', 'allow-scripts'); frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");
    const token = 'tli' + crypto.randomUUID().replaceAll('-', '');
    frame.src = '/api/builder/web-apps/' + encodeURIComponent(state.project.id) + '/preview?revision=' + revision.revision + '&token=' + token + (check ? '&check_index=' + revision.checks.indexOf(check) : '');
    state.frames.add(frame); host.append(frame);
    return {frame, token};
  }
  function preview() {
    if (!current() || state.locked || state.busy || state.testing) return;
    clearFrames(); ui.preview.textContent = ''; frameFor(current(), null, ui.preview);
    message('Isolated preview open. Try the app, then run the browser checks. Reloading the preview resets its in-memory state.');
  }
  async function runChecks() {
    const revision = current(); if (!revision || state.locked || state.busy || state.testing) return;
    state.testing = true; state.results = []; controls(); const epoch = state.epoch;
    ui.checksDetails.open = true;
    message('Running each browser check in a fresh isolated app. No commands run on the host.');
    try {
      for (const check of revision.checks) {
        if (epoch !== state.epoch || state.locked) return;
        const host = node('div'); host.hidden = true; ui.root.append(host);
        const {frame, token} = frameFor(revision, check, host);
        const result = await new Promise(resolve => {
          const finish = data => { clearTimeout(timer); window.removeEventListener('message', receive); frame.src = 'about:blank'; state.frames.delete(frame); host.remove(); resolve(data); };
          const receive = event => { if (event.source === frame.contentWindow && event.data?.tliAppPreview === token) finish({passed:event.data.passed === true,error:String(event.data.error || '').slice(0,500)}); };
          const timer = setTimeout(() => finish({passed:false,error:'No check result within 8 seconds (load, script, or sandbox failure).'}), 8000);
          window.addEventListener('message', receive);
        });
        if (epoch !== state.epoch || state.locked) return;
        state.results.push({name:check.name,...result}); renderChecks();
      }
      message(state.results.every(item => item.passed) ? 'Browser checks passed. Review the manual acceptance steps before treating the app as finished.' : 'Some browser checks failed. Use Repair to send these failures and your feedback to the local model.');
    } finally { if (epoch === state.epoch) { state.testing = false; controls(); } }
  }
  function prepareRequest(text = '') {
    if (!setup() || state.locked || state.busy || state.testing) return false;
    ui.showApps();
    const brief = String(text).trim();
    if (brief && (ui.brief.value.trim() || ui.feedback.value.trim() || state.project)) { message('Your current app or draft is retained. Use New app and paste the next brief when you are ready.'); return false; }
    if (brief) ui.brief.value = brief.slice(0, 4000);
    if (brief) ui.brief.focus(); return true;
  }
  async function open(text = '') {
    if (!setup() || state.locked || state.busy || state.testing) return false;
    const epoch = state.epoch; await refresh();
    if (epoch !== state.epoch || state.locked) return false;
    if (!prepareRequest(text)) return false;
    ui.root.scrollIntoView?.({behavior:'smooth',block:'start'}); return true;
  }
  return {setup, onOpen:refresh, open, prepareRequest};
})();
