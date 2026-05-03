"""
TLI Intent-Action Engine v2

3-state intent system:
  - IntentResult.matched     → intent detected + device resolved → execute action
  - IntentResult.failed      → intent detected + device NOT found → block LLM, return clarification
  - IntentResult.no_match    → no actionable intent → safe to fall through to tools/LLM

ActionResult: never None, never raises unhandled.
"""

import logging
import re
import json
import time
import requests
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
from difflib import SequenceMatcher


# ==================================================================
#  Structured audit logger
# ==================================================================

_logger = logging.getLogger("tli.actions")


def _log_action(event: str, **kwargs) -> None:
    _logger.info(json.dumps({"event": event, **kwargs}))


# ==================================================================
#  Device alias resolver
# ==================================================================

DEVICE_ALIASES: Dict[str, List[str]] = {
    "external hdd": [
        "drive", "hard drive", "external drive", "hdd",
        "external", "usb drive", "storage drive", "backup drive",
    ],
    "charger": [
        "charger plug", "phone charger", "charging",
        "charge", "charger outlet",
    ],
}


def _similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


def resolve_device(query: str, registry: List[Dict]) -> Tuple[Optional[Dict], List[str]]:
    """
    4-stage resolution: alias exact → IP match → substring containment → fuzzy similarity.
    Returns (matched_device_or_None, list_of_all_device_names).
    """
    all_names = [d.get("name", "") for d in registry if isinstance(d, dict)]
    if not registry or not query:
        return None, all_names

    q = query.lower().strip()

    # Stage 1: alias exact match
    for canonical, aliases in DEVICE_ALIASES.items():
        if q == canonical or q in aliases:
            for dev in registry:
                if not isinstance(dev, dict):
                    continue
                if dev.get("name", "").lower().strip() == canonical:
                    _log_action("device_resolved", query=query, stage="alias", device=dev.get("name"))
                    return dev, all_names

    # Stage 2: IP exact match
    for dev in registry:
        if not isinstance(dev, dict):
            continue
        ip = dev.get("ip", "").lower().strip()
        if q == ip:
            _log_action("device_resolved", query=query, stage="ip_exact", device=dev.get("name"))
            return dev, all_names

    # Stage 3: substring containment (name exact + partial)
    best: Optional[Dict] = None
    best_score = 0.0
    for dev in registry:
        if not isinstance(dev, dict):
            continue
        name = dev.get("name", "").lower().strip()

        if q == name:
            _log_action("device_resolved", query=query, stage="name_exact", device=dev.get("name"))
            return dev, all_names

        if q in name or name in q:
            score = _similarity(q, name) + 0.2  # bonus for substring
            if score > best_score:
                best_score = score
                best = dev

    if best:
        _log_action("device_resolved", query=query, stage="substring", device=best.get("name"))
        return best, all_names

    # Stage 4: fuzzy similarity (cutoff 0.5)
    for dev in registry:
        if not isinstance(dev, dict):
            continue
        name = dev.get("name", "").lower().strip()
        score = _similarity(q, name)
        if score > best_score and score >= 0.5:
            best_score = score
            best = dev

    if best:
        _log_action("device_resolved", query=query, stage="fuzzy", device=best.get("name"))
        return best, all_names

    _log_action("device_unresolved", query=query, candidates=all_names)
    return None, all_names


# ==================================================================
#  Result dataclasses
# ==================================================================

@dataclass
class IntentResult:
    status: str  # "matched" | "failed" | "no_match"
    intent: Optional[Dict[str, Any]] = None
    error: Optional[str] = None

    @classmethod
    def matched(cls, intent: Dict[str, Any]) -> "IntentResult":
        return cls(status="matched", intent=intent)

    @classmethod
    def no_match(cls) -> "IntentResult":
        return cls(status="no_match")

    @classmethod
    def device_not_found(cls, query: str, candidates: List[str], action: str) -> "IntentResult":
        if candidates:
            listed = ", ".join(f"**{n}**" for n in candidates)
            msg = (
                f"I understood you want to {action} **{query}**, "
                f"but I don't have a device by that name.\n\n"
                f"Registered devices: {listed}.\n\n"
                f"Try using one of those names."
            )
        else:
            msg = (
                f"I understood you want to {action} **{query}**, "
                f"but no devices are registered. "
                f"Add devices from the Home Automation panel."
            )
        return cls(status="failed", error=msg)


@dataclass
class ActionResult:
    success: bool
    message: str
    data: Optional[Dict[str, Any]] = None
    elapsed_ms: int = 0

    @classmethod
    def ok(cls, message: str, data: Optional[Dict] = None, elapsed_ms: int = 0) -> "ActionResult":
        return cls(success=True, message=message, data=data, elapsed_ms=elapsed_ms)

    @classmethod
    def fail(cls, message: str, data: Optional[Dict] = None, elapsed_ms: int = 0) -> "ActionResult":
        return cls(success=False, message=message, data=data, elapsed_ms=elapsed_ms)


# ==================================================================
#  Intent detection patterns
# ==================================================================

_SHELLY_ON_PATTERNS = [
    r"turn\s+on\s+(?:the\s+)?(.+)",
    r"switch\s+on\s+(?:the\s+)?(.+)",
    r"enable\s+(?:the\s+)?(.+)",
    r"power\s+on\s+(?:the\s+)?(.+)",
    r"start\s+(?:the\s+)?(.+)",
]

_SHELLY_OFF_PATTERNS = [
    r"turn\s+off\s+(?:the\s+)?(.+)",
    r"switch\s+off\s+(?:the\s+)?(.+)",
    r"disable\s+(?:the\s+)?(.+)",
    r"power\s+off\s+(?:the\s+)?(.+)",
    r"shut\s+(?:off\s+)?(?:the\s+)?(.+)",
    r"kill\s+(?:the\s+)?(.+)",
    r"stop\s+(?:the\s+)?(.+)",
]

_SHELLY_TOGGLE_PATTERNS = [
    r"toggle\s+(?:the\s+)?(.+)",
    r"flip\s+(?:the\s+)?(.+)",
]

_SHELLY_STATUS_PATTERNS = [
    r"(?:is|are)\s+(?:the\s+)?(.+?)\s+(?:on|off|running|active)",
    r"(?:check(?!\s+out)(?!\s+if)(?!\s+whether)|status|power|watt|energy)\s+(?:of\s+)?(?:the\s+)?(.+)",
    r"how\s+much\s+(?:power|energy|watts?)\s+(?:is|does)\s+(?:the\s+)?(.+?)(?:\s+(?:use|using|draw|consuming))?",
    r"what(?:'s| is)\s+(?:the\s+)?(.+?)\s+(?:status|power|state|wattage)",
]

_TOOL_PATTERNS = {
    "sys_snapshot": [
        r"system\s+(?:info|check|snapshot|status|details)",
        r"(?:about|info)\s+(?:my|this)\s+(?:computer|pc|machine|system)",
    ],
    "sys_top_processes": [
        r"top\s+process",
        r"what(?:'s| is)\s+(?:using|eating|consuming)\s+(?:my\s+)?(?:ram|memory|cpu)",
        r"running\s+process",
    ],
    "disk_overview": [
        r"disk\s+(?:space|usage|overview|info)",
        r"(?:how\s+much\s+)?(?:storage|space)\s+(?:do\s+i\s+have|left|free|used)",
    ],
    "net_snapshot": [
        r"network\s+(?:info|status|snapshot|details)",
        r"(?:my\s+)?(?:ip|network)\s+(?:address|config)",
    ],
    "net_connectivity_diag": [
        r"(?:ping|connectivity)\s+(?:test|check|diag)",
        r"(?:am\s+i|are\s+we)\s+(?:connected|online)",
    ],
}

_CLEANUP_PATTERNS = [
    # Formal / direct
    r"free\s+(?:up\s+)?(?:some\s+)?(?:disk\s+)?space",
    r"clean\s+(?:up|out)\s+(?:my\s+)?(?:disk|drive|storage|computer|pc|files?|junk|temp)",
    r"(?:delete|remove|clear)\s+(?:my\s+)?(?:junk|temp|temporary|cache|trash|old)\s*files?",
    r"(?:clear|empty)\s+(?:my\s+)?(?:temp|temporary|cache)\s*(?:files?|folder)?",
    r"(?:reclaim|recover)\s+(?:disk\s+)?space",
    r"make\s+(?:more|some)\s+(?:disk\s+)?(?:space|room)",
    r"clean\s+(?:up\s+)?(?:my\s+)?(?:computer|pc|system)",
    r"run\s+(?:a\s+)?(?:disk\s+)?cleanup",
    r"(?:delete|remove|wipe)\s+(?:all\s+)?(?:temp|temporary)\s+files?",

    # Casual / slang — disk is full or nearly so
    r"(?:my\s+)?(?:disk|drive|storage|pc|computer|hard\s*drive|ssd)\s+is\s+"
        r"(?:full|packed|stuffed|almost full|nearly full|getting full|basically full|pretty full|maxed\s*out|bursting)",
    r"(?:running|getting)\s+(?:low|out)\s+on\s+(?:disk\s+)?(?:space|storage|room)",
    r"(?:no|not\s+enough|barely\s+any)\s+(?:disk\s+)?(?:space|storage|room)\s+(?:left|remaining|free)?",
    r"storage\s+is\s+(?:getting\s+)?(?:low|tight|full|packed|crazy|insane|ridiculous)",

    # Action-first casual phrasing
    r"(?:tidy|tidy\s+up|declutter|declutter\s+(?:my\s+)?(?:pc|computer|disk|drive|storage))",
    r"(?:get\s+rid\s+of|trash|nuke|wipe)\s+(?:the\s+)?(?:junk|garbage|clutter|old\s+stuff|crap|trash)",
    r"(?:clear|clean)\s+(?:this\s+)?(?:thing|computer|machine|beast|pc)\s+(?:up|out)",
    r"(?:do\s+(?:a\s+)?)?(?:spring\s+)?clean(?:ing)?\s+(?:on\s+)?(?:my\s+)?(?:pc|computer|disk|drive|storage)?",

    # "can you / please" prefixed casual
    r"(?:can\s+you|please|could\s+you|would\s+you)?\s*(?:just\s+)?(?:clean|clear|free)\s+(?:it|this|my\s+disk|my\s+drive|my\s+storage|stuff)",
    r"(?:can\s+you|please|could\s+you)?\s*(?:just\s+)?(?:get\s+rid\s+of|remove|delete)\s+(?:the\s+)?(?:junk|garbage|temp|clutter|old\s+files?|unnecessary\s+files?)",

    # Disk-full frustration
    r"(?:so\s+much\s+)?(?:junk|clutter|garbage|crap)\s+(?:on\s+)?(?:my\s+)?(?:pc|computer|disk|drive)",
    r"(?:i\s+)?(?:have\s+)?(?:too\s+much\s+)?(?:stuff|files?|junk)\s+(?:taking\s+up\s+)?(?:space|room)",
    r"(?:help\s+me|i\s+need\s+(?:you\s+to\s+)?)\s*(?:free\s+up|clean\s+up|make\s+(?:more\s+)?space)",

    # External / USB drive mentions
    r"(?:my\s+)?(?:external|usb|portable)\s+(?:drive|hdd|ssd|disk|hard\s*drive)\s+is\s+"
        r"(?:full|packed|almost full|nearly full|running\s+out|out\s+of\s+space)",
    r"(?:free\s+up|clean\s+up|clear\s+out|clear)\s+(?:my\s+)?(?:external|usb|portable)\s+(?:drive|disk|hdd|ssd|hard\s*drive)",
    r"(?:external|usb|portable)\s+(?:drive|disk|hdd|ssd)\s+(?:is\s+)?(?:getting\s+)?(?:full|low|packed)",
]

_DIAGNOSTIC_PATTERNS = [
    r"run\s+diagnostics?",
    r"health\s+check",
    r"check\s+all\s+systems?",
    r"(?:is|are)\s+everything\s+(?:working|ok|okay|fine|up)",
    r"system\s+health",
    r"self.?test",
    r"run\s+(?:a\s+)?(?:self.?)?check",
]


# ==================================================================
#  Conversational guard
# ==================================================================

_CONVERSATIONAL_OPENERS = [
    "hey ", "hi ", "hello", "what do you think", "can you help me",
    "tell me about", "do you know", "have you heard", "what's your ",
    "what is your ", "let's ", "lets ", "i was wondering", "i'm wondering",
    "could you ", "would you ", "i just ", "i was ", "i've been ",
    "can you ", "can you check out", "can you look at", "can you read",
    "can you analyze", "can you explain", "can you tell me",
    "please ", "could you look", "what do you ", "how do you ",
]


def _is_conversational(text: str, shelly_registry: List[Dict]) -> bool:
    """
    Returns True if the message is clearly conversational with no device control intent.
    Used to short-circuit pattern matching before it can mis-fire on casual sentences.
    """
    q = text.lower().strip()

    # Must start with a recognised conversational opener
    if not any(q.startswith(opener) for opener in _CONVERSATIONAL_OPENERS):
        return False

    # If it mentions a registered device name, it might still be a command
    for dev in shelly_registry:
        if isinstance(dev, dict):
            name = dev.get("name", "").lower()
            if name and name in q:
                return False

    # Check static device aliases
    for canonical, aliases in DEVICE_ALIASES.items():
        if canonical in q:
            return False
        for alias in aliases:
            if alias in q:
                return False

    # If the message contains actionable system keywords, don't treat it as purely conversational
    _ACTION_KEYWORDS = [
        # Cleanup / space
        "free up", "free space", "clean up", "clean out", "clean this", "clean it",
        "reclaim", "clear temp", "delete temp", "remove junk", "get rid of",
        "disk cleanup", "disk full", "disk is full", "disk is packed",
        "storage is", "running out of space", "running low on space",
        "make space", "make more space", "make room", "tidy up", "declutter",
        "no space", "not enough space", "barely any space",
        "junk files", "temp files", "garbage", "clutter",
        "spring clean", "wipe the", "nuke the",
        # Diagnostics / system
        "run diagnostics", "health check", "top process", "disk usage",
        "help me free", "help me clean", "help me make",
    ]
    if any(kw in q for kw in _ACTION_KEYWORDS):
        return False

    return True


def detect_intent(text: str, shelly_registry: List[Dict]) -> IntentResult:
    """
    Detect an actionable intent from user text.
    Returns IntentResult with status: "matched" | "failed" | "no_match".

    IMPORTANT: If a Shelly pattern matches but device resolution fails,
    returns IntentResult.failed (NOT no_match) — this locks out the LLM.
    """
    if not text:
        return IntentResult.no_match()

    q = text.strip()
    q_lower = q.lower()

    _log_action("intent_detected", text_preview=q_lower[:80])

    # Guard: short-circuit clearly conversational messages before pattern matching
    if _is_conversational(q, shelly_registry):
        return IntentResult.no_match()

    # --- Diagnostic ---
    for pat in _DIAGNOSTIC_PATTERNS:
        if re.search(pat, q_lower):
            return IntentResult.matched({"type": "diagnostic"})

    # --- Shelly ON ---
    for pat in _SHELLY_ON_PATTERNS:
        m = re.search(pat, q_lower)
        if m:
            target = m.group(1).strip().rstrip("?!.")
            device, candidates = resolve_device(target, shelly_registry)
            if device:
                intent = {"type": "shelly_control", "action": "on", "target": target, "device": device}
                return IntentResult.matched(intent)
            _log_action("intent_failed", action="turn on", target=target, candidates=candidates)
            return IntentResult.device_not_found(target, candidates, "turn on")

    # --- Shelly OFF ---
    for pat in _SHELLY_OFF_PATTERNS:
        m = re.search(pat, q_lower)
        if m:
            target = m.group(1).strip().rstrip("?!.")
            device, candidates = resolve_device(target, shelly_registry)
            if device:
                intent = {"type": "shelly_control", "action": "off", "target": target, "device": device}
                return IntentResult.matched(intent)
            _log_action("intent_failed", action="turn off", target=target, candidates=candidates)
            return IntentResult.device_not_found(target, candidates, "turn off")

    # --- Shelly TOGGLE ---
    for pat in _SHELLY_TOGGLE_PATTERNS:
        m = re.search(pat, q_lower)
        if m:
            target = m.group(1).strip().rstrip("?!.")
            device, candidates = resolve_device(target, shelly_registry)
            if device:
                intent = {"type": "shelly_control", "action": "toggle", "target": target, "device": device}
                return IntentResult.matched(intent)
            _log_action("intent_failed", action="toggle", target=target, candidates=candidates)
            return IntentResult.device_not_found(target, candidates, "toggle")

    # --- Shelly STATUS ---
    for pat in _SHELLY_STATUS_PATTERNS:
        m = re.search(pat, q_lower)
        if m:
            target = m.group(1).strip().rstrip("?!.")
            device, candidates = resolve_device(target, shelly_registry)
            if device:
                intent = {"type": "shelly_status", "target": target, "device": device}
                return IntentResult.matched(intent)
            _log_action("intent_failed", action="check status", target=target, candidates=candidates)
            return IntentResult.device_not_found(target, candidates, "check status of")

    # --- Disk cleanup ---
    for pat in _CLEANUP_PATTERNS:
        if re.search(pat, q_lower):
            return IntentResult.matched({"type": "cleanup_run"})

    # --- Tool run ---
    for tool_id, patterns in _TOOL_PATTERNS.items():
        for pat in patterns:
            if re.search(pat, q_lower):
                intent = {"type": "tool_run", "tool_id": tool_id}
                return IntentResult.matched(intent)

    return IntentResult.no_match()


# ==================================================================
#  Action execution
# ==================================================================

_SHELLY_TIMEOUT = 5
_TOOL_TIMEOUT = 15


def execute_action(base_url: str, intent: Dict[str, Any]) -> ActionResult:
    """
    Execute an action and return ActionResult (never None, never raises).
    """
    itype = intent.get("type", "")
    base = base_url.rstrip("/") + "/"
    t0 = time.time()

    try:
        if itype == "shelly_control":
            result = _exec_shelly_control(base, intent, t0)
        elif itype == "shelly_status":
            result = _exec_shelly_status(base, intent, t0)
        elif itype == "tool_run":
            result = _exec_tool_run(base, intent, t0)
        elif itype == "diagnostic":
            result = _exec_diagnostic(base, intent, t0)
        elif itype == "cleanup_run":
            result = _exec_cleanup_run(base, intent, t0)
        else:
            result = ActionResult.fail(f"Unknown action type: {itype}")

        _log_action(
            "action_executed" if result.success else "action_failed",
            type=itype,
            success=result.success,
            elapsed_ms=result.elapsed_ms,
        )
        return result

    except Exception as e:
        elapsed = int((time.time() - t0) * 1000)
        _log_action("action_exception", type=itype, error=str(e), elapsed_ms=elapsed)
        return ActionResult.fail(f"Unexpected error executing action: {e}", elapsed_ms=elapsed)


def _exec_shelly_control(base: str, intent: Dict, t0: float) -> ActionResult:
    device = intent["device"]
    action = intent["action"]
    ip = device.get("ip", "")
    name = device.get("name") or ip

    if not ip:
        return ActionResult.fail(f"Can't control **{name}** — no IP address configured.")

    try:
        r = requests.post(
            base + "shelly/relay",
            json={"ip": ip, "action": action, "relay": 0},
            timeout=_SHELLY_TIMEOUT,
        )
        elapsed = int((time.time() - t0) * 1000)

        if r.ok:
            data = r.json()
            summary = data.get("summary") or {}
            is_on = summary.get("is_on")
            power = summary.get("power_w")

            state = "ON" if is_on else "OFF" if is_on is False else "unknown"
            pw = f" ({power:.1f}W)" if power is not None else ""

            action_past = {"on": "turned ON", "off": "turned OFF", "toggle": "toggled"}
            verb = action_past.get(action, action)

            already_msg = ""
            if action == "on" and is_on is True:
                already_msg = " (was already on)"
            elif action == "off" and is_on is False:
                already_msg = " (was already off)"

            msg = f"Done. **{name}** {verb}{already_msg} — currently {state}{pw}."
            return ActionResult.ok(msg, data=summary, elapsed_ms=elapsed)
        else:
            detail = ""
            try:
                detail = r.json().get("detail", "")
            except Exception:
                detail = r.text[:200]
            return ActionResult.fail(
                f"Failed to control **{name}**: {detail or f'HTTP {r.status_code}'}",
                elapsed_ms=int((time.time() - t0) * 1000),
            )

    except requests.Timeout:
        return ActionResult.fail(
            f"**{name}** ({ip}) didn't respond within {_SHELLY_TIMEOUT} seconds. May be powered off.",
            elapsed_ms=int((time.time() - t0) * 1000),
        )
    except requests.ConnectionError:
        return ActionResult.fail(
            f"Couldn't reach **{name}** ({ip}). Check network.",
            elapsed_ms=int((time.time() - t0) * 1000),
        )


def _exec_shelly_status(base: str, intent: Dict, t0: float) -> ActionResult:
    device = intent["device"]
    ip = device.get("ip", "")
    name = device.get("name") or ip

    if not ip:
        return ActionResult.fail(f"Can't check **{name}** — no IP address configured.")

    try:
        r = requests.get(
            base + f"shelly/status?ip={ip}&relay=0",
            timeout=_SHELLY_TIMEOUT,
        )
        elapsed = int((time.time() - t0) * 1000)

        if r.ok:
            data = r.json()
            summary = data.get("summary") or {}
            is_on = summary.get("is_on")
            power = summary.get("power_w")
            voltage = summary.get("voltage_v")
            current = summary.get("current_a")
            temp = summary.get("temperature_c")

            state = "**ON**" if is_on else "**OFF**" if is_on is False else "unknown"
            parts = [f"**{name}** is {state}"]
            if power is not None:
                parts.append(f"{power:.1f}W")
            if voltage is not None:
                parts.append(f"{voltage:.1f}V")
            if current is not None:
                parts.append(f"{current:.3f}A")
            if temp is not None:
                parts.append(f"{temp:.1f}°C")

            return ActionResult.ok(" · ".join(parts), data=summary, elapsed_ms=elapsed)
        else:
            return ActionResult.fail(
                f"Couldn't reach **{name}** ({ip}).",
                elapsed_ms=int((time.time() - t0) * 1000),
            )

    except requests.Timeout:
        return ActionResult.fail(
            f"**{name}** ({ip}) didn't respond within {_SHELLY_TIMEOUT} seconds. May be powered off.",
            elapsed_ms=int((time.time() - t0) * 1000),
        )
    except requests.ConnectionError:
        return ActionResult.fail(
            f"Couldn't reach **{name}** ({ip}). Check network.",
            elapsed_ms=int((time.time() - t0) * 1000),
        )


def _exec_tool_run(base: str, intent: Dict, t0: float) -> ActionResult:
    tool_id = intent.get("tool_id", "")

    try:
        r = requests.post(
            base + "tools/run",
            json={"tool_id": tool_id},
            timeout=_TOOL_TIMEOUT,
        )
        elapsed = int((time.time() - t0) * 1000)

        if not r.ok:
            return ActionResult.fail(
                f"Tool `{tool_id}` failed with HTTP {r.status_code}.",
                elapsed_ms=elapsed,
            )

        data = r.json()
        output = data.get("output", "")

        try:
            parsed = json.loads(output) if isinstance(output, str) else output
            msg = _format_tool_output(tool_id, parsed)
        except (json.JSONDecodeError, TypeError):
            if len(output) > 500:
                output = output[:500] + "..."
            msg = f"**{tool_id}** result:\n```\n{output}\n```"

        return ActionResult.ok(msg, elapsed_ms=elapsed)

    except requests.Timeout:
        return ActionResult.fail(
            f"Tool `{tool_id}` timed out after {_TOOL_TIMEOUT} seconds.",
            elapsed_ms=int((time.time() - t0) * 1000),
        )
    except requests.ConnectionError:
        return ActionResult.fail(
            f"Couldn't reach TLI tools endpoint. Check server.",
            elapsed_ms=int((time.time() - t0) * 1000),
        )


def _exec_diagnostic(base: str, intent: Dict, t0: float) -> ActionResult:
    try:
        r = requests.get(base + "api/ai/diagnostics", timeout=30)
        elapsed = int((time.time() - t0) * 1000)
        if r.ok:
            report = r.json()
            return ActionResult.ok(_format_diagnostic_report(report), data=report, elapsed_ms=elapsed)
        return ActionResult.fail(
            f"Diagnostics endpoint returned HTTP {r.status_code}",
            elapsed_ms=int((time.time() - t0) * 1000),
        )
    except requests.Timeout:
        return ActionResult.fail("Diagnostics timed out.", elapsed_ms=int((time.time() - t0) * 1000))
    except requests.ConnectionError:
        return ActionResult.fail("Couldn't reach diagnostics endpoint.", elapsed_ms=int((time.time() - t0) * 1000))


def _exec_cleanup_run(base: str, intent: Dict, t0: float) -> ActionResult:
    """
    Run the Safe Cleanup — moves auto-safe temp/cache files to quarantine.
    Calls GET /cleanup/scan first to check what's available, then POST /cleanup/clean_safe.
    """
    _CLEANUP_TIMEOUT = 60  # cleanup can take a moment on large disks

    try:
        # Step 1: Check scan summary — see what's available to reclaim.
        scan_r = requests.get(base + "cleanup/scan", timeout=15)
        elapsed = int((time.time() - t0) * 1000)

        if not scan_r.ok:
            return ActionResult.fail(
                "I tried to scan for safe-to-delete files but the cleanup scanner returned an error. "
                "You can run it manually from the Dashboard.",
                elapsed_ms=elapsed,
            )

        scan = scan_r.json()
        auto_gb = round(scan.get("auto_cleanable_gb", 0) or 0, 2)
        total_gb = round(scan.get("total_gb", 0) or 0, 2)

        if auto_gb < 0.01:
            # Still surface connected drives even when nothing to auto-clean
            drive_note = ""
            try:
                usb_r = requests.get(base + "devices/usb", timeout=5)
                if usb_r.ok:
                    drives = (usb_r.json().get("devices") or [])
                    if drives:
                        drive_names = ", ".join(
                            f"{d.get('name', 'Drive')} ({d.get('mount_path', '?').rstrip(chr(92))})"
                            for d in drives[:6]
                        )
                        drive_note = (
                            f"\n\n📦 I can see **{len(drives)} external drive{'s' if len(drives) != 1 else ''} "
                            f"connected**: {drive_names}. "
                            f"Open **Files** to browse those drives."
                        )
            except Exception:
                pass
            return ActionResult.ok(
                f"**Scan complete** — no safe-to-remove files found right now.\n\n"
                f"Total reclaimable (including files that need manual review): **{total_gb} GB**.\n"
                f"Open the **File Visualizer** to review and manually remove those."
                + drive_note,
                elapsed_ms=elapsed,
            )

        # Step 2: Run the cleanup.
        clean_r = requests.post(base + "cleanup/clean_safe", timeout=_CLEANUP_TIMEOUT)
        elapsed = int((time.time() - t0) * 1000)

        if not clean_r.ok:
            return ActionResult.fail(
                f"Cleanup found **{auto_gb} GB** to reclaim but the cleanup run failed "
                f"(HTTP {clean_r.status_code}). Try from the Dashboard ActionCard.",
                elapsed_ms=elapsed,
            )

        receipt = clean_r.json()
        gb = round(receipt.get("gb_reclaimed", 0) or 0, 2)
        moved = receipt.get("files_moved", 0)
        failed = receipt.get("files_failed", 0)

        cats_raw = receipt.get("categories", {}) or {}
        cats_summary = ", ".join(
            f"{k.replace('_', ' ').title()} ({round(v / 1e9, 1)} GB)"
            for k, v in sorted(cats_raw.items(), key=lambda x: x[1], reverse=True)
            if v > 0
        ) if cats_raw else ""

        lines = [f"**Done. Reclaimed {gb} GB** across {moved} files — moved to quarantine (not permanently deleted)."]
        if cats_summary:
            lines.append(f"\n**Cleaned:** {cats_summary}")
        if failed:
            lines.append(f"\n⚠️ {failed} file(s) couldn't be moved (in use or locked).")
        lines.append("\nYour files are in `data/cleanup_quarantine/` if you need to recover anything.")

        # Surface connected external drives so the AI feels aware of the system
        try:
            usb_r = requests.get(base + "devices/usb", timeout=5)
            if usb_r.ok:
                usb_data = usb_r.json()
                drives = usb_data.get("devices") or []
                if drives:
                    drive_names = ", ".join(
                        f"{d.get('name', 'Drive')} ({d.get('mount_path', '?').rstrip(chr(92))})"
                        for d in drives[:6]
                    )
                    lines.append(
                        f"\n📦 I also see **{len(drives)} external drive{'s' if len(drives) != 1 else ''} connected**: "
                        f"{drive_names}. "
                        f"Open **Files** to browse or clean those drives manually."
                    )
        except Exception:
            pass

        return ActionResult.ok("\n".join(lines), elapsed_ms=elapsed)

    except requests.Timeout:
        return ActionResult.fail(
            "Cleanup is taking longer than expected. Check the Dashboard — it may still be running.",
            elapsed_ms=int((time.time() - t0) * 1000),
        )
    except requests.ConnectionError:
        return ActionResult.fail(
            "Couldn't reach the cleanup endpoint. Is TLI running?",
            elapsed_ms=int((time.time() - t0) * 1000),
        )


def _format_diagnostic_report(report: Dict) -> str:
    healthy = report.get("healthy", False)
    checks = report.get("checks") or []
    lines = ["**TLI System Diagnostics**", ""]
    for c in checks:
        icon = "✅" if c.get("ok") else "❌"
        name = c.get("name", "?")
        detail = c.get("detail", "")
        ms = c.get("ms", 0)
        lines.append(f"{icon} **{name}** — {detail} · {ms}ms")
    passing = sum(1 for c in checks if c.get("ok"))
    total = len(checks)
    lines.append("")
    lines.append("All systems operational." if healthy else f"{passing}/{total} checks passing.")
    return "\n".join(lines)


def _format_tool_output(tool_id: str, data: Dict) -> str:
    if tool_id == "sys_snapshot":
        parts = ["**System Snapshot**"]
        parts.append(f"- Host: {data.get('hostname', '?')} · {data.get('os', '?')}")
        parts.append(f"- Python: {data.get('python_version', '?')} · CPUs: {data.get('cpu_count', '?')}")
        mem = data.get("memory") or {}
        if mem:
            parts.append(f"- RAM: {mem.get('used_gb','?')}/{mem.get('total_gb','?')} GB ({mem.get('percent_used','?')}% used)")
        for d in (data.get("disks") or [])[:3]:
            parts.append(f"- Disk {d.get('mountpoint','?')}: {d.get('free_gb','?')} GB free ({d.get('percent_used','?')}% used)")
        return "\n".join(parts)

    elif tool_id == "sys_top_processes":
        procs = data.get("top_processes") or []
        if not procs:
            return "No processes found."
        lines = ["**Top processes by memory:**"]
        for p in procs[:8]:
            lines.append(f"- `{p.get('name','?')}` (PID {p.get('pid','?')}) — {p.get('memory_mb','?')} MB")
        return "\n".join(lines)

    elif tool_id == "disk_overview":
        disks = data.get("disks") or []
        if not disks:
            return "No disk info available."
        lines = ["**Disk overview:**"]
        for d in disks:
            lines.append(f"- {d.get('device','?')} → {d.get('mountpoint','?')}: {d.get('free_gb','?')} GB free ({d.get('percent_used','?')}% used)")
        return "\n".join(lines)

    elif tool_id == "net_snapshot":
        ifaces = data.get("interfaces") or {}
        if not ifaces:
            raw = data.get("raw_output", "")
            return f"**Network info:**\n```\n{raw[:400]}\n```" if raw else "No network info."
        lines = ["**Network interfaces:**"]
        for name, info in list(ifaces.items())[:6]:
            up = "UP" if info.get("is_up") else "DOWN"
            addrs = [a.get("address", "") for a in (info.get("addresses") or [])
                     if a.get("address") and ":" not in a.get("address", "x")]
            addr_str = ", ".join(addrs[:2]) if addrs else "no IPv4"
            lines.append(f"- **{name}**: {up} · {addr_str}")
        return "\n".join(lines)

    elif tool_id == "net_connectivity_diag":
        tests = data.get("tests") or []
        if not tests:
            return "No connectivity results."
        lines = ["**Connectivity check:**"]
        for t in tests:
            status = "OK" if t.get("ok") else "FAIL"
            lines.append(f"- {t.get('host','?')}: {status}")
        return "\n".join(lines)

    return f"**{tool_id}:**\n```json\n{json.dumps(data, indent=2)[:600]}\n```"
