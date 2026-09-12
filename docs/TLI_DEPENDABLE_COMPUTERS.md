# Dependable across your computers

This checkpoint follows the read-only TLI product audit and the Free Space
rebuild. Its purpose is to make a selected computer, a recorded observation and
a requested action mean the same thing throughout the browser and Companion.

The modern interface, Classic interface, themes, live model and household data
are preserved. The implementation does not restart the running installation.

## Why this work was necessary

The audit found a real mismatch on FOX: the browser served the rebuilt Free
Space controller, but the running backend's OpenAPI document contained no
`/visualizer/jobs` routes. Refreshing the page could not load those missing
Python routes. The old build identifier covered one source file and could not
detect this mismatch. The live shell was PIN-locked; authenticated household
workflows were not exercised or represented as tested.

Source review also found address-based legacy peer coordination, direct browser
HTTP requests in LAN Messages, a direct temporary-file cleanup endpoint and a
routine endpoint that accepted execution without its reviewed revision/targets.
Troubleshooting shared a case's evidence pointers but could not explicitly
supply the recorded facts of one linked report. Companion still used a generic
report display despite richer facts already available on the backend.

## Running application identity

`/api/diagnostics/version` preserves its previous fields and adds versioned
release information. The process captures application identity before importing
routers and compares it with application files currently on disk. A frozen
executable binds its executable bytes and deployed browser assets; a source
installation binds its application files. The effective browser asset root is
included even when configured separately. Unreadable, linked or over-limit
application inputs produce **unknown**, not a match.

The browser explains **matched**, **manual restart required** and **unknown**.
Settings → App & troubleshooting → Software Updates → **Running host &
application files** exposes the full application identity and check time.
The compatibility check is read-only. Free Space checks capability support
before starting a new job, while existing job status and Stop remain available.
The notice never restarts TLI or repeats an action.

These identifiers describe code and browser assets, not a signature, model,
dependency lock or saved-data fingerprint. They are distinct from the full
frozen-source fingerprint in the delivery manifest. A matching protocol cannot
prove that every asset already cached by a browser is the current file.

After replacing application files, finish active work, stop and start TLI
normally, then refresh the browser. No automated check in this batch performs
that production restart. The PIN screen also uses a readable bounded-width
form; locked access no longer produces the legacy mesh join-status error toast.

## Explicit computer trust

Computers uses bilateral reviewed public cards. Each card binds the existing
stable node ID, Ed25519 identity, exact private-LAN IPv4 HTTPS origin, certificate
and supported capability contract. Compare the identity and certificate
fingerprints on the other computer before approval. Both computers must review
the other's card. No owner PIN, private identity key or phone credential is
copied between computers.

Discovery, a familiar name and an old IP address do not grant trust. Existing
directory entries remain intact and require review before the new transport
can use them. Replacing a computer at an existing IP does not inherit the old
identity. Directory reads fail clearly on malformed or missing protected state;
ordinary node-settings saves retain missing-directory protection.

Reviewed permissions cover system observation, coordination and LAN text
messages. Signed requests bind method, path, body, recipient, clock and nonce.
The sender checks the reviewed certificate before sending HTTP headers;
redirects, HTTP downgrade, changed trust and replayed requests are refused.
Responses and request duration are bounded. Approval/revocation is a local
authenticated operation; a peer cannot approve itself.

The first useful remote observation is deliberately narrow: CPU, RAM and uptime
reported by the selected TLI computer. Unavailable metrics stay unknown. This
is not remote process inspection, GPU measurement, storage scanning, network
diagnosis, execution or repair. Generic old agent-task and temporary-cleanup
paths cannot perform those actions. Cleanup goes to reviewed Free Space.

To set this up after both hosts have been updated and started normally:

1. Open **Computers → Review computer trust** on each unlocked host.
2. Enter that computer's HTTPS LAN IPv4 address and choose **Show this
   computer's card**. This public card contains no PIN or private key.
3. Paste the other computer's card, choose the required permissions and select
   **Review selected permissions**.
4. Compare the identity and certificate fingerprints with the other computer's
   screen, then approve the reviewed details. Repeat on the other host.
5. Use **Reviewed computer access** to inspect or revoke that relationship.

Opening the page does not approve anything. A changed address or certificate
requires another review; a discovery beacon cannot replace an approved endpoint.
Unreviewed entries say that no connection check was sent, rather than claiming
that the computer is offline. Phone Companion uses its separate pairing flow.

### LAN Messages

Text goes through the authenticated host-to-host HTTPS connection. A delivery
acknowledgement means the receiver recorded the message; it is not a read
receipt. Stable message IDs and durable receipts prevent a deliberate retry
from silently duplicating a received message. Uncertain writes remain uncertain.
An HTTP success code alone is insufficient: the acknowledgement must match
the message, thread, sender and recipient. Incoming thread identity is derived
from the reviewed sender/recipient pair, so another peer cannot inject text into
a different computer's conversation. The encrypted append is synchronized
before a completed receipt is recorded. Missing or malformed acknowledgements
remain uncertain and cannot become a claimed delivery.
Lock/background changes invalidate delayed browser results and do not replay
the message.

New LAN file transfers are unavailable in this checkpoint: the old direct
transfer transport is not part of the reviewed peer contract. The interface
explains that before file selection. Historical local downloads remain
authenticated and available. A bounded authenticated transfer protocol remains
separate work; this limitation is not called a completed transfer upgrade.

## Reviewed actions stay reviewed

Legacy routine calls without a request ID, saved revision and reviewed target
fingerprint return `review_required` without running a step. A partially supplied
review is rejected. Normal reviewed calls retain their existing URLs and body
fields. Durable start receipts protect uncertain interruption; a completed
duplicate returns the saved outcome instead of repeating I/O.

The original session or Companion credential and the routine/targets are checked
again before each step. A lock, revocation or changed target stops subsequent
steps. Already attempted steps retain their actual result; the response does
not pretend to undo them. Driver success remains separate from a physical
confirmation. These controls do not add automatic routine execution.

## Troubleshooting and useful evidence

The case-to-Chat review can explicitly include the recorded-facts projection of
**one linked diagnostic report**. Its pointer must also be selected and remain
linked to the reviewed case. Before preparation, the browser or Companion shows
the report facts to be shared. Before sending, the backend rechecks owner, case
revision, report revision and target agreement. A changed/missing/foreign
report cannot be substituted silently.

Absent the new optional `report_refs` field, the existing pointer-only behavior
remains. Report facts exclude findings, attached bodies and raw samples; source
receipts identify the supplied case and report. Selected notes and other
sharing restrictions remain stricter where already required. Explicit report
summaries can use backend facts without inference. Model explanations remain
interpretations, and an old report cannot establish current health.

Guided checks opt in to peer observations. They show the executing peer, exact
target, permission and scope before Run. No peer failure falls back to the
requesting host. Saving the report and linking it to a problem remain separate.
If linking fails, the saved report and draft survive and the check is not rerun.
A saved peer report requires a new target/trust review before repeating its
observation. Compatible comparisons retain peer identity and time caveats.

## Companion continuity

The native app presents recorded facts, units, process identity, sample coverage,
partial/stopped results, historical source changes and reviewed case/report
facts using the same contracts. It exposes the installed native application
version/build and the paired host's release identity; it does not infer a native
build number from JavaScript configuration. Interrupted work and explicit retry
remain separate from reconnecting.

The Android Beta candidate preserves package identity, signing lineage, pairing
keys and public version. Its mobile source, EAS upload, build identifier, APK
hash and signing comparison are recorded separately from host verification.
Physical Android update, retained pairing, backgrounding, Wi-Fi interruption and
phone-to-desktop continuation require device evidence. Signed iPhone
distribution and away-from-home access remain separate gates.

## Verification and delivery

Before implementation, 738 allowed source files were frozen at
`dc39eb37926617ae0837528e035f02aee28e9c2cea753778406902daeec6951c`.
The fresh isolated baseline passed **2,508 backend**, **1,026 frontend** and
**168 tooling** tests. No baseline failures were found.

The delivery manifest and acceptance record bind the final source and artifacts.
They separate automated software checks, model answers and physical acceptance.
Synthetic tests cover reviewed actions, original-session revocation, duplicate
requests, malformed/missing trust stores, changed identities, real loopback TLS,
late responses, case/report conflicts, preserved data and source/package imports.
Browser review covers Modern/Classic, themes and narrow layouts. All household
operations and physical-phone gates not actually exercised remain **not run**.

The final **765-file** snapshot is
`57d2b9ab77db3349d91d404c131f97df9e2f95e5301007b51897e29c0ff4d9ca`.
All **27 software verification stages passed**:

| Check | Final result |
|---|---|
| Complete source backend suite | 2,633 passed |
| Extracted installation backend suite | 2,621 passed; 11 packaging tests and one Git reader test run separately in source |
| Release-tooling suite | 169 passed |
| Browser-controller suite | 1,048 passed |
| Companion suite | 170 passed |
| Fresh runtime dependencies and imports before test dependencies | Passed; resolved versions recorded |
| TypeScript and Android/iOS Hermes exports | Passed |
| Real loopback HTTPS/PIN/bearer, stop/restart and occupied-port protection | Passed |
| Synthetic upgrade/rollback and backup reopening | Passed |
| Final source unchanged and package asset checks | Passed |

Deprecation warnings remain recorded in the logs: 5,098 in the source backend
run and 5,097 in the extracted run. They are not baseline test failures.
Rollback uses `a5f2104f134a0d0fe482e4b65acadd515699d2fb` as a compatibility
reference, not a previously published anniversary release. That older code
lacks Companion/Notebook workflows; old memory writes can discard newer note
metadata, so the rehearsal preserves and reads those records without editing
them through the older interface. Its launcher also needs explicit equivalent
HTTPS, binding and port settings.

The [delivery manifest - local evidence](LOCAL_EVIDENCE.md),
[acceptance record](TLI_DEPENDABLE_COMPUTERS_ACCEPTANCE.md) and
[before/after gallery - local evidence](LOCAL_EVIDENCE.md) retain the
exact proofs. Two superseded candidate records remain visible: one exposed
message acknowledgement/thread defects and test-fixture compatibility issues;
the other passed all backend tests but omitted two required synthetic mobile
test fixtures from the snapshot. The final candidate corrects both omissions
without widening the private-source exclusions.

The [Beta6 APK - local evidence](LOCAL_EVIDENCE.md)
is public version **0.1.0**, native build **6**, and its package and signer match
Beta5. All 75 uploaded mobile inputs match the final host snapshot. Its SHA-256
is `8a778a9e5d56c12130ef2f146784dc5dfdeb0bb98ef98c0a49ade01a9b776861`.
The desktop ZIP SHA-256 is
`a4cbd46f6fb590dfe3f99bd99e9c45414be5078605a89b546b37db7cf001cb90`.

The [eight-question Standard-model check](TLI_DEPENDABLE_COMPUTERS_MODEL_CHECK.md)
is a development smoke check of captured actual Chat inputs, not a sealed
holdout or comparison. Seven model answers completed without timeouts; the
separate deterministic summary stayed fact-bound. Agent review still found
misinterpretation of 26% historical CPU, lost uptime/outcome facts and suggestions
to repeat an unattempted driver update. Only one of seven model answers met all
four dimensions in the primary review. Complete answers and both assessments
remain visible. Earlier strict model-quality gates still have **no validated
winner**; no model/default change is inferred from better report presentation
or passing unit tests.

Remaining priorities are physical two-computer/phone acceptance, authenticated
file transfer, evidence-grounded model quality and the separate remote
connectivity checkpoint. None is silently completed by this document.
