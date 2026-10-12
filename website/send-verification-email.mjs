import { verificationEmailHTML } from './verification-email-template.mjs';

const platformNames = { windows: 'Windows', macos: 'macOS' };

// Only the server calls this adapter. API keys and verification tokens never
// enter the browser's request response, analytics, or application logs.
export async function sendVerificationEmail(env, { email, platform, version, token }, fetcher = fetch) {
  if (!env.RESEND_API_KEY || !env.DOWNLOAD_FROM_EMAIL
    || !Object.hasOwn(platformNames, platform) || !/^[a-f0-9]{64}$/.test(token)) {
    throw new Error('Verification email is unavailable');
  }
  const origin = new URL(env.DOWNLOAD_SITE_ORIGIN);
  if (origin.protocol !== 'https:' || origin.origin !== env.DOWNLOAD_SITE_ORIGIN) {
    throw new Error('Verification email is unavailable');
  }
  const link = `${origin.origin}/download/#verify=${token}`;
  const label = `TLI ${version} for ${platformNames[platform]}`;
  const text = `Verify your email to download ${label}.\n\nOpen this link, then choose "Verify email and show download":\n${link}\n\nThis link expires in 20 minutes and works once. If you did not request a TLI download, ignore this email. No download registration is verified until you confirm. This does not subscribe you to marketing emails.\n\nTheLANIntelligence\nhttps://thelanintelligence.com/`;
  const html = verificationEmailHTML({ label, link });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const idempotencyKey = 'tli-verification-' + [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetcher('https://api.resend.com/emails', {
      method: 'POST', signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ from: env.DOWNLOAD_FROM_EMAIL, to: [email],
        subject: `Verify your email — TLI for ${platformNames[platform]}`, text, html }),
    });
    if (!response.ok) throw new Error('Verification email was not accepted');
    const receipt = await response.json();
    if (!receipt || typeof receipt.id !== 'string' || !receipt.id.trim()) {
      throw new Error('Verification email was not acknowledged');
    }
    return true;
  } catch {
    // Provider responses can contain recipients or credentials. Keep errors generic.
    throw new Error('Verification email is unavailable');
  } finally {
    clearTimeout(timeout);
  }
}
