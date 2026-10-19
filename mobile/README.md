# TLI Companion

## Personal AI refresh (0.2.0)

The Android experience uses **Chat / Library / More**. Library shares existing
conversations and notes; Chat provides direct photo/document entry and supports
ordinary keyboard dictation without requesting microphone permission. Settings
shows the installed native version/build and a public **Get Android update** link
that remains usable when the home computer is offline.

On the desktop, choose **Connect phone** and follow Prepare computer → Install
Android app → Scan and connect → Start chatting. Android downloads no longer need
email verification. Use the installed app's scanner for the private pairing QR;
the separate installation QR only opens the public download page. Existing
credentials, certificate checks, accepted-run recovery and draft cleanup remain.

See [refresh behavior and acceptance](../docs/TLI_PHONE_REFRESH.md) and
[current signed delivery](../docs/TLI_COMPANION_CURRENT.md). The newer app requires
an in-place signed APK update; changing desktop files does not update the phone.

Native iPhone/Android private beta. The Expo Router app shares the owner's existing TLI conversations, devices, diagnostics, scenes, and activity review position. Every native server request uses the local certificate-pinned `modules/tli-transport` module. Expo Go is unsupported.

## Shared workspace source update

Android recovery now combines all private addresses returned by native DNS-SD
with bounded DNS fallback for the reviewed `.local` name. Native network callbacks
and foreground resume trigger fresh verification. Each candidate must prove the
saved certificate, hostname and signing identity without receiving credentials;
only the proven route becomes active. Recovery refreshes read-only state and
reattaches saved runs without resubmitting actions. Changed identity or certificate
details require review. See [connection rollout and acceptance](../docs/TLI_SEAMLESS_CONNECTIONS.md).

The Chat / Library / More navigation includes shared conversation search,
small-app Builder projects and revisions, reviewed document questions, and an
explicit reviewed LAN model selector. Chat renders escaped Markdown, tables and
copyable code. Model choices belong to a conversation on supporting hosts; actual
answer receipts identify the executing computer separately from the home host.

TXT/Markdown is read locally; selected PDF/DOCX files are uploaded over pinned
HTTPS for bounded extraction and text review. The existing four-document/64 KiB
text and 8 MiB source limits apply. Documents require a standalone local-provider
question; selecting them never silently changes the chosen LAN resource. Cached
source files are removed after reading. Document text selections clear on
backgrounding or pairing changes; an already accepted request continues on the host.

Supporting hosts expose owner-scoped runs. Once an answer or app generation is
accepted, backgrounding detaches this phone while the host continues. Foreground
resume reads the same run; it never repeats the submission. A protected,
owner/host-bound run pointer restores the most recent accepted Chat after app
restart. Stop requests cancellation on the host; an uncertain response does not
prove that earlier actions were undone. Older hosts retain the existing interrupted
foreground-request behavior. Shared-work notifications refresh read-only lists and
offer conversation refresh without overwriting a draft.

More can attach to a Chat run started on another screen, show its current answer
and request host cancellation. The unsent composer draft stays intact. Startup
attachment and history/settings reads wait for a reviewed foreground reconnection
after transient interruption; identity, credential and missing-record failures
stop with review guidance. Document questions keep the chosen bundled or LM Studio
route and require a fresh document capability check before accepting a host run.

Builder reuses the host library, immutable versions and revision conflicts.
Android previews run in a separate local WebView with a sandboxed opaque iframe,
response CSP, blocked network loading, no TLI credentials and no native JavaScript
bridge. Generated checks are advisory. Source ZIPs download through pinned native
transport into temporary cache before explicit sharing. iPhone preview is clearly
unavailable in this source release. Browser samples remain entirely synthetic.

These changes require a newly compiled Android build; they do not update an
installed beta automatically. Physical background/resume, picker, cache cleanup,
network loss, retained pairing, accessibility and preview egress checks remain
native release gates. JavaScript exports do not establish native acceptance.

The browser preview renders the same screens with clearly labeled sample data. Run `npm run preview` with the supported Node version below. Its platform-specific transport simulates conversations and controls entirely in memory; camera buttons use a sample printer illustration. It cannot pair with TLI, read protected credentials, upload a real photo, or control actual devices. Browser changes disappear on reload.

## Develop and check

Use Node **22.13+**, npm, and Expo development builds. Expo SDK 57 targets React Native 0.86.3, iOS 16.4+ and Android 7+. iOS native compilation requires Xcode 26.4+ on macOS or EAS; local Android compilation needs the Android SDK and supported JDK.

```powershell
cd mobile
npm ci
npm run check
npx expo install --check
npm run start
# Install a native development build first:
npm run android
# On a Mac:
npm run ios
```

The pure TypeScript tests exercise split SSE frames, incomplete EOF, routing, pairing validation, revocation, cancellation, no automatic command replay, and partial action results. Validate the actual native bundles with:

```powershell
npx expo export --platform ios --platform android --output-dir dist
```

## Pair

Open **Connect phone** in the desktop TLI. The guided preparation reuses PIN, LAN,
HTTPS, firewall and reviewed restart controls. After any required restart and
unlock, install the Android app, create a private pairing code, and scan it inside
the app on the same home network. Confirm the displayed computer and name the
phone. Existing prepared hosts skip preparation; technical repair options remain
available separately.

The single-use code contains the LAN HTTPS origin, short-lived invitation, public leaf certificate, and node identity. The invitation is discarded after redemption. SecureStore keeps the resulting credential and pairing details; neither is placed in application logs, URLs, AsyncStorage, or photos. A revoked credential cannot fall through to a desktop/anonymous session. A certificate replacement requires re-pairing.

Use **Settings → Review replacement pairing** to review a changed address,
certificate or host while retaining the previous credentials until verification
and secure saving succeed. New connection checks supersede old results; AI
readiness is shown separately from host reachability. See [safe startup and
connection recovery](../docs/SAFE_STARTUP_COMPANION_RECOVERY.md), including old
storage compatibility, interrupted-code reuse and rollback limits.

## App behavior

- **Today:** dated activity coverage, warnings, favorites, and explicit review acknowledgement. Activity links open a known device/conversation or prepare an Ask prompt for the owner to submit.
- **Ask TLI:** existing conversations, incremental streaming, Stop, selected-device context and the latest saved diagnostic evidence. LM Studio text uses `/chat`; bundled/mesh uses the bootstrap-selected stream. Photos, explicit controls, and supported diagnostic commands use TLI's existing fast paths. Requests are not replayed after interruption.
- **Home:** rooms, canonical registered device IDs mapped to HomePower source IDs, capability-specific on/off buttons, diagnostic history, scenes, and per-action results.
- **Notes & fixes:** private saved notes from existing encrypted TLI memory, reachable from Ask and Settings. Search, review edits/deletions, and attach up to four reviewed versions to a standalone question. Conflicts require refresh; failed questions keep draft and selections. Answer receipts identify supplied versions and open current notes. Notes are not forwarded to mesh peers or used to execute actions. See [Notebook checks and compatibility](../docs/HOUSEHOLD_NOTEBOOK.md).
- **Photos:** system camera/library picker, JPEG conversion at up to 2048 pixels, enlarged preview, reviewed AI destination, explicit Send, six-MiB upload bound, and `retention_days: 0`. Choose an ordinary photo question or screenshot explanation/error/next-step guidance with a separately selected computer. Temporary app-cache files are deleted when removed, successfully completed, the pairing changes, or the screen unmounts. Failed and stopped sends retain the draft/photo for explicit retry; they are not automatically resent. Server validation independently removes metadata and enforces its limits.
- **Settings:** connection recovery, protected pairing, shared appearance preference, and local forgetting. Data & Recovery explicitly checks saved notes, conversation and diagnostic data on the paired host, labels unavailable/stale results, and provides manual backup guidance. It creates no backup and runs no automatic check. See [recovery scope and checks](../docs/DATA_RECOVERY.md). Revoke paired phones from desktop Phone Companion to terminate server access.

On backgrounding, active requests are cancelled. Returning to the app refreshes read-only connection capabilities. Older data stays labeled as stale while offline; controls and chat are disabled. No background push, queued commands, automatic provider changes, or image retention is enabled.

Screenshot guidance uses `/api/intelligence/screenshots/context` before sending.
An unavailable review blocks image upload; text chat remains available. A changed
provider requires Recheck and a new explicit send. Deploy a matching backend
before installing the updated app. Shared history keeps bounded guidance receipt
metadata, never the image or provider review key. See
[checkpoint behavior and verification](../docs/COMPANION_SCREENSHOT_CONTINUITY.md).

The browser-only fixture recognizes “simulate failure”, “simulate interruption”,
“simulate slow”, and “simulate provider change” in sample questions for recovery
checks. These controls never reach the native transport or a real provider.

## Distribution and release checks

EAS profiles: `development` (dev client), `preview` (internally distributed Android APK / registered iOS devices), `simulator` (iOS Simulator), `production` (store-signed builds). Project: `@sergeantseven/tli-companion`. Signing credentials stay in EAS, not source files. Android preview builds run the native transport unit tests before assembling the APK.

Before uploading, inspect an EAS archive from the **mobile directory** and verify that it contains only the intended mobile sources, native module, package lock and config. The root `.easignore` allowlist is required for Git-root monorepo archives; the mobile `.easignore` protects app-root archives. Never upload runtime `data/`, model files, vault contents, private keys, repository distribution archives or signing credentials.

```powershell
npx eas-cli build:inspect --platform android --profile preview --stage archive --output build-inspect
# After inspecting the archive:
npx eas-cli build --platform android --profile preview
npx eas-cli build --platform ios --profile preview
# Compile on EAS without Apple signing credentials (not installable on an iPhone):
npx eas-cli build --platform ios --profile simulator
```

Native module tests and trust fixtures are documented under `modules/tli-transport`. This refresh targets physical Android with a Windows home host: pairing and revocation; wrong/expired certificates and hostname mismatch; camera/local-network denial; Wi-Fi loss mid-stream and mid-action; background/resume; large text/screen readers; keyboard/composer visibility; and photo questions continued on desktop under the same conversation ID. Those physical checks were not run for this candidate at the user's direction. Native iPhone delivery remains future work. Cloud compilation and JS tests do not replace physical-device verification.

`npm audit` currently reports 13 moderate transitive advisories in Expo's `xcode → uuid` build tooling and Router's `query-string → decode-uri-component` dependency paths, with no high/critical findings. The suggested automated fixes downgrade Expo/Router across major versions; those are intentionally not applied. Review upstream updates before wider distribution.

Official references: [Expo SDK compatibility](https://docs.expo.dev/versions/latest/), [development builds](https://docs.expo.dev/develop/development-builds/introduction/), [image picker](https://docs.expo.dev/versions/latest/sdk/imagepicker/), [image manipulator](https://docs.expo.dev/versions/latest/sdk/imagemanipulator/), [SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/), [EAS monorepos](https://docs.expo.dev/build-reference/build-with-monorepos/), [EAS ignore files](https://docs.expo.dev/build-reference/easignore/).


## Anniversary continuity checkpoint

The existing app identity, pairing storage keys, EAS project and signing profiles are unchanged. Today and connection settings now provide entry points to **Notes & fixes**, **Computers and reports** and **Troubleshooting**, keeping the existing Today / Ask TLI / Home tabs.

- **Ask:** Use saved notes controls automatic recall for the next question. Turning it off first verifies host support; an unsupported host blocks the question. Earlier conversation still applies. Selected-note questions keep their separate sharing rules. Opening a report or suggested question preserves an existing draft and its context instead of replacing it.
- **Answer evidence:** live and resumed conversations display the host's actual saved-note recall, prior-conversation, observation, document-coverage and input-budget receipts alongside existing screenshot and selected-note receipts. Missing information stays unknown. Document metadata is readable from history; this release adds no phone document picker. Input-token estimates are not answer-quality ratings.
- **Waiting and interruption:** each request measures elapsed time and first displayed text on this phone. Stop waiting retains partial text and the question for deliberate retry. It does not establish that server actions stopped. No automatic resend, model start or health probe follows an answer.
- **Reviewed note saves:** a completed saved reply can be reviewed as a new note or as a replacement for an owned current note. The comparison includes text, title, category, computer association and source. An updated AI answer is a saved AI suggestion, not a confirmed fix. Updates require the exact current revision; conflicts retain the proposed text and require a fresh review. Review drafts clear on backgrounding, connection replacement and close.
- **Computers:** canonical IDs distinguish same-named computers. Host access, AI readiness, registered inventory and saved diagnostic observations remain separate. Missing capabilities and observation times are shown as unavailable. Opening a roster/report does not run diagnostics.
- **Troubleshooting:** shared owner-scoped records contain a symptom, optional computer, reviewed links to notes/reports/replies, planned/tried/skipped steps, outcomes and a user-confirmed resolution. Opening/searching records is read-only. Evidence linking and saves are explicit; case steps never execute. Stale revisions reject updates, previous records and drafts are retained on failure, and private drafts clear on backgrounding or pairing changes. Deleting linked source data is never part of a case action.
- **Connection evidence:** connection screens show the exact paired HTTPS origin, latest check start and last successful connection. Native timeouts, connection-establishment failures, unavailable routes, certificate failures and rejected credentials have distinct guidance when the platform supplies that evidence. A generic network failure never claims a specific cause or AI outage.

The browser sample includes in-memory case and reviewed-note endpoints for interaction tests. It never contacts a household. Native JavaScript exports verify bundling; physical Android/iPhone acceptance remains separate. Delivering the updated existing Android Beta requires the same package/signing lineage and a higher native build number; do not uninstall or clear app data. The internal `beta` profile retains these identifiers and uses remote version increments. No iPhone distribution is implied by an iOS JavaScript export.

## Dependable computers source checkpoint

The phone now presents the existing host's `recorded_facts` on saved reports and
`evidence_context.recorded_report` before Chat prose. Compact cards keep the
executing host, selected process or target, observation status and sample coverage
visible; an explicit disclosure exposes measurements, interval and limitations.
Host and process CPU are separate scopes; process CPU uses whole-host capacity.
Memory values are displayed in MiB, with unknown samples retained as unknown.
Stopped/partial sampling never becomes a completed health or repair claim.
Malformed summaries or report/host/target mismatches display unavailable details.
Older saved reports retain bounded legacy descriptions without inferred coverage.

Historical changed/unavailable note receipts identify the exact earlier exchange,
handle, note ID, old title and revision. An earlier `N1` is not a current source
link. These receipts work for both streamed and reopened conversations.

**Case report review:** one current linked report may be included separately as
bounded recorded facts. Select its link description, explicitly preview the facts,
then acknowledge the exact selection. No report facts are fetched on navigation.
The additive `case_ref.report_refs` contains at most one `{kind:'report',id,revision}`
already selected in `evidence_refs`. `/api/intelligence/cases/context-review`
rechecks source ownership/revision and returns the facts; the eventual Chat request
checks capability again and confirms `included_reports` against the completed
receipt. Changed selections invalidate preview/acknowledgement, conflicts preserve
choices, and no request automatically retries. Full linked bodies remain excluded.

**Reviewed peer observation:** the phone opts into peer choices with
`GET /api/intelligence/diagnostics/options?include_peer_observation=true`.
Only an available `peer_system` choice enables the explicit reviewed Run. The
request binds the raw executing peer ID, selected inventory ID and scope revision.
Its saved response uses report kind `system` and records the peer's signed identity
binding, observation time and requesting host. No local-host fallback, internet
branch, peer process control or repair is introduced. Older hosts can still return
their existing local choices.

**Versions:** Settings reads the installed app's version, native build and package
from `expo-application` (Expo 57's compatible `~57.0.2` dependency). It never uses
the JavaScript manifest to invent a native build number. The browser fixture says
it has no installed native build. An explicit read of `/api/diagnostics/version`
shows host startup/code identity and `matched`, `restart_required` or `unknown`.
Matching host files do not certify every phone feature, model quality or physical
device. Pairing, native transport, signing identifiers and storage keys are unchanged.

This checkpoint requires a newly built, verified Android Beta update before these
native changes are available on a phone. The earlier Beta 5 remains the retained
artifact until its successor's package, higher build number and signer are verified.
Physical update/pairing, interrupted Wi-Fi/action, backgrounding, screen-reader,
keyboard, off-LAN routing and iPhone installation remain separate acceptance gates.
