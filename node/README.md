# TLI Node: share local AI compute

TLI Node lets another Windows computer supply text inference to your primary TLI.
The primary keeps your account, conversation, enabled saved notes and Shelly/device
actions. The Node receives the prepared text needed for your selected request and
streams the model's answer back. Use only a computer you trust with that text.

This first Node runs a small HTTPS service backed by **an already loaded LM Studio
model**. It does not run the full TLI interface or bundled model manager. It has no
remote setup, shell, file-transfer, process-inspection or device-action endpoints.
Setup and permission changes happen in a local terminal on the Node computer.

## Requirements

- Python 3.10 or newer and the dependencies in `node/requirements.txt`.
- LM Studio on the Node computer, with its local server enabled, a text model
  explicitly loaded, and support for `/api/v1/models` loaded-instance metadata.
  Token-protected LM Studio APIs are not supported by this version.
- Turn **Just in Time Model Loading off** in LM Studio if you require unloaded
  models to fail rather than being loaded automatically by LM Studio. TLI sends
  no load, switch or download commands, but cannot lock that external runtime.
- Updated TLI on the primary computer, with HTTPS configured for its LAN address.
- A private LAN adapter and this computer's own stable `machine-name.local`.
  New hostname Nodes bind the IPv4 listener across local adapters and advertise
  the exact HTTPS name/port through DNS-SD. Reviewed keys and certificate pins
  remain fixed when DHCP changes an adapter's address. Existing IPv4 Nodes still
  bind their original address and need that address retained.

Install dependencies and models before disconnecting from the internet. The
runtime needs the LAN and the Node's loopback model server; it does not need a
cloud account. This source package does **not** include Python, dependencies,
LM Studio, model weights, or a Windows service installer.

## Set up on Windows

Extract the Node source archive into a new application folder. Open PowerShell
there and create the dedicated environment once:

```powershell
py -3 -m venv node\.venv
.\node\.venv\Scripts\python.exe -m pip install -r node\requirements.txt
```

Choose a new state directory under your own Windows account. Keep this directory
separate from the full TLI installation and from the extracted application files.
Replace `gaming-pc.local` below with this computer's exact hostname plus `.local`
(run `hostname` to see it). Initialization covers that name with the Node's new
certificate. Names belonging to another computer are refused before state is
created. You can inspect adapters with `Get-NetIPAddress -AddressFamily IPv4`.

```powershell
$nodeState = Join-Path $env:LOCALAPPDATA 'TLI-Node'
.\TLI_Node.bat init --state-dir "$nodeState" --name "Gaming PC" --origin "https://gaming-pc.local:8444" --lm-studio-url "http://127.0.0.1:1234"
```

Initialization creates a persistent Node ID, signing identity and HTTPS
certificate. It requires an empty directory, starts no listener or model, and
grants no peer access. Subsequent commands validate the existing matching state
instead of silently creating a new identity. On Windows, the signing key is
protected for the current OS account; use the same account to run the Node.

## Pair both computers explicitly

Start the Node in its local interactive terminal:

```powershell
.\TLI_Node.bat run --state-dir "$nodeState" --pair
```

1. On the primary TLI, open **Connect device → Inference Node**, choose the
   discovered Node and request the connection. The only permission is inference.
2. Compare the entire code in the primary's browser and the Node terminal.
   Confirm the matching code on the primary and type that exact code into the
   Node terminal to approve inference there. Any other terminal input declines.
3. Return to the connection guide and check the Node's available models. Choose
   a model explicitly in Ask TLI before sending it work.

No public JSON cards need to be copied in this flow. The Node's public bootstrap
routes open only when `--pair` was requested; they exchange signed public material
and cannot approve trust. The window expires after five minutes even if terminal
input is pending. A successful local confirmation closes it to new requests;
existing signed status checks remain available until the deadline. The Node keeps
running for already reviewed inference peers afterward. Close and restart with
`--pair` to open a new window. Correct clocks are required for signed requests.

Existing or blocked trust cannot be replaced during ordinary pairing. To review
a replacement, stop the Node and restart with `run --pair --review-update`, choose
the matching replacement review on the primary, then compare and confirm the new
code on both computers. A change during that review invalidates it. Approvals
remain local to each computer; neither device can grant permission on the other.

### Advanced: manual public-card compatibility

Older installations can still use explicit public-card review:

```powershell
.\TLI_Node.bat card --state-dir "$nodeState" --out ".\gaming-pc-public.json"
```

1. On the primary TLI, open **Computers & LAN → Review computer trust**. Generate
   its public card using the primary's HTTPS LAN address and save the JSON as
   `host-public.json` on the Node computer.
2. In that same primary dialog, paste `gaming-pc-public.json`. Only the inference
   permission is available for a lightweight Node; leave it unchecked until you
   intend to share compute/context. Select it and review the card. Compare the
   identity fingerprint and HTTPS certificate SHA-256 against the values shown
   by `TLI_Node.bat card --state-dir "$nodeState"` on the Node's own screen, then
   approve the exact matching values.
3. On the Node, compare the host card's fingerprints against the primary's own
   screen. Then supply those separately compared values to the local command:

```powershell
.\TLI_Node.bat trust --state-dir "$nodeState" --card ".\host-public.json" --identity-fingerprint "HOST-IDENTITY-FROM-HOST-SCREEN" --certificate-sha256 "HOST-CERTIFICATE-SHA256-FROM-HOST-SCREEN"
.\TLI_Node.bat peers --state-dir "$nodeState"
```

The placeholder fingerprints must be replaced by their exact values. The command
checks both against the signed card before granting **inference only**. Names and
IP addresses alone never authorize a peer. The public cards contain no private
keys and may be exchanged manually; do not copy the Node's private state to the
other computer. Both machines' clocks must be correct for signed requests.

## Run and use it

If the Node is not listed, export a public connection invitation:

```powershell
.\TLI_Node.bat invitation --state-dir "$nodeState"
```

Paste it into **Connect device → Computer not listed?** on the primary. It contains
the signed public card and bounded private address hints, and grants no access.
Keep the Node running with `run --pair` for its local comparison and approval
window (or `run --pair --review-update` for a reviewed replacement). The primary
then verifies the signed model catalog and offers **Choose AI model**. The Node
retains inference-only permissions.

```powershell
.\TLI_Node.bat run --state-dir "$nodeState"
```

The Node runs in the foreground until Ctrl+C. It uses HTTPS only, with the saved
name/port and certificate. DNS-SD advertises only `inference_v1`, the actual private
adapters and its secure port; it never grants access. The public identity challenge
proves its saved signing identity before an authenticated peer sends work.
The launcher does not install a service, change firewall rules,
or download software. If Windows requests firewall access, scope it to your
private network and intended primary computer. Only one runtime may use this
state directory at a time.

On the primary, open **Ask TLI → AI: Local / current setup → List trusted
computers**. Select the Node, check its models, choose a loaded model and use it.
Checking models is explicit; its DNS-SD presence is only a route hint and does not
announce loaded models or working inference. General full-host console/observation actions do not apply
to this Node.

Your selected saved-note/history settings apply before text leaves the primary.
The primary's matching Shelly/device commands still execute there. Replies name
the inference computer/model. If the Node, model or permission becomes unavailable,
TLI reports the failure instead of silently sending context elsewhere. Interrupted
answers are not saved as completed assistant turns.

## Revoke, stop and preserve state

Inspect peer IDs with `peers`, then revoke locally:

```powershell
.\TLI_Node.bat revoke --state-dir "$nodeState" --peer-id "EXACT-HOST-NODE-ID"
```

Hostname Node advertisements refresh after adapter changes. The same reviewed
hostname, exact certificate and signed identity are required at a new IP; no
permission or trust revision is rewritten. A renamed machine, changed key or
certificate requires local review. Existing IPv4 Node markers and cards stay
unchanged; they are not silently upgraded or issued new certificates.

The runtime reads current permission state during inference; revocation does not
require restarting it. A request already sent to the local model cannot be
retracted, but further result acceptance stops when the next access check runs.
Connection cleanup can wait for its bounded current I/O call. Also revoke the
Node on the primary if you no longer intend to use it.

To update the application, stop the Node and replace application files while
retaining the separate state directory. Do not rerun `init` over existing state.
Back up that directory securely as a matching set. Missing keys, mismatched
certificates, corrupted configuration or the wrong Windows account cause startup
to fail while preserving the files. This version has no automatic identity reset,
reviewed-name migration, TLS renewal, unattended startup or recovery wizard.

## Build and verification

From the source repository, `python build_node.py` creates
`artifacts/TLI_Node_<version>.zip` using a fixed public source-file allowlist.
An existing output is never overwritten; use `--output` for a new filename.
The archive contains `node/manifest.json` with SHA-256 hashes. The build never
walks live `data/`, frontend, models or environment files. It includes only the
shared code required by this inference worker and this guide.

Automated and isolated checks do not substitute for a physical deployment trial.
Before relying on it, pair the actual two computers, ask two related questions,
check the saved conversation on the primary, test permission revocation, and
repeat with WAN disconnected but the LAN intact. Verify a safe Shelly test action
separately. No GPU performance, coding accuracy or real hardware acceptance is
claimed by the source package alone.
