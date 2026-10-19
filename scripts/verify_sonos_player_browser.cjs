/* Actual SPA, intercepted Sonos and access APIs. No speakers are contacted. */
const {chromium} = require('playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {makePage, fingerprintFiles} = require('./verify_anniversary_ui_browser.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build_work/sonos-player/browser-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(output, {recursive: true});
const protocol = 'tli-sonos-v1';
const emptyOnly = process.argv.includes('--empty-only');
const beam = {id: 'summary-beam', uid: 'RINCON_SUMMARY_BEAM', name: 'Living room', room: 'Living room', model: 'Beam', volume_cap: 35};
const dining = {id: 'summary-dining', uid: 'RINCON_SUMMARY_DINING', name: 'Dining room', room: 'Dining room', model: 'Amp', volume_cap: 25};
const office = {id: 'summary-office', uid: 'RINCON_SUMMARY_OFFICE', name: 'Office', room: 'Office', model: 'Play:1', volume_cap: 25};
const group = (device, playback = 'PLAYING') => ({device_id: device.id, uid: device.uid, name: device.name, member_names: device === beam ? [beam.name, dining.name] : [device.name],
  playback, title: device === beam ? 'Evening jazz <fixture>' : 'Morning piano', artist: 'Synthetic artist',
  source: {kind: 'spotify_connect', label: 'Spotify Connect', external: true}});
const report = {synthetic: true, physical_acceptance: 'not_run', source_before: fingerprintFiles(root), checks: [], screens: [],
  limitations: ['All Sonos and access APIs are intercepted. No live speakers, music services, or application server are contacted.']};
const deferred = () => { let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve}; };

async function setup(browser, width, theme, {empty = false, holdStartup = false} = {}) {
  const run = await makePage(browser, width, theme), {page} = run, calls = [], fixtureErrors = [];
  const startupHold = holdStartup ? deferred() : null;
  const roomLevels = device => ({device_id: device.id, uid: device.uid, name: device.name, volume: device === beam ? 24 : device === dining ? 12 : 8,
    muted: false, volume_cap: device.volume_cap});
  const state = {groups: empty ? [] : [group(beam), group(office, 'PAUSED_PLAYBACK')], devicesCount: empty ? 0 : 3,
    connectedCount: empty ? 0 : 3, fail: false, hold: startupHold, review: null, reviews: 0,
    volumes: {[beam.id]: roomLevels(beam), [dining.id]: roomLevels(dining), [office.id]: roomLevels(office)}, failVolumes: false};
  const volumesFor = id => {
    const rooms = (id === office.id ? [office] : [beam, dining]).map(room => ({...state.volumes[room.id]}));
    return {rooms, group: {volume: Math.round(rooms.reduce((sum, room) => sum + room.volume, 0) / rooms.length),
      max: Math.min(...rooms.map(room => room.volume_cap)), muted: rooms.every(room => room.muted)}};
  };
  await page.route('**/api/events/recent*', route => route.fulfill({json: {events: []}}));
  await page.route('**/api/sonos/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname, method = request.method();
    let body; try {body = request.postDataJSON();} catch {}
    calls.push({path: pathname, method, body});
    try {
      let value;
      if (pathname === '/api/sonos/now-playing') {
        if (state.hold) {const hold = state.hold; state.hold = null; await hold.promise;}
        if (state.fail) return route.fulfill({status: 503, json: {detail: 'Synthetic speakers unavailable.'}});
        value = {devices_count: state.devicesCount, connected_count: state.connectedCount, groups: state.groups, checked_at: new Date().toISOString(), unavailable_count: 0, partial: false};
      } else if (pathname === '/api/sonos/devices' && method === 'GET') value = {devices: state.devicesCount ? [beam, dining, office] : [], availability: {music: true}};
      else if (pathname.endsWith('/volume-controls')) {
        if (state.failVolumes) return route.fulfill({status: 503, json: {detail: 'Synthetic levels unavailable.'}});
        value = {device_id: pathname.split('/').at(-2), volume_controls: volumesFor(pathname.split('/').at(-2))};
      }
      else if (pathname.endsWith('/review')) {
        const device = [beam, dining, office].find(room => room.id === pathname.split('/').at(-2)); assert.ok(device);
        assert.ok(['play', 'pause', 'previous', 'next', 'volume', 'group_volume', 'mute', 'group_mute'].includes(body.action));
        if (['volume', 'group_volume'].includes(body.action)) assert.equal(typeof body.params.volume, 'number');
        else if (['mute', 'group_mute'].includes(body.action)) assert.equal(typeof body.params.muted, 'boolean');
        else assert.deepEqual(body.params, {});
        state.review = {review_id: 'mini-review-' + (++state.reviews), action: body.action, params: body.params, device,
          affected: [{uid: device.uid, name: device.name}], effect: 'Synthetic transport control.', actions_performed: false};
        value = state.review;
      } else if (pathname === '/api/sonos/execute') {
        assert.equal(body.review_id, state.review.review_id); assert.ok(body.request_id);
        const action = state.review.action, deviceId = state.review.device.id;
        if (action === 'volume') state.volumes[deviceId].volume = state.review.params.volume;
        if (action === 'mute') state.volumes[deviceId].muted = state.review.params.muted;
        if (action === 'group_mute') for (const room of volumesFor(deviceId).rooms) state.volumes[room.device_id].muted = state.review.params.muted;
        if (action === 'group_volume') {
          const controls = volumesFor(deviceId), delta = state.review.params.volume - controls.group.volume;
          for (const room of controls.rooms) state.volumes[room.device_id].volume = Math.max(0, Math.min(room.volume_cap, room.volume + delta));
        }
        state.groups = state.groups.map(row => row.device_id !== deviceId ? row : {...row,
          playback: action === 'pause' ? 'PAUSED_PLAYBACK' : action === 'play' ? 'PLAYING' : row.playback});
        value = {outcome: 'accepted', summary: 'Synthetic Sonos command acknowledged.'};
      } else if (pathname.endsWith('/status')) {
        const device = pathname.includes(office.id) ? office : beam, current = state.groups.find(row => row.device_id === device.id) || group(device, 'STOPPED');
        value = {device, reading: {...current, volume: 18, muted: false}, checked_at: new Date().toISOString(), clip_support: {state: 'unsupported'},
          group: {coordinator: device.uid, members: [device]}, topology: {checked_at: new Date().toISOString(), groups: [
            {coordinator: device.uid, member_count: 1, complete: true, members: [{...device, device_id: device.id, bonded: false, parent_uid: null, bond_source: null}]}]},
          volume_controls: {rooms: [{device_id: device.id, uid: device.uid, name: device.name, volume: 18, muted: false, volume_cap: device.volume_cap}], group: null}};
      } else throw Error('Unexpected synthetic Sonos request: ' + method + ' ' + pathname);
      await route.fulfill({json: {ok: true, protocol, ...value}});
    } catch (error) {fixtureErrors.push(String(error.stack || error)); await route.fulfill({status: 500, json: {detail: error.message}});}
  });
  if (empty) await page.addInitScript(() => {
    window.__sonosStartupVisible = [];
    window.__sonosStartupObserver = new MutationObserver(() => {
      for (const id of ['sonos-quick-player', 'dashboard-sonos']) {
        const node = document.getElementById(id);
        if (node && !node.hidden && node.getClientRects().length) window.__sonosStartupVisible.push(id);
      }
    });
    window.__sonosStartupObserver.observe(document, {childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'style']});
  });
  const initialRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/sonos/now-playing');
  await page.goto('https://tli-ui.test/', {waitUntil: 'load'}); await initialRequest;
  if (!empty) await page.locator('#sonos-quick-title').filter({hasText: 'Evening jazz'}).waitFor();
  else await page.locator('#sonos-dashboard-refresh').waitFor({state: 'attached'});
  return {...run, featureCalls: calls, fixtureErrors, state, startupHold};
}
async function screen(page, name) {await page.screenshot({path: path.join(output, name)}); report.screens.push(name);}
async function measure(page, id) {return page.evaluate(id => {
  const node = document.getElementById(id), rect = node.getBoundingClientRect();
  return {pageOverflow: document.documentElement.scrollWidth > innerWidth + 1, localOverflow: node.scrollWidth > node.clientWidth + 1,
    left: rect.left, right: rect.right, width: innerWidth};
}, id);}

(async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true}); let live;
  try {
    for (const theme of ['emeraldLight', 'midnight']) for (const width of [1440, 390]) {
      const run = await setup(browser, width, theme, {empty: true, holdStartup: true}), {page, state} = run; live = page;
      await page.evaluate(() => switchPanel('panel-dashboard2'));
      const hiddenLayout = () => page.evaluate(() => ['sonos-quick-player', 'dashboard-sonos'].map(id => {
        const node = document.getElementById(id), rect = node.getBoundingClientRect();
        return {id, hidden: node.hidden, display: getComputedStyle(node).display, width: rect.width, height: rect.height, rects: node.getClientRects().length};
      }));
      for (const stage of ['pending', 'empty']) {
        if (stage === 'empty') {run.startupHold.resolve(); await page.waitForFunction(() => !document.getElementById('sonos-dashboard-refresh').disabled);}
        for (const layout of await hiddenLayout()) {
          assert.equal(layout.hidden, true, stage + ': mount stays hidden'); assert.equal(layout.display, 'none');
          assert.equal(layout.height, 0); assert.equal(layout.width, 0); assert.equal(layout.rects, 0, 'Hidden player takes no layout space');
        }
      }
      assert.deepEqual(await page.evaluate(() => window.__sonosStartupVisible), [], 'No visible startup flash while detecting no speakers');
      await page.evaluate(() => window.__sonosStartupObserver.disconnect());
      assert.equal(run.featureCalls.filter(call => call.path.endsWith('/volume-controls')).length, 0);
      assert.equal(run.featureCalls.filter(call => call.method === 'POST').length, 0);
      await screen(page, `${theme}-${width}-dashboard-without-sonos.png`);
      const emptyReads = run.featureCalls.filter(call => call.path === '/api/sonos/now-playing').length;
      await page.evaluate(() => {switchPanel('panel-main'); switchPanel('panel-dashboard2');});
      assert.equal(run.featureCalls.filter(call => call.path === '/api/sonos/now-playing').length, emptyReads, 'Navigation leaves empty integration dormant');
      state.devicesCount = 3; state.connectedCount = 3; state.groups = [group(beam), group(office, 'PAUSED_PLAYBACK')];
      await page.evaluate(() => window.dispatchEvent(new Event('tli-sonos-changed')));
      await page.locator('#dashboard-sonos').waitFor({state: 'visible'}); await page.locator('#sonos-quick-player').waitFor({state: 'visible'});
      await page.waitForFunction(() => !document.getElementById('sonos-dashboard-refresh').disabled);
      state.fail = true; await page.locator('#sonos-dashboard-refresh').click(); await page.locator('#sonos-quick-player').waitFor({state: 'hidden'});
      assert.equal(await page.locator('#dashboard-sonos').isVisible(), true, 'A known owner keeps recovery controls during an outage');
      assert.equal(await page.locator('#sonos-dashboard-refresh').isEnabled(), true);
      assert.equal(await page.locator('#sonos-dashboard-play').isEnabled(), false);
      state.fail = false; state.devicesCount = 0; state.connectedCount = 0; state.groups = [];
      const removed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/sonos/now-playing');
      await page.evaluate(() => window.dispatchEvent(new Event('tli-sonos-changed'))); await removed;
      await page.waitForFunction(() => !document.getElementById('sonos-dashboard-refresh').disabled);
      for (const layout of await hiddenLayout()) {assert.equal(layout.hidden, true); assert.equal(layout.height, 0);}
      assert.equal(run.featureCalls.filter(call => call.method === 'POST').length, 0, 'Enrollment/removal observations never operate speakers');
      assert.deepEqual(run.fixtureErrors, []); assert.deepEqual(run.errors, []);
      report.checks.push({theme, width, scenario: 'without-sonos', noStartupFlash: true, hiddenWithoutLayoutSpace: true,
        noVolumeOrEffectOnEmpty: true, enrollmentShowsPlayers: true, knownOwnerOutageKeepsCard: true, lastRemovalHidesPlayers: true, passed: true});
      fs.writeFileSync(path.join(output, `${theme}-${width}-empty-requests.json`), JSON.stringify(run.featureCalls, null, 2));
      await run.context.close(); live = null;
    }
    for (const theme of emptyOnly ? [] : ['emeraldLight', 'midnight']) for (const width of [1440, 390]) {
      const run = await setup(browser, width, theme), {page, state} = run; live = page;
      const quick = page.locator('#sonos-quick-player'), dashboard = page.locator('#dashboard-sonos');
      const executions = () => run.featureCalls.filter(call => call.path === '/api/sonos/execute');
      const reviews = () => run.featureCalls.filter(call => call.path.endsWith('/review'));
      const reads = () => run.featureCalls.filter(call => call.path === '/api/sonos/now-playing');
      assert.equal(await quick.isVisible(), true); assert.equal(executions().length, 0);
      assert.equal(await page.locator('#sonos-quick-title').textContent(), 'Evening jazz <fixture>');
      assert.equal(await quick.locator('img,script,fixture').count(), 0, 'Speaker metadata is rendered as text');
      assert.equal(await page.locator('#sonos-quick-room').isVisible(), false, 'A single playing group needs no picker');
      const topLayout = await measure(page, 'sonos-quick-player'); assert.equal(topLayout.pageOverflow, false); assert.equal(topLayout.localOverflow, false);
      assert.ok(topLayout.left >= 0 && topLayout.right <= width + 1);
      await page.evaluate(() => switchPanel('panel-dashboard2')); await dashboard.scrollIntoViewIfNeeded();
      assert.equal(await page.locator('#sonos-dashboard-title').textContent(), 'Evening jazz <fixture>');
      await page.waitForFunction(() => {const range = document.getElementById('sonos-quick-volume-range'); return range && !range.disabled;});
      const readyVolume = async (prefix, expected) => page.waitForFunction(({prefix, expected}) => {
        const range = document.getElementById(prefix + '-volume-range');
        return range && !range.disabled && range.value === String(expected) && !document.getElementById('sonos-dashboard-refresh').disabled;
      }, {prefix, expected});
      assert.equal(await page.locator('#sonos-quick-volume-range').inputValue(), '18');
      assert.equal(await page.locator('#sonos-quick-volume-range').getAttribute('max'), '25');
      assert.equal(await page.locator('#sonos-quick-volume-toggle').getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('#sonos-dashboard-volume-mixer').isVisible(), false);
      await page.locator('#sonos-quick-volume-range').evaluate(range => {range.value = '21'; range.dispatchEvent(new Event('input', {bubbles: true}));});
      assert.equal(await page.locator('#sonos-quick-volume-value').textContent(), '21'); assert.equal(executions().length, 0);
      await page.locator('#sonos-quick-volume-range').evaluate(range => {range.value = '18'; range.dispatchEvent(new Event('input', {bubbles: true}));});
      await page.locator('#sonos-quick-volume-range').focus();
      for (const expected of [19, 20]) {
        const before = executions().length; await page.keyboard.press('ArrowRight'); await readyVolume('sonos-quick', expected);
        assert.equal(executions().length, before + 1); assert.deepEqual(reviews().at(-1).body, {action: 'group_volume', params: {volume: expected}});
        assert.equal(reviews().at(-1).path, '/api/sonos/devices/' + beam.id + '/review');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'sonos-quick-volume-range', 'Refresh preserves keyboard control without refocusing');
      }
      await page.locator('#sonos-quick-volume-toggle').click();
      const mixer = page.locator('#sonos-quick-volume-mixer'); await mixer.waitFor({state: 'visible'});
      assert.equal(await page.locator('#sonos-quick-volume-room-' + beam.id).getAttribute('max'), '35');
      assert.equal(await page.locator('#sonos-quick-volume-room-' + dining.id).getAttribute('max'), '25');
      const mixerLayout = await measure(page, 'sonos-quick-volume-mixer');
      assert.equal(mixerLayout.pageOverflow, false); assert.equal(mixerLayout.localOverflow, false);
      assert.ok(mixerLayout.left >= 0 && mixerLayout.right <= width + 1);
      await screen(page, `${theme}-${width}-room-mixer.png`);
      await page.locator('#sonos-quick-volume-room-' + dining.id).focus(); await page.keyboard.press('ArrowRight');
      await page.waitForFunction(id => {const el = document.getElementById(id); return el && !el.disabled && el.value === '15';}, 'sonos-quick-volume-room-' + dining.id);
      assert.deepEqual(reviews().at(-1).body, {action: 'volume', params: {volume: 15}});
      assert.equal(reviews().at(-1).path, '/api/sonos/devices/' + dining.id + '/review');
      await page.keyboard.press('Escape'); await mixer.waitFor({state: 'hidden'});
      assert.equal(await page.evaluate(() => document.activeElement.id), 'sonos-quick-volume-toggle');
      await page.locator('#sonos-quick-volume-toggle').click(); await mixer.waitFor({state: 'visible'});
      await page.locator('#sonos-quick-title').click(); await mixer.waitFor({state: 'hidden'});
      for (const muted of [true, false]) {
        const before = executions().length; await page.locator('#sonos-quick-volume-mute').click();
        await page.waitForFunction(muted => {const el = document.getElementById('sonos-quick-volume-mute'); return !el.disabled && el.getAttribute('aria-pressed') === String(muted);}, muted);
        assert.equal(executions().length, before + 1); assert.deepEqual(reviews().at(-1).body, {action: 'group_mute', params: {muted}});
      }
      await page.locator('#sonos-dashboard-room').selectOption(office.id); await readyVolume('sonos-dashboard', 8);
      assert.equal(await page.locator('#sonos-quick-title').textContent(), 'Evening jazz <fixture>');
      assert.equal(await page.locator('#sonos-dashboard-title').textContent(), 'Morning piano');
      assert.equal(await page.locator('#sonos-dashboard-volume-toggle').isVisible(), false, 'Single rooms need no mixer');
      await page.locator('#sonos-dashboard-volume-range').focus(); await page.keyboard.press('ArrowRight'); await readyVolume('sonos-dashboard', 9);
      assert.deepEqual(reviews().at(-1).body, {action: 'volume', params: {volume: 9}});
      assert.equal(reviews().at(-1).path, '/api/sonos/devices/' + office.id + '/review');
      await page.locator('#sonos-dashboard-room').selectOption(beam.id); await readyVolume('sonos-dashboard', 21);
      const dashboardLayout = await measure(page, 'dashboard-sonos'); assert.equal(dashboardLayout.pageOverflow, false); assert.equal(dashboardLayout.localOverflow, false);
      await screen(page, `${theme}-${width}-dashboard-playing.png`);
      const beforeNavigation = reads().length;
      await page.evaluate(() => switchPanel('panel-main')); assert.equal(await quick.isVisible(), true);
      assert.equal(await page.locator('#sonos-quick-title').textContent(), 'Evening jazz <fixture>');
      assert.equal(reads().length, beforeNavigation, 'Navigation keeps the existing global player');
      await screen(page, `${theme}-${width}-chat-mini-player.png`);
      for (const action of ['previous', 'next']) {
        const before = executions().length; await page.locator('#sonos-quick-' + action).click();
        await page.waitForFunction(() => !document.getElementById('sonos-quick-next').disabled);
        assert.equal(executions().length, before + 1); assert.deepEqual(reviews().at(-1).body, {action, params: {}});
        assert.equal(reviews().at(-1).path, '/api/sonos/devices/' + beam.id + '/review');
      }
      await page.locator('#sonos-quick-pause').click(); await quick.waitFor({state: 'hidden'});
      await page.evaluate(() => switchPanel('panel-dashboard2')); await dashboard.scrollIntoViewIfNeeded();
      assert.match(await page.locator('#sonos-dashboard-state').textContent(), /paused/i);
      assert.match(await page.locator('#sonos-dashboard-play').textContent(), /play/i);
      await screen(page, `${theme}-${width}-dashboard-paused.png`);
      await page.locator('#sonos-dashboard-play').click(); await quick.waitFor({state: 'visible'});
      assert.deepEqual(reviews().at(-1).body, {action: 'play', params: {}});
      state.groups = state.groups.map(row => ({...row, playback: 'PLAYING'}));
      await page.locator('#sonos-dashboard-refresh').click(); await page.locator('#sonos-quick-room').waitFor({state: 'visible'});
      await page.locator('#sonos-quick-room').selectOption(office.id);
      assert.equal(await page.locator('#sonos-quick-title').textContent(), 'Morning piano');
      await page.locator('#sonos-quick-next').click(); await page.waitForFunction(() => !document.getElementById('sonos-quick-next').disabled);
      assert.equal(reviews().at(-1).path, '/api/sonos/devices/' + office.id + '/review');
      await screen(page, `${theme}-${width}-multiple-playing-groups.png`);
      const beforeOpen = executions().length; await page.locator('#sonos-quick-open').click();
      await page.waitForFunction(id => document.getElementById('sonos-device')?.value === id, office.id);
      assert.equal(await page.locator('#panel-homeauto').isVisible(), true); assert.equal(await quick.isVisible(), true);
      assert.equal(executions().length, beforeOpen, 'Opening Rooms & volume performs no playback action');
      await page.evaluate(() => switchPanel('panel-dashboard2')); state.fail = true;
      await page.locator('#sonos-dashboard-refresh').click(); await quick.waitFor({state: 'hidden'});
      assert.equal(await page.locator('#sonos-dashboard-play').isDisabled(), true);
      state.fail = false; await page.locator('#sonos-dashboard-refresh').click(); await quick.waitFor({state: 'visible'});
      const held = deferred(); state.hold = held; const beforeLate = reads().length;
      await page.locator('#sonos-dashboard-refresh').click();
      await page.waitForFunction(() => document.getElementById('sonos-dashboard-refresh').disabled);
      assert.equal(reads().length, beforeLate + 1);
      await page.evaluate(() => window.dispatchEvent(new Event('tli-session-locked')));
      state.groups = [{...group(beam), title: 'LATE PRIVATE SONG'}]; held.resolve();
      await page.waitForFunction(() => document.getElementById('sonos-quick-player').hidden);
      assert.doesNotMatch(await quick.textContent(), /LATE PRIVATE SONG|Morning piano|Evening jazz/);
      assert.doesNotMatch(await dashboard.textContent(), /LATE PRIVATE SONG/);
      assert.equal(executions().length, 11);
      assert.deepEqual(run.fixtureErrors, []); assert.deepEqual(run.errors, []);
      report.checks.push({theme, width, topLayout, dashboardLayout, mixerLayout, automaticDetection: true, persistentAcrossPanels: true,
        inlineVolume: true, previewWithoutEffect: true, repeatedKeyboardVolume: true, groupMute: true, roomMixer: true, distinctVolumeTargets: true,
        directTransport: true, pausedDashboardPlay: true, selectedPlayingGroup: true, fullSonosLink: true, failuresClearPlaying: true, lockDiscardsLateData: true, passed: true});
      fs.writeFileSync(path.join(output, `${theme}-${width}-requests.json`), JSON.stringify(run.featureCalls, null, 2));
      await run.context.close(); live = null;
    }
    report.passed = true;
  } catch (error) {report.passed = false; report.failure = String(error.stack || error); if (live) await screen(live, 'failure.png').catch(() => {}); process.exitCode = 1;}
  finally {report.source_after = fingerprintFiles(root); report.source_changed = JSON.stringify(report.source_before) !== JSON.stringify(report.source_after);
    report.changed_files = [...new Set([...Object.keys(report.source_before), ...Object.keys(report.source_after)])].filter(file => report.source_before[file] !== report.source_after[file]);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser.close();
    console.log(JSON.stringify({output, passed: report.passed, checks: report.checks.length, screens: report.screens.length, source_changed: report.source_changed, changed_files: report.changed_files, failure: report.failure}));}
})();
