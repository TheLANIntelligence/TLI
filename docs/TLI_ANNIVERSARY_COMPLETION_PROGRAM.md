# Anniversary completion program

The user authorized pursuing the full remaining anniversary roadmap on September
8, 2026 ("conquer it all please"). This reopens parked ideas for implementation in
separate checkpoints. It does not authorize replacing live data, silently changing
the selected model, public exposure of the host, automatic household actions, or
inventing acceptance results. TLI remains a private home console.

This is the current delivery record. The earlier
[anniversary roadmap](TLI_ANNIVERSARY_ROADMAP.md) remains the historical feature
catalogue and the previous delivery remains retained. A feature is complete only
when its implementation and relevant checks are recorded; a card or help page is
not a working integration.

## Preservation baseline

- Source snapshot: `build_work/anniversary-completion/baseline/release-snapshot-jiwbqk_q`.
- 600 source files; fingerprint
  `cd5cc508c888457727c4cd6456d89b9d64810d35a8032f486f5c08fd41845f2e`.
- Snapshot contains the uncommitted working-tree source. No reset or stash.
- Fresh isolated baseline passed: backend, tooling, frontend, Companion and
  TypeScript checks. Results and logs are stored with that snapshot; no live
  inference, device actions or data were used.
- The earlier six-model comparison and sealed holdout stay historical evidence.
  Any subsequent tuning uses development questions and a new unseen holdout.

## Checkpoints and explicit completion criteria

| Checkpoint | Scope | Current state |
| --- | --- | --- |
| 1. Recorded outcomes and portable troubleshooting | Deterministic answers about supplied check completion and confirmed historical fixes; reviewed redacted exports; explicit repeat-check review and comparable reports | Implemented, including reviewed case-to-Chat context on desktop and Companion; clean integrated software checkpoint passed |
| 2. Companion beyond home Wi-Fi | Optional routed private-network setup using the existing trusted LAN origin; truthful setup and connection checks; matched phone build and physical acceptance | Software and synthetic browser/mobile checks passed; Android Beta 5 built, native tests passed and APK package/signer verified against Beta 4. Externally managed private route and physical acceptance not run |
| 3. Awareness, computers and relationships | User-selected priorities; useful observed timelines; unified details; explicit room/dependency associations; measured power history with gaps | Device details, importance, relationships, room views, account-scoped report timelines and passive Shelly meter history implemented; clean integrated software checkpoint passed |
| 4. Dependable routines and useful extensions | Reviewed routine templates and explanations; scoped MCP client/server capabilities; optional Home Assistant bridge; clear source/effect/permission review | Manual routine editor and preservation verified; scoped local MCP server and reviewed manual MCP client passed official SDK interoperability. Optional HA bridge passed synthetic transport/controller/browser checks. Previously advertised action triggers have no executor and remain inactive |
| 5. Reference and retrieval | Richer document support; optional semantic retrieval with provenance, revisions, deletion and opt-out; explicit relationships between saved facts | Reviewed PDF/DOCX extraction, explicit temporary related-note search and revision-bound note links passed backend, preservation and full-SPA browser checks. No automatic promotion of AI output to facts; live embedding quality unverified |
| 6. Models, voice and visual assistance | Validate existing model choices before runtime expansion; local push-to-talk and playback; reviewed screenshot guidance | Browser-local voice and local-only playback passed synthetic lifecycle and all-theme browser checks. Existing screenshot guidance retained. Fresh six-model blind comparison recorded: 328 received responses, two timeouts, no validated winner. Current model/default unchanged; real speech and model-quality acceptance remain open gates |
| 7. Rooms, reusable skills and bounded workflows | Optional room display; reviewed reusable steps; bounded multi-step plans with explicit scope, action previews and truthful receipts | Explicit room display and reusable troubleshooting guides passed controller and all-theme browser checks. Reviewed manual routines supply bounded executable steps separately from portable guides. No unrestricted autonomous repair, marketplace execution or hidden action activation |
| 8. Integrated anniversary delivery | Complete suites, source/package identity, synthetic preservation/recovery, full-theme and accessible browser review, matching Companion artifacts and separate device acceptance | Final frozen source passed all 27 release gates and browser review. Android Beta 5 signature and all 70 mobile source files match. Physical acceptance not run; failed model-quality gates remain visible |

## Implementation boundaries

Use the existing vanilla-JavaScript controllers, authenticated FastAPI endpoints,
encrypted storage conventions and activity contracts. Extend them where needed;
do not introduce competing runtime or action lifecycle owners. Existing panel
IDs, records, backups and configuration must remain readable.

New optional integrations are disabled until deliberately configured. Ordinary
navigation, suggestions, reconnection and view restoration do not execute tools,
send chat, upload private context or pair a device. Externally managed VPN/account
setup and physical-device tests can remain blocked while independent local work
continues; those are not software passes.

Temporary related-note indexes are derived and disposable. Source notes and
their ownership/revisions remain authoritative. **Use saved notes** off prevents
new ordinary-Chat note retrieval; separately reviewed **Related notes** searches
remain explicit and do not attach their results to Chat. New source stores
require missing-key protection and preservation support before writes are enabled.

Voice begins with explicit push-to-talk. Visual assistance begins with chosen
images. Room clients and skills must declare their supported observations/actions.
Multi-step work is bounded to an explicit plan; no silent process termination,
configuration tuning, file deletion, model switch or permission expansion.

## Verification record

The first integration snapshot contains 678 source files, fingerprint
`bbe7cc27418f8e6621e2989112240eba17437802ac8130c004dbef46381162ba`.
It passed 116 tooling and 149 Companion checks plus TypeScript. Its initial
backend run passed 2,190 checks with four failures; frontend passed 879 with
three failures. These were **new integration failures, not baseline failures**:
three follow-up fixtures still expected generation for a newly deterministic
question; one comparison fixture expected the superseded narrow result shape;
three action-panel fixtures targeted a controller now replaced by reviewed
routines. Fixtures were adapted to exercise the real preserved behavior, with
dedicated new tests retaining the deterministic and routine failure contracts.
The final clean source/package verification must supersede this checkpoint.

Independent integration review also found late unauthorized responses able to
affect a later session in device details and report review. These are corrected
with request/session invalidation tests before the final source freeze.

The first clean-install candidate (`0d0695bbe46156b58f552e0cb953d63b6faaf68f8d1615dcfcbb9f0d323a5201`)
failed its pre-test-dependency import gate: the new related-note service used
HTTPX, which existed in development test dependencies but was missing from
runtime requirements. HTTPX is now an explicit runtime dependency. This is a
fixed release defect, not a passing candidate or a pre-existing baseline failure.
The retained report is under `software-candidate/release-snapshot-q49djlt4`.

The same frozen-source full-shell sweep found no duplicate controls, unexpected
action requests or browser errors. Its reported Chat overflows were native
closed-disclosure visibility false positives, proved by a separate real-browser
regression; the visibility check was corrected without changing Chat layout.
The markup-preservation gate now records the exact eleven obsolete trigger-form
IDs replaced by the tested manual-routine workspace and still checks every
other original control ID.

The second clean candidate, fingerprint
`bdefcece680f28e7a664c4245acf044a245d6afbe0227911145895c7e8b44a3f`,
passed all **27** automated release gates. Its fresh runtime-only environment
imported successfully before test dependencies were added; 2,270 backend tests,
116 tooling tests and 2,258 extracted-package tests passed. The extracted run
omits the repository-only packaging tests and one Git-dependent previous-reader
test, which run separately in the repository. Loopback HTTPS/PIN startup,
occupied-port preservation, restart and the specified synthetic rollback/return
rehearsal passed. Full frontend, Companion, TypeScript and Android/iOS export
checks also passed. This candidate is retained under
`software-candidate-2/release-snapshot-4wh42i2e`; publication changes require the
final candidate to be verified separately.

The matching full-SPA synthetic sweep passed 190 views with zero overflow,
duplicate controls, failed sessions or changed source files. A separate evidence
audit found five earlier fixture scripts had requested `classic`, an unsupported
theme name that fell back to Emerald Light. Those screenshots do **not** establish
Classic TLI coverage. The corrected scripts assert the actual `classicTli` theme;
all five feature matrices and the Chat toggle matrix passed with actual Classic
views. The retained correction and report hashes are in
`build_work/anniversary-completion/classic-fixture-evidence-correction.json`.

Android Beta **0.1.0 (5)** is built from 70 inspected mobile source files,
fingerprint `10fa98538818f885b04cdd73e1b8ca8aa288ec15e8302070b411c109c24568e2`.
The APK's package remains `com.thelegatointelligence.companion.beta`; its verified
signer matches the retained Beta 4 artifact. Fourteen cloud native tests passed.
The new APK SHA-256 is
`05ba3ea8e8ef2985338e225da91dc3bdbb851107f430b6f91ac7f7a5754d6424`.
The exact archive, build, artifact and comparison evidence is in
`build_work/anniversary-completion/android-beta/update-verification.json`.
Update the existing Beta app without uninstalling it. Physical update, retained
pairing, interruptions and private-route access are still **not run**; signature
compatibility does not establish those results.

Checkpoint reports will distinguish implementation, automated fixtures, real
runtime/model checks, external service configuration and physical acceptance.
Keep failures and unavailable gates visible. New source after a candidate freeze
requires a new candidate; never relabel an older artifact as the new build.

## Recorded model-quality result

The fresh study evaluated six existing text presets sequentially with synthetic
data, CPU execution, four threads, a 4096-token context, a 512-token answer cap,
temperature zero and bounded requests. Each preset has 55 scored positions:
47 primary questions (including the newly sealed 24-question holdout) and eight
separate raw stress questions. All 54 additional timing-repeat requests completed.
Of the 330 scored requests, 328 returned answers; Power and Qwen3 8B each timed
out once on the whole-context-limit case. Missing answers retain null grades.

Four agents graded opaque shuffled answers before opening model attribution.
The root independently reviewed 20 overlap questions. Eleven disagreements
were explicitly adjudicated against supplied messages and the sealed rubric;
all reviews and adjudications were frozen before unblinding. There is **no
validated winner**: every candidate failed at least one required quality gate.
No model recommendation, selection or default changed.

| Preset | Grounding meets /47 | Context meets /47 | Useful next steps meets /47 | Truthful action claims meets /47 | Received /55 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Qwen2.5 Lite | 8 | 8 | 5 | 33 | 55 |
| Qwen2.5 Standard | 14 | 10 | 13 | 35 | 55 |
| Qwen2.5 Power | 19 | 16 | 14 | 32 | 54 |
| Qwen3 1.7B | 14 | 9 | 8 | 30 | 55 |
| Qwen3 4B | 20 | 19 | 11 | 35 | 55 |
| Qwen3 8B | 26 | 21 | 18 | 37 | 54 |

These are separate rubric dimensions, not an overall accuracy percentage or a
claim about arbitrary user questions. The tests assess real generated replies
to the supplied context; they do not execute production Chat's deterministic
handlers or prove that a raw failure bypasses those handlers. Current-note
attribution, unsupported historical repairs, stale observations and measurement
scope remain important model limitations. The older studies used different
questions/conditions and remain historical, not a controlled improvement claim.

The [local model comparison](../frontend/model-comparison-anniversary.html)
includes every answer, written assessment, missing result, timing, sampled memory
and host-load caveat. Its JSON SHA-256 is
`641b5b35809f93d94786c800be0d103c4b9354adb35cd08b9e5c6eb6746d1ef0`.
Model Technical details links this study while retaining earlier evidence.
Reference filenames never certify an installed file or running runtime.

## Final review corrections

The first final publication candidate, fingerprint
`a9fb9beb0215cbcca03ecc287910ea0825efd9d4e0d1bcc46e05e650488c61ab`,
passed all 27 software gates. Its retained reports remain valid for that source.
Subsequent review found stale catalogue/manual wording: Power was described as
"best quality," optional Qwen3 descriptions said no benchmark had run, and the
manual listed older RAM estimates. These descriptions were corrected without
changing preset requirements, runtime settings, model selection or the frozen
comparison questions, answers, grades and findings.

Actual onboarding review also demonstrated an initial Lite choice labeled as a
Standard download, and an enabled download button when no usable model choices
had loaded. Both are corrected: the initial button names its actual selected
preset, and unavailable, malformed or empty choices offer no download control.
Resource suggestions and the existing default are labeled separately. The model
guide now provides a keyboard-accessible scrolling table on narrow screens.

The failed visual/behavior checks and superseded candidates are retained. A
fresh final source snapshot is required for these corrections. Evaluation-input
equivalence must compare every supplied request and launch contract; the two
catalogue string edits are recorded as literal-only changes, never claimed to
be byte-identical launch source. Full masked source bytes and syntax trees must
match after exactly those reviewed substitutions, with no general whitespace
or implementation exemption.

The intervening `final-candidate-2` run completed its individual checks but was
correctly rejected by the final working-tree comparison after the onboarding
fixes changed source. Its status remains **failed**, with the source-drift reason
intact; it is not the delivered candidate. The replacement is verified from its
own snapshot and archive.

## Final matched delivery — September 8, 2026

The implemented software program is verified in
`build_work/anniversary-completion/final-candidate-3/release-snapshot-2e1l0p6a`.
Its 699-file source fingerprint is
`61db5f3fc236037a27401993a2871dee48d96aac0f4e890a26581f5b431284dd`.
All **27 release gates passed**, including final working-tree equality:

- 2,270 backend tests, 122 release-tooling tests and 2,258 extracted-package tests.
- 958 frontend tests, 149 Companion tests, TypeScript and Android/iOS exports.
- Fresh runtime-only imports before test dependencies, resolved dependency
  recording, owned loopback HTTPS/PIN restart and synthetic backup/rollback.
- 190 frozen-source browser shell views; 69 model-card and 120 onboarding/manual
  checks. The 117 static model-report checks are reused only through exact final
  HTML/JSON byte equality. The combined browser record binds 131 screenshots.

The final release report SHA-256 is
`f8dcf3c267af202132a08c121a2dd48012b8341bf7eda83c1641a00369193bf9`.
The desktop ZIP SHA-256 is
`17485b5565542a06d8de716593c51222f81932c6131c8780ab5c32af828c1e2c`.
Public version labels, model selection and defaults remain unchanged.

The final preparation proof compares all 55 requests and six launch contracts
under the new candidate's fresh Python environment, binding all 330 published
request/fixture pairs. It reports raw source inequality, permits only the two
reviewed catalogue-description literals, and records twelve receipt differences
limited to check timestamps. It does not claim the whole evaluated source is
identical or that future answers are guaranteed. The proof SHA-256 is
`8470b46194cebc6c11cbb661628774a7243e9e878d20b0cb45ff76bf40671438`.

Start with the [delivery gallery - local evidence](LOCAL_EVIDENCE.md),
which links feature views, earlier exhibits and their precise coverage scopes.
The [delivery manifest - local evidence](LOCAL_EVIDENCE.md)
binds the source, desktop archive, Android Beta 5, tests, browser evidence and
model study. The [acceptance record](TLI_ANNIVERSARY_COMPLETION_ACCEPTANCE.md)
separates these software results from remaining external gates.

This is **software verification**, not a claim that the entire roadmap has
passed every acceptance gate. Model-quality acceptance failed with no validated
winner. Physical phone update/pairing/interruption, user-configured private
routes and optional services remain **not run**. Live TLI was not restarted;
household files, devices and the running model were not used for acceptance.
