const CLIENT = /^TLI\/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function version(value) {
  const match = CLIENT.exec('TLI/' + value);
  return match ? match.slice(1, 4).map(Number) : null;
}

function older(left, right) {
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i];
  }
  return false;
}

export async function updateFeedResponse(request, response) {
  if (!response.ok || !['GET', 'HEAD'].includes(request.method)) return response;
  const agent = request.headers.get('User-Agent') || '';
  const match = CLIENT.exec(agent);
  if (!match) return response;
  // HEAD has no representation to adapt. Neither client-specific response can
  // enter a shared cache and become another installed version's update feed.
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Vary', 'User-Agent');
  headers.delete('ETag');
  headers.delete('Content-Length');
  if (request.method === 'HEAD') return new Response(null, { status: response.status, headers });
  const feed = await response.json();
  const installed = match.slice(1, 4).map(Number);
  const minimum = version(feed.minimum_prepare_version);
  const bridge = feed.compatibility_bridge;
  const bridgeFloor = version(bridge?.minimum_prepare_version);
  const bridgeVersion = version(bridge?.version);
  if (minimum && bridgeFloor && bridgeVersion && !older(installed, bridgeFloor)
      && older(installed, bridgeVersion) && older(bridgeVersion, version(feed.version) || [0, 0, 0])) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(bridge) + '\n', { status: response.status, headers });
  }
  if (!minimum || older(installed, minimum)) {
    // Manual fallback is deliberate: old updaters ignore minimum-version fields.
    feed.updater = 'manual';
    for (const entry of Object.values(feed.platforms || {})) entry.updater = 'manual';
    feed.notes = 'This installed version needs a one-time upgrade using the new package updater. Your original folder, saved data and models are preserved. ' + (feed.notes || '');
  }
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(feed) + '\n', { status: response.status, headers });
}
