# Direct Sonos rooms

TLI can find Sonos speakers by room name, save their connection, read their current
group and playback, and control music from **Smart home → Sonos**.
Sonos remains responsible for its music-service accounts. TLI does not need a
Home Assistant server or Sonos cloud-control account. Internet music still
depends on the music service and its existing Sonos configuration.

## Setup and use

Install the optional packages in the Python environment that runs TLI:

```powershell
cd backend
.venv\Scripts\python.exe -m pip install -r requirements-sonos.txt
```

Music control supports the project's Python 3.10 minimum. Local clip overlays
also require Python 3.11 or newer and the optional `sonos-websocket` package.
Missing packages leave ordinary TLI chat and other features available.

Keep the TLI host and speakers on the same home network. If your Sonos app
provides a UPnP privacy setting, allow it for local discovery and control.
Choose **Find speakers**. TLI checks the discovered speakers and shows their
reported room names and models. Choose **Add to TLI** on the intended speaker;
its connection details are handled automatically. No address entry is needed.
New speakers use their Sonos name/room and a volume ceiling of 35/100.
Choose **Done** to close the discovery results and use the room player.

Already saved speakers offer **Reconnect speaker**, which refreshes their
connection while preserving the saved name, room and volume ceiling. Use it after
a router assigns a different address. Manual address and enrollment configuration
fields are removed from the main UI. The authenticated enrollment API retains
manual address support for troubleshooting and custom name/room/volume limits.

Discovery checks a bounded set of responses and may report partial results.
Results expire after two minutes; choose **Find speakers** again when needed.
Discovery itself enrolls nothing and plays nothing. Adding a speaker rechecks
its identity against the selected discovery result. A changed identity or expired
result is rejected rather than selecting a different device.
Enrollment is private to the TLI owner. LAN UIDs are advertised identity, not
cryptographic proof of hardware authenticity.

While TLI is visible and browser access is verified, it automatically checks
saved Sonos connections and current playback. The dashboard shows connected,
playing, paused or unavailable rooms, with Play/Pause, a group selector and
direct volume controls.
No discovery or enrollment happens automatically: connect each intended speaker
once through **Find speakers** and **Add to TLI**.
When no speakers are saved, both the dashboard card and top player stay hidden,
including during the initial check. The empty enrollment check contacts no
speakers and stops recurring polling. Adding a speaker, reopening TLI or returning
to the app starts a fresh check. Sonos setup remains available in **Smart home**.
A user with saved speakers still sees the dashboard card if those speakers are
offline; a temporary connection failure does not turn into a setup prompt.

A compact player appears above the scrolling panels only while a room reports
**Playing**. It stays available across Dashboard, Ask TLI and other pages, with
track/source information, previous, pause, next and a volume slider. When multiple groups play,
choose the intended group in its selector. Pausing hides the compact player;
the dashboard keeps the paused room, its Play button and volume controls.
The compact player's **•••** button and the dashboard's **Manage rooms** button
open that group's full player and read its status and room volume sliders.

Both compact players show the room volume directly, or **Group** volume when
multiple verified rooms are playing together. The speaker icon toggles mute for
that room or group. Choose **2 rooms** (or the displayed room count) to expand
individual named room sliders and mute buttons, followed by Group Volume.
Release a slider, or adjust it with the keyboard, to send the change without
Apply or Confirm. The room list stays tucked away until opened; click outside
or press Escape to close it. A paused dashboard group can differ from the group
playing in the top bar, and each player's volume controls follow its own group.
If a group is incomplete, the room-count button exposes only its verified named
rooms and explains why group volume is unavailable, even when just one room can
be controlled.

Automatic checks run about every 10 seconds during playback or 20 seconds while
idle with saved speakers. Each request is a fresh, bounded,
read-only summary; it does not probe clips, favorites or volume controls. A
failed read removes the old playing claim and retries observations with backoff.
The summary deduplicates groups and isolates unavailable devices, with bounded
rotation for larger homes. Partial results are labeled on the dashboard.
No command is sent by detection, navigation, hiding the player or locking TLI.

Separate volume-only reads load the groups shown by the compact players, without
probing clips or fetching full playback status. They refresh alongside playback
checks and after an adjustment. Polls do not replace a slider while it is being
dragged or has keyboard focus. A failed volume read disables its old controls
and offers **Retry**; uncertain commands are never resent. After an individual
room adjustment, TLI rereads the displayed group rather than assuming the
command receipt still describes that group. The authenticated
`GET /api/sonos/devices/{ident}/volume-controls` endpoint returns these checked
controls and rejects enrollment or volume-ceiling changes during the read.

Lock, account changes and hidden/background pages clear the private music view
and stop its checks. Resuming requires fresh protected browser access; neither
session storage nor a PIN-disabled status alone authorizes polling. Commands
retain the existing review, exact target and single-submission protections.

Opening **Smart home** separately loads the saved room list.
**Refresh rooms** reloads that saved list. Select a room or speaker, then choose
**Refresh status** to check its playback and load the room volume sliders. The player stays hidden until a speaker
is selected. The full player has no separate continuous status polling loop.

The **Sonos groups** view is separate from playback results. Choose **Refresh
group** (or Refresh status) to see the groups reported by Sonos for your saved
speakers. The selected group and speaker are marked, the coordinator is labeled
**Group leader**, and a satellite is nested under its parent only when Sonos
explicitly reports that relationship. Matching room names do not establish a
group or a left/right surround role. Flat channel maps can report a bonded set
without identifying a parent. Invisible devices are labeled as Sonos-managed;
they are not assumed to be surrounds.

Groups show their last checked time. After a command or failed refresh, the
last-known grouping stays visible with **Refresh needed**; TLI never draws a new
group merely because a Join/Leave command was accepted. Action reviews show the
groups checked for that action, which can be a subset of all saved groups.
Unsaved speakers and changed addresses produce an incomplete group notice rather
than granting control. Groups with no saved members are omitted. Other Sonos
controllers can change grouping, and a speaker's reported topology can itself
be cached; the display is an observation, not a continuously verified live view.

The optional Home Assistant connection is collapsed below Sonos. It is not
needed for any of these direct Sonos controls.

**Play**, **Pause**, **Stop**, **Previous** and **Next** send the command on one
click, after checking the selected speaker and its current group. After a status
refresh, each logical room in the selected group has its own volume slider and
mute button, followed by **Group Volume** when multiple rooms play together.
Release a slider (or adjust it with the keyboard) to send the change immediately,
without Apply or Confirm. Dragging previews the value; TLI sends the final value
on release. Bonded surrounds and stereo partners stay under their primary room's
slider, using reported Sonos relationships rather than matching names.

Group Volume proportionally adjusts the rooms from their freshly checked levels,
keeping each within its effective ceiling and sharing any remaining increase
among rooms with headroom. It starts rooms evenly when all are at zero.
The displayed group value is the rounded average, and its maximum is the
average of the room ceilings, rounded down. A room's effective ceiling is the
lowest saved ceiling among its bonded devices. Limits and rounding can change
the final balance; TLI reads the rooms back after the adjustment.
The room mute buttons affect only that room. An unresolved or incomplete group
shows why its group control is unavailable; a selected room can still expose
its own controls when its full bonded membership is verified and enrolled.

Before the first status refresh, the selected-speaker **Apply volume**, **Mute**
and **Unmute** controls remain available. They still recheck the affected room
before acting. Play continues the room's current source, including
music selected in Spotify, AirPlay or another app. The player shows the source
reported by Sonos. When there is no playable source, start music in its app with
this Sonos room selected, or choose a Sonos favorite. Speaker checks
and network response time still apply. Controls stay disabled while a command is
pending, and an uncertain delivery is never automatically retried.

External app sessions use Sonos's local group playback API; Sonos-managed queues,
radio and other sources keep their existing transport. Neither path reloads a
track URI or replaces the queue for ordinary Play. Stop pauses an external app
session so its source remains available to resume. This local API path needs
the optional Sonos packages and Python 3.11 or newer. It checks the coordinator,
current group and bonded devices against the enrolled speakers before sending
one command; it never retries through another transport after uncertain delivery.
Sonos's self-signed local HTTPS transport follows the same trust limits as the
clip API described below.

A command acknowledgment is separate from playback: TLI says when Sonos still
reports paused/stopped, is starting playback, or could not verify the result.
An expired or disconnected external app session may need to be resumed from its
source app. TLI does not claim that every source permits every transport control.

Queue replacement, group changes and removal of a saved speaker still show a
confirmation. **Confirm** sends the reviewed command; **Cancel** clears it.
Confirmations for favorites and group changes expire after two minutes.

Same-named speakers remain separate entries; model and a stable short identifier
distinguish otherwise identical choices. Playback controls operate on the speaker's current group;
room volume and mute operate on the indicated logical room and its bonded devices.
Every group member must be
enrolled for group-affecting commands. The review includes the exact affected
rooms, parameters and current topology; changes before execution invalidate it,
including when a player click proceeds without a separate confirmation.

**Favorites**, **Group rooms** and **Recent activity** open only when requested.
Favorites lists the first 100 existing Sonos favorites. **Play favorite**
changes the current source and may replace the group's queue. TLI does not
search streaming-service catalogs or invent a URI from a song name. Join/leave
works on ordinary room groups; stereo pairs, surround bonds, alarms and system
configuration remain in the Sonos app. Join/Leave stays disabled until a current,
complete ordinary group is displayed; TLI also blocks regrouping any set with
bonded or Sonos-managed members. The backend rechecks exact members and
relationships before executing a reviewed action. Removing a saved speaker is available
inside Recent activity and requires confirmation.

## Speech and hardware

Sonos provides an output destination for TLI's separate voice service. A phone
or PC microphone is the input. This integration does not expose a Sonos built-in
microphone to TLI.

An explicit state read probes whether the speaker's local WebSocket API reports
`AUDIO_CLIP`. Announcements are gated on that capability and a fresh matching
UID. TLI never falls back to replacing music with an announcement. Beam (Gen 1)
and Play:1 are not assumed to have identical clip support; an unsupported or
unavailable Play:1 remains usable for music controls. The reported capability
does not prove an audible overlay on a particular hardware/firmware combination.

Announcement results distinguish an acknowledged scheduling request from actual
audibility or completion. Cancellation is restricted to the clip ID returned for
this owner's request. Ordinary music is never stopped as a fallback for clip
cancellation. The separate voice service supplies short-lived media URLs; the
Sonos control routes do not accept arbitrary media URLs.

The local WebSocket protocol uses the speaker's self-signed transport as the
upstream library does. Enrollment, literal LAN targeting and fresh UID checks
are application safeguards, not a claim of certificate-pinned Sonos identity.

## Receipts and recovery

TLI writes a durable pending receipt before mutating the speaker. A dropped
response is an unknown outcome, and restarting TLI never replays a recorded
request. Read state and recent receipts before choosing a new action. Distinct
physical speakers are locked across owners while an affected group operation
runs. Acknowledgment and a subsequent playback reading are recorded separately.
Group volume persists an exact per-room plan before sending the first change.
If a room rejects a command, delivery becomes uncertain, or access ends, later
rooms are not changed. Receipts retain completed, uncertain and unattempted
room outcomes; TLI never rolls back or retries an adjustment automatically.

Owner-scoped JSON records live under `data/sonos/`. Corrupt or unavailable saved
data fails closed and is retained. Request IDs are not pruned: the bounded
4,096-receipt store refuses further commands when full, instead of permitting an
old request to replay. Removing a speaker enrollment retains its command history.
TLI runs one backend process; these locks are not a multi-process coordinator.

## Acceptance

Synthetic tests cover named discovery, expiring owner-bound selections,
reconnection without losing saved settings, owner boundaries, browser authority, identity/address
changes, stale groups and favorites, exact parameters, volume ceilings, shared
speaker locks, interrupted delivery, duplicate request IDs, restart without
replay, durable-write failure, unsupported clips and scoped cancellation.
The optional real libraries are exercised against synthetic transports.

To exercise those codecs without adding optional packages to the core environment,
run these commands from the repository root. The dependency directory is an
ignored test artifact; `sys.path` is extended only for this test process.

```powershell
cd backend
.venv\Scripts\python.exe -m pip install --target ..\build_work\sonos-dependencies -r requirements-sonos.txt
.venv\Scripts\python.exe -c "import sys, pathlib, pytest; sys.path.insert(0, str(pathlib.Path('../build_work/sonos-dependencies').resolve())); raise SystemExit(pytest.main(['tests/test_sonos_service.py', '-q']))"
```

The combined actual-SPA browser fixture is
`scripts/verify_task_sonos_voice_browser.cjs`. Run it with Node and an available
Playwright installation (`NODE_PATH` can identify the bundled package directory).
It intercepts every API and injects fake microphone bytes, testing 1440/390-pixel
light/dark layouts, task review/continuation, named speaker discovery, adding and
reconnecting speakers without address entry, single-click Sonos playback and
confirmed queue replacement/group controls, reviewed and
opted-in voice turns, and blocked microphone capture during accepted or uncertain
Sonos speech. Reports and screenshots remain under `build_work/task-agent/`.

The compact player has focused lifecycle/transport tests in
`frontend/tests/sonos-player.test.cjs` and a separate intercepted-SPA fixture,
`scripts/verify_sonos_player_browser.cjs`, covering dashboard playback, the top
player across panels, group selection, one-click transport, pause/resume, direct
room/group volume, the expandable mixer, keyboard focus, stale callbacks,
private-access recovery and desktop/mobile layouts. Its reports are under
`build_work/sonos-player/`. `backend/tests/test_sonos_now_playing.py` covers the
read-only summary, identity checks, deduplication, bounded offline handling and
authority loss. `backend/tests/test_sonos_volume.py` covers volume-only reads,
bonded-room ceilings, incomplete groups and interrupted group adjustments.
These fixtures never contact speakers.

**Physical acceptance is not performed by these tests.** Before claiming a
particular Beam (Gen 1)/Play:1 setup is verified, record firmware and test:

- each speaker's current playback and volume, then one low-volume command;
- grouping and ungrouping two ordinary rooms, including a changed group before
  Run and a disconnected speaker;
- an existing favorite, with the queue-replacement effect visible;
- an overlay while local music, internet music and TV audio are playing, checking
  exact audible rooms, source/queue preservation and volume restoration;
- unsupported clips leaving music untouched, and cancellation of TLI's own clip;
- a real phone/PC microphone turn with Sonos reply, no recapture of TLI's reply,
  and the separate voice service's Stop/lock/media-expiration behavior.

For external-source acceptance, start music in Spotify with the Sonos room selected,
then check TLI Pause/Play, Stop/Play and track skipping without changing the source
or queue. Repeat for an available AirPlay sender and Sonos-managed music source;
record unsupported controls as such. Synthetic source-routing tests do not prove
audible playback on any particular firmware or provider session.

Protocol references: [SoCo](https://docs.python-soco.com/en/latest/),
[Sonos group playback](https://docs.sonos.com/reference/playback-play-groupid),
[local clip library](https://github.com/jjlawren/sonos-websocket),
[Home Assistant's Sonos compatibility notes](https://www.home-assistant.io/integrations/sonos/).
