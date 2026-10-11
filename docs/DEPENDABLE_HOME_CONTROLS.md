# Dependable Home Automation controls

Implemented in the working tree on September 6, 2026. This batch followed the
reviewed cleanup work. It addresses existing control problems before adding
new integrations; diagnostic rechecks remain parked.

## What changed

- Shelly cards and status requests use the address **and relay index**. Two
  relays on one address have separate names, readings and action buttons.
  The add-device form exposes the relay index, including index zero.
- Backend address-only requests resolve a unique registered relay. Multiple
  registered relays require an explicit index and cause zero device calls
  when omitted. Unregistered legacy addresses retain relay-zero behavior.
- A browser loads the host registry without automatically saving its cached
  list back to the host. Browser-only device definitions are retained for
  explicit import. The existing registry endpoint supports additive `merge`
  requests; saves preserve existing IDs, aliases, rooms and other metadata.
  A legacy name/address update cannot silently collapse multiple relays.
- Polling shares pending requests and serializes complete polling cycles.
  Readings for the requested relay must contain an actual boolean state.
  Missing output never becomes OFF, and an action acknowledgement never
  becomes a status snapshot. Old reads that predate a command cannot replace
  the post-command reading.
- A failed status request marks current state unavailable while retaining the
  last observation internally. Readings become stale after 30 seconds; visible
  cards age while Home Automation is open even if a device request is slow.
  A healthy relay cannot hide another stale or unavailable relay.
- Direct Shelly and Home Power commands return truthful `ok` values, preserve
  existing response fields and add `outcome`/`request_id`. Exceptions with an
  uncertain delivery outcome are reported as unconfirmed. Acknowledged commands
  receive a separate status read; a failed read does not relabel the command
  itself as failed or imply that the requested physical state was reached.
- Repeated clicks cannot launch competing commands for the same target from
  these panels. Both direct backend entry points share the same lock for an
  equivalent Shelly address/relay. Optional request IDs return a cached result
  instead of executing it twice within the retention window.
- Existing session authentication now protects Shelly registry mutations,
  direct commands and status reads, including Home Power status reads.
- Companion displays unavailable state as an indeterminate, disabled switch.
  After an unconfirmed command it asks for a status refresh instead of rolling
  the display back to a guessed ON/OFF value. Device names are rendered safely,
  controls have a 44-pixel hit area and keyboard focus indication, and long
  error messages wrap in the phone viewport.
- Dashboard wording now counts **registered** devices. Registration alone
  does not establish that a device is online.

## Compatibility and limits

Existing endpoint URLs, registry formats, IDs and saved-action formats remain
usable. The frontend sends explicit relay values and additive registry updates.
No persisted-data migration or model change is required. Browser cache loading
accepts older address-keyed records and clears their stale status assertions.
Command messages in cards are current-page feedback, not durable receipts.

The command guard is in process, bounded to 512 recent request IDs, retained for
five minutes after completion. Reusing an ID for a different command returns a
conflict. A restart clears this cache; no request is automatically replayed.
It is not a durable exactly-once guarantee, a global lock over every automation
or saved-action path, or protection against external controllers. Existing
saved-action and chat preflight behavior remains separate and covered by the
regression suite. Generic drivers still determine what their acknowledgements
mean; physical state is only shown when a separate status result supplies it.

Rolling back code requires no data conversion. However, the older UI does not
correctly support multiple relays and its registry-save bug returns on rollback;
use a copy of the data for rollback checks and preserve the corrected registry.

## Verification

The carried-forward checkpoint had 276 backend and 51 frontend tests passing.
During this batch, companion work elsewhere in the shared workspace added
backend coverage. An intermediate full run passed 315 tests before this batch's
new test file; no failing baseline was observed.

Final full run: **352 backend tests passed**, with 465 warnings, and **69
frontend tests passed**. This batch adds 25 backend cases and 18 frontend cases.
Coverage includes metadata preservation, legacy and ambiguous targeting,
requested relay status, invalid driver responses, authentication, repeated and
concurrent commands across the direct endpoints, uncertain outcomes, cache
bounds, stale and raced readings, frontend single-request behavior, Companion
state handling and browser-cache preservation. Existing chat, startup, model,
storage, authentication and companion tests remained passing.

`backend/tests/home_controls_preview.py` serves an isolated loopback fixture on
port 8767. Every device read and command is a fake using documentation addresses;
all persistence is temporary. Its optional Companion page simulates the pairing
guard and disables heartbeats solely for UI testing.

Browser checks at 1440 x 900 and 390 x 844 verified distinct relay cards, a
successful Relay 1 command, an accurately reported Relay 0 rejection, unknown
device state, inline naming without changing the other relay, and the phone
Companion's successful and unconfirmed command paths. Main controls and
Companion fit the phone viewport without horizontal overflow.

These are fixture and viewport checks, not physical smart-device or phone
validation. No real device was switched, live TLI restarted, model downloaded,
or distribution packaged. New backend behavior loads after a normal restart.
