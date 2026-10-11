# Portable Vault backup and separate-copy recovery

This checkpoint adds a complete backup of the **currently accessible Vault
scope**. It does not replace the existing Notes & fixes/history archive format,
and it does not activate a recovered installation.

## What is included

- Shared Vault files, with their existing normalized names and exact bytes.
- Shared Vault notes, with their existing identifiers and exact UTF-8 content.
- The authenticated account's secrets and saved browser logins, including
  supported extra login fields and original record identifiers.

Shared files and notes remain shared. Secrets and logins use the existing
account-to-filename rules. Those legacy rules can normalize different account
names to the same store; this checkpoint preserves the scope the current
application can access, rather than guessing historical ownership from a file
name. It cannot reconstruct an original upload filename or extension that the
old Vault already normalized away.

Other accounts' private stores, Notes & fixes, chat history, PIN configuration,
identity, TLS, Companion credentials, unlock sessions, machine keys and
extension API credentials are excluded. Unknown internal Vault stores are an
error rather than a silent omission.

## Four deliberate operations

1. **Check Vault** authenticates and reads every item in the stated source
   scope, with counts and an observation time. It creates no archive or keys.
2. **Create portable backup** requires that account's Vault to be unlocked and
   an independent archive password of at least 12 characters. It prepares and
   verifies encrypted ciphertext before offering a native browser download.
3. **Verify backup** checks a supplied archive and its password. It creates no
   recovery destination and does not change the active Vault.
4. **Recover to a separate folder** first reviews an authenticated archive and
   an exact new destination. A single-use review lasts ten minutes and is bound
   to the current account, archive hash, destination and parent identities.
   Creating the copy also requires a new destination Vault passphrase.

Password whitespace is literal. Neither archive password nor destination
passphrase is stored by the running application. Losing the archive password
prevents recovery; the old source passphrase is not needed to recover a valid
portable archive.

An archive being prepared or downloaded is not automatically replayed after a
disconnect. The browser must not call a prepared file “saved” merely because
the server produced it. Download ciphertext is owner-bound, expires after ten
minutes, and is removed after transfer, interruption or explicit discard.
**Find prepared download** can recover the result of a completed request after
the view was cleared, provided the same account's Vault is unlocked. It never
creates another archive. If removal is blocked by the operating system, the
encrypted temporary file remains recorded for a later cleanup attempt.

## Archive protocol

`tli-vault-backup-v1`, extension `.tlivaultbackup`:

```
"TLI-PORTABLE-VAULT\0\1" | salt:16 | nonce:12 | ciphertext | GCM-tag:16
```

- AES-256-GCM encrypts an uncompressed USTAR stream. The fixed complete header
  is additional authenticated data.
- Archive keys use scrypt with a fresh salt and the existing TLI archive cost
  (`n=131072`, `r=8`, `p=1`, 32-byte result). Inputs cannot request a different
  cost or downgrade the cipher. Source Vault encryption keys are not exported.
- The encrypted manifest contains protocol, creation time, source account,
  scope and ordered entries with kind, normalized name, plaintext size, SHA-256
  and record count. Payload names are fixed numeric identifiers, not paths
  supplied by archive authors.
- The entire ciphertext is authenticated before parsing. A bounded strict TAR
  reader accepts only this version's normal files, exact ordering, declared
  sizes and zero padding. It rejects GNU/PAX extensions, sparse entries, links,
  extra entries, duplicate/colliding names, traversal and malformed JSON.
- Every payload is checked against its manifest hash and current-reader form.
  Invalid UTF-8, coerced secret values, duplicate login identifiers and
  unreadable ciphertext fail the complete operation. No partial archive is
  reported as successful.

Limits are **250 MiB per entry, 4 GiB total plaintext, 10,000 entries** and an
8 MiB encrypted-manifest plaintext limit. The uploaded encrypted file can be
slightly larger for the fixed TAR, manifest and cipher overhead. File content
uses 1 MiB streaming buffers. Structured secret/login JSON is validated one
bounded entry at a time in memory; current application readback can likewise
hold one existing-reader file (up to 250 MiB) in memory. No plaintext spool or
temporary export is written.

Source snapshot preparation shares a transaction with Vault writes/deletes
and reset. Competing mutations receive a retryable busy response. Explicit
locking remains available and ends the export on its next access check. Source
file hashes, inventory and security metadata are checked for changes. TLI
session authority is revalidated during work and before returning results or
publishing a recovered copy.

## Recovered layout and verification

The new directory is an installation-root-style data copy containing:

- `vault_meta.json` in the root, matching the current cwd-relative reader.
- Normal encrypted `data/vault/*.vault` files.
- Current account stores mapped to `__secrets_local.vault` and
  `__logins_local.vault`.
- Encrypted `data/vault-backup-origin.enc` recording source owner, destination
  owner and archive/manifest hashes.
- A content-free `vault-recovery-receipt.json` after verification.

The new passphrase generates fresh normal password and content-encryption
salts. Each file is re-encrypted in the existing nonce/ciphertext/tag format.
No source key, unlock session or extension access key is carried forward.

The existing recovery path/lease machinery protects ordinary local parents,
staging directories and exclusive writes; publication cannot replace even an
empty existing destination. Existing staging files or keys are never adopted.
Before publication, a fresh bounded Python process establishes the destination
environment and working directory **before application imports**, authenticates
the new passphrase, and uses the current Vault file, note, secret and login
readers. Access is memory-only in that process. Network access, worker threads,
server imports and writes are blocked. Exact hashes, identifiers, extra fields,
owner mapping and unchanged files are required. Only counts and verification
flags leave the process.

The output remains locked, has no PIN or network identity, and is **not
activated**. Set up access protection before any separate activation or LAN
sharing. The existing `/vault/export_backup` endpoint remains an advanced
partial encrypted-file export; it is not this portable backup and still does
not include saved logins or all recovery metadata.

## Verification boundaries

Automated tests use disposable metadata, fake credentials and synthetic
content. They cover actual authenticated HTTP requests, current-reader
subprocess recovery, source byte preservation, malformed/authenticated hostile
archives, limits, cancellation, duplicate operations, expired authority,
unsafe/replaced destinations and injected staging files. No live Vault,
household files or running TLI process is used.

`scripts/verify_vault_backups_browser.cjs` exercises the real SPA using only
intercepted HTTPS requests and synthetic receipts. Its 15 behavior scenarios
cover explicit checks, prepared-download retrieval, duplicate requests,
verification, reviewed recovery, failed replacements, stopping the wait,
late results and both TLI-session and Vault-access expiry. The download click
is intercepted without downloading a file. No real archive or password is
loaded. The responsive matrix covers 1440, 768, 390 and 320 pixels in Emerald
Light, Midnight and Classic TLI, plus doubled text at 320 pixels. It records
source hashes, screenshots, keyboard access, labels, contrast and overflow.
Run the verifier with the project's existing Playwright runtime available;
reports are written beneath `build_work/anniversary-continuity/vault-browser/`.

Fourteen isolated controller tests in
`frontend/tests/vault-backups.test.cjs` cover the same operation boundaries,
including immediate clearing on HTTP 401/403 and rejecting a stale refusal
from an already invalidated request. Closing or locking the view never claims
to cancel server work. An explicit **Find prepared download** can recover an
owner's still-pending encrypted archive after leaving the view.

This checkpoint supports verified recovery from a ZIP/source Python runtime.
Frozen native executables fail closed before review or staging; their executable
is never launched with Python worker arguments. Native activation, physical
platform acceptance, abrupt power-loss recovery and a physical 4 GiB throughput
trial remain unverified. In-place restore, merging and restoration of other
accounts remain outside this workflow. Keep the original portable archive.
