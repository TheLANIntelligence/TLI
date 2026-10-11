# Game Optimizer validation

Verified 13 September 2026 for the Simplification Release. Game Optimizer reads
hardware and existing game settings only after Analyze this PC. Get my settings
plan performs a separate, deliberate request to the reviewed provider. The
analyzed computer and inference host are displayed separately.

## Guarded advice scope

AI selects and prioritizes one to three exact quality-setting trials from a
bounded catalogue using the game, goal, hardware, observations and optional
same-game previous advice. The backend supplies all displayed current values,
provenance, suggested values, rationale and tradeoffs. It rejects arbitrary
model prose, invented settings, extra benchmark fields, duplicate/empty choices,
wrong-model replies and incomplete streams before displaying AI advice. A
failure or Stop retains the previous advice and request draft.

This deliberately limits the release to a small Low/Medium/High/Ultra vocabulary
from the existing Cyberpunk 2077, The Witcher 3 and Red Dead Redemption 2 readers.
It does not validate every version of those games' menus. Known-game dropdowns and
rendered plans visibly ask the user to confirm that each choice exists in their
game version. Visual-quality explanations identify the relevant known CPU/GPU
and reported VRAM without claiming measured performance headroom. Other games accept
user-named quality settings whose options and effects remain explicitly
unverified. Unknown current values stay unknown; the user must check that the
trial moves in the chosen goal's direction. Ray tracing, upscaling and advanced
hardware-specific toggles are outside this trial catalogue. No game settings are
applied, no FPS is measured, and no performance gain or bottleneck is claimed.

Earlier unrestricted-prose reviews of the available 3B model produced fabricated
current values and unsuitable ray-tracing/visual-quality advice despite prompt
changes. That output is not the shipped rendering path. The structural validator
was added because prompt wording alone did not meet the release requirement.

## Live answer review

Final review: **2026-09-13 20:42:16 UTC**. Already-running Integrated endpoint:
`http://127.0.0.1:8089`; `/health` and `/v1/models` were read before generation.
The served model was **Qwen2.5-3B-Instruct-Q4_K_M.gguf**. Requests used temperature
**0.25**, maximum output **250 tokens**, streaming enabled, and no supplied seed.
The runtime's fixed request model field was `local`. Context capacity was unknown;
the shared budget enforced its 12,000-character ceiling and reserved 250 output
tokens. No runtime was started or active model changed.

The production TLI API on port 8000 was unavailable (`ConnectionError`). The
review therefore called the actual games route and narrow inference adapter in
an isolated Python process with temporary TLI state, binding to the exact model
already served on port 8089. The harness replaced the production runtime manager
binding/guard; it did not demonstrate end-to-end production app startup or model
selection UI against a running API. All hardware, game values and FPS observations
below were synthetic. These are answer-quality checks, not gaming benchmarks.

| Case | Final displayed result | Assessment |
| --- | --- | --- |
| Ryzen 5 3600, GTX 1660 6 GB, 16 GB RAM, 1080p, smoother gameplay, read Shadows High | Shadow Quality High (read) -> trial Medium | Correct source value and goal direction; no ray tracing or promised 60 FPS. |
| Ryzen 7 7800X3D, RTX 4080 16 GB, 32 GB RAM, 1440p, better visuals, individual values unknown | Shadow Quality, Texture Quality, Ambient Occlusion: Unknown -> trial High, only if increasing the current value | Unknowns preserved and higher workload/frame-time tradeoff stated. |
| Missing GPU and resolution, unknown game | Requests the missing details locally | No inference; no exact setting claims. |
| Older-PC follow-up: Shadows now Medium, unchanged synthetic 38-42 FPS, different-settings selected | Crowd Density and Ambient Occlusion: Unknown -> trial Medium, only if decreasing the current value | Excludes the already-tried shadows setting and preserves uncertainty. |
| Other game: user-named Shadow detail, Texture detail, Effects detail, each High | All three High (user supplied) -> trial Medium | Each explicitly says menu options/effects are unverified. |

Four inference cases and one local clarification completed. The model selected
valid candidate IDs in every final inference case. Review times were respectively
1.02, 2.25, 0.00, 2.23 and 3.37 seconds; these are local harness observations, not
expected production latency. The small sample does not establish general model
reliability or that these trials improve real game performance.

Live LM Studio was **unavailable**: `GET http://127.0.0.1:1234/v1/models` raised
`ConnectTimeout` with a two-second connect timeout. No live LM Studio answer
quality claim is made. Exact model/endpoint binding, different-model rejection,
unavailable/incomplete responses and no fallback were covered synthetically.

Detailed synthetic requests, returned text, budgets, provider settings,
availability and source hashes are retained in
`build_work/simplification/game-answer-review-final.json`; its reproducible local
harness is `build_work/simplification/review_game_advice_final.py`. Earlier failing
prose reviews and intermediate constrained reviews remain in the same folder.

## Focused checks

- Backend: **131 passed** across `test_game_advice.py`, `test_performance.py`,
  `test_input_budget.py`, and `test_input_budget_routes.py`.
- Frontend: **31 passed** across `game-workspace.test.cjs`,
  `network-specialists.test.cjs`, and `performance-workspace.test.cjs`.
- The real SPA browser harness uses intercepted synthetic API traffic and Edge
  Chromium. Five behavior checks cover deliberate reads/inference, current-value
  overrides, provider binding, follow-up context/exclusions, failure retention,
  another game's manual controls and exclusion of foreign history. Eight layout
  checks cover populated reader/manual plans at 1440 px and populated review at
  768, 390 and 320 px in emeraldLight and midnight, with no overflow, duplicate
  IDs or JavaScript errors. It is not live-provider browser integration.

The browser harness is `scripts/verify_game_workspace_browser.cjs`. The last
report and screenshots are recorded under `build_work/simplification/game-browser/`.
Lock, navigation, cancellation and late-response tests check that private gaming
state is cleared or retained appropriately and Performance observation is not
started by opening Game Optimizer.

## Source hashes

Hashes below are the exact final live-review sources. Frontend behavior/layout
checks ran on these same files. SHA-256:

| File | Hash |
| --- | --- |
| `backend/routers/games.py` | `d2ad2634094bf9187f248ee3df0e56cb9b3e5eb37fc26991d7244f2bb1349a1a` |
| `backend/intelligence/game_plans.py` | `a6246532b81331da61d899e51afdaab54a9f28587aede9b1c599a77d40dc6790` |
| `backend/intelligence/read_only_inference.py` | `c083e6fc16f2880cf45645ac85e030303fc87407a5ae8f7fc3ac45618f3ceda8` |
| `frontend/js/tli-games.js` | `d4e006bcd3dbefa5a56aa521d0e34616270237ba6197d29e0bcbf344f6eabf0d` |
| `frontend/game-workspace.css` | `722ac2fc58642d097ee5f13fc6e81655e87c7b8a639f6b140ea60a609ecc50c6` |
