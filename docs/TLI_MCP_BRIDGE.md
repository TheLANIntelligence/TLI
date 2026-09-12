# Optional local MCP bridge

This checkpoint exposes three fixed read-only TLI tools to a client running on the same computer. It implements MCP **2026-07-28** Streamable HTTP with JSON responses, including modern `server/discover`, per-request protocol metadata, mirrored method/name headers and private, immediately stale tool-list caching. The local Settings inspector speaks this same protocol. It is not a generic remote MCP client or a Home Assistant integration.

## Deliberate workflow

Open **Settings → Security & connections → Local MCP connections** using the host's literal loopback address or `localhost`, then review the separate read-only TLI access controls. Set and unlock the owner PIN first. Nothing connects, grants access, probes a device or runs inference when the section opens.

1. **Check local access** reports this browser's existing temporary grant.
2. Choose specific scopes, review their descriptions and select **Enable reviewed access · 15 minutes**.
3. Copy the separate temporary Bearer credential only to a trusted client on this host, or explicitly **Connect local inspector** to discover the granted tools.
4. Select a tool, review its exact arguments, then **Run reviewed read**.
5. **Disconnect & revoke access** ends the grant. TLI restart, PIN-session revocation, PIN disablement and expiry also invalidate it.

Closing Settings, hiding the page or opening the PIN lock screen clears displayed credentials and results. Closing the view does not itself revoke an external client's access or cancel a server read. A failed revocation stays visibly failed. If the credential was cleared while the server grant still exists, **Check local access** can find that grant and **Disconnect** it; its credential cannot be recovered. A new grant requires a fresh review.

## Exact scope

| Tool | Returned information | What it does not establish |
|---|---|---|
| `tli_registered_devices` | Bounded host/mesh/home-power/Shelly registry projections: names, identifiers, addresses, relay numbers, room labels and available recorded observation times | Current reachability, active capabilities, printer inventory or successful operation |
| `tli_reported_health` | Already collected TLI-host CPU, RAM and drive percentages with the original observation time and 30-second freshness | A new probe, AI availability, a diagnosis or another computer's health |
| `tli_recorded_rooms` | Recorded room labels and computer/device assignments | Detected room occupancy or physical location |

Missing or unreadable registries are disclosed; unknown measurements stay unknown, zero stays zero, and failed/stale observations do not become current. Names and registry text are untrusted saved data. Tool annotations do not grant permission or establish that a server or result is trustworthy. Tool output is source data, not proof of an AI claim.

No Notes & fixes, conversations, Troubleshooting bodies, documents, Vault contents, credentials or arbitrary metadata are included. There is no shell/stdio launcher, remote URL field, automatic LLM tool registration, device action, scan, diagnostic check, sampling, elicitation, subscription or model call. External clients control their own use and storage of returned information; TLI cannot retract copies already read.

## Authentication and limits

The bridge is disabled without an explicit grant. Grants exist only in process memory, are tied to the exact original PIN browser session/account and local origin, and last at most 900 seconds. Only a digest of the generated MCP credential is retained. Browser cookies and Companion credentials cannot authenticate MCP requests; MCP credentials cannot manage grants or access other TLI endpoints. This local custom Bearer flow is not an OAuth implementation.

The exact `/api/mcp` endpoint delegates to its own authentication guard. Sibling paths and every other path retain the existing Companion middleware rules. Both the actual socket peer and literal Host authority must be loopback. Origin, when supplied, must exactly match the local origin. Forwarded/proxy headers and LAN/public access are rejected. This is a direct host-local checkpoint, not a supported reverse-proxy deployment. A local native client supplies `Authorization: Bearer <temporary credential>` to the exact displayed endpoint.

Limits are 16 KiB per MCP request, 128 KiB per response, 60 requests per minute per grant, two concurrent requests per grant, two actual filesystem-read workers globally, 16 active browser grants, at most 2,000 registry entries and at most 50 returned entries per read. Request bodies and source reads have five-second deadlines. A timed-out read is never replayed; an underlying filesystem read retains its worker slot until it finishes. Every successful read rechecks grant validity before returning output. No persistent connection configuration, secret store or data format was introduced.

Management routes are `GET /api/integrations/mcp/status`, `POST /api/integrations/mcp/grant` with `{scopes, reviewed: true}`, and `POST /api/integrations/mcp/revoke` with `{id}`. The MCP endpoint accepts POST; GET and DELETE are unsupported. Legacy `initialize`/session handshakes are not silently accepted as modern MCP.

## Verification

`backend/tests/test_mcp_bridge.py` exercises real session authorization, exact endpoint delegation, scope and result bounds, host/origin/proxy rejection, absent and stale observations, byte-preserved synthetic stores, concurrent reads and revocation during a pending read. Frontend controller tests cover explicit request boundaries, unknown tools, duplicate clicks, failed replacement/revocation, expiry/lock clearing and late responses. The full-SPA fixture checks Emerald Light, Midnight and Classic at 1440, 768, 390 and 320 pixels. Narrow layouts do not imply phone/LAN bridge support.

The opt-in verifier `scripts/verify_mcp_interop.py` starts only its own synthetic loopback FastAPI server, using the real router and authorization middleware, and connects with the official **MCP Python SDK 2.2.0** from a separate environment. It proves modern discovery, scoped tool listing, structured reads, revocation, unchanged synthetic persistence and absence of legacy initialization. MCP SDK dependencies are not added to TLI's runtime requirements. Example:

```powershell
backend/.venv/Scripts/python.exe scripts/verify_mcp_interop.py --sdk-python build_work/anniversary-completion/mcp-interop-env/Scripts/python.exe --output build_work/anniversary-completion/mcp-interop/report.json
```

No live TLI, household data, real external account, physical phone, live model or Companion pairing is used by these checks. Compatibility with older protocol clients, arbitrary external MCP servers and third-party desktop applications remains unverified.

## Primary references checked 2026-09-08

- [Current MCP base protocol and metadata](https://modelcontextprotocol.io/specification/2026-07-28/basic)
- [Current Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [Modern server discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
- [Tools, input schemas, caching and untrusted annotations](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [Official Python client](https://py.sdk.modelcontextprotocol.io/client/)
- [Official Python transport interfaces](https://py.sdk.modelcontextprotocol.io/client/transports/)
- [Official SDK package](https://pypi.org/project/mcp/2.2.0/)
