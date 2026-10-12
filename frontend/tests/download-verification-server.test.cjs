const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash, createHmac } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const root = path.join(__dirname, '../..');
const moduleURL = pathToFileURL(path.join(root, 'website/download-verification.mjs')).href;
const migration = fs.readFileSync(path.join(root, 'website/migrations/0001_download_verification.sql'), 'utf8');
const origin = 'https://downloads.example.test';
const baseTime = Date.UTC(2026, 9, 12, 12);
const tokenHash = value => createHash('sha256').update(value).digest('hex');

// Run the actual migration and prepared SQL; D1 batch uses one SQL transaction.
class SQLiteD1 {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec(migration); this.batches = 0; }
  prepare(sql) {
    const database = this;
    function bound(parameters = []) {
      return { sql, parameters, bind: (...values) => bound(values),
        run: async () => database.execute(sql, parameters),
        all: async () => database.execute(sql, parameters),
        first: async () => database.execute(sql, parameters).results[0] || null };
    }
    return bound();
  }
  execute(sql, parameters) {
    const statement = this.sqlite.prepare(sql);
    const results = statement.columns().length ? statement.all(...parameters).map(row => ({ ...row })) : (statement.run(...parameters), []);
    return { success: true, results, meta: { changes: this.sqlite.prepare('SELECT changes() AS total').get().total } };
  }
  async batch(statements) {
    this.batches += 1;
    this.sqlite.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(statement => this.execute(statement.sql, statement.parameters)); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  rows(table) { return this.sqlite.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row })); }
  close() { this.sqlite.close(); }
}

async function fixture(t, options = {}) {
  const { createDownloadHandlers } = await import(moduleURL);
  const db = new SQLiteD1(); t.after(() => db.close());
  const env = { DOWNLOAD_DB: db, DOWNLOAD_HASH_KEY: 'synthetic-hmac-key-at-least-thirty-two-characters',
    TURNSTILE_SITE_KEY: 'synthetic-live-site-key', TURNSTILE_SECRET_KEY: 'synthetic-live-secret-key',
    RESEND_API_KEY: 'synthetic-mail-key', DOWNLOAD_FROM_EMAIL: 'TLI <verify@example.test>', DOWNLOAD_SITE_ORIGIN: origin };
  let now = baseTime;
  const calls = [], sent = [];
  let challenge = { success: true, hostname: new URL(origin).hostname, action: 'download_email' };
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      if (options.challengeFetch) return options.challengeFetch(url, init);
      return Response.json(challenge);
    }
    assert.equal(url, 'https://api.resend.com/emails', 'No unexpected external destination');
    assert.ok(options.realSender, 'Only the provider integration fixture may call mocked Resend');
    return Response.json({ id: 'synthetic-accepted-id' });
  };
  const dependencies = { fetcher, clock: () => now };
  if (!options.realSender) dependencies.sendEmail = async (...args) => {
    sent.push(args[1]);
    return options.sendEmail ? options.sendEmail(...args) : true;
  };
  const handlers = createDownloadHandlers(dependencies);
  const makeRequest = (route, payload, extra = {}) => new Request(`${origin}/api/download/${route}`, {
    method: 'POST', body: JSON.stringify(payload), headers: {
      Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.10', ...(extra.headers || {}),
    }, ...extra,
  });
  return { db, env, handlers, calls, sent, makeRequest,
    setTime(value) { now = value; }, advance(value) { now += value; }, setChallenge(value) { challenge = value; },
    request(body = {}, extra = {}) {
      return handlers.request(makeRequest('request', { email: 'reader@example.test', platform: 'windows', turnstileToken: 'synthetic-challenge', website: '', ...body }, extra), env);
    },
    verify(token, body = {}) { return handlers.verify(makeRequest('verify', { token, ...body }), env); },
  };
}

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  const value = await response.json();
  assert.equal(value.error, code);
  assert.equal(typeof value.message, 'string');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.ok(!Object.hasOwn(value, 'url') && !Object.hasOwn(value, 'token'));
  assert.doesNotMatch(JSON.stringify(value), /reader@example\.test|synthetic-mail-key|synthetic-live-secret-key/);
  return value;
}

test('config is minimal and fails closed for every missing binding, weak hash key, invalid origin and dummy Turnstile key', async t => {
  const f = await fixture(t);
  const request = () => new Request(`${origin}/api/download/config`);
  const enabled = await f.handlers.config(request(), f.env);
  assert.deepEqual(await enabled.json(), { enabled: true, turnstileSiteKey: f.env.TURNSTILE_SITE_KEY });
  for (const key of Object.keys(f.env)) {
    const env = { ...f.env }; delete env[key];
    await expectError(await f.handlers.config(request(), env), 503, 'unavailable');
  }
  for (const replacement of [
    { DOWNLOAD_HASH_KEY: 'short' }, { DOWNLOAD_SITE_ORIGIN: `${origin}/` }, { DOWNLOAD_SITE_ORIGIN: 'http://downloads.example.test' },
    { TURNSTILE_SITE_KEY: '1x00000000000000000000AA' }, { TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' },
    { TURNSTILE_SITE_KEY: '2x00000000000000000000BB' }, { TURNSTILE_SECRET_KEY: '3x0000000000000000000000000000000AA' },
  ]) await expectError(await f.handlers.config(request(), { ...f.env, ...replacement }), 503, 'unavailable');
  assert.equal(f.calls.length, 0);
  assert.equal(f.db.rows('download_rate_events').length, 0);
});

test('method, exact origin, JSON content and bounded body checks happen before external effects', async t => {
  const f = await fixture(t);
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    const response = await f.handlers.verify(new Request(`${origin}/api/download/verify`, { method }), f.env);
    await expectError(response, 405, 'invalid_request'); assert.equal(response.headers.get('Allow'), 'POST');
  }
  for (const request of [
    new Request(`${origin}/api/download/request`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }),
    new Request(`${origin}/api/download/request`, { method: 'POST', body: '{}', headers: { Origin: 'https://other.example.test', 'Content-Type': 'application/json' } }),
    new Request(`https://other.example.test/api/download/request`, { method: 'POST', body: '{}', headers: { Origin: origin, 'Content-Type': 'application/json' } }),
    new Request(`${origin}/api/download/request?email=reader@example.test`, { method: 'POST', body: '{}', headers: { Origin: origin, 'Content-Type': 'application/json' } }),
  ]) await expectError(await f.handlers.request(request, f.env), 403, 'forbidden');
  const direct = (body, type = 'application/json', extra = {}) => new Request(`${origin}/api/download/request`, {
    method: 'POST', body, headers: { Origin: origin, 'Content-Type': type, ...extra },
  });
  await expectError(await f.handlers.request(direct('{}', 'text/plain'), f.env), 415, 'invalid_request');
  await expectError(await f.handlers.request(direct('x'.repeat(4097)), f.env), 413, 'invalid_request');
  await expectError(await f.handlers.request(direct('{}', 'application/json', { 'Content-Length': '5000' }), f.env), 413, 'invalid_request');
  for (const value of ['{', 'null', '[]', '"string"']) await expectError(await f.handlers.request(direct(value), f.env), 400, 'invalid_request');
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
});

test('email syntax, disposable domains and subdomains, platform, honeypot and extra fields are server validated', async t => {
  const f = await fixture(t);
  for (const email of ['', 'not-an-address', 'a..b@example.test', '.a@example.test', 'a@example', 'a\r\nb@example.test', 'a@-bad.test', `${'a'.repeat(65)}@example.test`]) {
    await expectError(await f.request({ email }), 400, 'invalid_email');
  }
  for (const email of ['reader@mailinator.com', 'reader@sub.mailinator.com']) await expectError(await f.request({ email }), 400, 'disposable_email');
  for (const platform of ['linux', '__proto__', '', null]) await expectError(await f.request({ platform }), 400, 'invalid_platform');
  for (const website of ['https://spam.example', null, false]) await expectError(await f.request({ website }), 400, 'invalid_request');
  await expectError(await f.request({ url: 'https://untrusted.example/package.exe' }), 400, 'invalid_request');
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
});

test('Turnstile requires true success, exact hostname and the dedicated action before reserving or emailing', async t => {
  const f = await fixture(t);
  for (const value of [null, {}, { success: 'true', hostname: 'downloads.example.test', action: 'download_email' },
    { success: false, hostname: 'downloads.example.test', action: 'download_email' },
    { success: true, hostname: 'other.example.test', action: 'download_email' },
    { success: true, hostname: 'downloads.example.test', action: 'login' }]) {
    f.setChallenge(value); await expectError(await f.request(), 400, 'challenge_failed');
  }
  for (const turnstileToken of ['', null, 'x'.repeat(2049)]) await expectError(await f.request({ turnstileToken }), 400, 'challenge_failed');
  assert.equal(f.sent.length, 0); assert.equal(f.db.rows('download_rate_events').length, 0);
  const posted = JSON.parse(f.calls[0].init.body);
  assert.equal(posted.secret, f.env.TURNSTILE_SECRET_KEY);
  assert.equal(posted.response, 'synthetic-challenge'); assert.equal(posted.remoteip, '192.0.2.10');
  assert.equal(f.calls[0].init.method, 'POST'); assert.ok(f.calls[0].init.signal);
});

test('challenge network errors, HTTP rejection and malformed acknowledgements fail closed', async t => {
  for (const challengeFetch of [async () => { throw new Error('synthetic private provider error'); },
    async () => new Response('{}', { status: 503 }), async () => new Response('not json')]) {
    const f = await fixture(t, { challengeFetch });
    await expectError(await f.request(), 400, 'challenge_failed');
    assert.equal(f.sent.length, 0); assert.equal(f.db.rows('pending_downloads').length, 0);
    assert.equal(f.db.rows('download_rate_events').length, 0);
  }
});

test('request returns only check-email, stores a random token hash, and records verification only after a one-use POST', async t => {
  const f = await fixture(t);
  const response = await f.request({ email: 'First.Last+beta@GoogleMail.com', platform: 'macos' });
  assert.equal(response.status, 202); assert.deepEqual(await response.json(), { status: 'check_email' });
  const sent = f.sent[0]; assert.match(sent.token, /^[a-f0-9]{64}$/);
  assert.equal(sent.email, 'First.Last+beta@googlemail.com');
  assert.equal(sent.version, '1.4.4-beta'); assert.equal(sent.platform, 'macos');
  const pending = f.db.rows('pending_downloads')[0], rate = f.db.rows('download_rate_events')[0];
  assert.equal(pending.token_hash, tokenHash(sent.token)); assert.notEqual(pending.token_hash, sent.token);
  assert.equal(pending.expires_at - pending.requested_at, 20 * 60_000);
  assert.equal(pending.sent_at, baseTime); assert.equal(f.db.rows('verified_downloads').length, 0);
  assert.equal(rate.email_key, createHmac('sha256', f.env.DOWNLOAD_HASH_KEY).update('email:firstlast@gmail.com').digest('hex'));
  assert.equal(rate.ip_key, createHmac('sha256', f.env.DOWNLOAD_HASH_KEY).update('ip:192.0.2.10').digest('hex'));
  assert.doesNotMatch(JSON.stringify(rate), /@|192\.0\.2|First/);
  const scanner = await f.handlers.verify(new Request(`${origin}/api/download/verify?token=${sent.token}`), f.env);
  await expectError(scanner, 405, 'invalid_request'); assert.equal(f.db.rows('pending_downloads').length, 1);
  const verified = await f.verify(sent.token);
  assert.deepEqual(await verified.json(), { status: 'verified', platform: 'macos', version: '1.4.4-beta',
    url: 'https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.4-beta/TLI_1.4.4-beta_macOS.zip' });
  assert.equal(f.db.rows('pending_downloads').length, 0);
  const record = f.db.rows('verified_downloads')[0];
  assert.equal(record.email, sent.email); assert.equal(record.asset_filename, 'TLI_1.4.4-beta_macOS.zip');
  assert.equal(record.requested_at, baseTime); assert.equal(record.verified_at, baseTime);
  await expectError(await f.verify(sent.token), 400, 'invalid_token');
  assert.equal(f.db.rows('verified_downloads').length, 1);
});

test('pending sender status cannot redeem, provider failure removes the pending email but retains quota', async t => {
  let finishSend;
  const f = await fixture(t, { sendEmail: () => new Promise(resolve => { finishSend = resolve; }) });
  const request = f.request();
  while (!finishSend) await new Promise(setImmediate);
  const token = f.sent[0].token;
  await expectError(await f.verify(token), 400, 'invalid_token');
  assert.equal(f.db.rows('verified_downloads').length, 0);
  finishSend(false); await expectError(await request, 503, 'delivery_failed');
  assert.equal(f.db.rows('pending_downloads').length, 0); assert.equal(f.db.rows('download_rate_events').length, 1);
  await expectError(await f.verify(token), 400, 'invalid_token');
  await expectError(await f.request(), 429, 'rate_limited');
  assert.equal(f.sent.length, 1);
});

test('expiry, invented tokens and client-selected package fields never disclose a download', async t => {
  const f = await fixture(t); await f.request(); const token = f.sent[0].token;
  for (const value of ['', 'bad', 'A'.repeat(64), '0'.repeat(64)]) await expectError(await f.verify(value), 400, 'invalid_token');
  await expectError(await f.verify(token, { platform: 'macos', url: 'https://untrusted.example/file' }), 400, 'invalid_request');
  assert.equal(f.db.rows('verified_downloads').length, 0);
  f.advance(20 * 60_000); await expectError(await f.verify(token), 410, 'expired_token');
  assert.equal(f.db.rows('verified_downloads').length, 0);
  assert.equal(f.db.rows('pending_downloads').length, 0, 'Expired email is removed on redemption attempts');
});

test('provider exceptions expose no private diagnostics, retain the reservation and do not create verified records', async t => {
  const f = await fixture(t, { sendEmail: async () => { throw new Error('reader@example.test synthetic-mail-key'); } });
  const response = await f.request();
  await expectError(response, 503, 'delivery_failed');
  assert.equal(f.db.rows('pending_downloads').length, 0);
  assert.equal(f.db.rows('verified_downloads').length, 0);
  assert.equal(f.db.rows('download_rate_events').length, 1);
});

test('concurrent redemption has exactly one winner and one verified record', async t => {
  const f = await fixture(t); await f.request(); const token = f.sent[0].token;
  const responses = await Promise.all(Array.from({ length: 12 }, () => f.verify(token)));
  assert.equal(responses.filter(response => response.status === 200).length, 1);
  assert.equal(responses.filter(response => response.status === 400).length, 11);
  assert.equal(f.db.rows('verified_downloads').length, 1); assert.equal(f.db.rows('pending_downloads').length, 0);
});

test('canonical Gmail aliases share the atomic cooldown and five-request UTC-day budget', async t => {
  const f = await fixture(t);
  const aliases = ['First.Last@gmail.com', 'firstlast+one@gmail.com', 'f.i.r.s.t.l.a.s.t@googlemail.com', 'FIRSTLAST+two@GMAIL.COM', 'firstlast+three@googlemail.com'];
  const simultaneous = await Promise.all(aliases.map(email => f.request({ email })));
  assert.equal(simultaneous.filter(response => response.status === 202).length, 1);
  assert.equal(simultaneous.filter(response => response.status === 429).length, 4);
  for (let index = 1; index < 5; index += 1) { f.advance(60_000); assert.equal((await f.request({ email: aliases[index] })).status, 202); }
  f.advance(60_000); await expectError(await f.request({ email: aliases[0] }), 429, 'rate_limited');
  assert.equal(f.sent.length, 5); assert.equal(f.db.rows('download_rate_events').length, 5);
  f.setTime(Date.UTC(2026, 9, 13, 12)); assert.equal((await f.request({ email: aliases[0] })).status, 202);
  assert.equal(f.db.rows('download_rate_events').length, 1, 'Old rate rows are cleaned up');
  assert.equal(f.db.rows('pending_downloads').length, 1, 'Expired pending email is cleaned up');
});

test('concurrent requests from one IP cannot exceed ten reservations in the rolling hour', async t => {
  const f = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 18 }, (_, index) => f.request({ email: `reader${index}@example.test` })));
  assert.equal(responses.filter(response => response.status === 202).length, 10);
  assert.equal(responses.filter(response => response.status === 429).length, 8);
  assert.equal(f.sent.length, 10); assert.equal(f.db.rows('download_rate_events').length, 10);
  f.advance(60 * 60_000); assert.equal((await f.request({ email: 'later@example.test' })).status, 202);
});

test('UTC midnight does not erase a rolling IP-hour budget or the preceding email cooldown', async t => {
  const f = await fixture(t); f.setTime(Date.UTC(2026, 9, 12, 23, 59, 30));
  const accepted = await Promise.all(Array.from({ length: 10 }, (_, index) => f.request({ email: `midnight${index}@example.test` })));
  assert.ok(accepted.every(response => response.status === 202));
  f.advance(30_000);
  await expectError(await f.request({ email: 'newday@example.test' }), 429, 'rate_limited');
  await expectError(await f.request({ email: 'midnight0@example.test' }, {
    headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.99' },
  }), 429, 'rate_limited');
  assert.equal(f.sent.length, 10);
});

test('global daily send reservation is atomic and pending cleanup cannot reset daily quotas', async t => {
  const f = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 110 }, (_, index) => f.request({ email: `global${index}@example.test` }, {
    headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': `192.0.2.${index + 1}` },
  })));
  assert.equal(responses.filter(response => response.status === 202).length, 100);
  assert.equal(responses.filter(response => response.status === 429).length, 10);
  assert.equal(f.sent.length, 100); assert.equal(f.db.rows('pending_downloads').length, 100);
  f.advance(21 * 60_000);
  await expectError(await f.request({ email: 'later@example.test' }), 429, 'rate_limited');
  assert.equal(f.db.rows('pending_downloads').length, 0);
  assert.equal(f.db.rows('download_rate_events').length, 100);
});

test('D1 transaction errors never email without a reservation or consume without a verified record', async t => {
  const f = await fixture(t);
  f.db.sqlite.exec("CREATE TRIGGER fail_pending BEFORE INSERT ON pending_downloads BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
  await expectError(await f.request(), 503, 'unavailable');
  assert.equal(f.db.rows('download_rate_events').length, 0); assert.equal(f.sent.length, 0);
  f.db.sqlite.exec('DROP TRIGGER fail_pending;'); await f.request(); const token = f.sent[0].token;
  f.db.sqlite.exec("CREATE TRIGGER fail_verified BEFORE INSERT ON verified_downloads BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
  await expectError(await f.verify(token), 503, 'unavailable');
  assert.equal(f.db.rows('pending_downloads').length, 1); assert.equal(f.db.rows('verified_downloads').length, 0);
  f.db.sqlite.exec("DROP TRIGGER fail_verified; CREATE TRIGGER fail_consumption BEFORE DELETE ON pending_downloads BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
  await expectError(await f.verify(token), 503, 'unavailable');
  assert.equal(f.db.rows('pending_downloads').length, 1);
  assert.equal(f.db.rows('verified_downloads').length, 0, 'Consumption failure rolls back the verified INSERT');
});

test('actual provider adapter receives the private token only in a mocked verification email', async t => {
  const f = await fixture(t, { realSender: true });
  const response = await f.request(); assert.equal(response.status, 202);
  const result = await response.json(); assert.deepEqual(result, { status: 'check_email' });
  assert.deepEqual(f.calls.map(call => call.url), ['https://challenges.cloudflare.com/turnstile/v0/siteverify', 'https://api.resend.com/emails']);
  const mail = JSON.parse(f.calls[1].init.body);
  assert.deepEqual(mail.to, ['reader@example.test']);
  const token = mail.text.match(/#verify=([a-f0-9]{64})/)[1];
  assert.equal(f.db.rows('pending_downloads')[0].token_hash, tokenHash(token));
  assert.ok(!JSON.stringify(result).includes(token));
  assert.equal(f.db.rows('verified_downloads').length, 0);
});

test('Pages adapters fail closed with missing deployment configuration', async () => {
  for (const route of ['config', 'request', 'verify']) {
    const adapter = await import(pathToFileURL(path.join(root, `functions/api/download/${route}.js`)).href);
    await expectError(await adapter.onRequest({ request: new Request(`${origin}/api/download/${route}`), env: {} }), 503, 'unavailable');
  }
});
