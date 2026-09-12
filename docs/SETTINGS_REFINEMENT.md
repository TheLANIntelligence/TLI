# Settings organization and preservation

Implemented as a focused Settings checkpoint on September 7, 2026. Existing TLI
navigation, themes and feature panels are retained. This is a working-tree
change, not a packaged release or a live-host upgrade.

## Organization

Settings uses five categories and a local search of static setting labels:

| Category | Contents |
| --- | --- |
| General | Appearance, shortcut to existing Narrator settings, host background activity profile |
| AI & chat | Bundled model library, chat defaults, browser/host routing, LM Studio, image-capable providers, optional web search |
| Security & connections | Access PIN, Vault, computer name/role, host trust identity, phone pairing and secure startup |
| Saved data & backups | Saved notes and retained images, readability checks, encrypted notes/chat/report backups, legacy browser data |
| App & troubleshooting | Update preferences, licensing and browser debug log |

The previous nested scrolling area is removed. Category switches keep existing
controls, event handlers and unsaved values in place. Search does not index
credentials, input values or saved results and does not send network requests.
Opening a result reveals its existing controls; their ordinary read/check
behavior still applies. Existing PIN, Vault and license links reveal the correct
category. Advanced details remain expandable with keyboard and ARIA state.

The “Where AI runs” follow-up replaces inherited rounded row cards with flat
rows, consistent control sizes and separate This browser / TLI host fieldsets.
Its on/off switch retains the native checkbox, accessible name and keyboard
operation. Changing the switch still requires the existing host-routing save;
styling does not issue requests or alter routing rules. This presentation-only
follow-up passes the 360-test frontend suite and uses the same isolated browser
checks, recorded in `build_work/settings-refresh/routing-polish-verification.json`.

## Terminology and scope

- **Notebook / saved notes:** private saved setup details, preferences and past
  fixes. This is separate from conversation history. Users can control saved
  memory eligibility or explicitly select notes for a question. Opening Notebook
  does not attach a note to chat or generate a response.
- **Chat history:** saved conversations. It is not automatically a Notebook note.
- **Back up notes, chats & reports:** an encrypted archive of the existing
  account-scoped stores. It is not a Vault or whole-installation backup. Archive
  verification does not restore over live data; existing scope review and
  password requirements remain.
- **Browser preferences & legacy history:** the older browser-only JSON export,
  import and clear controls. They do not remove current host-saved conversations.
- **TLI host:** the computer running the server, even when the user visits from
  a phone. Model defaults, security, startup and shared routing apply there.
- **This browser:** appearance, chat preferences, source policy, preferred LAN
  host and search preferences. **Current browser session:** debug logs.

Settings no longer claims that every setting is browser-local or that no enabled
feature can contact the internet. Optional search, updates and downloads have
specific connection disclosures.

## Correctness fixes

- Theme changes save independently. One visible chat-preferences save merges
  its owned fields into the existing settings object, preserving Search Assist
  and custom fields. The old Apply control ID remains as a hidden compatibility
  alias. Profile reads no longer overwrite unsaved response settings.
- Host model/profile/name/routing settings, licenses and update preferences
  check actual save outcomes and guard duplicate submissions.
- The legacy history controls use their intended original keys. Imports validate
  the legacy payload before writing and explicitly review replacement.
- Update status includes the existing saved `auto_check` choice. A saved `false`
  survives URL changes. Missing/unreadable preferences disable saving instead of
  silently choosing a new value.
- Startup and pairing errors distinguish unavailable server capabilities,
  authentication and connection failures. Missing endpoints are not represented
  as problems that repeated browser refreshes can fix. Stale startup forms stay
  disabled until a valid read; drafts are retained.

Endpoint URLs, control IDs, existing storage keys, archive protocol values and
persisted formats are preserved. The `auto_check` status field is additive.

## Verification and limits

The final isolated runs pass **1,148 backend tests** and **360 frontend tests**,
plus all six Settings browser viewport/theme combinations. The initial backend
run exposed an authentication-fixture error in a newly added test; the test now
uses the existing authenticated fixture and the complete suite passes. Production
authentication was not weakened. Existing dependency deprecation warnings remain.

Automated evidence, source hashes and suite logs are saved under
`build_work/settings-refresh/`; the browser report linked from its verification
record includes screenshots and intercepted requests. Checks use temporary
persistence, synthetic providers and fixtures rather than the live installation.

`scripts/verify_settings_workspace_browser.cjs` exercises the actual Settings
controllers at 1440, 390 and 320 pixel widths in light and selectable dark themes.
It checks preserved IDs and outside-panel HTML, navigation/search, save failures,
unrelated settings preservation, Notebook opening, startup readiness and retained
drafts. It verifies that navigation does not issue mutations and that controls
fit without horizontal overflow or an inner Settings scrollbar.

No live TLI process, model, device or user store was changed by verification.
Physical phones, screen-reader applications and all theme variants have not
been exercised. Backend changes require the next normal TLI restart; frontend
organization loads on refresh. A broader redesign of other panels remains
separate work.
