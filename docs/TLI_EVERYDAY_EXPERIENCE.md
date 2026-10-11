# TLI everyday experience

TLI is a private, general-purpose AI for questions, learning, writing,
brainstorming, planning, coding and everyday conversation. Start by typing in
**Ask TLI**; no device, computer problem or workspace selection is required.
With a local model installed and running, general conversation works without the
internet. Model quality and installed capabilities determine what it can handle;
offline knowledge does not include live internet information.

Computer help, smart-device control and small-app creation are additional
capabilities. Expand **Connected tools** above the conversation to open one of
those workflows, or use the existing workspaces. An unsent text request can become a
computer problem or app brief; the original chat draft is retained. Attachments
and selected evidence are never silently moved into a different task.

## Help with a computer

1. Describe the symptom in Ask TLI, then open **Connected tools → Computer help**.
2. Choose the affected computer and save the problem. Review a suggested or
   available check, including which computer will measure what, then run it.
3. Use **Save report with this problem** to retain the observation and its link.
   **Ask TLI about this problem** opens the existing evidence review for chat.
4. **Record what happened**, save the outcome, and reopen the investigation if
   it recurs. Earlier reports, tried steps and the recorded outcome remain.

A report has a source and observation time. A saved reading is historical, and a
successful check does not prove the cause or claim that TLI repaired anything.
Host diagnostics and separately authorized full-peer observations keep their
existing scopes. The lightweight inference Node still supplies compute only.

## Work with Shelly and smart devices

Use **Connected tools → Smart home** to open configured controls. In ordinary chat, try:

- `List my smart devices`
- `Check Office Lamp`
- `Turn on Office Lamp`
- `Turn off Lamp in the Office`

Names, aliases and stable IDs resolve to the registered device and relay. The
host performs the operation through its authenticated device service. After a
command acknowledgement it reads state once and reports a mismatch, unavailable
reading or unknown outcome honestly. It never retries an uncertain command.
Device details also offers **Ask TLI for live state**, preparing an unsent request.

Conditional, delayed and multi-action requests point to the existing reviewed
Routines workflow. A quoted command inside a code or explanation request cannot
fall through to the old device executor. Existing feature/license rules remain.

## Build a small app

1. Write a brief in Ask TLI and choose **Connected tools → Build an app**, or open Builder directly.
2. Describe the app and concrete examples of what should work. Choose
   **Build with local AI**. New app files are stored separately from the existing
   repository editor and belong to the signed-in TLI account.
3. Review the files, open the isolated preview, and try the actual behavior.
   Run the browser smoke checks and compare with your own acceptance examples.
4. Describe a failure or improvement and use **Repair / improve**. A successful
   revision retains earlier versions. Preview or download any saved version;
   repairs start from the latest one. A failed generation retains the brief,
   feedback and previous working files for deliberate retry.

The supported output is a small HTML/CSS/JavaScript app with three files and
in-memory state. No packages, generated servers or shell commands run. Download
the ZIP to keep or develop the source elsewhere. App state resets on reload;
the saved Builder projects and version history persist on the TLI host.

Local generation uses the existing bundled/LM Studio configuration. To use a
reviewed LAN computer, select its model in Ask TLI, then explicitly enable
**Use the LAN model selected in Ask TLI** in Builder. This shares the app brief,
source and repair feedback with that computer, excluding chat history and saved
notes. Changed permissions or interrupted streams fail without local fallback.
The first LAN protocol permits up to 2,048 output tokens, so keep these apps small.

The preview has an opaque browser origin and no TLI session or device authority.
Its content policy blocks normal external resources and fetch requests. Browser
sandboxing is not a guarantee against every outgoing navigation from hostile
generated code; review source before previewing sensitive work. Model-authored
smoke checks run alongside generated code and are advisory, not independent proof
of correctness or security. TLI never labels an app finished merely for passing
those checks.

## Offline use and verification

Install models and dependencies before disconnecting the WAN. The primary host,
local model, LAN and supported local smart-device interfaces provide the offline
path. A phone browser still depends on the primary host. Cloud integrations and
internet search retain their own connectivity requirements.

`backend/tests/experience_preview.py` starts a disposable server with synthetic
hardware, a synthetic lamp and a synthetic app provider. The browser acceptance
script exercises real UI and API paths without operating household devices.
Separate real-model trials use the bundled Qwen 2.5 3B model, synthetic app briefs
and independent browser assertions. Results live under
`build_work/everyday-experience/`; they do not establish general coding accuracy.

The September 28, 2026 connected-workflow baseline passed **3,225 backend tests** and
**1,372 frontend tests**. Browser acceptance passed at desktop (1,280 px) and
phone (390 px) widths, covering the saved computer investigation and outcome,
chat lamp command with verified state, and app creation, preview, repair,
earlier-version preview and ZIP download. The final focused Builder run also
passed all 77 tests after the last generation-prompt adjustment.

The subsequent general-AI refinement changed the default welcome, conversation
starters and local-provider prompts, and made Connected tools an optional,
collapsed section. Generic image questions no longer assume troubleshooting.
The desktop/phone browser workflow passed again, including a writing starter
that stays in chat without sending or opening another task. Prompt-budget,
image, selected-computer, memory and provider-route checks passed (215 backend
tests), along with 97 relevant frontend tests. These verify integration and
routing, not the accuracy of a model's answers across arbitrary subjects.
An additional 294 focused checks passed for whole-message command recognition,
general writing/review requests through the authenticated home route, device
clarification, LAN chat and preserved storage-review behavior. Mentioning a
command inside a story, explanation or translation no longer triggers that
legacy action; explicit supported commands still use their existing handlers.

The real local `Qwen2.5-3B-Instruct-Q4_K_M` trial illustrates why preview and
repair are necessary. Both initial apps passed structural validation but failed
independent behavior checks. With explicit failure feedback and adjustments to
the generation prompt, the counter passed at revision 3 and the calculator at
revision 5. The independent checks exercised increment/reset and two distinct
bill/tip examples; they were not written by the model. These are supervised
development trials, not a first-attempt accuracy benchmark or evidence of a
general autonomous coding agent. The isolated CPU-only model server was stopped
after testing, with no change to TLI's configured model runtime.

A physical two-computer/WAN-disconnected trial and operation of an actual smart
device remain unperformed. These software checks must not be presented as those
physical acceptance results.
