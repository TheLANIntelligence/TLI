import domains from './vendor/disposable-email-domains.json' with { type: 'json' };

const blocked = new Set(domains);

// Include subdomains, but never unrelated names such as mailinator.com.example.org.
export function isDisposableDomain(domain) {
  const labels = String(domain).toLowerCase().split('.');
  for (let index = 0; index < labels.length - 1; index += 1) {
    if (blocked.has(labels.slice(index).join('.'))) return true;
  }
  return false;
}
