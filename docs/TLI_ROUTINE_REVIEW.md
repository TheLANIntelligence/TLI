# Reviewed saved actions and routines

This checkpoint repairs preservation and execution gaps in the existing saved
action engine. It keeps `actions.json`, existing step formats and endpoint URLs.
Manual previews and run reviews are additive.

The old Automations screen offered presence, power and daily trigger definitions,
but the matching trigger executor and toggle/delete routes were absent. Stored
definitions remain retained. They do not become active during this update, and
the capability response states that fact. Existing Home Power scene operations
remain a separate controller; this change does not start its legacy loop.

The review protocol is `tli-action-review-v1`:

- `POST /actions/preview` resolves every step of an unsaved draft without saving
  or executing it.
- `GET /actions/{id}/review` reports the saved revision and exact resolved device,
  address, relay and effect of every step, with unavailable targets identified.
- `POST /actions/run/{id}` accepts optional `request_id`, `expected_revision` and
  `expected_targets` together. The backend revalidates all targets before any
  device call. Existing callers without a body remain supported.

Concurrent runs of the same saved action are guarded. Reviewed runs persist a
start receipt before device calls. A completed duplicate returns its recorded
result; a started run without a final receipt blocks replay and reports the
uncertainty. If recording the final receipt fails, the response retains actual
step results and reports `receipt_saved: false`. No action is retried automatically.

Saving supports an optional stable request identifier. Concurrent saves retain
each distinct draft and a repeated identical request does not create duplicates.
Unreadable stores or registries are never replaced with empty data. Readable old
records retain their additional fields. Reads, preview, save and execution use
the existing session authentication.

The initial backend checkpoint passed 45 preservation/review and existing
action, dashboard and previous-reader checks using fake devices and temporary
persistence. The manual routine editor and integrated software checks have
since passed; see the current [completion program](TLI_ANNIVERSARY_COMPLETION_PROGRAM.md)
and its source-bound delivery record. These are not physical automation
acceptance, and they do not activate the retained legacy trigger definitions.
