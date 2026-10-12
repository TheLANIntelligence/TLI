import { PUBLIC_RELEASE } from '../landing/js/release.js';
import { COMPANION_RELEASE } from '../landing/js/companion-release.js';
import { isDisposableDomain } from './disposable-domains.mjs';
import { sendVerificationEmail } from './send-verification-email.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TOKEN_LIFETIME = 20 * MINUTE;
const BODY_LIMIT = 4096;
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
});

class APIError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new APIError(status, code, message); };
const json = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), { status, headers: { ...HEADERS, ...extra } });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex = bytes => [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
const encode = value => new TextEncoder().encode(value);

function configuration(env) {
  const required = ['DOWNLOAD_HASH_KEY', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY',
    'RESEND_API_KEY', 'DOWNLOAD_FROM_EMAIL', 'DOWNLOAD_SITE_ORIGIN'];
  if (!env?.DOWNLOAD_DB || typeof env.DOWNLOAD_DB.prepare !== 'function' || typeof env.DOWNLOAD_DB.batch !== 'function'
    || required.some(name => typeof env[name] !== 'string' || !env[name].trim()) || env.DOWNLOAD_HASH_KEY.length < 32
    || [env.TURNSTILE_SITE_KEY, env.TURNSTILE_SECRET_KEY].some(key => /^[123]x0{10,}/i.test(key.trim()))) {
    fail(503, 'unavailable', 'Email verification is not available yet. Please try again later.');
  }
  let origin;
  try { origin = new URL(env.DOWNLOAD_SITE_ORIGIN); } catch { /* handled below */ }
  if (!origin || origin.protocol !== 'https:' || origin.origin !== env.DOWNLOAD_SITE_ORIGIN) {
    fail(503, 'unavailable', 'Email verification is not available yet. Please try again later.');
  }
  return origin;
}

function checkRequest(request, origin, method) {
  if (request.method !== method) fail(405, 'invalid_request', `Use ${method} for this request.`);
  const url = new URL(request.url);
  if (url.origin !== origin.origin || url.search
    || (request.headers.has('Origin') && request.headers.get('Origin') !== origin.origin)
    || (method === 'POST' && request.headers.get('Origin') !== origin.origin)
    || (request.headers.has('Sec-Fetch-Site') && request.headers.get('Sec-Fetch-Site') !== 'same-origin')) {
    fail(403, 'forbidden', 'Open the download page on this website and try again.');
  }
}

async function bodyJSON(request) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('Content-Type') || '')) {
    fail(415, 'invalid_request', 'Send a JSON request.');
  }
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) {
    fail(413, 'invalid_request', 'The request is too large.');
  }
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'invalid_request', 'The request is incomplete.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) {
        await reader.cancel();
        fail(413, 'invalid_request', 'The request is too large.');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!plain(value)) fail(400, 'invalid_request', 'The request is incomplete.');
    return value;
  } catch (error) {
    if (error instanceof APIError) throw error;
    fail(400, 'invalid_request', 'The request could not be read.');
  } finally { reader.releaseLock(); }
}

function onlyKeys(body, keys) {
  if (Object.keys(body).some(key => !keys.includes(key))) fail(400, 'invalid_request', 'The request contains unsupported fields.');
}

function emailAddress(value) {
  if (typeof value !== 'string') fail(400, 'invalid_email', 'Enter a valid email address.');
  const email = value.trim();
  const pieces = email.split('@');
  const local = pieces[0], domain = pieces[1]?.toLowerCase();
  const atom = /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*$/;
  const labels = domain?.split('.') || [];
  if (pieces.length !== 2 || email.length > 254 || !local || local.length > 64 || !atom.test(local)
    || labels.length < 2 || !labels.every(label => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
    || !/^[a-z]{2,63}$/.test(labels.at(-1))) fail(400, 'invalid_email', 'Enter a valid email address.');
  if (isDisposableDomain(domain)) fail(400, 'disposable_email', 'Use an email inbox that you keep and can open.');
  const gmail = domain === 'gmail.com' || domain === 'googlemail.com';
  const canonicalLocal = gmail ? local.toLowerCase().split('+', 1)[0].replaceAll('.', '') : local.toLowerCase();
  if (!canonicalLocal) fail(400, 'invalid_email', 'Enter a valid email address.');
  return { email: `${local}@${domain}`, canonical: `${canonicalLocal}@${gmail ? 'gmail.com' : domain}` };
}

async function challenge(env, origin, token, ip, fetcher) {
  if (typeof token !== 'string' || !token.trim() || token.length > 2048) {
    fail(400, 'challenge_failed', 'Complete the security check and try again.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetcher(SITEVERIFY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip }),
    });
    if (!response.ok) throw new Error('Challenge unavailable');
    const value = await response.json();
    if (!plain(value) || value.success !== true || value.hostname !== origin.hostname || value.action !== 'download_email') {
      throw new Error('Challenge rejected');
    }
  } catch {
    fail(400, 'challenge_failed', 'Complete the security check and try again.');
  } finally { clearTimeout(timeout); }
}

async function reserve(env, { tokenHash, email, emailKey, ipKey, platform, release, now }) {
  const db = env.DOWNLOAD_DB;
  const day = Math.floor(now / DAY) * DAY;
  // D1 batch is a transaction. The conditional INSERT serializes the quota
  // decision with its reservation; there is no read-then-increment race.
  const result = await db.batch([
    db.prepare('DELETE FROM pending_downloads WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM download_rate_events WHERE requested_at < ?').bind(Math.min(day, now - HOUR)),
    db.prepare(`INSERT INTO download_rate_events(token_hash, email_key, ip_key, requested_at)
      SELECT ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM download_rate_events WHERE email_key = ? AND requested_at > ?)
        AND (SELECT COUNT(*) FROM download_rate_events WHERE email_key = ? AND requested_at >= ?) < 5
        AND (SELECT COUNT(*) FROM download_rate_events WHERE ip_key = ? AND requested_at > ?) < 10
        AND (SELECT COUNT(*) FROM download_rate_events WHERE requested_at >= ?) < 100
      RETURNING token_hash`).bind(tokenHash, emailKey, ipKey, now, emailKey, now - MINUTE,
        emailKey, day, ipKey, now - HOUR, day),
    db.prepare(`INSERT INTO pending_downloads(token_hash, email, platform, release_version, asset_filename, requested_at, expires_at)
      SELECT token_hash, ?, ?, ?, ?, ?, ? FROM download_rate_events WHERE token_hash = ?`).bind(
      email, platform, release.version, release.filename, now, now + TOKEN_LIFETIME, tokenHash),
  ]);
  return result[2]?.results?.length === 1;
}

export function createDownloadHandlers({ fetcher = globalThis.fetch, clock = Date.now,
  sendEmail = sendVerificationEmail, cryptoImpl = globalThis.crypto,
  desktopRelease = PUBLIC_RELEASE, companionRelease = COMPANION_RELEASE } = {}) {
  // Desktop and Companion ship independently. A token is bound to the exact
  // platform, version and asset that its verification email was requested for.
  const releaseFor = platform => {
    if (platform === 'android') return companionRelease;
    if (platform === 'windows' || platform === 'macos') {
      return { ...desktopRelease[platform], version: desktopRelease.version };
    }
    return null;
  };
  const digest = async value => hex(await cryptoImpl.subtle.digest('SHA-256', encode(value)));
  const keyed = async (key, value) => {
    const material = await cryptoImpl.subtle.importKey('raw', encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await cryptoImpl.subtle.sign('HMAC', material, encode(value)));
  };
  const boundary = (method, operation) => async (request, env) => {
    try {
      const origin = configuration(env);
      checkRequest(request, origin, method);
      return await operation(request, env, origin);
    } catch (error) {
      const known = error instanceof APIError;
      const status = known ? error.status : 503;
      return json({ error: known ? error.code : 'unavailable',
        message: known ? error.message : 'Email verification is temporarily unavailable. Please try again later.' }, status,
      { ...(status === 405 ? { Allow: method } : {}), ...(status === 429 ? { 'Retry-After': '60' } : {}) });
    }
  };
  return {
    config: boundary('GET', async (_request, env) => json({ enabled: true, turnstileSiteKey: env.TURNSTILE_SITE_KEY })),
    request: boundary('POST', async (request, env, origin) => {
      const body = await bodyJSON(request);
      onlyKeys(body, ['email', 'platform', 'turnstileToken', 'website']);
      if (body.website !== '') fail(400, 'invalid_request', 'The request could not be accepted.');
      const address = emailAddress(body.email);
      if (!['windows', 'macos', 'android'].includes(body.platform)) fail(400, 'invalid_platform', 'Choose Windows, macOS or Android.');
      const release = releaseFor(body.platform);
      const ip = request.headers.get('CF-Connecting-IP');
      if (!ip || ip.length > 64 || !/^[a-f0-9:.]+$/i.test(ip)) fail(503, 'unavailable', 'Email verification is temporarily unavailable.');
      await challenge(env, origin, body.turnstileToken, ip, fetcher);
      const now = clock();
      const token = hex(cryptoImpl.getRandomValues(new Uint8Array(32)));
      const tokenHash = await digest(token);
      const [emailKey, ipKey] = await Promise.all([
        keyed(env.DOWNLOAD_HASH_KEY, 'email:' + address.canonical), keyed(env.DOWNLOAD_HASH_KEY, 'ip:' + ip.toLowerCase()),
      ]);
      if (!await reserve(env, { tokenHash, email: address.email, emailKey, ipKey, platform: body.platform, release, now })) {
        fail(429, 'rate_limited', 'Please wait before requesting another verification email.');
      }
      let accepted = false;
      try { accepted = await sendEmail(env, { email: address.email, platform: body.platform, version: release.version, token }, fetcher) === true; }
      catch { /* Never disclose provider responses or recipient details. */ }
      if (!accepted) {
        await env.DOWNLOAD_DB.prepare('DELETE FROM pending_downloads WHERE token_hash = ?').bind(tokenHash).run();
        fail(503, 'delivery_failed', 'The verification email could not be sent. Please wait a minute and try again.');
      }
      const sent = await env.DOWNLOAD_DB.prepare('UPDATE pending_downloads SET sent_at = ? WHERE token_hash = ? AND expires_at > ?')
        .bind(clock(), tokenHash, clock()).run();
      if (sent.meta?.changes !== 1) fail(503, 'delivery_failed', 'The verification email could not be confirmed. Please request a new link.');
      return json({ status: 'check_email' }, 202);
    }),
    verify: boundary('POST', async (request, env) => {
      const body = await bodyJSON(request);
      onlyKeys(body, ['token']);
      if (typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)) {
        fail(400, 'invalid_token', 'This verification link is invalid or already used. Request a new link.');
      }
      const tokenHash = await digest(body.token);
      const now = clock();
      const db = env.DOWNLOAD_DB;
      const windows = releaseFor('windows'), macos = releaseFor('macos'), android = releaseFor('android');
      const result = await db.batch([
        db.prepare(`INSERT INTO verified_downloads(token_hash, email, platform, release_version, asset_filename, requested_at, verified_at)
          SELECT token_hash, email, platform, release_version, asset_filename, requested_at, ? FROM pending_downloads
          WHERE token_hash = ? AND sent_at IS NOT NULL AND expires_at > ?
            AND ((platform = 'windows' AND release_version = ? AND asset_filename = ?)
              OR (platform = 'macos' AND release_version = ? AND asset_filename = ?)
              OR (platform = 'android' AND release_version = ? AND asset_filename = ?))
          RETURNING platform, release_version, asset_filename`).bind(now, tokenHash, now,
          windows.version, windows.filename, macos.version, macos.filename, android.version, android.filename),
        db.prepare(`DELETE FROM pending_downloads WHERE token_hash = ?
          AND EXISTS (SELECT 1 FROM verified_downloads WHERE token_hash = ?)`).bind(tokenHash, tokenHash),
      ]);
      const record = result[0]?.results?.[0];
      if (!record) {
        const pending = await db.prepare('SELECT platform, expires_at, release_version, asset_filename FROM pending_downloads WHERE token_hash = ?').bind(tokenHash).first();
        const expected = pending && releaseFor(pending.platform);
        if (pending && expected && (pending.expires_at <= now || pending.release_version !== expected.version || pending.asset_filename !== expected.filename)) {
          await db.prepare('DELETE FROM pending_downloads WHERE token_hash = ? AND (expires_at <= ? OR release_version <> ? OR asset_filename <> ?)')
            .bind(tokenHash, now, expected.version, expected.filename).run();
          fail(410, 'expired_token', 'This verification link has expired. Request a new link.');
        }
        fail(400, 'invalid_token', 'This verification link is invalid or already used. Request a new link.');
      }
      return json({ status: 'verified', platform: record.platform, version: record.release_version, url: releaseFor(record.platform).url });
    }),
  };
}

export const downloadHandlers = createDownloadHandlers();
