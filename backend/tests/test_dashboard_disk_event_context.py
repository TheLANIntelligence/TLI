"""Synthetic mounted drives only: never inspect the host's storage."""
from types import SimpleNamespace

import ambient
import event_bus


def test_disk_events_name_the_affected_drive_in_both_title_and_body(monkeypatch):
    events = []
    monkeypatch.setattr(ambient.platform, 'system', lambda: 'Windows')
    monkeypatch.setattr(ambient, '_psutil', SimpleNamespace(disk_partitions=lambda all=False: [
        SimpleNamespace(mountpoint='C:\\', fstype='NTFS'),
        SimpleNamespace(mountpoint='L:\\', fstype='NTFS'),
    ]))
    def usage(path):
        assert path in {'C:\\', 'L:\\'}, 'Unexpected host storage access'
        used = 88 if path == 'C:\\' else 99
        return SimpleNamespace(total=100, used=used, free=100-used)
    monkeypatch.setattr(ambient.shutil, 'disk_usage', usage)
    monkeypatch.setattr(ambient.S, 'add_alert', lambda *args, **kwargs: True)
    monkeypatch.setattr(ambient.S, 'resolve_alert', lambda *args: None)
    monkeypatch.setattr(event_bus, 'emit_event', lambda *args: events.append(args))

    ambient._check_disk()

    assert len(events) == 2
    c_drive, l_drive = events
    assert 'C:\\' in c_drive[2] and 'C:\\' in c_drive[3]
    assert 'L:\\' in l_drive[2] and 'L:\\' in l_drive[3]
    assert 'C:\\' not in l_drive[3]
    assert 'no files have been changed' in l_drive[3]
