# Security policy

## Report a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/TheLANIntelligence/TLI/security/advisories/new)
for suspected security issues in TLI. Private reporting is enabled for this
repository. Avoid posting exploit details or sensitive information in a public
issue or pull request.

Include the affected version or commit, platform, configuration needed to
reproduce the issue, expected security boundary and observed result. A minimal
reproduction using synthetic data is helpful. Do not include real credentials,
Vault passphrases, private keys, personal conversations or another person's data.

Use [GitHub Issues](https://github.com/TheLANIntelligence/TLI/issues) for ordinary
bugs that do not expose a security vulnerability.

## Release and deployment context

TLI is beta software. Development source, downloadable packages and native
Companion builds may be at different revisions. Check the affected artifact's
version and the [published release notes](https://github.com/TheLANIntelligence/TLI/releases)
when reporting or applying a fix. A source change does not automatically update
a running host or an installed phone app.

TLI's default host binding is local-only. Review **Settings → Security &
connections** before enabling LAN access. Reviewed peer identities, HTTPS
certificate pins and explicit permissions govern LAN inference and other peer
operations; discovery alone does not authorize access.

Your selected AI provider and integrations determine where requests go. A
trusted LAN inference worker receives the prepared text for its selected
request. Local hosting does not imply that every optional integration is
offline or that every saved file is encrypted. Treat the installation's runtime
state and backups as private, and keep credentials and personal data out of
repository commits and public bug reports.

Automated checks cover the cases recorded with each change. They do not establish
a general security guarantee or replace deployment-specific validation.

## Known dependency advisories

On **2026-10-11**, `npm audit --package-lock-only` in `mobile/` reported **29
affected dependency entries: 19 high, 10 moderate, and zero critical**. Counts
include parent packages that inherit a transitive finding; four underlying
advisories remain. Re-run the audit when assessing a later checkout because
advisories and available fixes change.

Compatible updates in the lockfile resolved the critical
[shell-quote advisory](https://github.com/advisories/GHSA-pqg4-j6r4-53mv) by selecting
1.12.0, and updated brace-expansion to 5.0.12, compression to 1.8.2, and
source-map-js to 1.2.2. Direct application dependency versions were unchanged.

| Remaining dependency | Advisory | Fix status at the audit date |
| --- | --- | --- |
| `braces` 3.0.3 | [High: deeply nested pattern denial of service](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | No patched release listed; retained through micromatch and Metro. |
| `node-forge` 1.4.0 | [High: RSA signature verification](https://github.com/advisories/GHSA-86w9-cpqp-85rv) | No patched release listed; retained through Expo CLI and its certificate tooling. |
| `decode-uri-component` 0.2.2 | [Moderate: malformed input denial of service](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr) | Fixed in 0.5.0, outside query-string's current `^0.2.2` range; Expo Router depends on that query-string version. |
| `uuid` 7.0.3 | [Moderate: output buffer bounds](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | Fixed in 11.1.1 and later patched release lines, outside xcode's current `^7.0.3` range. |

Further remediation needs upstream fixes or a reviewed dependency migration.
The audit's suggested major changes include framework downgrades and should not
be applied automatically. These dependency findings and passing tests do not
determine whether an advisory is reachable in a particular native build, web
deployment, or development environment.
