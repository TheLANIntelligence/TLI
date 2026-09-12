# Anniversary follow-up: context and guided troubleshooting

Development checkpoint, 2026-09-06. This follows the awareness/dependable-actions checkpoint in `ANNIVERSARY_RELEASE.md`. No release, installation replacement, version bump, or data migration has been performed.

## Implemented groups

1. **Shared context.** A view combines existing Home Power, Shelly, cached host printers, and mesh node registries. Optional display names, aliases, and rooms live in a separate metadata file. Existing device IDs and relay targets remain unchanged. Chat intent and saved Shelly action resolution use the same overlays; old device names remain aliases. Reports and chat identify the host performing checks and do not infer the phone's location or connection quality.
2. **Guided diagnostics.** Devices has user-triggered network, resource, and selected-device checks. The network default tests host interfaces, the default route, and gateway ICMP. Explicitly enabling internet checks adds TCP to `1.1.1.1:443` and a DNS lookup for `example.com`. Selected-device checks use registered addresses and service ports; a successful connection is not presented as successful printing or device operation. Missing probes remain unavailable. Two concurrent diagnostic sessions are permitted; subprocess and TCP probes have timeouts. No repair or model process is launched by these checks.
3. **Diagnostic history.** Up to 200 reports per user are encrypted locally. Comparable reports show check-status changes. A fix becomes remembered only when the user explicitly records what they verified. “Discuss this report” attaches its evidence to chat. The existing activity feed gets a generic completion event, without private report contents.
4. **Memory controls.** Settings supports viewing, adding, editing, and forgetting facts. Both local chat paths use the same bounded retrieval adapter. Existing encrypted user facts remain in their original format. Unowned legacy device files are accessible only in the open, PIN-disabled local session; their contents are not assigned to a signed-in user by guessing ownership. Editing a legacy fact writes its encrypted replacement before removing the old text. Bundled conversation endpoints now check ownership; old `bundled-ai` conversations remain available to the open local session rather than being reassigned to an arbitrary authenticated account.
5. **Model visibility.** Settings lists the existing bundled presets and models advertised by the configured LM Studio API. Availability, selection, and vision capability are separate. LM Studio's model list is not treated as proof a model is loaded. Vision capability for an external model requires explicit user confirmation and selection. Discovery never downloads, starts, or switches a model. Text context/history has a character budget; primary system instructions and the current question are preserved, and oversized requests fail explicitly. This is a bounded text budget, not a tokenizer-exact context-window guarantee.
6. **Image troubleshooting.** Existing chat attachments are validated as JPEG/PNG, limited to 6 MB and 16 million pixels, re-encoded to remove metadata, and sent only to a healthy active bundled Vision preset or an explicitly selected available LM Studio vision model. Image requests bypass text command execution. Failures never fall back to text-only or mesh requests. Images are transient unless retention of one or seven days is requested; retained images are encrypted and individually deletable. Expired images become inaccessible immediately and are physically removed from the encrypted user image store on its next access. Image bytes are not saved in conversations. Settings lists retained images and expiry times.

## Where to find the controls

- **Devices → Device context & diagnostics:** names, aliases, rooms, checks, history, and confirmed fixes.
- **Chat → Device, report & image context:** select a device, review/clear a report, and choose image retention.
- **Settings → Memory, model capabilities & images:** memory, provider capability selection, retained-image controls.
- **Phone Companion:** “Open diagnostics, memory & image tools” opens the responsive full console. Explicit chat requests such as “check my network” work without inference. Companion's script is now served from a same-origin file because the existing CSP blocks inline JavaScript. Unpaired redirects preserve join tokens and request the full console to avoid a mobile redirect loop. The existing join-screen handler also removes its hidden class so the form becomes visible.

Both desktop and Companion stream consumers handle errors, split frames, and incomplete streams without automatically replaying requests. Companion device/scene controls check execution results. The desktop send path snapshots attachments/context and blocks overlapping submissions while routing.

## Compatibility and limits

- Existing endpoint URLs, SSE event names, registries, action formats, model settings, and encryption keys are retained. New controls use `/api/intelligence/*` and optional chat request fields. New metadata and encrypted report/image files live under `data/intelligence/`.
- Image validation adds the direct dependency `Pillow>=12.1.1`; it was already installed in the development virtual environment. Distribution environments must install the updated requirements.
- Bundled and LM Studio local chat share memory retrieval. Ordinary mesh text routing remains available. Selected local diagnostic/device context is explicitly rejected on the legacy mesh route, which cannot carry it faithfully. Images are not forwarded to mesh. Remote memory/context federation has not been added.
- Existing user facts and saved actions can be read by the previous format. Previous code ignores the new sidecar files. This does not establish a tested packaged rollback, and new metadata will not be visible in older UI code.
- Diagnostic resource samples are point-in-time evidence. ICMP filtering, closed services, absent system utilities, USB printers, and offline providers are not translated into stronger health claims.
- Retention expiry is an access restriction with deletion on next access, not a background erasure service. Forgetting a memory fact does not erase the historical report from which the user created it.

## Verification

Final backend suite: **149 passed, zero skipped**. Frontend component suites: **15 passed** (six existing anniversary regressions plus nine context/stream/Companion regressions). Syntax and whitespace checks passed. Existing dependency/API deprecation warnings remain.

Run from the repository root:

```powershell
backend\.venv\Scripts\python.exe -m pytest backend/tests/ -q
node --test frontend/tests/anniversary.test.cjs frontend/tests/intelligence.test.cjs
node --check frontend/app.js
node --check frontend/js/intelligence.js
node --check frontend/js/companion.js
```

Tests establish temporary persistence and inert integrations before application imports. New coverage includes shared alias ambiguity, relay preservation, encrypted owner-scoped histories, comparisons, confirmed-fix upserts, memory edits/deletion, legacy ownership, failed-write preservation, context bounds, model capabilities, image validation/metadata removal/expiry, image failure without execution or fallback, SSE failures, mobile entrypoint behavior, and Companion request handling. Windows/macOS/Linux gateway command construction is tested with fake subprocess results.

Browser checks used `backend/tests/anniversary_preview.py`, a disposable loopback installation with simulated diagnostic probes. Desktop report creation, confirmed fixes, report handoff to chat, memory editing/forgetting, and unavailable model reporting were exercised. The full console fit a 390 × 844 viewport without horizontal document overflow, and diagnostic chat worked with inference unavailable. An existing PIN nudge initially covered the bottom navigation and was dismissed. The existing unpaired-mesh HTTP 400 message remains visible in preview logs.

Physical devices, paired Companion hardware, real image-capable model execution, live mesh peers, macOS/Linux application startup, packaged installations, and full rollback still require validation before distribution. Automated fixtures and responsive browser checks do not establish those guarantees.
