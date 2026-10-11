# Vault rebuild: preservation and recovery boundaries

This checkpoint refreshes Vault presentation while retaining its existing endpoints, ownership rules, passphrase derivation, encryption salts and nonce-plus-ciphertext file format. It does not migrate the user's encrypted files, rotate keys, restore archives or change a running installation.

## Implemented preservation fixes

- Existing secret and saved-login stores now fail closed if their bytes cannot be read, decrypted or parsed. A missing store is still a valid empty store. Damaged or unavailable data is no longer treated as an empty collection that a subsequent save can overwrite.
- File uploads, note saves, secret saves and existing saved-login operations write complete encrypted data to a temporary file, flush it, then replace the destination. A failed write or replacement reports HTTP 503 and preserves the previous file. No payload format changed.
- Upload names beginning with two underscores after normalization are reserved for internal Vault records. Public file operations reject internal identifiers and path components. Note read/delete identifiers reject path separators, parent components and Windows alternate-data-stream syntax. Resolved paths and linked file targets cannot redirect these operations outside the Vault.
- Persisted unlock-session replacements are atomic. Lock removes the owner's in-memory key immediately; failure to remove the saved session returns HTTP 503 instead of reporting success. The error explains that restarting TLI may restore the still-saved access until it expires, and that locking can be retried explicitly.
- Ordinary file and note names retain their existing normalization and overwrite semantics. The interface reviews matching destinations; the backend does not introduce a new versioning or rename format.

No saved-login or browser-autofill interface was added. Its existing backend operations receive the preservation fixes because they use the same encrypted storage pattern.

## Existing access behavior

Unlock lasts a fixed 30 minutes from a successful passphrase check. Reading a collection does not extend that expiry. Access is keyed to the authenticated owner, rather than an individual browser tab. The same owner's clients share this state, and an unexpired saved session may survive a host restart. Closing the page does not lock Vault.

The tenth wrong passphrase starts a ten-minute lockout shared by the Vault. Passphrase whitespace is literal. The UI must not silently trim it. Status and unlock timestamps use the existing naive-UTC strings; this checkpoint does not change the response contract.

Damaged password metadata, or missing metadata alongside existing encrypted files, remains unavailable. It must never appear to be a new Vault awaiting setup.

The browser clears decrypted lists, revealed values, editor contents, passphrase fields and pending download URLs when access is lost. Generation checks prevent late replies from rebuilding them. An independent timer observes the deadline returned by a successful unlock. While the view has confirmed access, a bounded status-only check runs every 30 seconds and on focus; it does not load decrypted contents or extend the server session. A status check that fails or exceeds 15 seconds clears the private view and requires an explicit recheck. Keep unsaved notes saved before the access window ends. Server lock failure is shown separately from clearing this browser's private view.

## Encrypted export is a partial copy

The existing `/vault/export_backup` endpoint exports unchanged encrypted `.vault` bytes. It includes ordinary Vault files, shared Vault notes and the current owner's secret store.

It **does not include saved logins, `vault_meta.json`, the encryption salt, machine keys, saved sessions or the rest of TLI's data**. The passphrase alone cannot derive the original content key without the original encryption salt. Keep the matching original installation and metadata. This ZIP is an encrypted-file copy, not a standalone recoverable backup; no restore or import button is introduced.

Reset remains a separate destructive action requiring the correct current passphrase and `RESET VAULT`. It deletes Vault data; it does not recover a forgotten passphrase. If a file cannot be removed, existing reset behavior reports partial deletion and preserves password metadata.

Vault file names and note titles remain visible in stored filenames. Secret names and values are inside their encrypted store. Do not imply that every part of every record is hidden on disk. Secret values are hidden in the list until deliberately revealed; existing explicit chat-secret inclusion means no universal promise can be made that a value will never appear in a generated reply or conversation history.

## Verification

The pre-edit source snapshot contains 462 allowlisted source files:

- Snapshot: `build_work/vault-rebuild/release-snapshot-7gxfd2vz/source`
- Manifest: `build_work/vault-rebuild/release-snapshot-7gxfd2vz/manifest.json`
- Source fingerprint: `8f081ab67767fd146085627537b90ab7bef80e5bdf1b82be8e7d3c8fff827834`

The existing relevant suites passed before changes: 136 tests, no baseline failures. Their logs are `baseline-vault-backend.log` and `baseline-vault-adjacent.log` in `build_work/vault-rebuild`.

After changes, the combined seven relevant suites passed: **182 tests**, including **46 new preservation tests**. The final log is `build_work/vault-rebuild/vault-backend-final.log`; existing datetime/FastAPI deprecation warnings remain. The 137-test intermediate run is recorded in `vault-preservation-tests.log`.

The complete backend suite also passed: **1,195 tests**, 2,070 existing deprecation warnings, in 67.77 seconds. See `build_work/vault-rebuild/full-backend-final.log`. There were no failing tests or additional baseline failures.

`backend/tests/test_vault_preservation.py` adds coverage for malformed ciphertext and JSON, unreadable stores, disk/replace failures, byte-for-byte preservation, reserved upload names, unsafe identifiers, unchanged legacy ciphertext readers, owner-scoped durable locking, authentication, fixed expiry, lockout timing and the exact partial export scope. Tests derive the unchanged legacy AES key independently when checking newly saved bytes.

All tests establish temporary persistence before application imports. HTTP, discovery, updates, inference and real device/file side effects are blocked by the existing isolated test configuration. No live Vault data, live model, or running TLI process was used. Browser fixture acceptance is recorded separately in [TLI_VAULT_BROWSER_ACCEPTANCE.md](TLI_VAULT_BROWSER_ACCEPTANCE.md).

## Remaining boundaries

This checkpoint does not claim complete-installation recovery, archive import, key rotation, per-browser Vault sessions, transactional concurrency across multiple backend processes, or a browser-autofill security audit. Existing extension-domain matching, concurrent whole-store edit conflicts and whole-Vault reset interruption semantics require their own bounded changes and acceptance work.
