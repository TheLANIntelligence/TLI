# Finish the fix: next checks and secure LAN handoffs

This anniversary checkpoint connects saved troubleshooting evidence to a useful
next observation and restores reviewed file sharing between trusted TLI
computers. It builds on the existing cases, diagnostics, LAN Messages and
Companion screens. Modern, Classic, all themes, saved records and the current
installation remain in place.

**Implemented; software and the signed Android artifact are verified.** The
785-file candidate passed all 27 software stages. Broader model-answer quality
remains **not validated**, and physical two-computer/phone acceptance remains
**not run**. These are separate results, not a blanket release approval.

## A next check grounded in the selected evidence

The case review offers a bounded read-only view of **Known**, **Missing** and
**Already tried**, then one available observation with a reason. It derives that
choice from implemented diagnostic capabilities and the explicitly selected
case steps/report facts. It does not treat a saved report as a current reading
or use unselected linked note/report bodies as hidden context.

Reviewing the suggestion performs no diagnostic, model request, case save or
peer probe. **Review suggested check** uses the existing target/scope review.
**Run** is separate. The backend checks the reviewed case/report revisions,
selected computer, suggested option, execution host and current scope before
the existing diagnostic runner can act. Unsupported or missing targets remain
unavailable; a failed peer check never falls back to the local host.

Tried steps preserve their recorded outcomes. Skipped and planned steps are not
described as completed. Narrow questions about the selected case's recorded
steps and measurements can be answered directly from those records. Causal
explanations remain interpretation. A suggestion is not a diagnosis or proof
that a change will help.

After a check, the existing report review, comparison and case-link workflow
continues. Report saving and case linking remain separate, with explicit retry
and preserved drafts if linking fails. Recording a resolution remains the
user's conclusion, separate from a measured improvement or confirmed fix.

## Secure file handoff

File sharing uses the existing bilateral computer identity/certificate reviews
and the messages permission, plus **explicit receiver approval for each file**.
The sender prepares a browser-selected file on its own TLI host. Only immutable
offer metadata reaches the other computer before acceptance.

The receiver reviews the sender, name, size, content hash and destination:
**TLI Inbox, encrypted on the receiving host**. The sender cannot choose an
arbitrary destination path or overwrite an existing household file. After the
complete content hash validates, the receiver can explicitly download the file
through the browser. Receiving, downloading and opening are distinct actions.

The initial protocol is intentionally bounded: one file up to 250 MiB, 64 KiB
chunks, four active transfers per owner, thirty-minute offers/consent, 32 pending
incoming transfers per host, and 256 retained records. Admission reserves at most
1 GiB of raw content; encrypted storage is capped at 2 GiB. Encryption overhead
can stop admission below the raw limit. Retained completed or stopped content
counts until explicitly discarded. Staged, acknowledged and verified bytes have
different meanings. An uncertain response pauses the transfer for explicit
status reconciliation; reconnecting never silently repeats the operation.

Every request remains bound to the authenticated account and reviewed peer
identity. Original-session changes, revocation, expiration and target changes
stop subsequent work. Encrypted staging and durable receipts preserve prior
results across failures. Existing historical transfer records/downloads stay
readable; the older insecure upload path does not become executable again.

This is host-to-host LAN sharing. It does not add unrestricted file browsing,
remote execution, automatic opening or away-from-home connectivity. Existing
AI-offload interfaces are a separate contract from the new file-transfer flow.
In particular, the retained `/tli/ai/chat` compatibility service is not part of
the reviewed peer file/message/observation protocol. This checkpoint makes no
claim that every legacy LAN interface has gained the same trust boundary.

The transfer Inbox and staging copies are not included in Notes & fixes/history
backup v1 or saved-work backup v2. Those scopes remain unchanged. Download a
verified received file explicitly when you need a separate copy. A stopped or
expired offer does not imply that already received content was recalled or that
retained bytes were deleted. The transfer controls describe local discard
separately from peer delivery.

## Companion and physical acceptance

Companion uses the same case selection, guidance, scope review and run contract.
Unsaved drafts and conflicts remain visible, and lock/background changes
invalidate delayed results. The verified Android candidate is **Beta7**:
`com.thelegatointelligence.companion.beta`, public version `0.1.0`, native build
`7`. Its package and signing certificate match the freshly reverified Beta6;
pairing-storage keys remain unchanged. Its 76 upload inputs are frozen, with
183 mobile tests, TypeScript, Android/iOS exports and 14 native build tests
passing. Native file transfer is not added to Companion in this checkpoint.

Actual update, retained pairing, interruptions and phone-to-desktop continuation
must be recorded on the physical device. Two-computer trust and file delivery
also require real hosts. The [acceptance record](TLI_FINISH_THE_FIX_ACCEPTANCE.md)
keeps these gates separate from software tests. No test requires replacing a
household pairing or restarting production TLI automatically.

## Interface contracts and preservation

The additive `tli-case-next-check-v1` response comes from authenticated
`POST /api/intelligence/cases/next-check`. Existing diagnostic execution accepts
an optional `next_check_ref` binding the selected case/report revisions and
option. Existing callers, Chat endpoints, SSE names and saved records retain
their original behavior. A capability flag depends on registered routes; it is
not proof that a model or peer is available.

The additive `tli-peer-file-v1` protocol uses:

- Local `GET /mesh/files/capabilities`, `GET /mesh/files`,
  `POST /mesh/files/outgoing` and `GET /mesh/files/{id}`.
- Local `POST /mesh/files/{id}/{operation}` for explicit stage, offer, review,
  accept, status reconciliation, send-next, complete, resume, cancel, decline
  and discard. A verified incoming file has a separate authenticated download.
- Signed peer `GET /agent/peer/files/capability` and
  `POST /agent/peer/files/{offer,status,chunk,complete,cancel}`.

The existing chat key protects the encrypted transfer index, manifests and
chunks under `data/mesh/secure_transfers`. Missing-key protection includes these
records and their marker; it never silently starts a replacement empty store.
Windows operations hold directory handles that prevent parent replacement;
POSIX operations use held directory descriptors. These are tested filesystem
safeguards, not a claim about native installation on every platform.

Consent and uncertain-operation identity survive ordinary list refreshes and
editable selections. Response validation binds the exact transfer, direction,
peer, name, size and checksum. Chunk acknowledgements must advance by the exact
expected amount; only complete verified receipts display delivery. A malformed
or stale response preserves the previous record and stops further chunks.

## Baseline and prospective quality evidence

The fresh 765-file baseline is
`57d2b9ab77db3349d91d404c131f97df9e2f95e5301007b51897e29c0ff4d9ca`.
It passed 2,633 backend, 1,048 frontend and 169 tooling tests. The baseline
backend run retained 5,096 deprecation warnings; no test failures were found.

Eight prior development questions are retained unchanged. Twelve additional
confirmation questions and their scoring policy were frozen before answers:
question SHA-256
`d7dd9d9593fc3d51467a46c5b5981e70022a2b3235317a3947e890f590c586c4`;
policy SHA-256
`0a3dfb6a17ea2d8a242823eb50da76757270ffc18bb673fb9971f421fb9b24df`.
Actual JSON/SSE preparation is captured separately from isolated Standard
inference. The [completed assessment](TLI_FINISH_THE_FIX_MODEL_CHECK.md) separates
deterministic responses and model answers. Full four-dimension passes rise from
5/20 to 8/20: final factual responses pass 5/5, model responses 3/15. The remaining
15 model requests are identical before/after and 14 answers are identical; this
is a routing improvement, not improved model interpretation. No model selection,
default or recommendation changes follow from this check.

Earlier strict model comparisons still have **no validated winner**. The new
decision workflow may improve a particular answer by using recorded facts
directly; that cannot be described as an improvement to the language model
itself. False historical action claims, wrong-host attribution and unsupported
causal conclusions remain visible in the final evidence. The ordinary
model-answer quality gate remains failed; the reviewed workflow is useful
without presenting model explanations as established facts.

## Delivery record

- Source: **785 files**, fingerprint
  `05f9aa8e95c94d17243b7c5c2b56dfa29c2afbb43f93484d5867353ae27ca071`.
  There are 53 changed/new paths and no removed paths against the captured
  working-tree baseline; existing unrelated uncommitted work is preserved.
- Complete checks: **2,741 source backend**, **2,729 extracted-package backend**,
  **178 tooling**, **1,093 frontend** and **183 Companion tests**, plus TypeScript,
  Android/iOS exports, clean runtime imports/dependencies, actual isolated HTTPS
  startup/restart, occupied-port refusal and synthetic upgrade/rollback/recovery.
- Desktop source ZIP: **398 files**, SHA-256
  `2adfba0ae0c9fde92d2853ce040665f4d13bb7ebfab20a8d2bf998c720786dc3`.
  It excludes runtime data, credentials, model weights and test environments.
  It is an internal source package, not a verified native installer.
- Android Beta7: SHA-256
  `949691b7c0985f9da21927e959c6016e3c41b75ee3d95f4d9c14b8356d582c25`;
  package/signing compatibility with Beta6 verified. Update without uninstalling.
  Installation and retained pairing still need physical acceptance.
- Synthetic browser evidence: next-check **8 checks / 188 layouts**, transfers
  **80 checks / 66 layouts**, compiled Companion web **144 checks / 8 layouts**.
  Modern/Classic and 23 browser themes are covered; these are browser fixtures.
- Real isolated HTTPS transfer rehearsal: **7 checks passed**, with both owned
  listeners stopped. Eight focused tests and a forced parent-exit check also
  verified harness restrictions and cleanup. This does not prove a household
  LAN transfer or native-platform installation.

The first final verification completed its stages but was superseded because
the isolated TLS test helper was strengthened after its snapshot. The second
attempt reached the source-backend 300-second bound while other isolated work
was running; no assertion failure had appeared. The unchanged final candidate
then passed all stages in a serialized run. Those attempts and their logs are
retained. Existing source/extracted backend deprecation warnings (5,270/5,269)
remain recorded rather than hidden.

The compatibility baseline is retained commit
`a5f2104f134a0d0fe482e4b65acadd515699d2fb`, not a published anniversary release.
It lacks Companion/Notebook and saved-startup support. The rehearsal verifies
preservation/readability without editing newer note metadata through old code;
older launchers require equivalent explicit HTTPS/bind/port settings. This
does not establish unrestricted backward write compatibility.

Open the [before/after review gallery - local evidence](LOCAL_EVIDENCE.md),
[matched source/artifact manifest - local evidence](LOCAL_EVIDENCE.md),
[full release report - local evidence](LOCAL_EVIDENCE.md)
and [acceptance record](TLI_FINISH_THE_FIX_ACCEPTANCE.md). The actual-answer
[quality report](TLI_FINISH_THE_FIX_MODEL_CHECK.md) explains remaining failures.
Automated checks did not restart production, switch its model, pair a household
device or operate on household files.
