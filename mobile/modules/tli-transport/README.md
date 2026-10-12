# TLI native LAN transport

Local Expo module for iOS and Android development/release builds. It does not run
in Expo Go or a browser. All TLI requests must use this client; it never modifies
global React Native networking or the phone's system trust store.

## App integration

`import TliTransport from './modules/tli-transport'` exposes the interface defined
in `index.ts`. The app retains the paired certificate and device credential,
calls `configure` when opening a pairing, and attaches the bearer credential to
requests after successful configuration. Subscribe to `onHeaders` and `onChunk`
before calling a streaming request. Filter events by the unique request `id`.

Native callbacks emit headers, then valid UTF-8 chunks, then settle the request
promise in that order. Successful streaming results have an empty `body`;
non-streaming results and HTTP error results contain the decoded response.
HTTP error bodies do not emit `onChunk`. HTTP error statuses resolve normally, so
the app must inspect `status`. Transport failures reject. All 3xx responses
reject and redirects are never followed. Cancellation rejects with `E_CANCELLED`.
`configure` and `reset` cancel all prior requests, discard old connection pools
and clear previous trust. Failed reconfiguration leaves the module unconfigured.

Legacy pairings use canonical numeric RFC1918 or IPv4 link-local HTTPS origins.
Android also supports reviewed `.local` origins as described below; iOS retains
the numeric-address contract for this release.
The actual URL hostname must match the QR certificate's SANs. New certificates
require a fresh desktop pairing; unknown certificates are never learned from a
network response. No credential is sent until exact-certificate, date and
platform TLS hostname/trust checks have passed. Requests use relative paths on
that one origin; routing, cookie and HTTP framing headers cannot be overridden.

Responses, including streams, are capped at 8 MiB decoded network bytes, request
bodies at 16 MiB UTF-8, and certificates at 16 KiB DER. Requests use a 15-second
Android connection timeout, 120-second idle/request timeout and five-minute
overall limit. Native retry is disabled on Android. Client actions still need
server-side idempotency: a connection failure can happen after a server acts.

`requestHelper(configuration, request)` provides the optional Host Start path.
It creates one independent pinned client/session without replacing the main
transport's configuration. Pass the existing reviewed certificate DER and the
explicitly reviewed helper fingerprint; native code verifies that they match
before HTTP. The app additionally binds the helper to the paired computer's IP,
node and protected pairing envelope. Only status GET and start POST routes,
restricted `tlih_` credentials and nonstreaming requests are accepted. Helper
bodies are limited to 4 KiB, responses to 64 KiB and calls to 20 seconds. Cancel
and reset close these independent sessions; uncertain starts are never retried.
See `docs/TLI_HOST_START.md` in the repository root for setup and distribution
requirements. Existing native binaries need a compatible future release.

## Native project configuration

- `expo.autolinking.nativeModulesDir` must point to `./modules` (Expo's default).
- iOS needs `NSLocalNetworkUsageDescription`, `NSAllowsLocalNetworking`, and
  scoped ATS exceptions for `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, and
  `169.254.0.0/16`. Literal IP/CIDR ATS keys are supported from iOS 17; earlier
  supported iOS versions use the local-network exception. Do not enable global
  `NSAllowsArbitraryLoads`. The local exception allows app-provisioned trust;
  this module still requires HTTPS, TLS 1.2+ and complete certificate validation.
- Android SDK 36 needs `INTERNET`; this module declares it. When targeting SDK 37
  or higher, also declare `android.permission.ACCESS_LOCAL_NETWORK` in the app.
  The module requests it during `configure` only on Android 17+ with target 37+,
  and checks for revocation before each request. Denial or missing declaration
  rejects with `E_LOCAL_NETWORK_PERMISSION`. It is intentionally not declared
  for this beta's target 36.
- The Gradle module uses Expo's toolchain configuration and OkHttp 4.12.0. The
  installed Expo/React Native toolchain targets Java 17. iOS uses Swift 5.9+,
  Security.framework, ExpoModulesCore and the app's supported Xcode version.

## Verification

Native helper tests exercise private-origin boundaries, path/header injection,
UTF-8 split boundaries, malformed UTF-8, DER parsing and certificate dates.
Android `PinnedClientTest` performs real JVM TLS handshakes through the production
client builder with in-memory, runtime-generated certificates. It covers the
paired leaf, a different leaf, a replacement with the same public key, expired
and not-yet-valid leaves, SAN mismatch, and redirects. Failure tests assert that
HTTP header/body writes never begin and MockWebServer receives no request;
the success test verifies delivery of a dummy bearer credential and image body.
The loopback test server does not weaken production private-origin validation.
For a cross-platform syntax-only check, run
`npm exec --yes --package=@ast-grep/cli -- ast-grep scan --rule modules/tli-transport/tests/native-syntax.yml modules/tli-transport`
from `mobile`. This parses Kotlin/Swift; it does not typecheck platform APIs.
After Android prebuild, run `:tli-transport:testDebugUnitTest` with the app's
Gradle wrapper (or `:tli-transport:testReleaseUnitTest :app:assembleRelease` for
the preview release gate). Gradle logs passed/skipped/failed test names so EAS
build logs contain the test evidence. The podspec includes an XCTest `Tests` test specification for
the iOS helpers. These tests require their platform build toolchains.

Before distributing a native build on a platform, verify on its physical phone
(this release targets Android; iPhone delivery remains pending):

1. Pair and POST over the actual generated self-signed TLI certificate; confirm
   token-by-token SSE, UTF-8 text, cancellation and JSON photo uploads.
2. Substitute a different cert (including a trusted public/system root), an
   expired cert, and a cert for another LAN IP. Confirm the test server receives
   no Authorization header or request body for every rejected TLS handshake.
3. Return HTTPS and HTTP redirects; confirm their destinations receive no request.
4. Start two streams, cancel one, then reconfigure/reset; verify promises settle
   once and no old request events appear after cancellation/reconfiguration.
5. Deny/revoke local-network permission, disconnect Wi-Fi, restart TLI, and change
   its address. Check that the UI distinguishes known permission failures,
   certificate failures and unavailable connections without HTTP fallback.

Windows can run TypeScript/autolinking checks and Android tooling when installed.
Building/testing Swift and iOS TLS requires a Mac/Xcode or EAS plus physical
iPhone testing. Static checks are not a substitute for this transport gate.
## Native additions: reviewed reconnects and bounded files

`request()` remains the text/JSON/SSE interface. `uploadFile()` sends raw bytes
(not multipart), up to 8 MiB, from a canonical path inside the app cache.
`downloadFile()` writes at most 16 MiB into a randomly named app-cache file and
returns its `fileUri`; non-2xx responses return bounded text and remove the file.
Both share the existing cancellation, exact certificate pin, hostname validation
and redirect refusal. Failed/cancelled downloads are removed. The UI should use
the platform share sheet only after a successful explicit download.

On Android, `discover({timeoutMs})` returns bounded, untrusted `_tli._tcp.` hints.
`probeConnection()` validates the saved Ed25519 public key/node ID using a fresh
nonce and exact-pinned HTTPS before any bearer is sent. For `.local` connections,
`configure()` requires saved `nodeId`, `publicKey`, and 1–8 private literal
`resolvedAddresses`; it runs that probe before activating the connection. Its
client routes only that hostname to those candidates while retaining the
hostname in SNI, certificate checks, and HTTP Host. It never uses general DNS or
redirects as a fallback. Numeric IPv4 configurations retain their original
behavior. The helper remains on its separately reviewed numeric address.

Only the single private address observed on the successfully proved socket is
activated for authenticated requests. A proof does not authorize the rest of a
discovery result. Every new route/configuration repeats the signed challenge;
every later TLS socket validates the same exact leaf and hostname. The identity
proof is tied to the configured route, not repeated for each application request.

Discovery/probe and hostname reconnect are explicitly unsupported on iOS in this
Android release. iOS retains numeric-IP pinned transport and the bounded file
APIs. No Expo Go/web real-network fallback is supplied.

