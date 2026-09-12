# Saved data protection and Data & Recovery

The September 7 [everyday desktop checkpoint](ANNIVERSARY_EVERYDAY_TOOLS.md)
adds a scoped, password-protected Notebook & history archive and isolated
verification to the desktop screen. The read-only saved-data check described
below remains unchanged in scope. Whole-installation backup status remains
unknown; the new archive neither includes all installation data nor performs a
live restore. Companion was not changed for this addition.

This anniversary checkpoint preserves unreadable saved files and adds an explicit
read-only check in desktop Settings and native Companion Settings. It fixes a
destructive recovery path: an unreadable encryption key could be replaced, while
unreadable conversation history could appear empty and be overwritten on save.

These are source changes. Live TLI was not restarted, user data was not copied or
restored, and installed Companion builds were not replaced.

## Storage behavior

- Existing malformed, inaccessible or foreign-account encryption keys fail
  clearly and remain untouched. Reading encrypted data never creates a missing
  replacement key. Each use checks the persisted key instead of trusting a cached
  copy that could conceal a missing or changed file.
- New keys use exclusive file creation and must finish writing and syncing before
  they can encrypt new data. Windows protection failure does not silently fall
  back to an unprotected key. Competing creation cannot overwrite an existing key.
- Existing 32-byte legacy keys remain readable without rewriting their bytes.
  Existing encrypted formats, paths and owner associations remain unchanged.
  Explicit writes can still encrypt readable legacy plaintext memory/history.
- Notebook memory, conversations and private intelligence sidecars reject reads
  or writes when the existing store cannot be validated. A caller supplying a new
  empty dictionary does not authorize replacing unreadable saved data.
- Missing shared keys are checked against known dependent stores before a new
  owner's first write. The check is bounded to 512 matching files, 4,096 directory
  entries and 8 MiB total; unreadable or unchecked dependencies block creation.
- Encrypted LAN chat propagates unavailable-history errors and validates key use
  before opening a new thread file. Persisted Vault sessions retain unreadable
  entries and refuse replacement of a missing key when saved sessions exist.
  Normal passphrase unlock and expiry cleanup remain available.

## What the screen checks

Choose **Settings → Data & Recovery → Check saved data** on either client. The
check runs on the TLI host for the signed-in owner. Opening the screen does not
start it. Companion is a client of that storage, not an additional backup.

| State | Meaning |
|---|---|
| Readable | The saved area can be read now using its persisted key, or its supported legacy plaintext format |
| Not created | No saved file or entries for this owner were found in that area |
| Unavailable | The saved file, its shape or its matching key could not be read |
| Not checked | The file exceeds the bounded 16 MiB inspection limit |

The inspected areas are Household Notebook, conversation history and saved
diagnostic reports. The screen includes host identity, check time and scope.
Host lookup reads existing configuration without initializing or repairing it.
If that identity is unavailable, desktop labels the host unknown and Companion
rejects the result because it cannot confirm the paired host.
It never returns note text, conversation titles, diagnostic contents, encryption
keys or filesystem paths. Unknown or invalid responses cannot appear successful.
A failed refresh preserves the last result with an explicit stale label. Duplicate
clicks send one request; session changes and backgrounding invalidate late results.

The additive authenticated endpoint is `GET /api/intelligence/data-health`, with
`Cache-Control: no-store`. It returns `schema_version`, `checked_at`, `host`,
`scope`, `checks`, `backup` and `guidance`. Each check includes an `id`, `label`,
`status` and `detail`. Existing browser authentication and Companion bearer
validation apply. No mutation endpoint, SSE change or persistence migration was
introduced.

## Backup and recovery guidance

Backup status remains **unknown**: a readable file does not prove a separate
backup exists or can be restored. This original checkpoint provided guidance;
the later desktop archive/verification is separate from this check and from
the full-installation copying guidance below. No reset or live restore is added.

1. Record the installation location, original operating-system account and any
   separately configured data/model locations. Keep the Vault passphrase safe.
2. Stop TLI normally and wait for it to exit before copying files.
3. Copy the installation and complete data folder, including matching encryption
   keys, to a separate protected destination. Include separately configured data
   and legacy `vault_meta.json` from the folder TLI was launched in.
4. Preserve both originals and backup. Test a separate copy with matching TLI
   code and the original operating-system account. Never extract over a running
   installation or combine keys from different copies.
5. If data is unavailable, preserve it. Check storage access, original account
   and matching backups before attempting recovery. Deleting keys or resetting
   the Vault cannot recover the old encrypted data.

Windows DPAPI protection is tied to the original Windows account and machine
context. A same-named account or a copied folder on another machine does not
establish decryptability. This is not a portable recovery archive. Existing Vault
file exports also do not include all TLI history, Notebook, pairing or model data.

## Scope and remaining work

The screen does not inspect Vault contents/metadata, node identity, devices,
pairing, models or every installation file. It does not recover lost passphrases,
repair corruption, certify backup completeness or prove cross-platform restore.
The later [safe startup checkpoint](SAFE_STARTUP_COMPANION_RECOVERY.md) adds
Vault metadata, node identity and PIN preservation/preflight. They are still not
inspected by this three-area Data & Recovery screen and must not be inferred
healthy from these results. The previous
installation/rollback rehearsal remains separate evidence, not a new backup test.

The subsequent Companion startup and connection recovery checkpoint persists
reviewed secure-startup settings, retains working pairing until a replacement
succeeds, and prevents old connection responses from overwriting newer state.
Home Automation and diagnostic rechecks remain parked. Local voice still requires
a separate runtime and platform checkpoint.

## Verification — 2026-09-06

- Carried baseline: 478 backend, 105 desktop and 46 Companion tests passed; no
  baseline failures. Tests use temporary persistence, fake devices/providers,
  downloads and runtime processes before application imports.
- Final regression suites: **549 backend, 115 desktop and 56 Companion tests
  passed**. Backend reported 869 existing/deprecation warnings and no failures.
  Initial implementation failures were corrected before completion; an older
  intelligence fixture now isolates its conversation path as well as its data
  directory, so cached keys cannot hide cross-test persistence.
- Regression coverage includes missing/corrupt keys, Windows account mismatch,
  creation races, failed persistence, corrupted stores, shared-key dependencies,
  owner isolation, existing plaintext/encrypted compatibility and unavailable LAN
  history. It also retains authentication, streaming and existing Vault coverage.
- UI coverage includes explicit checks, all four states, literal untrusted text,
  invalid responses, duplicate requests, late responses and stale failed refreshes.
- Browser fixtures checked at 1440 × 900 and 390 × 844. Desktop Settings and the
  native Companion browser preview keep the recovery view within the phone width.
  Readable, unavailable and failed-refresh cases use disposable sample data.
- Strict mobile TypeScript checking and local iOS/Android Hermes exports passed.
  Export output: `mobile/.expo/verification-data-recovery-20260906` (ignored).
  This does not rebuild an APK, sign an iPhone app or prove physical-device behavior.

Disposable desktop preview: run `backend/tests/data_recovery_preview.py` with the
backend interpreter and `--case readable`, `unavailable` or `fail-refresh`.
Companion's browser-only sample supports `sample_data_health=unavailable` and
`sample_data_health=fail_after_first`; native transport never uses those controls.

The companion validation record links this checkpoint separately from the older
native build artifacts.
