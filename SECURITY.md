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
