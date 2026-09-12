# Optional Home Assistant connection

This checkpoint adds an explicitly launched, temporary connection under **Smart devices → Optional Home Assistant connection**. It reads Home Assistant's reported light/switch states and can submit one individually reviewed `turn_on` or `turn_off` service action. It does not install Home Assistant, modify TLI's device registry, add an AI tool, enable a scene, run an automation or start background refresh.

## Review → Connect → Read → Review action → Run

1. Open TLI through HTTPS or directly on its host, with the owner PIN enabled and unlocked.
2. Enter the existing Home Assistant origin, including the correct port. Select **Review origin and addresses**. This resolves and validates the destination; it sends no Home Assistant credential.
3. Check the exact origin, resolved private addresses and transport. HTTPS uses normal certificate and hostname verification. HTTP requires an explicit acknowledgement that the token and states travel unencrypted to that selected origin.
4. Enter a Home Assistant long-lived access token and **Connect reviewed origin**. TLI verifies only the fixed `/api/` endpoint. It does not read entities at connection time. A failed replacement retains the previous connection.
5. **Read lights & switches** explicitly requests the state list. Select an exact entity ID, then **Review Turn on** or **Review Turn off**. This performs another read of that exact entity, without an action.
6. Check the origin, address, entity ID, name and effect. **Run reviewed action** rechecks the current entity revision and submits at most one fixed service request. A changed, unknown, unavailable or mismatched target requires a new review.

Home Assistant's REST API authenticates using Bearer tokens. Its service API operates entities; writing `/api/states/<entity_id>` merely changes Home Assistant's representation and is not used by this bridge. A service response can contain unrelated state changes, so TLI does not treat that array as proof that a physical device reached the requested state. [Home Assistant REST API](https://developers.home-assistant.io/docs/api/rest/)

Tokens are created in the Home Assistant profile. Their underlying lifetime and permissions belong to Home Assistant; TLI's short connection lifetime does not revoke the original token there. [Home Assistant authentication](https://developers.home-assistant.io/docs/auth_api/)

## Scope and truthful outcomes

The displayed list contains only `light.*` and `switch.*` entity IDs, friendly names, state, unit and supplied change/update times. TLI fetches the complete bounded `/api/states` response, then excludes other domains and arbitrary attributes. No history, configuration, location, private URL or attribute body is saved. Large result lists show at most 50 matching choices at once, with the displayed and total counts; filtering is local.

An explicit read means **Home Assistant reported this state when TLI read it**. It does not prove reachability of the physical device, current power consumption or the outcome of an earlier action. An old `last_changed` value can legitimately mean a light has stayed off; it is not a fresh physical observation. `unknown` and `unavailable` remain distinct, and those states cannot be used to prepare an action.

Only the standard light and switch On/Off services are available. No toggle, brightness, scene, multi-entity target, arbitrary domain/service, template or script is accepted. [Light actions](https://www.home-assistant.io/integrations/light/), [Switch actions](https://www.home-assistant.io/integrations/switch/)

The exact entity's complete source-state digest is checked again under the existing target command lock before submitting a service request. Duplicate request identifiers keep the same original receipt and time; a consumed review cannot be reused with another identifier. Failed preflight reads report **no service action submitted**. A lost response after an attempted submission reports **outcome unconfirmed**. Nothing retries automatically. Read the entity again and create a new review before deciding on another action.

Home Assistant entity IDs can be reassigned by an administrator. TLI checks origin, pinned address set, exact entity ID, current name/state metadata and review revision; it does not claim independent hardware identity or physical confirmation.

## Temporary ownership and preservation

The connection belongs to the original authenticated PIN browser session and account, for at most 15 minutes. Credentials and reviewed intent exist only in TLI process memory. The token never enters Home Power's plaintext `extra` field, ordinary registries, Notebook, Vault, model prompts or backups. No new persisted credential store, key, migration or optional package was introduced.

Expiry rejects access immediately. Expired entries are pruned on later service
operations; this is not a guarantee of wall-clock token erasure from RAM.
Disconnect and actual PIN-session revocation also remove the corresponding
in-memory connection. TLI does not revoke the original token held by Home Assistant.

PIN-session revocation, owner change, PIN disablement, expiry and TLI restart invalidate access. **Disconnect temporary session** removes that TLI connection and invalidates a pending candidate connection. It does not revoke the original Home Assistant token or cancel a service action already submitted. Closing the panel, hiding the page or showing the PIN lock screen clears the browser's credential fields, state list and reviews. This is view clearing, not a claim that server work was cancelled. There is no automatic reconnect.

A failed state replacement or failed disconnect preserves the previous displayed result and its observation time. A failed new connection preserves the existing connection. Delayed results after lock, a replaced connection or explicit disconnect cannot repopulate a private view or adopt an invalidated candidate. Home Assistant authentication failures are integration errors, not TLI PIN-session failures; they do not clear unrelated Chat drafts.

## Destination and resource boundaries

Only reviewed RFC1918 private IPv4, IPv6 ULA and loopback addresses are supported. Public, link-local/metadata, multicast, unspecified and mixed public/private DNS results are rejected. Origins cannot include embedded credentials, path, query or fragment. The current TLI loopback listener is not an allowed HA destination.

Hostnames are resolved explicitly during review. The complete resolved private address set must remain unchanged before each request. TCP connects to a pinned literal address; HTTPS still verifies the original hostname. There is no redirect following, environment proxy use, credential forwarding or unverified-certificate fallback. An expired or changed destination requires a fresh review.

Limits are 8 KiB per TLI request, five seconds to receive it, three seconds for bounded DNS waiting, two actual DNS workers, four active outbound requests, eight seconds per HTTP request, 2 MiB per HA response, 2,000 source entities, 16 temporary connections, 32 origin reviews and 64 action reviews. Origin reviews last five minutes and action reviews two minutes. A blocked resolver retains its worker slot until it finishes. A closed or timed-out HTTP socket cannot reconnect implicitly.

## Verification and remaining acceptance

`backend/tests/test_home_assistant_bridge.py` uses synthetic sessions, source records and owned local HTTP/HTTPS servers. It checks destination rebinding, mixed DNS, certificate/hostname verification before credential transmission, redirects, size/encoding/JSON/deadline errors, exact service paths, unknown targets, revisions, duplicate/uncertain submissions, late candidate invalidation, owner changes and unchanged persistence. Existing Home Power, Companion and MCP regressions run separately.

`frontend/tests/home-assistant.test.cjs` exercises the actual controller with isolated fetches and clocks. `scripts/verify_home_assistant_browser.cjs` loads the real SPA with intercepted synthetic responses across Emerald Light, Midnight and Classic, at 1440, 768, 390 and 320 pixels. It verifies that navigation/review run no action, explicit selection is required, one Run produces one request, failures retain results and lock discards late responses.

No real Home Assistant server, token, physical light/switch or household data is available or used for this batch. Actual HA deployment compatibility, local certificates, permissions, device behavior and native phone parity remain **not run**. Persistent connection configuration, broader domains, scenes, automatic monitoring, generic MCP/AI registration and Companion controls are outside this checkpoint.
