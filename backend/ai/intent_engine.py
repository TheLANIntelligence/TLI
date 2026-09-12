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
from device_resolution import resolve, label, normalize, DEFAULT_ALIASES
from .status_answers import is_status_question
from action_results import driver_succeeded


# ==================================================================
#  Structured audit logger
# ==================================================================

_logger = logging.getLogger("tli.actions")


def _log_action(event: str, **kwargs) -> None:
    _logger.info(json.dumps({"event": event, **kwargs}))


# ==================================================================
#  Device alias resolver
# ==================================================================

DEVICE_ALIASES = DEFAULT_ALIASES


def resolve_device(query: str, registry: List[Dict]) -> Tuple[Optional[Dict], List[str]]:
    """Compatibility adapter; fuzzy matches are suggestions, never targets."""
    result = resolve(query, registry, DEVICE_ALIASES)
    return result.device, [label(d) for d in result.candidates]


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
    r"(?:check(?!\s+out)(?!\s+if)(?!\s+whether)|status|power(?!\s+(?:on|off)\b)|watt|energy)\s+(?:of\s+)?(?:the\s+)?(.+)",
    r"how\s+much\s+(?:power|energy|watts?)\s+(?:is|does)\s+(?:the\s+)?(.+?)(?:\s+(?:use|using|draw|drawing|consume|consuming))?",
    r"what(?:'s| is)\s+(?:the\s+)?(.+?)\s+(?:status|power|state|wattage)",
    r"what(?:'s| is)\s+(?:the\s+)?(?:status|power|state|wattage)\s+of\s+(?:the\s+)?(.+)",
]


def _shelly_status_target(text: str, registry: List[Dict]) -> Optional[str]:
    """Recognize a complete status request, not a clause inside explanation.

    Normalize only ordinary request framing. Device names/IDs still go through
    the existing resolver, including its unknown and ambiguous outcomes.
    """
    query = text.strip().lower().replace("\u2019", "'").rstrip("?!. ").strip()
    query = re.sub(r"^(?:hey|hi|hello)(?:,\s*|\s+)", "", query, count=1)
    query = re.sub(r"^(?:please[\s,]+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please[\s,]+)?", "", query, count=1)
    query = re.sub(r"(?:,\s*|\s+)please$", "", query).strip()
    for pattern in _SHELLY_STATUS_PATTERNS:
        match = re.fullmatch(pattern, query)
        if match:
            target = match.group(1).strip()
            if re.search(r"\b(?:compared\s+(?:with|to)|because|while|when|whether)\b", target):
                # A comparison/causal clause is not part of a device request.
                # Preserve explicitly named devices/aliases that happen to
                # contain these ordinary words, without accepting a substring.
                exact_names = set()
                for device in registry:
                    if not isinstance(device, dict):
                        continue
                    aliases = device.get("aliases") or []
                    aliases = [aliases] if isinstance(aliases, str) else aliases if isinstance(aliases, list) else []
                    exact_names.update(normalize(v) for v in [device.get("name"), device.get("label"),
                        device.get("id"), device.get("device_id"), *aliases,
                        *DEVICE_ALIASES.get(normalize(device.get("name")), [])] if v)
                if normalize(target) not in exact_names:
                    return None
            return target
    return None


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

    # AI readiness belongs to the read-only chat fast path, never a relay lookup.
    if is_status_question(text):
        return IntentResult.no_match()

    from intelligence.devices import with_context
    shelly_registry = with_context(shelly_registry)
    q = text.strip()
    q_lower = q.lower()

    _log_action("intent_detected", text_preview=q_lower[:80])

    # Guard: short-circuit clearly conversational messages before pattern matching
    status_target = _shelly_status_target(q, shelly_registry)
    if status_target is None and _is_conversational(q, shelly_registry):
        return IntentResult.no_match()

    # --- Diagnostic ---
    for pat in _DIAGNOSTIC_PATTERNS:
        if re.search(pat, q_lower):
            return IntentResult.matched({"type": "diagnostic"})

    # A complete read-only status request takes precedence over words inside
    # its device name, such as "Start Lamp" or "Stop Fan". Direct power on/off
    # commands are explicitly excluded by the status grammar above.
    if status_target is not None:
        resolution = resolve(status_target, shelly_registry, DEVICE_ALIASES)
        device = resolution.device
        candidates = [label(d) for d in resolution.candidates]
        if device:
            intent = {"type": "shelly_status", "target": status_target, "device": device}
            return IntentResult.matched(intent)
        _log_action("intent_failed", action="check status", target=status_target, candidates=candidates)
        return IntentResult(status="failed", error=resolution.message(status_target))

    # --- Shelly ON ---
    for pat in _SHELLY_ON_PATTERNS:
        m = re.search(pat, q_lower)
        if m:
            target = m.group(1).strip().rstrip("?!.")
            resolution = resolve(target, shelly_registry, DEVICE_ALIASES)
            device = resolution.device
            candidates = [label(d) for d in resolution.candidates]
            if device:
                intent = {"type": "shelly_control", "action": "on", "target": target, "device": device}
                return IntentResult.matched(intent)
            _log_action("intent_failed", action="turn on", target=target, candidates=candidates)
            return IntentResult(status="failed", error=resolution.message(target))

    # --- Shelly OFF ---
    for pat in _SHELLY_OFF_PATTERNS:
        m = re.search(pat, q_lower)
        if m:
            target = m.group(1).strip().rstrip("?!.")
            resolution = resolve(target, shelly_registry, DEVICE_ALIASES)
            device = resolution.device
            candidates = [label(d) for d in resolution.candidates]
            if device:
                intent = {"type": "shelly_control", "action": "off", "target": target, "device": device}
                return IntentResult.matched(intent)
            _log_action("intent_failed", action="turn off", target=target, candidates=candidates)
            return IntentResult(status="failed", error=resolution.message(target))

    # --- Shelly TOGGLE ---
    for pat in _SHELLY_TOGGLE_PATTERNS:
        m = re.search(pat, q_lower)
        if m:
            target = m.group(1).strip().rstrip("?!.")
            resolution = resolve(target, shelly_registry, DEVICE_ALIASES)
            device = resolution.device
            candidates = [label(d) for d in resolution.candidates]
            if device:
                intent = {"type": "shelly_control", "action": "toggle", "target": target, "device": device}
                return IntentResult.matched(intent)
            _log_action("intent_failed", action="toggle", target=target, candidates=candidates)
            return IntentResult(status="failed", error=resolution.message(target))

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
    ip = device.get("ip") or device.get("host") or ""
    relay = int(device.get("relay") or 0)
    name = device.get("name") or ip

    if not ip:
        return ActionResult.fail(f"Can't control **{name}** — no IP address configured.")

    try:
        r = requests.post(
            base + "shelly/relay",
            json={"ip": ip, "action": action, "relay": relay},
            timeout=_SHELLY_TIMEOUT,
        )
        elapsed = int((time.time() - t0) * 1000)

        if r.ok:
            data = r.json()
            if not driver_succeeded(data):
                return ActionResult.fail(f"Failed to control **{name}**: the device did not report success.", elapsed_ms=elapsed)
            summary = data.get("summary") if isinstance(data.get("summary"), dict) else {}
            is_on = summary.get("is_on")
            power = summary.get("power_w")

            state = "ON" if is_on else "OFF" if is_on is False else "unknown"
            pw = f" ({power:.1f}W)" if power is not None else ""

            action_past = {"on": "turned ON", "off": "turned OFF", "toggle": "toggled"}
            verb = action_past.get(action, action)

            msg = (f"**{name}** {verb} — currently {state}{pw}." if is_on is not None else
                   f"**{name}** accepted the {action} command. Current state has not been verified.")
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
    ip = device.get("ip") or device.get("host") or ""
    relay = int(device.get("relay") or 0)
    name = device.get("name") or ip

    if not ip:
        return ActionResult.fail(f"Can't check **{name}** — no IP address configured.")

    try:
        r = requests.get(
            base + "shelly/status", params={"ip": ip, "relay": relay},
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
    """Legacy cleanup intent now directs the user to explicit file review only."""
    return ActionResult.ok(
        "Open **Free Space** to choose a location and explicitly start a scan. "
        "Select individual files, review the exact paths, then choose whether to move them to Trash. "
        "No scan was started and nothing was moved or deleted. File sizes are not measured freed space.",
        data={"review_required": True, "navigate_to": "panel-visualizer", "code": "review_required"},
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
