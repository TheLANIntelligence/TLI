/* First-run welcome. Server completion is authoritative; optional setup stays optional. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const SEEN = 'tli_onboard_seen_v1', FORCE = 'tli_force_onboard_once', DRAFT = 'tli_onboard_progress_v3';
  const read = (store, key) => { try { return store.getItem(key); } catch { return null; } };
  const write = (store, key, value) => { try { value === null ? store.removeItem(key) : store.setItem(key, value); } catch {} };
  if (read(localStorage, SEEN) !== '1' || read(localStorage, FORCE) === '1') document.documentElement.dataset.tliOnboard = '1';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const steps = [
    ['Welcome to your next idea.', 'A question, a plan, a spark of something new. TLI gives you a private place to think, learn, write and create.'],
    ['Make yourself at home.', 'Give this computer a familiar name and choose a look that feels like you.'],
    ['Your space. Your access.', 'Choose how people can open TLI on this host. You can change this later in Settings.'],
    ['Bring your AI to life.', 'Use a model you already have, or download one if you need it. You can finish welcome setup offline and set up AI later.'],
    ['Where shall we begin?', 'Your workspace is taking shape. Choose your first stop; everything else will be here when you need it.'],
  ];
  let overlay, step = 0, epoch = 0, open = false, busy = false, initializing = false, blocked = false;
  let started = false, completed = false, locked = false, timer, previousFocus, previousOverflow;
  let name = '', savedName = '', security = 'pin', pinEnabled = false, pinNeedsVerify = false;
  let selectedModel = '', presets = [], ai = null, download = null, destination = '', aiOperation = false, refreshSerial = 0;
  const isolated = new Map();
  let resume;
  const MUSIC = 'tli_onboard_music_v1';
  let music, musicMuted = false, musicVolume = .25, musicState = 'idle';
  let musicEligible = false, musicAttempted = false, musicSuspended = false, musicPending = false, musicRequest = 0;

  function saveMusic() { write(localStorage, MUSIC, JSON.stringify({muted:musicMuted, volume:musicVolume})); }
  function musicAllowed() { return musicEligible && open && !locked && !document.hidden; }
  function musicControls() {
    if (!music) return;
    const playing = musicState === 'playing' && !music.paused && !musicMuted && musicVolume > 0 && musicAllowed();
    const active = musicPending || (!music.paused && musicAllowed());
    const text = musicMuted || musicVolume === 0 ? 'Music is off' : {
      idle:'Your welcome soundtrack', starting:'Starting your soundtrack…', playing:'Welcome soundtrack · playing',
      buffering:'Waiting for the soundtrack…', blocked:'Press play to listen', paused:'Paused · press play to resume',
      ended:'Soundtrack finished', error:'Music unavailable · try again',
    }[musicState];
    $('onboard-music-toggle').setAttribute('aria-pressed', String(playing));
    $('onboard-music-toggle').setAttribute('aria-label', active ? 'Pause onboarding music' : 'Play onboarding music');
    $('onboard-music-label').textContent = active ? 'Pause music' : musicState === 'ended' ? 'Replay music' : 'Play music';
    $('onboard-music-status').textContent = text || 'Your welcome soundtrack';
    $('onboard-music-toggle').disabled = locked || !musicEligible;
    $('onboard-music-volume').disabled = locked || !musicEligible;
    const percent = Math.round(musicVolume * 100);
    $('onboard-music-volume').value = String(percent);
    $('onboard-music-volume').setAttribute('aria-valuetext', `${percent} percent`);
    $('onboard-music-level').textContent = `${percent}%`;
  }
  function pauseMusic() {
    if (!music) return;
    musicSuspended = true; musicRequest++; musicPending = false;
    music.pause();
    if (musicState !== 'ended') musicState = 'paused';
    musicControls();
  }
  function playMusic({gesture = false, explicit = false} = {}) {
    if (!music || !musicAllowed() || (musicSuspended && !gesture)) return;
    if (!explicit && (musicMuted || musicVolume === 0 || musicState === 'ended')) return;
    if (explicit) {
      musicMuted = false;
      if (musicVolume === 0) musicVolume = .25;
      if (music.ended) music.currentTime = 0;
      saveMusic();
    }
    music.muted = musicMuted; music.volume = musicVolume;
    if (!music.paused || musicPending) { musicControls(); return; }
    musicSuspended = false; musicPending = true; musicState = 'starting';
    const ticket = ++musicRequest;
    musicControls();
    const failed = error => {
      if (ticket !== musicRequest) return;
      musicPending = false;
      musicState = error?.name === 'NotAllowedError' ? 'blocked' : 'error';
      musicControls();
    };
    // Keep play() in the click/input call stack, before setup's first await.
    try {
      if (music.error) music.load();
      const attempt = music.play();
      Promise.resolve(attempt).then(() => {
        if (ticket !== musicRequest) return;
        musicPending = false;
        if (!musicAllowed() || musicMuted || musicVolume === 0 || musicSuspended) { pauseMusic(); return; }
        musicState = music.paused ? 'paused' : 'playing'; musicControls();
      }, failed);
    } catch (error) { failed(error); }
  }
  function initMusic() {
    music = $('onboard-music-audio'); if (!music) return;
    try {
      const saved = JSON.parse(read(localStorage, MUSIC) || '{}');
      musicMuted = saved.muted === true;
      if (typeof saved.volume === 'number' && Number.isFinite(saved.volume)) musicVolume = Math.min(1, Math.max(0, saved.volume));
    } catch {}
    music.volume = musicVolume; music.muted = musicMuted;
    $('onboard-music-toggle').addEventListener('click', () => {
      if (musicPending || !music.paused) { musicMuted = true; music.muted = true; saveMusic(); pauseMusic(); }
      else playMusic({gesture:true, explicit:true});
    });
    $('onboard-music-volume').addEventListener('input', event => {
      musicVolume = Number(event.target.value) / 100;
      musicMuted = musicVolume === 0; music.volume = musicVolume; music.muted = musicMuted; saveMusic();
      if (musicMuted) pauseMusic(); else playMusic({gesture:true, explicit:true});
      musicControls();
    });
    music.addEventListener('playing', () => {
      if (!musicAllowed() || musicMuted || musicVolume === 0 || musicSuspended) { pauseMusic(); return; }
      musicState = 'playing'; musicControls();
    });
    music.addEventListener('pause', () => {
      if (!musicPending && !['error','blocked','ended'].includes(musicState)) musicState = 'paused';
      musicControls();
    });
    music.addEventListener('waiting', () => { if (musicAllowed() && !music.paused) {musicState = 'buffering'; musicControls();} });
    music.addEventListener('ended', () => {musicRequest++; musicPending = false; musicState = 'ended'; musicControls();});
    music.addEventListener('error', () => {musicRequest++; musicPending = false; musicState = 'error'; musicControls();});
    musicControls();
  }

  async function request(url, body, timeout = 15000) {
    const controller = new AbortController(), alarm = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
        credentials: 'same-origin', signal: controller.signal,
        ...(body === undefined ? {} : {headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)}) });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || (body !== undefined && data.ok !== true)) {
        throw new Error(typeof data?.detail === 'string' ? data.detail : typeof data?.error === 'string' ? data.error : `TLI could not confirm this request (${response.status}). Try again.`);
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Your TLI host is taking longer than expected. Check that it is running and try again.');
      throw error;
    } finally { clearTimeout(alarm); }
  }
  function status(message = '', error = false) {
    $('tli-onboard-status').textContent = message;
    $('tli-onboard-status').classList.toggle('onboard-error', error);
  }
  function remember() {
    // Never persist PINs or credentials. Server started state gates restoring this draft.
    write(sessionStorage, DRAFT, JSON.stringify({step, name, security, selectedModel, destination}));
  }
  function current(ticket) { return open && !locked && ticket === epoch; }
  function controls() {
    $('tli-onboard-next').disabled = busy || initializing || locked;
    $('tli-onboard-back').disabled = step === 0 || busy || initializing || locked;
    $('tli-onboard-close').disabled = busy || initializing || locked;
    overlay.setAttribute('aria-busy', String(busy || initializing));
    musicControls();
  }
  function isolate(value) {
    for (const child of document.body.children) {
      if (child === overlay || child.id === 'tli-lock-screen' || ['SCRIPT','LINK','STYLE'].includes(child.tagName)) continue;
      if (value && !isolated.has(child)) { isolated.set(child, child.inert); child.inert = true; }
    }
    if (!value) { for (const [child, was] of isolated) child.inert = was; isolated.clear(); }
  }
  function show() {
    if (open) return;
    open = true; previousFocus = document.activeElement; previousOverflow = document.body.style.overflow;
    overlay.classList.remove('hidden'); overlay.setAttribute('aria-hidden', 'false');
    document.documentElement.dataset.tliOnboard = '1'; document.body.style.overflow = 'hidden';
    if (resume) resume.hidden = true;
    overlay.inert = locked;
    isolate(true);
  }
  function hide() {
    open = false; epoch++; clearTimeout(timer); remember();
    pauseMusic();
    overlay.classList.add('hidden'); overlay.setAttribute('aria-hidden', 'true');
    delete document.documentElement.dataset.tliOnboard; isolate(false);
    document.body.style.overflow = previousOverflow || '';
    if (previousFocus?.isConnected && previousFocus !== document.body) previousFocus.focus();
  }
  function pause() {
    if (busy || initializing || locked) return;
    hide();
    if (!completed) {
      if (!resume) {
        resume = document.createElement('aside'); resume.className = 'onboard-resume'; resume.setAttribute('aria-label', 'Continue TLI setup');
        const text = document.createElement('span'); text.textContent = 'Your welcome setup is saved for later.';
        const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Continue setup'; button.addEventListener('click', () => launch(false));
        resume.append(text, button); document.body.append(resume);
      }
      resume.hidden = false; resume.querySelector('button').focus();
    }
  }
  function render(persist = true) {
    epoch++; clearTimeout(timer); if (persist) remember();
    const [title, text] = steps[step];
    $('tli-onboard-step-title').textContent = title; $('tli-onboard-step-text').textContent = text;
    $('onboard-step-count').textContent = `STEP ${String(step + 1).padStart(2, '0')} / 05`;
    $('tli-onboard-bar').style.width = `${(step + 1) * 20}%`;
    overlay.dataset.step = String(step);
    overlay.querySelectorAll('[data-onboard-step]').forEach(item => {
      const n = Number(item.dataset.onboardStep); item.classList.toggle('is-complete', n < step);
      if (n === step) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
    });
    $('tli-onboard-next').textContent = ['Let’s begin', 'Save & continue', 'Continue', 'Continue', 'Open TLI'][step];
    $('onboard-footer-note').textContent = ['A few simple steps. At your pace.', 'Make it yours. Change it anytime.', 'You stay in control.', 'You can set up AI later.', 'Welcome to TLI.'][step];
    const dyn = $('tli-onboard-dyn'); dyn.replaceChildren(); status(); controls();
    [welcome, personalize, access, intelligence, begin][step](dyn);
    overlay.querySelector('.onboarding-content').scrollTop = 0;
    if (!locked) $('tli-onboard-step-title').focus({preventScroll:true});
  }
  function welcome(dyn) {
    dyn.innerHTML = `<div class="onboard-features">
      <div class="onboard-feature"><span class="onboard-icon" aria-hidden="true">01</span><h3>Think it through</h3><p>Ask anything. Untangle an idea, learn something new or plan your next move.</p></div>
      <div class="onboard-feature"><span class="onboard-icon" aria-hidden="true">02</span><h3>Make something</h3><p>Find the words, explore code or turn an idea into a small web app.</p></div>
      <div class="onboard-feature"><span class="onboard-icon" aria-hidden="true">03</span><h3>Connect your world</h3><p>Bring in files, computers and supported home devices when you choose.</p></div>
    </div><p class="onboard-note">Welcome setup works offline. Bring your own local AI, download a model when you choose, or explore first.</p>`;
  }
  function personalize(dyn) {
    dyn.innerHTML = `<div class="onboard-field"><label for="onboard-node-name">What should we call this computer?</label><input id="onboard-node-name" type="text" maxlength="48" autocomplete="off" placeholder="e.g. Studio, Office PC, My laptop" value="${esc(name)}" aria-describedby="onboard-name-hint"><p id="onboard-name-hint">A familiar name for your workspace and connected computers. Leave blank to keep the current name.</p></div><h3>Set the mood</h3><div class="onboard-theme-options" aria-label="Workspace theme"></div><p class="onboard-note" id="onboard-theme-note">Colors save in this browser. Explore the full collection in Settings.</p>`;
    $('onboard-node-name').addEventListener('input', event => {name = event.target.value; remember();});
    for (const id of ['emeraldLight', 'midnight', 'porcelainLight', 'pacific']) {
      const theme = window.TLIThemes?.themes.find(t => t.id === id); if (!theme) continue;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'onboard-theme';
      button.dataset.onboardTheme = id; button.dataset.theme = id;
      button.innerHTML = `<span class="onboard-preview" aria-hidden="true"><i></i><i></i><i></i></span><strong>${esc(theme.name)}</strong><small>${esc(theme.tone)} appearance</small>`;
      button.addEventListener('click', () => {
        const select = $('settings-theme');
        if (!select) { status('Appearance is unavailable. Choose a theme later in Settings.', true); return; }
        select.value = id; select.dispatchEvent(new Event('change', {bubbles:true}));
        let saved = null; try { saved = JSON.parse(localStorage.getItem('tli_settings') || '{}'); } catch {}
        status(saved?.defaultTheme === id && saved?.appearanceMode === 'theme' ? 'Theme saved for this browser.' : 'This theme could not be saved. Try again in Settings.', saved?.defaultTheme !== id);
        syncThemes();
      });
      dyn.querySelector('.onboard-theme-options').append(button);
    }
    syncThemes();
  }
  function syncThemes() {
    overlay.querySelectorAll('[data-onboard-theme]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.onboardTheme === document.documentElement.dataset.theme)));
  }
  function access(dyn) {
    if (pinEnabled && !pinNeedsVerify) {
      dyn.innerHTML = '<div class="onboard-ai-state"><span class="onboard-badge">Protected</span><h3>Your access PIN is already set.</h3><p>Your existing PIN stays in place. Manage it in Settings whenever you need to.</p></div><p class="onboard-note">Vault has its own separate passphrase for encrypted items.</p>';
      return;
    }
    dyn.innerHTML = `<div class="onboard-security-choice"><button type="button" class="onboard-choice" data-onboard-security="pin"><strong>Protect with a PIN</strong><span>Recommended for shared computers and LAN access.</span></button><button type="button" class="onboard-choice" data-onboard-security="open"><strong>Set up later</strong><span>People who can reach this host can access its shared workspace.</span></button></div><div id="onboard-pin-fields"></div><p class="onboard-note">A PIN protects access to TLI. Vault uses a separate passphrase to encrypt its contents.</p>`;
    dyn.querySelectorAll('[data-onboard-security]').forEach(button => button.addEventListener('click', () => {
      if (pinNeedsVerify) return;
      security = button.dataset.onboardSecurity; remember(); pinFields(); status();
    }));
    pinFields();
  }
  function pinFields() {
    overlay.querySelectorAll('[data-onboard-security]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.onboardSecurity === security)); button.disabled = pinNeedsVerify;
    });
    $('onboard-pin-fields').innerHTML = security === 'pin' ? `<div class="onboard-pin-fields"><div class="onboard-field"><label for="onboard-pin">${pinNeedsVerify ? 'Verify your saved PIN' : 'Choose a PIN'}</label><input id="onboard-pin" type="password" minlength="4" maxlength="32" autocomplete="${pinNeedsVerify ? 'current-password' : 'new-password'}" aria-describedby="onboard-pin-hint"></div>${pinNeedsVerify ? '' : '<div class="onboard-field"><label for="onboard-pin2">Confirm your PIN</label><input id="onboard-pin2" type="password" minlength="4" maxlength="32" autocomplete="new-password"></div>'}</div><p id="onboard-pin-hint">4–32 characters. Keep your PIN somewhere safe.</p>` : '<p class="onboard-note">PIN setup is optional. You can enable it later in Settings → Access.</p>';
  }
  function ready() { return ai?.healthy === true; }
  function aiLabel() {
    if (!ai) return 'Status unavailable';
    if (ready()) return 'Local AI ready';
    if (download?.in_progress) return 'Download in progress';
    if (presets.some(p => p.installation_complete === true)) return 'Installed · needs activation';
    return 'Bundled model not active';
  }
  function intelligence(dyn) {
    dyn.innerHTML = '<div id="onboard-ai-details" aria-live="polite"><p>Checking models on this computer…</p></div><div class="onboard-inline-actions"><button type="button" id="onboard-ai-refresh">Check again</button></div><p class="onboard-note">Already using a local provider such as LM Studio? Keep using it and continue; you do not need another download. Manage existing models, other providers and reviewed LAN models in Settings → AI. Only model downloads need internet here, and they can be several GB. No provider is changed until you choose to use a model.</p>';
    $('onboard-ai-refresh').addEventListener('click', () => refreshAI());
    refreshAI();
  }
  async function refreshAI() {
    const ticket = epoch, serial = ++refreshSerial;
    clearTimeout(timer);
    const refresh = $('onboard-ai-refresh'); if (refresh) refresh.disabled = true;
    const results = await Promise.allSettled([request('/api/ai/status'), request('/api/ai/models/presets'), request('/api/ai/model/download/status')]);
    if (!current(ticket) || serial !== refreshSerial) return;
    ai = results[0].status === 'fulfilled' && typeof results[0].value.healthy === 'boolean' ? results[0].value : null;
    presets = results[1].status === 'fulfilled' && Array.isArray(results[1].value.presets) ? results[1].value.presets.filter(p => p && typeof p.id === 'string' && typeof p.name === 'string') : [];
    download = results[2].status === 'fulfilled' ? results[2].value : null;
    if (!presets.some(p => p.id === selectedModel)) selectedModel =
      presets.find(p => p.running)?.id || presets.find(p => p.installation_complete && (p.compatibility?.selectable || p.compatibility?.state === 'unknown'))?.id ||
      ['standard','lite'].find(id => presets.some(p => p.id === id && p.compatibility?.state === 'compatible')) || presets[0]?.id || '';
    if (step === 3) drawAI(); else if (step === 4) drawSummary();
    if (refresh) refresh.disabled = false;
    if (download?.in_progress && !document.hidden) timer = setTimeout(refreshAI, 2000);
  }
  function drawAI() {
    const details = $('onboard-ai-details'); if (!details) return;
    const model = presets.find(p => p.id === selectedModel);
    details.innerHTML = `<div class="onboard-ai-state"><span class="onboard-state-label">${esc(aiLabel())}</span><p>${ready() ? 'A local model is responding. You can keep it and continue offline.' : !ai ? 'The bundled model status could not be checked. You can continue offline and manage AI later.' : download?.in_progress ? 'You can keep exploring while the model downloads.' : presets.some(p => p.installation_complete === true) ? 'A model is already on this computer. Choose it below to check and use it; no download is needed.' : 'Choose a download only if you need a model. You can keep your existing provider or continue offline and set up AI later.'}</p></div>`;
    if (download?.in_progress) {
      const progress = document.createElement('div'); progress.className = 'onboard-download';
      const total = Number(download.bytes_total), done = Number(download.bytes_done);
      const percent = total > 0 && Number.isFinite(done) ? Math.min(100, Math.max(0, Math.round(done / total * 100))) : null;
      progress.innerHTML = `<progress max="100" ${percent === null ? '' : `value="${percent}"`} aria-label="Model download progress"></progress><p>${download.status === 'cancelling' ? 'Cancellation requested. Waiting for the download to stop.' : `Downloading${percent === null ? '…' : ` · ${percent}%`}`}</p><button type="button" id="onboard-ai-cancel">Cancel download</button>`;
      details.append(progress);
      $('onboard-ai-cancel').disabled = download.status === 'cancelling';
      $('onboard-ai-cancel').addEventListener('click', () => aiAction('cancel'));
    } else {
      if (download?.status === 'error' || download?.status === 'cancelled' || download?.status === 'done') {
        const note = document.createElement('p'); note.className = 'onboard-note';
        note.textContent = download.status === 'error' ? `Download failed. ${download.error || 'Try again when your connection is available.'}` : download.status === 'cancelled' ? 'Download cancelled. You can try again or continue setup.' : 'Download complete. Activation is a separate step.';
        details.append(note);
      }
      const choices = document.createElement('div'); choices.className = 'onboard-models'; choices.setAttribute('aria-label', 'Local AI models');
      for (const p of presets) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'onboard-model'; button.dataset.onboardModel = p.id;
        button.setAttribute('aria-pressed', String(p.id === selectedModel));
        const state = p.running ? 'Running' : p.installation_complete ? 'Installed' : p.size_human || 'Download size unavailable';
        button.innerHTML = `<strong>${esc(p.name)}</strong><span>${esc(state)}</span><small>${esc(p.description || 'Local AI model')}</small>`;
        button.addEventListener('click', () => {selectedModel = p.id; remember(); drawAI();}); choices.append(button);
      }
      details.append(choices);
      if (model) {
        const c = model.compatibility || {}, installed = model.installation_complete === true;
        const action = document.createElement('button'); action.type = 'button'; action.id = 'onboard-ai-action'; action.className = 'btn-primary';
        action.textContent = model.running ? 'This model is running' : installed ? (c.state === 'unknown' ? 'Check and use this model' : 'Use this model') : `Download${model.size_human ? ' · ' + model.size_human : ' model'}`;
        action.disabled = aiOperation || !!model.running || (installed ? c.selectable !== true && c.state !== 'unknown' : c.download_allowed !== true);
        action.addEventListener('click', () => aiAction(installed ? (c.state === 'unknown' ? 'check' : 'select') : 'download'));
        const note = document.createElement('p'); note.className = 'onboard-note';
        note.textContent = installed ? 'Activation checks the model and uses computer memory. A successful check selects it as your local AI.' : c.download_allowed === true ? 'Download only starts when you choose it. Your current model is kept until activation.' : c.download_reason || 'This download is currently unavailable. Check model requirements in Settings.';
        if (Array.isArray(c.reasons) && c.reasons.length) note.textContent += ' ' + c.reasons.join(' ');
        details.append(action, note);
      } else {
        const note = document.createElement('p'); note.textContent = 'Model choices are unavailable. Check again or set up AI later in Settings.'; details.append(note);
      }
    }
  }
  async function aiAction(action) {
    if (aiOperation || busy || locked || blocked) return;
    const ticket = epoch;
    aiOperation = true; busy = true; clearTimeout(timer); controls();
    overlay.querySelectorAll('#onboard-ai-details button, #onboard-ai-refresh').forEach(b => {b.disabled = true;});
    const paths = {cancel:'model/download/cancel',download:'model/download',select:'models/select',check:'models/check'};
    status(action === 'cancel' ? 'Requesting cancellation…' : action === 'download' ? 'Starting your download…' : 'Checking and starting the model. This may take a few minutes…');
    try {
      const result = await request('/api/ai/' + paths[action], action === 'cancel' ? {} : {preset_id:selectedModel}, ['select','check'].includes(action) ? 240000 : 15000);
      if (!current(ticket)) return;
      if (['select','check'].includes(action) && result.healthy !== true) throw new Error('Activation was not confirmed. Check the model status before using AI.');
      await refreshAI();
      if (current(ticket)) status(action === 'cancel' ? 'Cancellation requested. The download status will confirm when it stops.' : action === 'download' ? 'Download requested. You can continue setup while it runs.' : 'Your local AI is ready.');
    } catch (error) { if (current(ticket)) {status(error.message, true); await refreshAI();} }
    finally {
      aiOperation = false; busy = false; controls();
      if (current(ticket) && step === 3) drawAI();
      else if (open && !locked && step === 3) refreshAI();
    }
  }
  function begin(dyn) {
    if (!destination) destination = ready() ? 'chat' : 'dashboard';
    dyn.innerHTML = '<div id="onboard-summary"></div><div class="onboard-destinations" aria-label="Your first destination"></div><p class="onboard-note">You can find every workspace in the sidebar. Phone pairing, devices and AI settings are available whenever you need them.</p>';
    const options = [
      ['chat','Ask TLI','Start a conversation, write or explore an idea.'],
      ['dashboard','Explore Dashboard','Find your bearings and see this computer’s overview.'],
      ['create','Create something','Turn an idea into a small web app with available AI.'],
      ['companion','Connect your phone','Open Phone Companion setup when you are ready.'],
    ];
    for (const [id, title, text] of options) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'onboard-destination'; b.dataset.onboardDestination = id;
      b.innerHTML = `<strong>${title}</strong><span>${text}</span>`;
      b.addEventListener('click', () => {destination = id; remember(); syncDestinations();}); dyn.querySelector('.onboard-destinations').append(b);
    }
    syncDestinations(); drawSummary(); refreshAI();
  }
  function syncDestinations() { overlay.querySelectorAll('[data-onboard-destination]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.onboardDestination === destination))); }
  function drawSummary() {
    const summary = $('onboard-summary'); if (!summary) return;
    summary.innerHTML = `<dl class="onboard-summary"><div><dt>Your computer</dt><dd>${esc(savedName || name || 'Current computer name')}</dd></div><div><dt>Access</dt><dd>${pinEnabled ? 'PIN protected' : 'PIN not set'}</dd></div><div><dt>Local AI</dt><dd>${esc(aiLabel())}</dd></div></dl>${ready() ? '' : '<p class="onboard-note">Your workspace is available now. Conversation and generation need a responding AI provider. Finish local model setup or configure another provider in Settings → AI.</p>'}`;
  }
  async function next() {
    if (busy || initializing || locked) return;
    if (blocked) { await initialize(true); return; }
    if (step < 4) playMusic({gesture:true});
    let ticket = epoch;
    busy = true; controls(); status();
    try {
      if (!started) {
        const result = await request('/system/onboarding/start', {});
        if (!current(ticket)) return;
        started = true; completed = result.complete === true;
      }
      if (step === 1) {
        const value = name.trim();
        if (value && value !== savedName) {
          const result = await request('/system/node/name', {name:value});
          if (!current(ticket)) return;
          savedName = result.node_name || value; name = value;
          const identity = window.TLIUI?.hostIdentity || window.TLIHostIdentity;
          identity?.observe?.({id:identity.get?.().id, name:savedName, source:'host-rename', observedAt:Date.now()});
        }
      }
      if (step === 2 && (!pinEnabled || pinNeedsVerify) && security === 'pin') {
        const pin = $('onboard-pin')?.value.trim() || '', confirm = $('onboard-pin2')?.value.trim() || '';
        if (pin.length < 4 || pin.length > 32) { $('onboard-pin')?.focus(); throw new Error('Choose a PIN with 4–32 characters, or select Set up later.'); }
        if (!pinNeedsVerify && pin !== confirm) { $('onboard-pin2')?.focus(); throw new Error('Your PINs do not match. Enter the same PIN in both fields.'); }
        if (!window.TLIPinLock?.verifyForSetup) throw new Error('Access setup is unavailable. Reload TLI and try again.');
        if (!pinNeedsVerify) {
          await request('/system/pin/set', {pin});
          pinEnabled = true; pinNeedsVerify = true;
          if (!current(ticket)) return;
        }
        await window.TLIPinLock.verifyForSetup(pin);
        // The PIN owner rejects explicit lock/recovery races. Background expired
        // reads may have changed the view epoch during this confirmed unlock.
        if (!open || locked) return;
        ticket = epoch;
        pinNeedsVerify = false;
      }
      if (step === 4) {
        await request('/system/onboarding/complete', {});
        if (!current(ticket)) return;
        completed = true; write(localStorage, SEEN, '1');
        hide(); write(sessionStorage, DRAFT, null); if (resume) resume.hidden = true;
        const panels = {chat:'panel-main',dashboard:'panel-dashboard2',create:'panel-builder',companion:'panel-companion'};
        window.switchPanel?.(panels[destination] || panels.dashboard);
        if (destination === 'chat') $('chat-input')?.focus();
        window.dispatchEvent(new CustomEvent('tli:onboarding-complete'));
      } else { step++; render(); }
    } catch (error) {
      if (current(ticket)) {
        if (step === 2 && security === 'pin') {
          // A disconnected response may still have saved the PIN. Recheck
          // before offering another create request, without assuming an unlock.
          if (!pinEnabled) {
            const pinState = await request('/system/pin/status').catch(() => null);
            if (!current(ticket)) return;
            if (pinState?.enabled === true) { pinEnabled = true; pinNeedsVerify = true; }
          }
          if (pinNeedsVerify) pinFields();
        }
        status(error.message, true);
      }
    }
    finally { busy = false; controls(); }
  }
  async function initialize(force = false) {
    if (initializing) return;
    initializing = true; blocked = false; controls();
    try {
      const state = await request('/system/onboarding/status');
      if (typeof state.complete !== 'boolean') throw new Error('Setup status could not be confirmed with your TLI host. Check that it is running and try again.');
      completed = state.complete; started = state.started === true;
      if (completed && !force) { write(localStorage, SEEN, '1'); if (open) hide(); delete document.documentElement.dataset.tliOnboard; return; }
      if (!completed) write(localStorage, SEEN, null);
      if (started && !force) {
        try {
          const draft = JSON.parse(read(sessionStorage, DRAFT) || '{}');
          step = Number.isInteger(draft.step) && draft.step >= 0 && draft.step < 5 ? draft.step : 0;
          name = typeof draft.name === 'string' ? draft.name.slice(0,48) : '';
          security = draft.security === 'open' ? 'open' : 'pin';
          selectedModel = typeof draft.selectedModel === 'string' ? draft.selectedModel : '';
          destination = ['chat','dashboard','create','companion'].includes(draft.destination) ? draft.destination : '';
        } catch {}
      }
      const pin = await request('/system/pin/status');
      if (typeof pin.enabled !== 'boolean') throw new Error('Access status could not be confirmed. Recheck before continuing.');
      pinEnabled = pin.enabled;
      if (!pinEnabled) pinNeedsVerify = false;
      const node = await request('/agent/ping').catch(() => null);
      savedName = typeof node?.node_name === 'string' ? node.node_name : '';
      if (!name) name = savedName;
      musicEligible = true;
      show(); render();
      if (!musicAttempted && !musicSuspended) { musicAttempted = true; playMusic(); }
    } catch (error) {
      show(); render(); blocked = true;
      status(error.message, true); $('tli-onboard-next').textContent = 'Try again';
    } finally { initializing = false; controls(); }
  }
  async function launch(replay = false) {
    if (!overlay || open || initializing) return;
    if (replay) { step = 0; destination = ''; }
    await initialize(true);
  }
  function init() {
    overlay = $('tli-onboard'); if (!overlay) return;
    locked = $('tli-lock-screen')?.getAttribute('aria-hidden') === 'false';
    initMusic();
    $('tli-onboard-next').addEventListener('click', next);
    $('tli-onboard-back').addEventListener('click', () => {if (!busy && !initializing && !locked && step > 0) {step--; render();}});
    $('tli-onboard-close').addEventListener('click', pause);
    overlay.addEventListener('keydown', event => {
      if (locked) return;
      if (event.key === 'Escape') {event.preventDefault(); pause();}
      if (event.key !== 'Tab') return;
      const items = [...overlay.querySelectorAll('button:not(:disabled),input:not(:disabled),a[href],[tabindex="0"]')].filter(el => el.getClientRects().length);
      const first = items[0], last = items[items.length-1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !items.includes(document.activeElement))) {event.preventDefault(); last.focus();}
      else if (!event.shiftKey && (document.activeElement === last || !items.includes(document.activeElement))) {event.preventDefault(); first.focus();}
    });
    document.addEventListener('focusin', event => {
      if (open && !locked && !overlay.contains(event.target)) $('tli-onboard-step-title').focus({preventScroll:true});
    });
    window.addEventListener('tli-session-locked', () => {
      locked = true; epoch++; clearTimeout(timer); overlay.inert = true;
      pauseMusic();
      overlay.querySelectorAll('input[type="password"]').forEach(input => {input.value = '';}); controls();
    });
    window.addEventListener('tli-session-unlocked', () => {
      locked = false; overlay.inert = false; controls();
      if (open) document.body.style.overflow = 'hidden';
      if (open && !busy && !initializing) { if (step === 3 || step === 4) refreshAI(); $('tli-onboard-step-title').focus({preventScroll:true}); }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) pauseMusic();
      clearTimeout(timer); if (!document.hidden && open && !locked && !busy && (step === 3 || step === 4)) refreshAI();
    });
    window.addEventListener('pagehide', () => {pauseMusic(); clearTimeout(timer); epoch++;});
    window.addEventListener('pageshow', event => {if (event.persisted && open && !locked && (step === 3 || step === 4)) refreshAI();});
    window.addEventListener('tli:theme-change', syncThemes);
    window.TLIOnboarding = {open: () => launch(false), replay: () => launch(true)};
    window.TLI_resetOnboarding = () => launch(true);
    const forced = read(localStorage, FORCE) === '1'; write(localStorage, FORCE, null);
    if (read(localStorage, SEEN) !== '1' || forced) { show(); render(false); status('Checking saved setup…'); }
    initialize(forced);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true}); else init();
})();
