# Companion through a private route

The browser's Phone Companion page and the native app's connection settings now
explain an optional way to reach the **already paired home-network address**
through an externally managed private route. Pair on the home network first.
Keep the existing host identity, certificate trust and app credentials.

TLI does not install a VPN, configure a router, open firewall ports, create a
public endpoint or guarantee reachability. A user-managed VPN with a suitable
home-network route and name resolution can provide the network path. The phone
must be able to reach the exact paired private HTTPS origin; a certificate-valid
address in setup is only a candidate, not evidence that this remote path works.

The workflow retains existing private-address and certificate checks. It does
not introduce direct trust for a new mesh-VPN address, permit public hosts or
bypass TLS. Link-local addresses such as `169.254.x.x` are unsuitable for this
remote workflow. If using a hostname, its remote resolution must continue to
identify the intended trusted home host.

The native app shows its paired address and explicitly checked connection
result. A successful host check is distinct from AI availability. Failed checks
preserve the earlier observation and its time. Timeout, refusal and certificate
errors are distinguished only where native transport provides that evidence;
unknown failures are not given invented diagnoses.

Connection restoration never replays a message, action or pairing request.
Interrupted conversations and drafts retain their existing deliberate retry
flow. Checking the route does not replace pairing or copy credentials.

Software verification includes isolated backend/controller checks, 149 combined
Companion tests in the integration checkpoint, TypeScript and mobile exports.
Synthetic browser/mobile interruption and layout evidence, with before/after
views and artifact hashes, is in
`build_work/anniversary-completion/remote-review.html` and `remote-coverage.json`.

**External VPN setup, off-Wi-Fi access, physical Android update and retained
pairing remain not run.** The updated Android Beta is a separately tracked build;
browser changes alone do not update an installed native app. No household
pairing or live host configuration was changed by these checks.
