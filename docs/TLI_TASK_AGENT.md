# Work on a task

Ask TLI remains a general conversation without a selected folder. Enable **Work
on a task** for a bounded investigation/action/check loop on the primary host.
The model selects one typed action at a time and sees its actual result before
choosing the next step. The existing Builder stays separate.

## Start a task

1. Open Ask TLI and enable **Work on a task**.
2. Under **Approve a work area**, name it and enter absolute readable folders,
   one per line. Add the narrower folders where TLI may edit text. Game-location
   suggestions are discovery only; approve the specific game/mod/log folders.
3. Select the reasoning provider. Start a bundled local model first, or enter
   the exact loaded LM Studio model ID. Local endpoints must be loopback.
4. Describe the desired result in the usual composer and choose **Start task**.
5. Read the activity and receipts. A new executable/arguments/working-directory
   combination pauses for review. **Approve for this task**, then **Continue
   task**, permits that exact command to run again during repair attempts.
6. Use **Stop task** to cancel. **Saved tasks** reopens progress after a lost
   connection. A stopped/interrupted task can be deliberately continued using
   its saved evidence; approved pending effects are cleared after interruption.

Commands execute with the host account's access. Work-area folders restrict
file tools; they are not an operating-system sandbox for an approved program.
Review the executable, arguments, working directory and the code it will run.
Exact executable content and working-directory identity are checked again.
Shell strings and batch wrappers are not command inputs. Windows children run
hidden in a task Job Object and are terminated together on cancellation/timeout.

## File work and evidence

Folder listing, filename/content search, bounded reads, text creation/editing,
syntax validation, and undo use owner-scoped grants independent of Builder's
selected project. Read roots and write roots are separate. Broad system roots,
private credentials, saves, binaries, archives and launcher-managed assets are
excluded. Concrete game directories in recognized Program Files library layouts
are allowed; this does not grant access to the whole library or Windows folder.

Existing text edits require the original SHA256, preserve supported encoding and
line endings, and save reversible snapshots. Changed originals, links/junctions,
hard links, and escaped paths are refused. Undo checks the edited hash before
restoring so a later manual change is preserved. Create files within existing
approved directories; directory creation/deletion is not a file tool in this release.

Validation parses supported text/config formats without executing project code.
An approved executable is required for project checks. A passing JSON parse is
**configuration repaired**, not **game launch verified**. Tool output, logs,
webpages and saved notes are evidence, never new authorization. Tasks preserve
changed-file receipts, check results, failures and unresolved questions.

## Providers and research

Local reasoning is the default. Selected LAN reasoning uses the existing reviewed
inference grant/resource and requires the excerpt-sharing checkbox. All tools
still execute on the primary host. Provider/resource changes or failure stop the
task; there is no implicit cloud or peer fallback. History and saved-note choices
are captured at task start. Relevant bounded excerpts are shared, not a folder upload.

For optional OpenAI Responses reasoning, set `TLI_OPENAI_API_KEY` in the host
process environment before startup. Choose **OpenAI cloud**, the API model ID
(for example `gpt-6-astra`), a supported reasoning effort, and explicitly allow
context sharing. Credentials stay server-side. API access/billing is separate
from a ChatGPT subscription. There is no invented Ultra parameter. Requests use
Responses with `store: false`; the provider's own data policy still applies.
See [function calling](https://developers.openai.com/api/docs/guides/function-calling)
and [Astra settings](https://developers.openai.com/api/docs/models/gpt-6-astra).

Enable **Allow internet research** per task. Local/LAN tasks use the host's
`TLI_TASK_SEARXNG_URL` (for example a configured SearXNG instance with JSON search
enabled). Cloud tasks use Responses web search. Public page retrieval accepts
bounded HTTPS text, validates/pins public DNS destinations and retains URLs;
redirects and private destinations are refused. Research queries leave the host.

## Sonos and voice

Device-only tasks can run without a work area. Enroll speakers in **Smart
devices → Sonos** first. Task tools inspect playback and propose music/group
actions with an affected-room review. Existing Favorites require explicit queue
replacement. Spoken announcements require exact reviewed text and a supported
audio-clip capability; arbitrary media URLs are not model tools.

See [Sonos setup](TLI_SONOS.md) and [host voice setup](TLI_HOST_VOICE.md). Beam
Gen 1 and Play:1 are the intended physical acceptance targets, not certified
devices. Enrollment checks actual identities/capabilities. Unsupported clip
overlays leave current playback untouched. Phone/PC microphones provide input.

## Persistence and acceptance

Task JSON lives under `data/workspace/tasks/`; grants/snapshots are under
the owner-hashed journals in `data/task_workspaces/`. Host runs retain durable
request IDs. Refresh/reconnect never submits an action again. Effects have
receipts independently of the final chat answer. Unknown delivery pauses the
task for review; restart never automatically resumes it. A single backend
process owns execution. Keep these private runtime files out of distribution.

Automated fixtures cover a malformed mod config traced from a log, minimal
repair/validation/undo, a failing approved check followed by repair/retest,
multiple-file coding, authority revocation/path escapes/stale writes, child
process cancellation, restart/reconnect, Sonos topology/uncertain effects, and
voice/media lifecycle. Browser fixtures cover desktop/phone layouts and fake
microphone turns. They do not measure model reasoning quality or prove a real
game launch, audible speaker output, or HTTPS microphone operation.

Before claiming physical acceptance, record the installed versions, speaker
UID/model/capabilities, music/favorite/group outcomes, overlay behavior during
music, unsupported-speaker preservation, and two real HTTPS push-to-talk turns.
Check Stop, lock/navigation cleanup, echo prevention and media expiry. No such
physical acceptance is recorded by this source implementation.
