# Optional Room display

Room display is a browser view of a room’s registered devices and explicitly requested saved observations. It uses the existing authenticated TLI session. It does not create a restricted kiosk account, register a new computer, store credentials or add another device controller.

Open **Rooms & devices → Open room display**, then choose a configured room. No room is selected automatically, including when only one room is available. The **Unassigned devices** choice represents existing devices with no shared room label; it does not infer where they are physically located.

## What appears

- The TLI host name and stable identity, with the room-list read time.
- Each registered device’s name, stable ID, kind, configured address and relay where present.
- Shared household importance. This is a user preference, not measured severity or an automation trigger.
- **Observation not read** until the user chooses **Read saved observation** for that device.
- A requested record’s observation time, saved-metadata read time and age at the last display update. A recent registry observation is not proof of current device health, host reachability or AI readiness.

Identical display names remain separate cards with their original IDs. Room selection and **Show 24 more devices** change presentation only. No device, model, action, location, occupancy or microphone probe occurs.

## Explicit reads and freshness

The existing API is reused without new persistence or endpoint contracts:

| User choice | Existing request | Meaning |
| --- | --- | --- |
| Open display / Refresh room list | `GET /api/intelligence/rooms` | Read configured groups and registered references. |
| Read saved observation | `GET /api/intelligence/devices/{id}/details` | Read saved metadata for the exact registered ID. The display retains only observation metadata. |
| Refresh saved observations | Same details GETs, sequentially | Reread at most 24 previously requested, currently visible records. No fresh device check. |

Responses must use `tli-device-details-v1`, confirm `actions_performed:false`, and identify the expected host and target. Duplicate IDs, inconsistent room membership, changed host identity, malformed observation metadata, or changed address/relay bindings cannot silently replace an accepted observation.

The display shows at most 24 device cards initially. Additional cards are revealed explicitly. A response with more than 2,000 registered devices is refused by this bounded client instead of silently truncating it.

The existing **30-second** freshness boundary is retained. Age is calculated when the view updates and the calculation time is shown. There is no interval, clock timer, background refresh or polling. A record explicitly marked stale remains older even if the computed age is short. Missing or future observation times remain unknown. Neither the labels nor elapsed time become a live health claim.

## Failure and lifecycle behavior

- Failed reads preserve the previous list and observations, including their original times, while identifying the latest failure.
- Failed or mismatched per-device responses cannot be attributed to another device or substituted by name.
- A removed room does not select its successor automatically. Removed or rebound target references lose their cached observation.
- Room choices and repeated reads are guarded while a read is pending. There are no automatic retries, writes or action endpoints.
- **Open fullscreen** uses the browser API only on explicit activation. Failure leaves the ordinary view available. When the display owns fullscreen, Escape first exits fullscreen; otherwise Escape closes the display. Browser-specific fullscreen behavior still needs physical acceptance.
- Closing, locking, hiding the page or leaving it clears in-memory room selection and private observations. Late responses cannot reopen the display; a stale 401 from a previous view cannot lock a newly authorized view.
- Only fullscreen owned by this display is released. Other application fullscreen state is not changed.

The entry in Rooms & devices closes that read-only dialog before opening Room display. If the matching module is unavailable, the existing view stays open with a refresh explanation. Existing device-edit draft protection is retained.

## Implementation

- `frontend/js/room-display.js`: `window.TLIRoomDisplay.open()` / `.close()`, dynamic native dialog, strict read-only response checks and in-memory state.
- `frontend/room-display.css`: existing theme tokens, tablet grid, narrow-screen and enlarged-text layout.
- `frontend/js/device-details.js`: explicit Room display entry and epoch-scoped handling of old authentication rejections.

No backend, configuration, encrypted-store, pairing, model, startup or native app changes belong to this display.

## Isolated verification

**43 focused frontend checks passed:** 14 Room display controller checks, 17 device-details checks and 12 existing network-specialist checks. These cover duplicate names, exact IDs, malformed responses, 30/31-second boundaries, future/missing times, failed refresh preservation, source replacement, duplicate requests, large rosters, fullscreen, keyboard closing, lock/background cleanup and delayed 401 responses.

`scripts/verify_room_display_browser.cjs` passed **10 browser behavior checks and 33 layout/contrast checks across all 23 themes**, with detailed 1440/760/390/320-pixel views, enlarged text and reduced motion. The separate `--spa` pass used the real browser shell, the actual Rooms & devices entry, and JSON from authenticated isolated backend routes: **3 flows, 3 layouts and 3 screenshots**. All browser traffic was intercepted; every operation was a GET. There were no browser errors, overflow findings, contrast findings or tested-source changes.

Evidence:

- `build_work/anniversary-completion/room-display-browser/2026-09-08T17-14-32-832Z/report.json` — theme/behavior matrix and 13 screenshots.
- `build_work/anniversary-completion/room-display-browser/2026-09-08T17-14-24-720Z/report.json` — real SPA and actual synthetic route schemas.
- `build_work/anniversary-completion/room-display-final-tests.log` — focused unit results.
- `build_work/anniversary-completion/room-display-review.html` — local gallery, with artifact hashes in `room-display-coverage.json`.

These fixtures do not validate physical room hardware, sensors, room occupancy, a real always-on tablet, native fullscreen differences, screen readers or device operation. Those remain **not run**. The modern default, existing themes and the browser’s actual session authority remain unchanged.
