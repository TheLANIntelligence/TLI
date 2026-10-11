"""Small real-model Builder trial against an explicitly started owned loopback server.

Uses synthetic briefs and a fresh store. Does not start a runtime or read TLI data.
The caller owns/stops the dedicated model process on port 8792.
"""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build_work" / "everyday-experience" / "model-trial"
OUT.mkdir(parents=True, exist_ok=True)
os.environ["TLI_ROOT"] = tempfile.mkdtemp(prefix="tli-builder-model-trial-")
sys.path.insert(0, str(ROOT / "backend"))
from builder import web_apps

calls = []
response_offset = len(list(OUT.glob("response-*.txt")))
def complete(messages, temperature, max_tokens):
    start = time.monotonic()
    payload = {"messages": messages, "temperature": temperature, "max_tokens": max_tokens, "stream": False}
    request = urllib.request.Request("http://127.0.0.1:8792/v1/chat/completions", data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=240) as response:
        result = json.loads(response.read(512_000))
    content = result["choices"][0]["message"]["content"]
    calls.append({"seconds": round(time.monotonic() - start, 2), "usage": result.get("usage"), "finish_reason": result["choices"][0].get("finish_reason")})
    (OUT / f"response-{response_offset + len(calls)}.txt").write_text(content, encoding="utf-8")
    return content, "Qwen2.5-3B-Instruct-Q4_K_M / isolated CPU trial"


cases = [
    ("counter", "Build a counter. An Add button with id add increments count by 1, a Reset button with id reset returns it to 0. Show count in id count, initially 0. Keep it simple and responsive. Acceptance: Add twice gives 2, Reset gives 0. Use only three plain files and no dependencies."),
    ("calculator", "Build a tip calculator with labeled numeric inputs bill and percent (ids bill and percent), Calculate button id calculate, and output id total. Total = bill * (1 + percent / 100), formatted to two decimals. Initial bill=100, percent=15. Acceptance: Calculate gives 115.00; bill=80 percent=20 gives 96.00. Keep three files small, no external resources."),
]
repair = "--repair" in sys.argv
record = {"model": "Qwen2.5-3B-Instruct-Q4_K_M", "synthetic_briefs": True, "repair": repair, "projects": [], "calls": calls}
for label, brief in cases:
    if "--only" in sys.argv and label != sys.argv[sys.argv.index("--only") + 1]:
        continue
    if repair:
        project = json.loads((OUT / f"{label}.json").read_text(encoding="utf-8"))
        web_apps._save(project, "model-trial")
        feedback = ("Independent browser test: pressing Add twice leaves #count at 0. Each click raises 'Assignment to constant variable.' Use a mutable count. Correct the checks: one click gives 1, two clicks gives 2, reset gives 0."
                    if label == "counter" else
                    "Independent browser test: initial Calculate does not show 115.00; code shows tip only instead of full bill including tip, and Calculate has no click listener. Required total is bill * (1 + percent / 100). With 100 and 15 show 115.00; with 80 and 20 show 96.00. Fix logic and wire Calculate, and ensure checks assert these exact outcomes.")
        if label == "calculator" and len(project["revisions"]) >= 3:
            feedback = "The latest version computes bill plus tip and wires Calculate, but still fails formatting. #total must contain exactly 115.00 for bill=100 percent=15 and 96.00 for bill=80 percent=20. Format the FULL TOTAL with toFixed(2), not just the tip. Preserve the rest of the app. Tests must check two decimal places. Return corrected complete files."
        if label == "calculator" and len(project["revisions"]) >= 4:
            feedback = "Browser check failed: #total actually displays 'Total: 10015.00' for 100 and 15, expected 'Total: 115.00'. The code adds numeric bill to formattedTip, which is a STRING from toFixed; + concatenates them. Add numeric bill and numeric tip first, then call toFixed(2) on that sum. Do not add bill to a formatted string. Verify both (100,15)->115.00 and (80,20)->96.00. Preserve controls and return complete corrected files."
        project = web_apps.generate_app(app_id=project["id"], owner="model-trial", expected_revision=len(project["revisions"]), feedback=feedback, complete=complete)
    else:
        project = web_apps.generate_app(brief, owner="model-trial", complete=complete)
    (OUT / f"{label}.json").write_text(json.dumps(project, indent=2), encoding="utf-8")
    record["projects"].append({"case": label, "status": project["status"], "revisions": len(project["revisions"]), "error": project["last_error"]})
    (OUT / (("repair-results-" + str(response_offset) + ".json") if repair else "results.json")).write_text(json.dumps(record, indent=2), encoding="utf-8")
    print(json.dumps(record["projects"][-1]), flush=True)
print(json.dumps({"calls": calls}), flush=True)
