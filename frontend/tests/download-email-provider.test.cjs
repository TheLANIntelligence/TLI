const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const sender = import('../../website/send-verification-email.mjs');
const domains = import('../../website/disposable-domains.mjs');
const env = {
  RESEND_API_KEY: 'synthetic-server-only-key',
  DOWNLOAD_FROM_EMAIL: 'TLI Downloads <downloads@notify.example.org>',
  DOWNLOAD_SITE_ORIGIN: 'https://thelanintelligence.com',
};
const message = { email: 'visitor@example.org', platform: 'windows', version: '1.4.0-beta', token: 'a'.repeat(64) };

test('disposable-domain filter covers subdomains while permitting normal personal email', async () => {
  const { isDisposableDomain } = await domains;
  for (const domain of ['mailinator.com', 'sub.mailinator.com', 'MAILINATOR.COM', 'guerrillamail.com', '10minutemail.com']) {
    assert.equal(isDisposableDomain(domain), true, domain);
  }
  for (const domain of ['mailinator.com.example.org', 'gmail.com', 'outlook.com', 'icloud.com', 'yahoo.com', 'proton.me', 'fastmail.com', 'privaterelay.appleid.com']) {
    assert.equal(isDisposableDomain(domain), false, domain);
  }
});

test('verification email goes only to the supplied recipient with a one-use fragment link', async () => {
  const { sendVerificationEmail } = await sender;
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ id: 'synthetic-accepted-message' }) };
  };
  assert.equal(await sendVerificationEmail(env, message, fetcher), true);
  const request = calls[0];
  assert.equal(request.url, 'https://api.resend.com/emails');
  assert.deepEqual(request.body.to, [message.email]);
  assert.equal(request.body.from, env.DOWNLOAD_FROM_EMAIL);
  assert.match(request.body.text, /\/download\/#verify=a{64}/);
  assert.match(request.body.text, /expires in 20 minutes/);
  assert.match(request.body.text, /does not subscribe you to marketing/);
  assert.ok(!request.body.text.includes('releases/download/'));
  assert.ok(!request.body.html.includes(env.RESEND_API_KEY));
  assert.ok(!request.options.headers['Idempotency-Key'].includes(message.token));
  assert.match(request.options.headers['Idempotency-Key'], /^tli-verification-[a-f0-9]{64}$/);
  await sendVerificationEmail(env, message, fetcher);
  assert.equal(calls[1].options.headers['Idempotency-Key'], request.options.headers['Idempotency-Key']);
});

test('provider failures cannot count as an accepted verification email or expose provider details', async () => {
  const { sendVerificationEmail } = await sender;
  const cases = [
    async () => ({ ok: false, json: async () => ({ message: message.email }) }),
    async () => ({ ok: true, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => ({ id: '' }) }),
    async () => ({ ok: true, json: async () => { throw new Error(message.token); } }),
    async () => { throw new Error(env.RESEND_API_KEY); },
  ];
  for (const fetcher of cases) {
    await assert.rejects(sendVerificationEmail(env, message, fetcher), error => {
      assert.equal(error.message, 'Verification email is unavailable');
      return true;
    });
  }
});

test('missing sender settings and untrusted origins or tokens never contact the email provider', async () => {
  const { sendVerificationEmail } = await sender;
  let calls = 0;
  const fetcher = async () => { calls += 1; throw new Error('must not send'); };
  for (const config of [
    { ...env, RESEND_API_KEY: '' }, { ...env, DOWNLOAD_FROM_EMAIL: '' },
    { ...env, DOWNLOAD_SITE_ORIGIN: 'http://thelanintelligence.com' },
    { ...env, DOWNLOAD_SITE_ORIGIN: 'https://thelanintelligence.com/redirect' },
  ]) await assert.rejects(sendVerificationEmail(config, message, fetcher));
  await assert.rejects(sendVerificationEmail(env, { ...message, token: '<script>' }, fetcher));
  await assert.rejects(sendVerificationEmail(env, { ...message, platform: 'attacker' }, fetcher));
  assert.equal(calls, 0);
});
