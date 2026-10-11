import { PUBLIC_RELEASE } from './release.js?v=1.4.0-beta-1';

// Website registration precedes access to the selected fresh-install link.
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

const emailForm = document.getElementById('download-email-form');
const emailStatus = document.getElementById('email-status');
const emailInput = document.getElementById('download-email');
const platformInput = document.getElementById('download-platform');
const submit = document.getElementById('download-submit');
const ready = document.getElementById('download-ready');
const downloadFile = document.getElementById('download-file');
const macInstaller = document.getElementById('mac-installer');
const platformNames = { windows: 'Windows', macos: 'macOS' };

if (emailForm && emailInput && platformInput && submit && ready && downloadFile && macInstaller) {
  let pending = false;
  let formRevision = 0;

  function lockDownload() {
    formRevision += 1;
    ready.hidden = true;
    downloadFile.removeAttribute('href');
    macInstaller.hidden = true;
    emailStatus.textContent = '';
  }

  emailInput.addEventListener('input', lockDownload);
  platformInput.addEventListener('change', lockDownload);
  ['windows', 'macos'].forEach((platform) => {
    document.querySelectorAll(`[data-${platform}-download]`).forEach((link) => {
      link.href = '#access';
      link.addEventListener('click', (event) => {
        event.preventDefault();
        platformInput.value = platform;
        lockDownload();
        emailInput.focus();
      });
    });
  });

  emailForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending) return;
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
    lockDownload();
    const revision = formRevision;
    const release = PUBLIC_RELEASE[platform];
    const body = new FormData();
    // Explicit fields keep email out of URLs, browser storage and logs.
    for (const [name, value] of Object.entries({
      email, platform, release_version: PUBLIC_RELEASE.version,
      asset_filename: release.filename, request_kind: 'desktop_download_request',
      source_page: '/download/', _subject: `TLI ${PUBLIC_RELEASE.version} ${platformNames[platform]} download request`,
    })) body.set(name, value);

    pending = true;
    const initialLabel = submit.textContent;
    submit.disabled = true;
    submit.textContent = 'Recording request…';
    emailForm.setAttribute('aria-busy', 'true');
    emailStatus.textContent = 'Recording your download request…';
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(emailForm.action, {
        method: 'POST', body, headers: { Accept: 'application/json' },
        signal: controller.signal, credentials: 'omit',
      });
      if (!response.ok) throw new Error('Request was not accepted');
      const receipt = await response.json();
      // Formspree's success contract is { next: string }. Never navigate to
      // that redirect: only the platform selected from our release is offered.
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
        || typeof receipt.next !== 'string' || !receipt.next
        || Object.hasOwn(receipt, 'error') || Object.hasOwn(receipt, 'errors')) {
        throw new Error('Request was not acknowledged');
      }
      if (revision !== formRevision || emailInput.value.trim() !== email || platformInput.value !== platform) {
        emailStatus.textContent = 'Your details changed. Submit the current email and platform to continue.';
        return;
      }
      downloadFile.href = release.url;
      downloadFile.textContent = `Download TLI ${PUBLIC_RELEASE.version} for ${platformNames[platform]}`;
      ready.hidden = false;
      macInstaller.hidden = platform !== 'macos';
      emailStatus.textContent = 'Request recorded. Your download is ready below.';
      downloadFile.focus();
    } catch {
      // A timeout can follow a saved request. Never imply delivery or completion.
      emailStatus.textContent = 'We could not confirm your request. Please try again, or contact thelanintelligence@gmail.com for help.';
    } finally {
      window.clearTimeout(timeout);
      pending = false;
      submit.disabled = false;
      submit.textContent = initialLabel;
      emailForm.removeAttribute('aria-busy');
    }
  });
  lockDownload();
  submit.disabled = false;
}
