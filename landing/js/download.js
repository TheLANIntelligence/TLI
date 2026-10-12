import { PUBLIC_RELEASE } from './release.js?v=release-1.4.2-20261011';

// Verified email precedes access to the selected fresh-install link.
// The underlying public GitHub release is not an authenticated file service.
['windows', 'macos'].forEach((platform) => {
  const checksum = document.getElementById(`${platform}-sha256`);
  if (checksum) checksum.textContent = PUBLIC_RELEASE[platform].sha256;
});

const copyStatus = document.getElementById('copy-status');

async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Older browsers and denied clipboard permission may still allow a
      // copy initiated by the user's button press through execCommand.
    }
  }
  const previousFocus = document.activeElement;
  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.setAttribute('aria-label', 'Text to copy');
  field.style.cssText = 'position:fixed;left:-9999px;top:0;';
  document.body.append(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand('copy') === true;
  } catch {
    copied = false;
  } finally {
    field.remove();
    previousFocus?.focus({ preventScroll: true });
  }
  return copied;
}

document.querySelectorAll('[data-copy]').forEach((button) => {
  button.hidden = false;
  const initialLabel = button.textContent;
  let resetTimer;
  button.addEventListener('click', async () => {
    clearTimeout(resetTimer);
    const source = document.getElementById(button.dataset.copy);
    if (!source) return;
    button.disabled = true;
    const copied = await copyText(source.textContent.trim());
    button.disabled = false;
    button.textContent = copied ? 'Copied' : 'Select and copy';
    copyStatus.textContent = copied
      ? `${button.dataset.copyName} copied to clipboard.`
      : 'Copy was unavailable. The text is selected; use your keyboard or browser menu to copy it.';
    if (!copied) {
      source.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(source);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    resetTimer = window.setTimeout(() => { button.textContent = initialLabel; }, 3500);
  });
});

// Read only the documented opaque fragment; scrub it before any API or widget load.
let verificationToken = null;
let invalidVerificationLink = false;
if (window.location.hash.startsWith('#verify=')) {
  const match = /^#verify=([a-fA-F0-9]{64})$/.exec(window.location.hash);
  try {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    verificationToken = match ? match[1].toLowerCase() : null;
    invalidVerificationLink = !match;
  } catch {
    // A token that could not be removed from the address bar is never submitted.
    invalidVerificationLink = true;
  }
}

const emailForm = document.getElementById('download-email-form');
const emailStatus = document.getElementById('email-status');
const emailInput = document.getElementById('download-email');
const platformInput = document.getElementById('download-platform');
const websiteInput = document.getElementById('download-website');
const submit = document.getElementById('download-submit');
const ready = document.getElementById('download-ready');
const downloadFile = document.getElementById('download-file');
const macInstaller = document.getElementById('mac-installer');
const verificationPanel = document.getElementById('email-verification');
const verifyButton = document.getElementById('verify-email');
const verifyStatus = document.getElementById('verify-status');
const challengeStatus = document.getElementById('challenge-status');
const platformNames = { windows: 'Windows', macos: 'macOS' };
const unavailableMessage = 'Email verification is temporarily unavailable. Please try again later or contact TLI below for help.';

async function apiRequest(path, body) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error('Download verification failed');
      error.code = data && typeof data.error === 'string' ? data.error : '';
      throw error;
    }
    return { status: response.status, data };
  } finally {
    window.clearTimeout(timeout);
  }
}

function errorMessage(error, verifying = false) {
  const messages = {
    invalid_email: 'Enter a valid email address and try again.',
    disposable_email: 'Please use an email address that can receive your verification link; temporary email services are not supported.',
    invalid_platform: 'Choose Windows or macOS to continue.',
    challenge_failed: 'Complete the Cloudflare check again, then request your link.',
    rate_limited: 'Too many attempts. Please wait before trying again, or contact TLI below for help.',
    unavailable: unavailableMessage,
    delivery_failed: 'We could not send the verification email. Please try again later or contact TLI below for help.',
    invalid_token: 'This verification link is invalid or has already been used. Request a new link below.',
    expired_token: 'This verification link has expired. Request a new link below.',
  };
  return Object.hasOwn(messages, error.code) ? messages[error.code]
    : verifying ? 'We could not confirm your email. Try again or request a new link below. Contact TLI if you need help.'
      : 'We could not confirm that a verification email was sent. Please try again, or contact TLI below for help.';
}

function loadTurnstile() {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = window.setTimeout(() => reject(new Error('Challenge unavailable')), 20000);
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.addEventListener('load', () => {
      window.clearTimeout(timeout);
      if (window.turnstile && typeof window.turnstile.render === 'function') resolve(window.turnstile);
      else reject(new Error('Challenge unavailable'));
    }, { once: true });
    script.addEventListener('error', () => {
      window.clearTimeout(timeout);
      reject(new Error('Challenge unavailable'));
    }, { once: true });
    document.head.append(script);
  });
}

if (emailForm && emailInput && platformInput && websiteInput && submit && ready && downloadFile
  && macInstaller && verificationPanel && verifyButton && verifyStatus && challengeStatus) {
  let serviceEnabled = false;
  let pending = false;
  let formRevision = 0;
  let challengeToken = '';
  let widgetId = null;

  function updateButtons() {
    submit.disabled = !serviceEnabled || !challengeToken || pending;
    verifyButton.disabled = !serviceEnabled || !verificationToken || pending;
  }

  function hideDownload() {
    ready.hidden = true;
    downloadFile.removeAttribute('href');
    macInstaller.hidden = true;
  }

  function showPendingVerification() {
    if (!verificationToken) return;
    verificationPanel.hidden = false;
    verificationPanel.scrollIntoView({ block: 'center', behavior: 'instant' });
    if (!verifyButton.disabled) verifyButton.focus({ preventScroll: true });
  }

  function resetChallenge() {
    challengeToken = '';
    updateButtons();
    if (widgetId !== null) {
      try { window.turnstile.reset(widgetId); } catch { /* The form remains disabled. */ }
    }
  }

  function editDetails() {
    formRevision += 1;
    hideDownload();
    verificationToken = null;
    verificationPanel.hidden = true;
    verifyStatus.textContent = '';
    emailStatus.textContent = serviceEnabled ? '' : unavailableMessage;
    updateButtons();
  }

  emailInput.addEventListener('input', editDetails);
  platformInput.addEventListener('change', editDetails);
  ['windows', 'macos'].forEach((platform) => {
    document.querySelectorAll(`[data-${platform}-download]`).forEach((link) => {
      link.href = '#access';
      link.addEventListener('click', (event) => {
        event.preventDefault();
        // A platform shortcut must not discard an email link already in hand.
        if (verificationToken) {
          showPendingVerification();
          return;
        }
        platformInput.value = platform;
        editDetails();
        emailInput.focus();
      });
    });
  });

  emailForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending || !serviceEnabled || !challengeToken) return;
    emailInput.value = emailInput.value.trim();
    if (!emailForm.reportValidity()) return;
    const platform = platformInput.value;
    if (!Object.hasOwn(platformNames, platform)) {
      emailStatus.textContent = 'Choose Windows or macOS to continue.';
      platformInput.focus();
      return;
    }
    const email = emailInput.value;
    if (!email || !emailInput.checkValidity()) return;
    hideDownload();
    verificationToken = null;
    verificationPanel.hidden = true;
    const revision = ++formRevision;
    const turnstileToken = challengeToken;
    challengeToken = '';
    pending = true;
    updateButtons();
    submit.textContent = 'Sending verification link…';
    emailForm.setAttribute('aria-busy', 'true');
    emailStatus.textContent = 'Requesting your verification email…';
    try {
      const { status, data } = await apiRequest('/api/download/request', { email, platform, turnstileToken, website: websiteInput.value });
      if (revision !== formRevision || emailInput.value.trim() !== email || platformInput.value !== platform) return;
      if (status !== 202 || !data || data.status !== 'check_email') throw new Error('Request not confirmed');
      emailStatus.textContent = 'Check your inbox. Open the verification link, then choose “Verify email and show download” on this page. Check your spam folder if needed.';
    } catch (error) {
      if (revision === formRevision) emailStatus.textContent = errorMessage(error);
    } finally {
      pending = false;
      submit.textContent = 'Send verification link';
      emailForm.removeAttribute('aria-busy');
      resetChallenge();
    }
  });

  verifyButton.addEventListener('click', async () => {
    if (pending || !serviceEnabled || !verificationToken) return;
    const token = verificationToken;
    const revision = formRevision;
    pending = true;
    hideDownload();
    updateButtons();
    verificationPanel.setAttribute('aria-busy', 'true');
    verifyStatus.textContent = 'Verifying your email…';
    try {
      const { status, data } = await apiRequest('/api/download/verify', { token });
      if (revision !== formRevision || token !== verificationToken) return;
      if (status !== 200 || !data || data.status !== 'verified'
        || !Object.hasOwn(platformNames, data.platform) || data.version !== PUBLIC_RELEASE.version
        || data.url !== PUBLIC_RELEASE[data.platform].url) throw new Error('Unrecognized release');
      verificationToken = null;
      platformInput.value = data.platform;
      downloadFile.href = PUBLIC_RELEASE[data.platform].url;
      downloadFile.textContent = `Download TLI ${PUBLIC_RELEASE.version} for ${platformNames[data.platform]}`;
      ready.hidden = false;
      macInstaller.hidden = data.platform !== 'macos';
      verificationPanel.hidden = true;
      emailStatus.textContent = 'Email verified. Your download is ready below.';
      downloadFile.focus();
    } catch (error) {
      if (revision === formRevision && token === verificationToken) {
        verifyStatus.textContent = errorMessage(error, true);
        if (error.code === 'invalid_token' || error.code === 'expired_token') verificationToken = null;
      }
    } finally {
      pending = false;
      verificationPanel.removeAttribute('aria-busy');
      updateButtons();
    }
  });

  hideDownload();
  verificationPanel.hidden = !verificationToken && !invalidVerificationLink;
  if (invalidVerificationLink) verifyStatus.textContent = 'This verification link is invalid. Request a new link below.';
  updateButtons();
  showPendingVerification();

  async function initialize() {
    let publicSiteKey;
    try {
      const { status, data } = await apiRequest('/api/download/config');
      if (status !== 200 || !data || data.enabled !== true || typeof data.turnstileSiteKey !== 'string'
        || !data.turnstileSiteKey.trim()) throw new Error('Verification unavailable');
      publicSiteKey = data.turnstileSiteKey;
      serviceEnabled = true;
      emailStatus.textContent = '';
      updateButtons();
      showPendingVerification();
    } catch {
      emailStatus.textContent = unavailableMessage;
      if (!verificationPanel.hidden) verifyStatus.textContent = unavailableMessage;
      showPendingVerification();
      return;
    }
    try {
      const turnstile = await loadTurnstile();
      widgetId = turnstile.render('#download-challenge', {
        sitekey: publicSiteKey, action: 'download_email', theme: 'light', size: 'compact', 'response-field': false,
        callback(token) {
          challengeToken = typeof token === 'string' ? token : '';
          challengeStatus.textContent = '';
          updateButtons();
        },
        'expired-callback'() {
          challengeToken = '';
          challengeStatus.textContent = 'The Cloudflare check expired. Complete it again to request your link.';
          updateButtons();
        },
        'error-callback'() {
          challengeToken = '';
          challengeStatus.textContent = 'The Cloudflare check could not finish. Reload this page or contact TLI below for help.';
          updateButtons();
        },
      });
    } catch {
      challengeToken = '';
      challengeStatus.textContent = 'The Cloudflare check is unavailable. Reload this page or contact TLI below for help.';
      updateButtons();
    }
  }
  initialize();
}
