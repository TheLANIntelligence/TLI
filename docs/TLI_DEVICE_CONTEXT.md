# Computer and device context

Device details combine registered identity, user-entered importance and
relationships, cached observation times, and the current account's saved reports.
Opening a detail or room view does not discover, probe, control a device, send
chat, or attach evidence.

Names are labels. Computer IDs, device registry IDs, addresses and relay numbers
remain distinct. A removed relationship endpoint stays visibly missing. A new
device with the same name is never substituted. Rooms describe labels explicitly
entered by a user, not detected location or occupancy. Importance is a shared
host preference and neither a measured warning nor permission to act.

Relationship edits require the current shared-context revision. The backend
rejects self-links, duplicate edges and directed dependency cycles. Informational
"connected to" links may exist in both directions. A missing existing pointer can
be retained unchanged or removed. Name/room edits from older clients preserve
the additional fields; unreadable metadata cannot be overwritten as an empty
store. No data migration is performed.

The historical timeline is account-scoped, bounded to 20 displayed reports and
includes its total count. Its host/target IDs must match the saved observation.
Report failures remain unavailable; they do not become an empty history. An old
successful test or user-confirmed fix is not current health. Registry timestamps
older than 30 seconds are labeled stale, and missing timestamps remain unknown.

## Power readings

Existing Shelly status requests can retain meter fields from the requested
`switch:<relay>` component. Units follow the publisher's [Switch status
documentation](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/#status).
There is no added polling or power control. A registry binding is checked before
and after the request; changing the target prevents its result being associated
with a replacement. This does not verify the physical device's serial number.

The volatile history holds at most 32 targets and 512 received samples per target
for up to 24 hours, ending on TLI restart. Unknown readings, failed requests and
intervals without observations remain visible. Negative power values are retained
when the device reports them. The Wh value is the device's cumulative counter,
which may reset; TLI does not calculate energy consumption or savings from these
sparse readings. Other drivers remain explicitly unsupported in this view.

## Verification

- 42 focused backend checks passed across device details, guided diagnostics and
  repeat reviews.
- 51 focused backend checks passed across passive power history, details and
  existing home controls. These overlap the previous group and are not additive
  coverage totals.
- 39 focused browser-controller tests passed; device UI fixtures include all 23
  themes, small-screen layouts, dirty drafts, revision conflicts, failed refresh,
  session lock and delayed responses.
- Actual synthetic authenticated-route JSON passed three browser schema checks.
- No household device, live model or live installation was used. Physical device
  acceptance remains separate.

Artifacts are retained under `build_work/anniversary-completion/` in
`device-details-browser/`, `device-fixture/` and the shared source baseline.
