# Reviewed recovery into a separate copy

This checkpoint completes recovery of Notes & fixes, saved AI conversations and
diagnostic history from the existing password-protected `.tlibackup` archive.
It creates a new, separate data copy. It does not replace the active installation,
merge records, change model selection or recover Vault content.

## User workflow

Open **Settings → Saved data & backups → Recover into a separate copy**.
Choose the archive, enter its password and specify a new folder on the TLI host
under an existing parent folder. The destination must not already exist, even if
empty. The browser or phone's filesystem is not the destination.

**Review** checks the archive and destination, then shows the archive account,
source host, export time, record counts, checksum, destination and owner mapping.
It does not create the recovery folder. **Create reviewed copy** is a distinct,
explicit action after review. Changing the file, password or destination requires
a fresh review. A review expires after ten minutes and can be used only once.

Recovered account data maps to the new copy's `local` owner, which is the owner
used by TLI's normal PIN access. The original account and conversation ownership
associations remain in recovery metadata. This mapping creates no PIN or account
credentials. Without PIN protection, local access to that copy would share one
owner, just as in a fresh installation.

The result contains a normal `data/` directory and a recovery receipt. It does not
contain the TLI program. Opening a separate installation against that data and
setting up its access remain deliberate, separate work. The current TLI session
continues to use its original data.

## Preservation and verification

The v1 archive format, existing encrypted store formats, record IDs, revisions,
timestamps, deleted notes and saved provenance are retained. Fresh destination
keys use TLI's existing OS key protection. Source encryption keys, PIN, identity,
TLS, Companion credentials, Vault, models and configuration are excluded.
On Windows, the new keys are bound to the OS account creating the copy; retaining
the original portable archive and its password remains necessary for portability.

Recovery rejects overlap with the active installation, existing targets, missing
parents and linked/reparse-point paths. Windows mapped network drives, unconfirmed
drive types and invalid names are rejected during review. Paths are limited to
1,024 characters. Recovery reserves the operation, pins staging directories,
writes encrypted stores with exclusive file creation and publishes the new
destination only after current readers validate it.
No automatic retries are made. Closing or backgrounding the page clears private
review information, but cannot promise cancellation of server work already sent.
If the connection is lost during creation, check the chosen destination before
reviewing another attempt.

The receipt is readable JSON containing source/account labels, counts, destination,
checksum and verification results. Saved note/message/report contents and the
detailed original conversation ownership mapping stay encrypted. File contents
are flushed before publication; atomic publication does not establish behavior
through a power failure. Power-loss durability has not been tested. A failed
cleanup can leave an unpublished encrypted staging folder, which is never treated
as a completed copy.

Readback runs in a fresh bounded Python process, with the destination established
before TLI imports and no server, inference, discovery or device operations. It
checks Notes & fixes, conversations and diagnostics through current readers.
Success means those saved stores reopened and matched the expected contents. It
does not mean excluded attachments exist, a past diagnostic is current, or the
copy is a running installation.

Python/source installations support this check. Frozen standalone executables
must fail closed rather than accidentally launch TLI as a Python subprocess;
their recovery helper support and native installation acceptance are separate.

## Existing controls remain distinct

- **Check saved data** checks readability of the current account's existing stores.
- **Create backup** downloads an encrypted portable archive of the named areas.
- **Verify backup** checks an uploaded archive in a temporary copy.
- **Recover into a separate copy** writes reviewed data to a new destination and
  checks it with current readers. It does not activate or merge that copy.

The existing `/create` and `/verify` contracts are unchanged. New authenticated
POST paths under `/api/intelligence/backups/recovery/` are `/review` and `/create`.
Password submission requires HTTPS or a loopback connection. Cross-site browser
submissions, malformed fields, excess uploads and duplicate requests are rejected.
There is no `/restore` endpoint.

## Verification record

The complete suites pass against the frozen source: **1,571 backend tests,
609 frontend tests and 56 developer-tool tests**. The 112 recovery backend tests
include current-reader roundtrips and preservation failures. There are no new
suite failures; the existing 2,235 backend warnings remain recorded in the log.

The final snapshot contains **498 files**, fingerprint
`718232d68ba9bf1e037f326a4563800fb6af0f5069c00cfc4fa1d14bb25c9892`.
It is stored at `build_work/separate-recovery/release-snapshot-1njxt03y/source`,
with its manifest alongside. Verification confirms it matches the working tree.
The snapshot includes all intended source changes without resetting, stashing or
requiring a commit. Runtime data, model files and credentials are excluded.

Final suite logs are `build_work/separate-recovery/final-backend.log`,
`final-frontend.log` and `final-tooling.log`. The test harness establishes temporary
persistence before imports and uses fake providers and synthetic data. Tooling
also verifies isolated loopback HTTPS/PIN startup and restart; it does not touch
the live host.

| Boundary | Evidence |
|---|---|
| Review and ownership | Archive hashes, expiry, owner/destination/parent binding, one-use tokens, Unicode owner labels and legacy conversation ownership |
| Store preservation | Original bytes and timestamps, unchanged note metadata and IDs, retained deleted records, encrypted new stores and new protected keys |
| Rejection and failure | Missing probes, low space, corrupt/foreign/malformed records, key/write/readback failures, changed archives and existing destinations |
| Filesystem races | Actual Windows stage replacement, child replacement and pre-pin link injection produce zero unreviewed writes; duplicate creates cannot publish twice |
| Current readers | Real fresh Python subprocess, Windows DPAPI key readback, exact stored digests, note normalization, conversations, report access and origin metadata |
| Worker isolation | No server or inference startup; child write/network/process/thread attempts rejected; bounded reads, timeouts and frozen-runtime preflight |
| HTTP boundaries | Session/transport/origin checks, bounded multipart parsing, rejected navigation methods, duplicate requests and a cancelled request retaining its worker lease |
| Browser behavior | Review before creation, exact readback receipt validation, deliberate retry, retained prior receipts, expired/changed reviews and private-state clearing on lock/close/background |

An independent audit found and reproduced a staging-directory replacement defect
during development. The implementation was corrected before the final snapshot;
all three independent Windows replacement scenarios now produce zero outside
files, no published copy and unchanged source bytes. The regression is retained.

The final real-SPA fixture run passed **43 browser checks across 22 selectable
themes**, with no contrast, layout, JavaScript or source-change failures. Detailed
checks cover Emerald Light and Midnight at 1,440, 390 and 320 pixels, doubled text,
reduced motion, keyboard acknowledgement, duplicate requests, stale responses and
Settings category/lock/background transitions. These browser checks use intercepted
synthetic responses; the real archive/reader workflow is covered by backend tests.

There are **20 current and 2 frozen-baseline screenshots** in the
[before/after gallery](../build_work/separate-recovery/review.html).
The detailed report is
`build_work/separate-recovery/browser-2026-09-08T01-44-09-898Z/report.json`.
The final browser run used the same frozen source fingerprint recorded above.

The pre-change source snapshot has 491 files and fingerprint
`8205aedb5ec691c74079793816c6d59203b5c29969fd740463d596d87dd07b06`.
Fresh isolated baseline: **1,459 backend and 582 frontend tests passed**.

The frozen baseline's developer-tool suite reported **52 passed, 4 failed** because
the source snapshot omitted the synthetic answer-quality fixture. The snapshot
allowlist now includes that exact fixture and still excludes arbitrary files in
its directory. This pre-existing verification defect is separate from recovery
application behavior; the baseline logs are retained unchanged.

Publication uses the platform's no-replacement behavior. Implementation references
are the [Windows directory and sharing contract](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew),
[Linux `RENAME_NOREPLACE`](https://man7.org/linux/man-pages/man2/rename.2.html) and
[Apple exclusive renaming support](https://developer.apple.com/documentation/foundation/urlresourcevalues/volumesupportsexclusiverenaming).
POSIX paths were reviewed in code; native Linux/macOS execution was not tested.

Physical phones, real-data recovery, live installation activation, whole-installation
recovery, Vault recovery and native Windows/macOS/Linux installation acceptance
are outside the automated evidence for this checkpoint.
