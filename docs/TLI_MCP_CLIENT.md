# Manual MCP client

This optional Settings connection lets a PIN-unlocked browser review and invoke a tool from an MCP server already running on the **TLI host**. It complements the separate read-only TLI MCP server. It does not make external tools available to Chat, launch a server, discover background services, register devices or copy private TLI context.

The supported protocol is **2026-07-28**, verified against an isolated **official Python SDK 2.2.0** server. Older initialization/session protocols, remote LAN/public servers, stdio subprocesses, OAuth flows, subscriptions, sampling, roots, elicitation, resources and MCP Apps are unsupported in this checkpoint. There is no fallback to an older transport or automatic repeat after a server asks for more input.

## Review and invocation

1. Enter an exact literal-loopback endpoint such as `http://127.0.0.1:8124/mcp`. An explicit port different from the current TLI listener is required. Only `/mcp` and `/api/mcp` paths are accepted; hostnames, userinfo, queries, fragments and redirects are rejected. IPv6 `::1` is supported with bracket notation. The endpoint belongs to the host, even when its Settings page is opened from a phone.
2. **Review endpoint** validates the address locally and displays transport/discovery scope. It does not connect or send a token. Review lasts five minutes.
3. Confirm the reviewed endpoint, optionally supply that external server's Bearer token, then **Connect & list tools**. TLI sends `server/discover` and bounded `tools/list` requests only. Its owner PIN cookie and Companion/delegated credentials never authorize client management or get forwarded automatically. Failed replacement preserves the prior connection.
4. Choose an exact tool. Its full definition, schema, fingerprint and annotations are displayed as **untrusted server claims**. Unsupported schemas remain visible with an explicit disabled reason. `readOnlyHint` does not enforce a read-only effect.
5. Enter a JSON object and **Prepare invocation review**. TLI rechecks the server identity/catalogue, validates the arguments and shows the exact source, definition, arguments and any protocol-mirrored headers. This review is owner/connection-bound, one-use and valid for at most two minutes.
6. Confirm and **Invoke reviewed tool once**. TLI freshly rechecks the exact identity and entire catalogue fingerprint before sending at most one `tools/call`. A changed definition, annotation, server identity or missing tool rejects the attempt before invocation. No inference or implicit saved-note, case, document, conversation or Vault read occurs.

Remote server identity is self-reported. A valid schema or result is not evidence that a tool is safe, that its assertions are true or that a physical effect occurred. The server may operate files/devices or contact other services even when its annotations claim otherwise. Users must review the external server and intended tool themselves.

## Outcomes and preservation

The response separates `completed` (server returned a supported result), `server_error` (server reported a tool error), `not_sent` (preflight rejected before tool transport) and `unknown` (an invocation may have run but its result was not confirmed). Tool errors can also have effects. No state is called a verified physical success.

Every invocation consumes its review. A duplicate request ID with the same binding returns the saved receipt or pending status; it never sends the tool again. Reusing an ID for another review fails. A lost connection, timed-out response, malformed result, failed output schema or request for additional input never triggers a retry. A new deliberate review is required after checking the external system's outcome.

The UI retains the previous completed output with its original source/time when replacement reads, connections or invocations fail. Returned tool errors and uncertain attempts appear separately. Text and structured JSON render as inert text. Non-text items are counted and excluded; no image, resource, URL, application, script or instruction is fetched or executed from a result. No result is attached to Chat automatically.

**Stop waiting** abandons this browser's wait and invalidates its review. It does not prove that remote work stopped. Closing, backgrounding, session lock and known expiry clear the private view and ignore late results; an old 401 cannot clear a newer view. Closing the panel does not revoke a still-valid backend connection. **Check temporary connection** finds it without contacting the server; **Disconnect** ends that temporary access without revoking the original external token or claiming to undo earlier work.

## Authority and transport limits

Only a current PIN browser cookie may manage connections. PIN-disabled sessions, Companion/MCP Authorization headers, cross-site origins and forwarding headers are rejected. Credentials may be submitted only via HTTPS to TLI or through a direct loopback browser connection. Every operation rechecks owner/session identity, and revocation hooks discard loaded client state.

Temporary connections expire after 15 minutes and have scheduled in-memory cleanup even if the user makes no further request. PIN revocation, owner change and restart also end access. Credentials, catalogues, review arguments and invocation receipts are never written to configuration, backups or another persistence store. This is not a secure-memory-erasure guarantee: an already-running bounded request may retain its local references until it finishes. All newly introduced state is disposable.

Outbound HTTP uses a fixed literal loopback IP, normal TLS certificate/IP validation for HTTPS, no environment proxy, no redirect, no cookie forwarding and no reconnect. Each owned socket has a **12-second total deadline**, including SSE dribbles. The implementation closes only its own connections. A fresh RPC has one POST and one request ID. It never sends protocol cancellation/resume/retry requests or accepts a server-originated JSON-RPC request. Bounded request-related notifications are ignored as data before the final matching response.

Limits: 16 temporary connections; 32 endpoint reviews; 64 invocation reviews; one operation at a time per PIN browser; four concurrent outbound HTTP requests globally; 64 tools across at most eight list pages; 512 KiB per remote response; 24 KiB per tool definition; 16 KiB per schema and argument object; 24 KiB inbound management body with a five-second body deadline; 128 SSE events; 128 content items; 128 KiB projected output; 32 invocation attempts per connection. Exceeding a limit fails explicitly without adopting a partial catalogue or automatically retrying. A paginated operation may perform up to nine bounded discovery/list requests; invocation adds one final bounded tool request. The browser's wait is bounded separately to 125 seconds.

## Supported schemas

The client intentionally validates a limited JSON Schema **2020-12** subset without a new runtime dependency. It supports object/array/primitive types (including type unions), `properties`, `required`, boolean/schema `additionalProperties`, homogeneous `items`, `enum`, `const`, bounded `anyOf`/`oneOf`/`allOf`, numerical bounds and string/item/property count bounds. It accepts inert title/description/default/examples annotations. Schemas are bounded to 12 levels and 256 nodes. The root input schema must declare object type.

References (`$ref`/`$defs`), regular expressions, format checks, other dialects and unimplemented keywords are rejected rather than ignored. No reference resolver or network schema loader exists. Optional output schemas are checked against structured output when the server reports success.

Valid `x-mcp-header` properties follow the protocol's static `properties`-only reachability and primitive string/integer/boolean constraints. Names are case-insensitively unique, bounded HTTP tokens. Integral JSON numbers enforce the safe integer limit before mirroring and use canonical decimal headers. Unsafe/plain-sentinel text is UTF-8 Base64 encoded using the protocol sentinel, never interpolated into raw headers. Unsupported header placements disable the tool.

## Verification

- `backend/tests/test_mcp_client.py`: isolated session/review/ownership, source-preservation, schema/numeric boundaries, single-use/duplicate/uncertain requests, real owned JSON/SSE HTTP and HTTPS fixtures, credential rejection before invalid TLS, response/deadline/no-redirect/no-replay bounds and scheduled expiration cleanup.
- `frontend/tests/mcp-client.test.cjs`: actual controller with synthetic fetch/DOM; navigation causes no connection, explicit workflow, inert results, failed replacement preservation, duplicate prevention, invalid schemas/JSON, Stop/lock/expiry and stale-401 handling.
- `scripts/verify_mcp_client_interop.py`: actual official SDK **2.2.0** server in a separate environment and actual TLI router/client in a temporary persistence root; verifies current discovery, supported schema, real SSE structured result, one invocation, no forwarded cookie, unchanged stores and owned child termination. SDK is not added to core requirements. Run with the source Python, `--sdk-python` pointing to the isolated SDK interpreter and `--output` an ignored report path.
- `scripts/verify_mcp_client_browser.cjs`: intercepted full SPA in Emerald Light, Midnight and Classic at 1440/768/390/320 widths; connection/review/result workflows, overflow, exact explicit call counts, retained old results and late-output protection. Screenshots are browser fixtures, not a physical phone or real external-server acceptance record.

No live MCP server, household credential, real tool effect, model, user data or TLI restart was used. Existing configuration, encrypted stores, endpoints and Chat/SSE contracts are unchanged.

## Primary protocol sources

Consulted official sources for this checkpoint:

- [MCP 2026-07-28 discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover): current per-request discovery and self-reported identity.
- [MCP 2026-07-28 tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools): schemas, untrusted effect annotations and text/structured results.
- [MCP 2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http): per-request metadata, matching headers, JSON/SSE, parameter encoding and no legacy protocol sessions/resumption.
- [Official Python SDK 2.2.0](https://pypi.org/project/mcp/2.2.0/): isolated interoperating SDK. Its installed `mcp.server.mcpserver.MCPServer.streamable_http_app` API is used by the verifier.
