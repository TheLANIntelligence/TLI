import { PUBLIC_RELEASE } from './release.js?v=1.4.0-beta-1';

// Static links are the no-JavaScript fallback. Never use the updater manifest
// to choose a fresh-install archive.
['windows', 'macos'].forEach((platform) => {
  document.querySelectorAll(`[data-${platform}-download]`).forEach((link) => {
    link.href = PUBLIC_RELEASE[platform].url;
  });
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

emailForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!emailForm.reportValidity()) return;
  const submit = emailForm.querySelector('button[type="submit"]');
  if (submit.disabled) return;
  const initialLabel = submit.innerHTML;
  submit.disabled = true;
  submit.textContent = 'Sending…';
  emailForm.setAttribute('aria-busy', 'true');
  emailStatus.textContent = 'Sending your request…';
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);
  try {
    // The only network request on this page beyond static assets is this
    // optional form submission, initiated by the visitor.
    const response = await fetch(emailForm.action, {
      method: 'POST',
      body: new FormData(emailForm),
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('Request was not accepted');
    emailStatus.textContent = 'Request received. We’ll email you a download link. You can also download the beta above now.';
    emailForm.reset();
  } catch {
    emailStatus.textContent = 'We could not confirm your request. Please try again, email thelanintelligence@gmail.com, or use the download above.';
  } finally {
    window.clearTimeout(timeout);
    submit.disabled = false;
    submit.innerHTML = initialLabel;
    emailForm.removeAttribute('aria-busy');
  }
});
