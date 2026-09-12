# Safe startup and Companion connection recovery

This anniversary checkpoint makes normal startup retain reviewed connection
settings and preserves security state when files are unavailable. Companion can
review a replacement pairing while keeping the previous credentials until the
candidate is verified and durably saved.

These are source changes. No live TLI restart, real pairing, firewall operation,
model download, inference, data restore or native/cloud build was performed.

## Startup and security preservation

Read-only security preflight runs before identity initialization, relay/update
startup and other application workers, and again before listening/startup events.
It validates existing PIN configuration, mesh node configuration, cryptographic
identity and legacy Vault metadata. Malformed, unreadable, mismatched or incomplete
existing files stop startup with a safe recovery explanation. No replacement
identity, disabled authentication or new Vault is substituted.

Valid existing formats remain supported. New installations can initialize absent
state. Missing files with known dependent records are treated as incomplete
recovery: for example, a missing PIN with Companion pairing history, or missing
Vault metadata while encrypted blobs/sessions remain. Standalone missing node
files without relationship records can still initialize for compatibility with
older installations; absence alone cannot prove an identity was previously saved.

First security writes use exclusive creation and must finish syncing before they
can be used. Existing saves validate the prior file and replace it atomically.
Windows protection failure cannot silently generate an unprotected or replacement
identity. Public/private identity keys are checked as a matching pair.

PIN removal requires current authentication and a readable configuration. The
existing emergency-reset URL remains but no longer bypasses authentication.
Authorized removal writes `{"enabled": false}`, which older TLI also understands
as disabled. Forgot PIN provides preservation guidance and a read-only recheck.
Failed or malformed PIN status keeps the desktop lock visible and accessible.
Existing authenticated credentials remain valid during runtime PIN-file failure,
but cannot overwrite that file; subsequent startup stops until recovery.

Vault reset reports incomplete deletion and retains password metadata if any
payload deletion fails. Already-deleted payloads cannot be restored by that error;
the operation is never automatically repeated. A successful reset retains its
existing explicit authorization and setup behavior.

## Reviewed persistent startup settings

Desktop **Settings → TLI Companion → Startup & secure LAN access** shows the
running listener, saved/default choices, effective next startup, environment
overrides and current browser origin. Choose access and port, review, then save.
Saving does not restart TLI, generate a certificate, open a firewall or change the
current listener. After a normal restart, the launcher prints the actual URL and
opens the browser only when the server accepts connections.

Settings persist in additive `data/startup.json`:

```json
{"version":1,"host":"0.0.0.0","port":8443,"https":true}
```

Without a saved file or overrides, defaults stay loopback, port 8000, HTTP.
Saved LAN access requires HTTPS and an enabled owner PIN. Explicit `TLI_HOST`
overrides `TLI_LAN_MODE`; `TLI_PORT` and `TLI_ENABLE_TLS` override their saved
fields. Invalid saved settings/overrides stop startup. Overrides that would turn
a saved LAN setup into HTTP are refused. Existing unsaved deployments using
explicit legacy environment settings retain their configuration path.

`GET` and `PUT /api/companion/v1/startup` require an actual PIN-authenticated
browser owner session; Companion bearer credentials cannot change startup.
Responses are `no-store` and include `saved`, `configured`, `effective_next`,
`running`, `restart_required`, and `environment_overrides`. A failed save preserves
the previous file and visible draft. Unknown running bind is labelled explicitly.

Windows, macOS, Linux, packaged entrypoint and the development launcher share
the same resolution and TLS policy. Requested HTTPS never falls back to HTTP.
LAN announcements and local registration use the running port, so editing the
saved next port does not change advertisements for the current server. Legacy
TCP subnet discovery still probes port 8000; UDP announcements carry custom ports.

## Companion recovery

- Only the newest connection check for the current pairing and foreground state
  may publish success, failure or credential rejection. Older results cannot
  overwrite a newer connection.
- Host reachability, certificate trust, rejected credentials, incompatible API
  versions and AI readiness have separate explanations. A connected host with
  unavailable AI can still expose saved data, controls and explicit diagnostics.
- Bootstrap keeps its API version and chat transport contract and adds `ai`
  with `status`, `provider`, optional `model`, `detail` and `checked_at`.
  Bundled readiness requires runtime health. Mesh advertisements are observations,
  not a current reachability test. LM Studio readiness uses only a recent cached
  chat check; connection refresh does not generate inference.
- Settings offers **Review replacement pairing**. The current host remains
  visible while the user reviews the new host/certificate. In-flight mutations
  prevent replacement. During verification, ordinary requests pause because the
  existing native transport has one selected destination.
- Candidate redemption, matching bootstrap identity and owner access must succeed
  before protected storage commits. Failure/cancellation restores the previous
  transport and preserves its credentials. Storage and transport recovery failures
  are reported separately. No command or message is automatically replayed.
- A failed storage commit attempts to restore the exact previous envelope bytes
  or its original absence, including when the previous file could not be parsed.
  If both writing and recovery fail, durable selection is reported as unconfirmed;
  the previous credentials remain available in the current session.
- Replacement, Forget and credential-rejection cleanup share one session guard.
  It remains held until storage and transport work settle, so old cleanup cannot
  erase a new pairing. Forget invalidates pending checks before awaiting storage.
- A code may have been consumed before an interrupted verification completes.
  Obtain a fresh desktop code in that case; review unused paired-device entries
  from desktop Settings if cleanup is needed.
- Pairing uses one protected `tli.pairing.envelope` item with
  `{"schema_version":1,"pairing":...}`. Existing two-key storage loads unchanged
  when the envelope is absent. A corrupt envelope never falls back silently.
  Forget stores an explicit empty selection before cleaning old keys; failed
  cleanup remains visible and cannot resurrect a pairing in this app version.

## Compatibility and rollback

Backend encrypted formats, endpoint URLs, SSE fields, model defaults and device
registries remain intact. No data migration is required. New security checks may
expose an incomplete copied installation that older code would silently reset;
preserve original files and recover matching state rather than rerunning setup.

Older backend code ignores `startup.json`. Rolling code back therefore requires
the equivalent explicit HTTPS/bind/port environment settings to retain Companion
reachability. It also restores the older security failure behavior. Preserve a
complete stopped-installation copy before rollback; this checkpoint did not
perform a live restore or certify a portable backup.

Older Companion builds do not read the new envelope and may use their previous
legacy pairing. Re-pair on the older build if required. If old-key cleanup failed,
revoke unwanted device credentials on the host before using older app code.
Installed native artifacts remain unchanged until an updated build is installed.

## Verification record

Baseline carried forward: 549 backend, 115 desktop and 56 Companion tests passed;
no baseline failures. Tests isolate persistence and integrations before app imports.

Coverage includes corrupt/missing security files, DPAPI/keypair failures, failed
initial writes, authenticated reset, partial Vault reset, temporary security
fixtures, saved configuration in a fresh process, environment precedence,
certificate refusal, actual-port advertisements, connection ordering,
replacement cancellation and secure-storage/transport failures. Full regression
totals: **648 backend, 138 desktop and 78 Companion tests passed**. Backend
reported 934 existing/deprecation warnings and no failures. During implementation,
five fixture failures were corrected by isolating Vault session persistence and
seeding complete security state for screenshot tests; these were not baseline
failures. Strict mobile TypeScript, shell syntax and tracked diff checks passed.

Final local iOS and Android Hermes exports passed on 2026-09-06. Output:
`mobile/.expo/verification-connection-recovery-20260906` (ignored). This refreshes
JavaScript export verification only; installed native apps were not rebuilt.

Desktop startup review/save and the phone layout were inspected at 1440 × 900 and
390 × 844 using `backend/tests/startup_preview.py`. The saved HTTPS/port change
left the fixture's running HTTP listener unchanged. Corrupting only the disposable
PIN fixture returned an unavailable status and kept the recovery view locked.
Companion browser fixtures
cover AI-unavailable, trust and replacement-entry states; real trust handshakes,
SecureStore behavior, reboot, background/resume and accessibility still require
physical iPhone/Android acceptance. TypeScript, shell syntax and local Hermes
exports provide source validation, not native release acceptance.
