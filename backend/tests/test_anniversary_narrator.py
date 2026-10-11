from narrator_policy import NarratorPolicy
from routers import dashboard_presence as dp
import event_bus


def sample(t, cpu=20, ram=40, disks=None):
    return {"probed_ts": 1000 + t, "cpu_pct": cpu, "ram_pct": ram,
            "disk_pct_by_drive": disks if disks is not None else {"C:\\": 40}}


def render(policy, t, **kw):
    return policy.render(sample(t, **kw), t, 1000 + t)


def test_short_spike_is_quiet_sustained_pressure_and_recovery_are_delayed():
    p = NarratorPolicy()
    assert render(p, 0, cpu=95)[1] == "status"
    assert render(p, 20, cpu=95)[1] == "status"
    assert render(p, 25, cpu=20)[1] == "status"
    for t in (30, 40, 50):
        assert render(p, t, cpu=95)[1] == "status"
    assert "CPU" in render(p, 60, cpu=95)[0]
    assert "CPU" in render(p, 65, cpu=20)[0]
    assert "CPU" in render(p, 90, cpu=20)[0]
    assert render(p, 95, cpu=20)[1] == "status"


def test_ram_and_disk_priority_independent_of_drive_order():
    p = NarratorPolicy()
    for t in range(0, 31, 5):
        result = render(p, t, ram=94)
    assert "RAM" in result[0]
    text, kind = render(p, 31, disks={"C:\\": 88, "D:\\": 98})
    assert "D:\\" in text and "critically" in text and kind == "alert"


def test_confirmation_lasts_ten_seconds_but_critical_disk_interrupts():
    p = NarratorPolicy()
    p.confirm("Opened Devices.", 0)
    assert render(p, 9)[1] == "confirmation"
    assert render(p, 10)[1] == "status"
    p.confirm("Opened Devices.", 11)
    assert render(p, 12, disks={"/": 97})[1] == "alert"
    assert render(p, 13)[1] == "status"


def test_event_deduplication_keys_expiry_and_critical_escalation():
    p = NarratorPolicy()
    ev = {"category": "device", "node": "one", "title": "Offline", "level": "warn"}
    def show(t, event):
        return p.render(sample(t), t, 1000 + t, event)
    assert show(0, ev)[0].startswith("Offline")
    assert show(31, ev)[1] == "status"  # no repeated message
    assert show(40, {**ev, "node": "two"})[0].startswith("Offline")
    p.confirm("Done", 41)
    assert show(42, {**ev, "level": "critical"})[1] == "alert"
    assert show(300, ev)[0].startswith("Offline")


def test_missing_stale_partial_and_failed_monitoring_never_claim_health():
    p = NarratorPolicy()
    assert "unavailable" in p.render({}, 0, 1000)[0]
    assert "stale" in p.render(sample(0), 30, 1030)[0]
    assert "unavailable" in p.render({**sample(0), "probe_error": "failed"}, 1, 1001)[0]
    assert "Some system checks" in render(p, 2, cpu=None)[0]
    assert "Some system checks" in render(p, 3, disks={})[0]


def test_monitoring_gap_does_not_count_as_sustained_pressure():
    p = NarratorPolicy()
    render(p, 0, cpu=99)
    render(p, 5, cpu=99)
    p.render(sample(5), 40, 1040)
    assert render(p, 41, cpu=99)[1] == "status"


def test_policy_ticks_on_unchanged_bands(monkeypatch):
    p = NarratorPolicy()
    monkeypatch.setattr(dp, "_narrator_policy", p)
    monkeypatch.setattr(dp, "_state", {})
    monkeypatch.setattr(dp, "_narrator", {"text": "", "type": "status", "timestamp": 0})
    now = [0]
    monkeypatch.setattr(dp.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(dp.time, "time", lambda: 1000 + now[0])
    monkeypatch.setattr(dp, "_probe_metrics", lambda: {k: v for k, v in sample(0, cpu=99).items() if k != "probed_ts"})
    monkeypatch.setattr(dp, "_score_disk_actions", lambda _: None)
    for t in range(0, 31, 5):
        now[0] = t
        dp._poll_once()
    assert "CPU" in dp._get_narrator()["text"]


def test_suppression_does_not_remove_activity_feed_events(monkeypatch):
    from collections import deque
    monkeypatch.setattr(event_bus, "_events", deque(maxlen=200))
    monkeypatch.setattr(event_bus, "_post_emit_hooks", [dp.on_event])
    monkeypatch.setattr(dp, "_narrator_policy", NarratorPolicy())
    event_bus.emit_event("device", "warn", "Offline", node="one")
    event_bus.emit_event("device", "warn", "Offline", node="one")
    assert len(event_bus.get_recent()) == 2


def test_check_ins_are_measured_and_do_not_churn_on_each_poll():
    p = NarratorPolicy()
    first = render(p, 0)
    assert "CPU 20%" in first[0]
    assert render(p, 5, cpu=25) == first
    assert render(p, 59, cpu=21) == first
    assert "Storage check" in render(p, 60)[0]
    p.confirm("Opened Devices.", 61)
    assert render(p, 69)[0] == "Opened Devices."
    assert "stale" in p.render(sample(60), 90, 1090)[0]


def test_recovery_is_announced_only_after_sustained_improvement():
    p = NarratorPolicy()
    for t in range(0, 36, 5):
        render(p, t, cpu=99)
    for t in range(40, 70, 5):
        assert render(p, t, cpu=20)[1] == "alert"
    assert "below the warning threshold for 30 seconds" in render(p, 70)[0]
    assert "below the warning" not in render(p, 100)[0]


def test_critical_disk_keeps_warning_visible_alongside_activity():
    p = NarratorPolicy()
    state = sample(0, disks={"C:\\": 98})
    message, kind = p.render(state, 0, 1000, {"title": "Storage scan finished", "category": "system"})
    assert kind == "alert" and "critically full" in message and "Storage scan finished" in message
    assert "Open Free Space" in render(p, 31, disks={"C:\\": 98})[0]


def test_warning_keeps_activity_visible_and_reports_both_resource_warnings():
    p = NarratorPolicy()
    for t in range(0, 31, 5):
        render(p, t, cpu=99, ram=98)
    event = {"title": "Device command failed", "level": "error", "category": "device"}
    text, kind = p.render(sample(31, cpu=99, ram=98), 31, 1031, event)
    assert kind == "alert" and "CPU" in text and "RAM" in text
    assert "Device command failed" in text
    text, kind = render(p, 32, disks={"C:\\": 89})
    assert "89%" in text and "Device command failed" in text
    assert "Open Free Space" in render(p, 62, disks={"C:\\": 89})[0]


def test_transient_pressure_is_observed_without_claiming_no_issues_or_alerting():
    p = NarratorPolicy()
    render(p, 0)
    text, kind = render(p, 5, cpu=99)
    assert kind == "status" and "Checking whether" in text
    assert "No issues" not in text
    assert "Checking whether" not in render(p, 10)[0]


def test_monitoring_loss_discards_old_measured_check_in():
    p = NarratorPolicy()
    assert "CPU 20%" in render(p, 0)[0]
    p.render({**sample(1), "probe_error": "failed"}, 1, 1001)
    render(p, 2, cpu=50)
    text, _ = render(p, 33, cpu=50)
    assert "CPU 20%" not in text


def test_burst_results_get_readable_turns_and_expire():
    p = NarratorPolicy()
    def event(t, title):
        return p.render(sample(t), t, 1000 + t, {"category": "ai", "title": title})[0]
    assert event(0, "Installation started").startswith("Installation started")
    assert event(1, "Installation finished").startswith("Installation started")
    assert event(8, "Another operation started").startswith("Installation finished")
    assert render(p, 16)[0].startswith("Another operation started")
    assert "Installation" not in render(p, 39)[0]


def test_burst_queue_is_bounded_and_never_overrides_confirmation_or_escalation():
    p = NarratorPolicy()
    p.confirm("Panel opened.", 0)
    for n in range(20):
        text, _ = p.render(sample(1), 1, 1001, {"title": f"Change {n}"})
        assert text == "Panel opened."
    assert len(p.pending_events) <= 8
    text, kind = p.render(sample(2), 2, 1002, {"title": "Urgent", "level": "critical"})
    assert "Urgent" in text and kind == "alert"
    assert "Change" not in render(p, 33)[0]
