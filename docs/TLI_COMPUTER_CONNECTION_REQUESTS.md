# Computer connection requests

Full TLI installations can request a LAN connection without copying
public cards. Both computers need this implementation and must restart TLI after
updating. Their HTTPS LAN listeners must be reachable on the same network.

Start with **Connect device** in Computers, LAN Messages, or Phone Companion.
The continuous setup, invitations, recovery rules and physical acceptance gates
are documented in [Seamless connections](TLI_SEAMLESS_CONNECTIONS.md).
The shared guide checks this host's existing setup, offers phone/browser,
full-computer and compute-only Node paths, and uses explicit connection/model
checks after review. Phone invitations and computer comparison codes use their
existing approval screens. Nodes open a five-minute window with `run --pair`;
their terminal compares the same code and accepts inference approval locally.
Normal Node pairing also exchanges public cards automatically. The guide links **Legacy companion and
local history** for preserved browser-local data.

1. Open **Computers** or **LAN Messages**, select the discovered computer, and
   choose **Request connection**. Select the permissions to review: text messages
   and file offers, system observations, coordination, or AI inference. Messages
   plus basic observations and coordination are selected initially for a new
   full-computer connection. Existing connections retain their current permissions.
   Inference is a separate choice and still needs an explicit model selection.
2. On the other computer, choose **Review request** in the incoming banner, or
   open **Computers → Connection requests**.
3. Compare the entire code on the two computers' own screens. Select the code
   comparison and displayed permission checkboxes, then choose
   **Codes match — connect** on each computer.
4. Keep the request open until both confirmations appear. Then send a message.

Each computer saves exactly the displayed permissions after its own approval.
Text message permission also permits reviewed file offers; each file still
requires separate receiver consent. A successful connection check lists the
permissions both computers have granted. This check requires no system-observation
or coordination permission and returns no system metrics.

Discovery names and IP addresses remain hints. A name change or two identities
at the same IP does not merge trust or carry permission to another identity.
The main Computers list shows the newest discovery for each address and listener
port. Earlier unreviewed discovery records remain saved in the access directory;
LAN Messages puts them under **Previous discoveries**, preserving each original
conversation and draft. Reviewed and blocked identities remain visible. Approving
the newest discovery does not bring its older duplicate cards back.
Previously blocked or reviewed full computers use **Review connection** to start
an explicit update. Existing permissions stay unchanged until the owner compares
the new code and approves the displayed replacement permissions. Declining leaves
the existing trust intact. The advanced card flow remains available for older
installations. Nodes support inference only, and their replacement review also
requires the local `run --pair --review-update` option.

Requests expire after five minutes and disappear when TLI restarts. Declining or
cancelling stops further confirmation of that request. It does not revoke a
permission already saved; use **Revoke trust** for that. Each computer saves only
its own explicit permission. A single confirmation is shown as waiting for the
other computer, and message authentication still checks the receiver's trust.

Open this flow in each computer's local TLI browser. Remote browser access must
have a valid TLI PIN session. With the PIN disabled, trust changes require a
localhost/loopback browser connection. Companion credentials and peer signatures
cannot act as a browser owner to approve trust.

## Protocol and boundaries

The legacy `tli-message-pairing-v1` bootstrap still supports messages and file
offers. The additive `tli-computer-pairing-v2` protocol binds the selected grants,
whether an existing connection is being replaced, and both concrete LAN interfaces
into the comparison transcript. Both exchange signed public cards over HTTPS.
The initiator commits to a random nonce before receiving the responder's nonce;
the responder fixes its signed response before the initiator reveals its nonce.
The 12-hex-character comparison code binds the complete signed exchange, both
nonces, both identities, certificate pins, addresses, roles, and message grant.
People must compare the whole code on both screens; receiving a request or
seeing a familiar name never grants permission.

This uses the commitment-before-reveal principle described for short code
comparison in [RFC 6189, section 4.4.1.1](https://www.rfc-editor.org/rfc/rfc6189.html#section-4.4.1.1).
It is a TLI-specific protocol, not an implementation of ZRTP or a claim of formal
protocol verification.

The initial exchange contains public bootstrap material only. Its observed TLS
certificate must match the returned signed card. Later messages check the exact
certificate pin before sending bytes. Transport accepts only fixed pairing
paths at private IPv4 or reviewed `.local` HTTPS origins, binds to the selected local LAN
adapter, and follows no redirects. There are no inbound callbacks, browser
credentials, prompts, or files in the bootstrap.

Requests are bounded to 64 KiB and 32 pending records, with request rate limits,
network deadlines, and replay rejection. Browser confirmations bind to the
original session and saved trust revision. Changed identity, certificate,
address, revoked session, or concurrent trust changes require a fresh review.
Only explicit browser confirmation on a full host or local terminal code entry
on a Node writes the existing trust store. Node approvals bind to the live
in-process console authority, recheck the global deadline before saving, and take
the same OS administration lock as local trust/revoke commands. A Node accepts
only v2 handshakes from a full host with exactly the inference grant. Its public
handshake routes have no remote approval operation and are absent in ordinary
Node mode. Node cards always advertise exactly `inference_v1`.

## Stable home-network connections

New v2 connections prefer the computer's `.local` HTTPS name only when the current
certificate already covers that exact name and the running listener accepts its
private adapter. No certificate or signing key is replaced to enable discovery.
Existing IPv4 connections remain valid; moving them to a stable name requires the
guided connection review on both computers.

DNS-SD advertises `_tli._tcp.local.` with the running secure port and actual private
adapters, alongside legacy UDP discovery. Adapter changes refresh the advertisement.
These are unsigned route hints. Changing the resolved IP never rewrites a reviewed
card, permission, or trust revision. Before authenticated work, the connection
checks the reviewed hostname's SAN, exact certificate pin, and a nonce-bound
Ed25519 identity proof on the same TLS socket. Changed keys, certificates or
reviewed names need another desktop review. Away access is a separate feature.

LAN messages synchronize by their persisted arrival position and message ID, so a
late message or two messages with the same sender timestamp are not skipped.

## Verification

`backend/tests/test_peer_pairing.py` uses two synthetic installations to exercise
the exchange, bilateral permission, cancellation, expiry, altered transcripts,
source-address checks, session changes, and pinned transport limits.
`backend/tests/test_peer_trust_browser_authority.py` verifies the same browser
authority boundary for manual trust changes.
`backend/tests/test_connected_mesh_v2.py` adds multi-grant replacement, signed
messages-only status, arrival-cursor, exact SAN, identity-proof, adapter-rebind and
Node boundary tests using synthetic hosts and sockets.
`backend/tests/test_node_pairing.py` verifies host/Node code comparison, local
console authority, deadline and trust revision checks, terminal text escaping,
inference-only grants, explicit replacement, and the public HTTP boundary.
`scripts/verify_connected_mesh_v2_browser.cjs` checks the guided permission/update
flow at desktop and phone widths. `scripts/verify_peer_pairing_browser.cjs` runs the real SPA against intercepted
fixtures on desktop and mobile in Modern and Classic modes. These checks do not
contact, approve, or send messages to physical LAN computers. Physical two-computer
and Android validation, including DHCP changes, still needs both installations
updated and the owners' explicit review.
