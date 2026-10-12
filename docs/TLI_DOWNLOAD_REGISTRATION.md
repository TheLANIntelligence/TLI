# Verified website download requests

The website asks visitors to select Windows or macOS and verify their email
before showing that platform's download link. The request must pass Cloudflare
Turnstile, server-side email validation, a disposable-domain filter, and rate
limits. Resend then sends a single-use verification link that expires after
20 minutes. Opening the email link displays an explicit verification button;
an email scanner's GET request cannot consume it.

Only successful verification writes to the private `verified_downloads` register
and returns the current release URL. Provider errors and missing configuration
leave downloads locked. This flow replaces the Formspree download form; old
Formspree submissions remain separate, unverified requests.

## What verification establishes

A verified request demonstrates access to that inbox at verification time.
It does not establish a person's identity, guarantee that an address will never
be used for spam, or prove a completed download or installation. Common personal
email providers remain allowed. Known disposable domains and their subdomains
are blocked using the versioned list in `website/vendor/`.

The GitHub release ZIPs, `downloads.json`, and Mac installer remain public.
Direct GitHub downloads and shared copies can bypass this website flow. The
register records verified website requests, not every person who obtains TLI.
GitHub's separate asset download counts include repeat and validation requests
and do not identify downloaders.

## Hosting and activation

Cloudflare Pages serves `landing/` and routes `/api/download/*` to Pages
Functions. `wrangler.toml` defines separate production and preview D1 databases.
Apply `website/migrations/0001_download_verification.sql` to each database before
deployment. The API is unavailable until every required binding is configured.

Public settings:

- `DOWNLOAD_SITE_ORIGIN`: the exact HTTPS origin without a trailing slash.
  Production uses `https://thelanintelligence.com`. The configured preview uses
  `https://email-verification-preview.thelanintelligence.pages.dev`; requests to
  other deployment URLs are intentionally rejected.
- `DOWNLOAD_FROM_EMAIL`: a sender on a domain verified in Resend. The planned
  sender is `TLI Downloads <downloads@notify.thelanintelligence.com>`.
- `TURNSTILE_SITE_KEY`: a real managed widget configured for both site hostnames.
- `DOWNLOAD_DB`: the environment's D1 binding.

Secret settings, stored only as encrypted Pages environment secrets:

- `RESEND_API_KEY`: a Resend key with sending permission for the verified domain.
- `TURNSTILE_SECRET_KEY`: the matching widget's secret.
- `DOWNLOAD_HASH_KEY`: a cryptographically random value of at least 32 characters,
  used to HMAC email and IP quota identifiers.

Do not put secrets in `wrangler.toml`, the static site, source control, or desktop
packages. Local Wrangler `.dev.vars` files are ignored and rejected by the source
hygiene check. Official Turnstile testing keys are rejected by the deployed API.

Signing into Resend with a Gmail address identifies the account owner; it does
not verify an outgoing sender domain. Verify the `notify.thelanintelligence.com`
subdomain using the DNS records supplied by Resend, then configure the sending
key and sender. Keep the site's existing mailbox DNS intact. Connecting an editor
plugin alone does not install a sending key in Cloudflare.

Deploy and inspect the preview before production. With real credentials in place,
use an owner-approved test inbox to confirm email delivery, verification, the
correct release link, exactly one verified row, and rejection of a reused link.
Exclude that clearly labeled test row from real-request reports. Never claim
end-to-end delivery based only on mocked provider tests.

## Where to see verified requests

In the Cloudflare account, open Workers & Pages, D1, then the production database
`tli-download-verification`. Its `verified_downloads` table is the register. For
example, the authenticated D1 console can run this read-only query:

```sql
SELECT email, platform, release_version, asset_filename,
       datetime(requested_at / 1000, 'unixepoch') AS requested_at_utc,
       datetime(verified_at / 1000, 'unixepoch') AS verified_at_utc
FROM verified_downloads
ORDER BY verified_at DESC;
```

There is no public records endpoint. Limit dashboard and database access to
people who need these contact details. Do not commit query results or exports.
The verification email does not subscribe anyone to marketing.

## Retention and abuse controls

Pending records contain the entered email, selected release, timestamps, and a
SHA-256 token hash. Raw verification tokens are only in the email link and the
visitor's short-lived page memory. The fragment is removed from the address bar
before the external challenge script loads. Tokens are never saved in browser
storage or returned by the request API.

Pending links stop working after 20 minutes. Pending records are physically
purged on the next accepted-challenge request; expired-token redemption also
cleans up the corresponding expired record. This is opportunistic cleanup, not a scheduled purge.
Quota records store keyed hashes, not raw IP addresses, and are cleaned up after
their applicable time windows during new requests. Verified records remain until
an operator deletes them; set a retention policy appropriate to the business and
handle removal requests through the private database. Resend and Cloudflare also
have their own account-level logs and retention settings.

Default server limits are one email request per 60 seconds, five per canonical
email per UTC day, ten per Cloudflare client IP per rolling hour, and 100 total
per UTC day. Gmail dots and plus aliases share an email quota. Failed delivery
attempts consume quota to avoid unlimited provider retries. These limits are
atomic across requests but cannot eliminate distributed abuse or all temporary
addresses; review delivery failures and usage before adjusting them.

## Validation

Use Node 24 or newer for the server suite's built-in SQLite adapter:

```text
node --test frontend/tests/download-registration.test.cjs frontend/tests/download-email-provider.test.cjs frontend/tests/download-verification-server.test.cjs
wrangler pages functions build --outdir build_work/download-verification-worker
```

The tests use synthetic inputs and mocked outbound services. They cover locked
frontend states, exact release matching, malformed requests, origin checks,
Turnstile failures, disposable addresses, delivery errors, atomic quotas,
expiration, concurrent redemption, and transactional rollback. They do not send
mail or claim to validate live DNS, sender verification, or delivery.

Service references:

- [Resend email API](https://resend.com/docs/api-reference/emails/send-email)
- [Turnstile server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Pages Wrangler configuration](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)
- [Disposable-domain source and license](https://github.com/disposable-email-domains/disposable-email-domains)
