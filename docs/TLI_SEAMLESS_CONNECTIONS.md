# Seamless TLI connections

This source update brings setup, discovery, bilateral permission review and
connection verification into **Connect device**. Physical-device acceptance is
still required before declaring the experience release-ready.

## Everyday connection

1. Open **Connect device** in Computers or LAN Messages on the main computer.
   Saved computers render immediately; nearby discoveries and verified status
   update in the background.
2. Use **Prepare this computer** if secure LAN access is not ready. Set and unlock
   the owner PIN, review the listener, HTTPS port and certificate details, then
   confirm the proposed settings. Existing certificates are preserved. Repairing
   invalid or missing stable-name coverage is a separate review that explains
   which existing pairings need renewed review.
3. Restart through the reviewed host lifecycle control when available. Open the
   reviewed HTTPS address, handle any browser certificate prompt locally, and
   unlock again. The setup receipt resumes completed work; it carries no PIN,
   session cookie or pairing secret. A manually launched host needs a manual
   restart.
4. On Windows, separately review the firewall step and approve its UAC prompt.
   The backend remains unelevated. The fixed helper creates application-specific
   inbound rules for the configured HTTPS port and UDP 5353/47474, restricted to
   Private networks and LocalSubnet. Migrating existing broad TLI rules requires
   a separate explicit selection. Denied elevation, Public networks and managed
   policy are reported rather than treated as success. Other platforms receive
   manual firewall guidance.
5. Select the other computer. New full-computer connections default to messages,
   basic observations and coordination. Review the exact requested permissions
   and compare the complete code on both computers before approving. Existing
   connections keep their current grants until an explicit replacement review.
   AI sharing is separate and still requires choosing a model before use.
6. Keep the flow open for verification. Use **Open messages**, **View computer**
   or **Choose AI model** when the corresponding capability is ready. A Node
   remains inference-only and requires its local `run --pair` window.

Phone pairing uses the same home host and its approved resources. Native phone
credentials and peer signatures cannot change host networking or approve trust.
Manual cards and legacy satellite functions remain under **Advanced**.

## When a computer is not listed

Choose **Computer not listed?** and copy a connection invitation from the other
computer. A Node exports one with `TLI_Node.bat invitation --state-dir "PATH"`.
The versioned invitation wraps the existing signed public card and up to eight
private address hints in a signature. Import validates all of it, then enters
the same comparison flow. Import alone grants nothing and does not unblock a
previously blocked identity.

DNS-SD is the normal discovery mechanism. Legacy UDP discovery remains available.
The optional diagnostic subnet scan is explicit, bounded and adapter-specific;
normal browsing does not sweep the subnet. If multicast is blocked, invitations
and the reviewed hostname's DNS routes provide alternatives.

## Recovery and connection state

Discovery observations, trust, reachability and individual operation readiness
are tracked separately. Seeing a device never grants access. A saved grant never
proves that it is online, and an absent advertisement never removes trust.
Computers, LAN Messages, dashboards and the connection guide consume the same
cached connection projection. Messaging-only grants can verify messaging without
observation or computer-control permission. Nodes verify their signed catalog.

Multiple private routes retain their source, interface and expiry. An IP-only
advertisement cannot replace a reviewed stable hostname. Bounded verification
prefers a previously proven route and can try alternatives before authenticated
work. A candidate must satisfy the saved TLS certificate, reviewed hostname and
signed identity challenge before receiving credentials. A changed identity or
certificate requires review; ordinary DHCP changes do not. Old literal-IP
pairings remain supported and retain their original authority.

A portable adapter watcher refreshes discovery after adapter changes and
sleep/resume, including unchanged addresses. Android collects NSD addresses,
uses bounded DNS fallback and native network callbacks, and retains only the
proven active route. Foreground checks refresh saved state and reattach accepted
host runs by their saved IDs. Recovery does not replay messages, actions,
inference requests or Builder submissions, or change the selected model.

Connection failures report available evidence: missing permission, unsupported
protocol, failed resolution, refused listener, timeout or identity mismatch.
They do not infer that a computer is asleep or that a firewall is the cause.

## API compatibility

- `/api/lan/peers` and presence events include the versioned connection snapshot,
  freshness, discovery hints and capability readiness. Lists read cached state;
  background checks update it independently.
- `/mesh/directory/{device_id}/connection` requests a coalesced verification.
  A check still in progress is distinct from a successful connection.
- `/mesh/pairing/invitation` exports public material;
  `/mesh/pairing/invitation/import` validates it without granting trust.
- `/api/network-setup/v1/status`, `/preview`, `/confirm` and `/receipt/{id}`
  require local browser-owner authority. Mutations also require an unlocked
  owner PIN session. Previews bind the current process, session, settings,
  certificate and fixed helper. Receipts survive restart without replaying work.
- Interrupted preparation can be reviewed again. An uncertain elevated firewall
  process is fenced until its outcome or process exit is established. A helper
  rechecks the signed request deadline before each mutation.

New features are advertised in bootstrap. Old cards, grants, identities, blocked
entries and conversation history remain compatible. Trust approval still uses
the existing bilateral comparison protocol.

## Rollout and acceptance

Roll out the host/API package, then its browser interface, then the signed Android
update retaining the existing package and signing lineage. The host retains the
workspace and must be available. Remote access, workspace replication and host
failover remain follow-on work.

Automated verification covers protocol boundaries, hostile route hints,
invitation tampering, cached projections, setup authorization, interruption and
native transport behavior. It cannot establish physical LAN latency or operating
system integration. The healthy eligible LAN target is discovery and recovery
within ten seconds after listeners or the network become available.

Before release, record results using two full computers, an inference Node and
an Android phone:

- Fresh setup, denied UAC, managed policy, Public-network classification, browser
  certificate prompts, restart resumption and reviewed broad-rule migration.
- Multiple adapters, dead-first addresses, nondefault HTTPS ports, DHCP changes,
  sleep/resume with unchanged IP, blocked multicast and WAN disconnected.
- Everyday and messaging-only grants, existing grants unchanged, Node catalog
  readiness, invitation fallback and legacy clients.
- Changed certificates/identities, revoked trust, malformed discovery,
  unauthorized setup, stale callbacks and repeated request IDs rejected safely.
- Accepted chat and Builder runs survive phone background/Wi-Fi interruption,
  with identical history and no duplicate messages, actions or revisions.
- Install the new Android APK over the prior signed beta; verify protected pairing
  retention, keyboard, large text, screen reader behavior, documents, downloads
  and preview isolation on the device.

Reference: [DNS-SD continuous browsing](https://www.rfc-editor.org/rfc/rfc6763.html#appendix-F),
[Windows firewall rules](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/rules),
[Android NSD](https://developer.android.com/develop/connectivity/wifi/use-nsd) and
[Android network callbacks](https://developer.android.com/develop/connectivity/network-ops/reading-network-state).
