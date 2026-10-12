# One TLI workspace on phone and computers

This implementation keeps conversations, notes and Builder projects on the home
host. Android and the responsive browser read the same owned resources. Trusted
computers supply explicitly reviewed capabilities; discovery never authorizes
work. The home host must be available.

## Using the update

1. Update the host source and install `backend/requirements.txt` in its existing
   environment. DNS-SD uses the new `zeroconf` dependency. Restart the host normally
   after saving current work; code changes do not replace a running process.
2. Open TLI at its HTTPS address. Phones now receive the full responsive interface
   at `/`; the installed browser application's start URL is `/` too. The original
   companion remains at `/companion/legacy`, using its existing origin-local
   history and satellite controls.
3. Use **Connect device** for host readiness, startup configuration, the relevant
   phone/computer/Node instructions, permissions and a final check. Full computers
   compare the connection code and permission choices on both screens. A phone
   uses already approved resources through its home host.
   For a Node, start `TLI_Node.bat run --state-dir "<Node state folder>" --pair`,
   select it in the guide, and compare the browser's code with its terminal.
   Both sides approve inference only. The five-minute window exchanges public
   cards automatically; the Node's approval remains local console input.
   Replacing saved trust also requires the Node's `--review-update` option.
4. Install the signed Android update over the existing Beta package. Keep app data.
   The four destinations are Chat, Today, Home and Tools. Tools opens Builder,
   notes, conversations, computers and available workflows. The signed artifact
   and its verification record are tracked in [current delivery](TLI_COMPANION_CURRENT.md).
5. To upgrade an existing IP pairing, create a new invitation using the checked
   `.local` name and review it in the phone. Matching computer identity and
   certificate retain the existing device credential. Changed identity or
   certificate needs a new review. No pairing is silently rewritten.

## Shared work and interruption

An accepted Chat or Builder request has a durable request ID before execution.
Reusing that ID with the same payload retrieves its existing run; a conflicting
payload returns 409. The clients never automatically replay an uncertain POST.
They can retrieve a run by its run ID or original request ID, including when its
acceptance response was lost. A compact Saved work list provides recovery after
navigation or client restart.

Backgrounding or closing a display detaches it. Accepted work continues on the
host. Explicit Stop requests cancellation; actions completed before Stop remain
recorded. The worker rechecks its original owner credential and cancellation at
execution/persistence boundaries. Revocation stops remaining authorized work.
There is one active turn per conversation across legacy and new endpoints.

After host restart, unfinished runs become `interrupted` without dispatch or
replay. Completed runs read saved conversation messages or immutable Builder
revisions. Prompts, credentials, uploaded text and token buffers are not copied
into the durable run journal. The journal stores owner, request digest, status
and saved-resource pointers. Up to four runs execute concurrently, with ten-minute
execution checkpoints, a 2 MiB answer limit and a bounded 512-event replay buffer.
Blocking model calls also retain their provider timeouts; Stop cannot undo work
already executed by a provider.

Conversation settings retain the reviewed LAN resource tuple and a revision.
`null` means the host's current local AI setup. A stale tuple fails visibly; it
does not select a substitute computer or provider. Replies retain actual model,
executing computer and the existing source/context receipts. Settings changes
use optimistic revision checks and cannot change during an active turn.

Owner-scoped change notifications invalidate saved conversation, note and Builder
views. They contain resource IDs, not content. Clients refresh saved work while
preserving unsent drafts. Notification cursors reset after host restart or buffer
overflow, causing a refresh rather than pretending no changes occurred.

## Interfaces

| Interface | Contract |
| --- | --- |
| Companion bootstrap | Existing v1 response plus feature flags and protocols; advertisements do not select AI transport |
| `POST /api/runs` | `request_id`, `kind`, `payload`; optional `app_id`, `chat_path`; 202 accepted or 200 existing |
| `GET /api/runs` | Compact owner-scoped directory; optional `conversation_id` |
| `GET /api/runs/{id}` | Status, text/metadata/result, replay cursor and bounded events |
| `GET /api/runs/{id}/events?after=N` | Existing Chat SSE meanings plus snapshots when replay has expired |
| `POST /api/runs/{id}/cancel` | Explicit owner-authorized cancellation |
| Conversation `/{id}/settings` | GET/PATCH with `compute_selection` and `expected_settings_revision` |
| `GET /api/workspace/events?after=N&epoch=E` | Owner-filtered invalidations and refresh/reset indication |
| `POST /api/connection/v1/identity` | Bounded credential-free, nonce-bound signed host proof |
| `POST /api/companion/v1/pairings/upgrade` | Consume a reviewed invitation while retaining the existing phone key |
| `/agent/peer/status` | Signed capability-specific readiness without demanding coordination permission |

Stable-name identity/card origins include the HTTPS port, including `:443`.
Pairing redemption normalizes default-port HTTP Host headers to that contract.
DNS-SD advertises `_tli._tcp.local.` on eligible private adapters and the actual
HTTPS port. Legacy UDP and manual addresses remain available. Peer messages use
persistent arrival cursors and existing message IDs, independent of sender clocks.
See [computer connection details](TLI_COMPUTER_CONNECTION_REQUESTS.md).

Ordinary Node startup exposes its compute and public identity endpoints. Only
explicit `run --pair` opens the temporary public handshake window; it adds no
remote approval endpoint. Node cards remain inference-only, and either side of
a Node pairing must request exactly the inference grant. Manual public-card
review remains an advanced compatibility option.

## Native boundaries

Android discovers route hints with native NSD. A new route must prove the saved
certificate, hostname and signed computer identity before credential transport
is activated. TLS sockets continue checking the exact pin and hostname. Discovery
cannot alter the reviewed origin, trust key, owner, grant or certificate.

Document picking accepts bounded text/Markdown/PDF/Word inputs. PDF/Word extraction
uses the host's existing signed extraction receipts; users review the text before
including it. Unsupported combinations are rejected before sending and failed
requests retain drafts. Native upload/download methods use the pinned transport
with bounded app-cache files (8 MiB upload, 16 MiB ZIP download).

Android Builder receives only a selected immutable revision's rendered content
and security headers. Its credential-free local WebView serves an in-memory
wrapper containing an opaque `sandbox="allow-scripts"` frame. The rendered
document retains its CSP response header. Native bridges, file/content access,
network loading, external navigation, permission grants and service-worker
network access are disabled. Generated smoke checks remain advisory. Leaving the
screen, backgrounding, changing revisions or changing connection destroys the
preview. See [native preview policy](../mobile/modules/tli-preview/README.md).

## Validation and remaining release gates

Automated host tests cover durable admission, duplicate/conflicting requests,
owner boundaries, cancellation/revocation, restart interruption, Builder recovery,
settings revisions and legacy mobile routing. Mesh tests exercise synthetic hosts
and sockets, permission-specific status, arrival cursors, certificate-covered
names and adapter changes. They do not approve or operate household devices.

The frozen mobile checkpoint passed strict TypeScript, 245 tests and
Android/iOS/web exports. Seven compiled browser workflows covered Chat/Tools
drafts, reviewed model choice, document review, Builder versions and attachment
to an active Chat run with Stop. Both Android native modules compiled against
SDK 36; their 28 tests covered TLS pins, hostname and signed-identity checks,
bounded binary transfers and preview policy. Exports and fixtures do not replace
physical acceptance. The signed APK and archive verification are recorded in
the [current delivery record](TLI_COMPANION_CURRENT.md).

Before declaring a production rollout complete, run these physical gates:

- Two real computers plus Android: messaging-only trust, inference, nondefault
  ports, multiple adapters, DHCP changes, sleep/resume and WAN disconnection.
- Backgrounding and Wi-Fi interruption during Chat and Builder: retrieve the same
  run without duplicate messages, actions or revisions.
- Hostile discovery, changed identity/certificate, revoked credential and
  cross-owner attempts; retain prior pairing and fail visibly.
- Android update over the prior signed Beta: protected pairing retention,
  keyboard, large text, screen reader, document picker and ZIP destination.
- Real WebView attempts at network requests/navigation/permissions, including
  generated hostile content. Policy unit tests do not replace this check.

No real-phone or two-computer acceptance is claimed by browser fixtures. Files
and mesh sharing, Vault/routine editing, broader native tools and voice follow.
Away-from-home routing and DNS verification, workspace replication, host failover,
on-phone inference and native iPhone delivery remain outside this implementation.
