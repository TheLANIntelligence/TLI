# Push-to-talk with the TLI host

Ask TLI includes **Talk to TLI** alongside the existing browser-local dictation
button. Hold Talk on a phone or PC, release, review the transcript, and choose
**Send reviewed message**. Opening the dialog never starts a microphone. Recording
is limited to thirty seconds. The recording is processed on the TLI host, removed
after transcription, and never sent to a cloud speech service. Text follows the
explicitly selected Chat or task model settings when you choose Send.

The optional **Send push-to-talk turns on release** checkbox sends recognized text
after transcription. It starts off and resets when the dialog closes. TLI waits
for each response and its speech before allowing another recording; there is no
always-listening microphone. The original dictation button keeps its existing behavior.

Host voice is an optional Windows feature requiring Python 3.11 or newer. Core
TLI still supports Python 3.10; existing browser-local voice is unchanged.

## Setup

1. In the TLI backend environment, install `requirements-voice.txt`.
2. Provide a preinstalled CTranslate2 faster-whisper `base.en` model directory
   containing `model.bin`, `config.json`, `tokenizer.json`, and the model's other
   required files. TLI does not download models or missing tokenizer files.
3. In **Talk to TLI → Host voice setup**, enter that directory's absolute path on
   the TLI host and save. Transcription uses CPU int8 and English.
4. For a phone browser, use HTTPS with a certificate trusted by that phone and
   unlock TLI with its PIN. Localhost also supports browser microphone access.

Completed, saved responses can be read in the browser using Windows speech from
the TLI host. If the browser blocks automatic playback, choose **Play response**.
Partial and failed answers are never spoken. Messages longer than 8,000 characters
remain available as text; they are not silently truncated into speech.
Generated audio must be a valid WAV no longer than three minutes. Browser output
keeps Talk paused until playback ends, fails, or you choose Stop, including when
the browser requires a playback gesture.

## Sonos output

Enroll a speaker through the Sonos panel, choose it in the voice dialog, and set a
volume within that speaker's configured cap. Host voice setup offers an explicit
**Enable Sonos audio sharing** action. Select a private IPv4 interface belonging to
the host and an available port (default 8766). This starts a separate temporary
HTTP media listener, not a public file server. A firewall rule may be needed for
the chosen listener; TLI does not change firewall rules automatically.

Each unguessable media URL expires after two minutes and serves only its generated
WAV clip to the enrolled speaker's IP. GET, HEAD and one byte range are supported.
No app cookies, arbitrary paths, directory browsing or uploaded recordings are
served. Listener activation is not restored on restart. Close the voice dialog to
disable it, or disable it explicitly. The listener closes when its original
session is revoked or expires.

To speak your own announcement, open **Announce a message on Sonos**, type and
review the exact message, then choose **Announce this message**. This uses local
speech directly, without sending the message to an AI model. It uses the same
speaker selection, volume cap, temporary media and cancellation rules as replies.

Announcements require the speaker's audio-clip capability. An unsupported Beam
or Play:1 remains available for its supported music controls; TLI does not replace
its music queue as an announcement fallback. Acknowledgement is shown separately
from confirmed playback. Real speaker compatibility must be checked on the
installed model and firmware.

For accepted or uncertain Sonos delivery, Talk stays paused for the generated
audio duration plus ten seconds of delivery grace, or until Stop. This is an
estimate, not confirmation that the speaker finished; wait if it is still playing.
When timing is unavailable, Stop is required before another recording.

Stop, navigation, backgrounding and locking stop recording, revoke pending audio,
and request cancellation of owned speaker clips when supported. Audio already
fetched by a speaker may continue if the device cannot cancel that clip. Stop
never issues an unrelated music-stop command.

## Validation

Automated tests use synthetic processes, audio and loopback HTTP. They cover local
model enforcement, stdin-only speech text, cancellation before processing,
revocation, owner isolation, media expiry/ranges, microphone cleanup and completed
response callbacks, output/capture separation and opt-in send-on-release turns.
They do not certify real microphone capture, model performance,
Windows voices, phone certificate trust, firewall reachability or Sonos hardware.
