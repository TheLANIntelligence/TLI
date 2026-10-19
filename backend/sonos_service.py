"""Owner-scoped Sonos LAN controls with reviewed topology and durable no-replay receipts.

Public functions are synchronous: call from a worker thread in async routes. No
discovery, import, speaker contact or background work happens at module import.
SoCo supplies SOAP construction; our bounded transport does not follow redirects,
use proxies, subscribe to events, or retry a command. LAN UIDs are advertised
identity, not cryptographic authentication of household hardware.
"""
from __future__ import annotations

import asyncio
import copy
import hashlib
import http.client
import importlib.util
import ipaddress
import json
import os
import re
import secrets
import socket
import sys
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from xml.etree import ElementTree as ET

from fastapi import HTTPException
import tli_state as S
from sonos_local import NotSent as SonosCommandNotSent

PROTOCOL = "tli-sonos-v1"
MAX_DEVICES = 64
MAX_RECEIPTS = 4096  # Never prune IDs and accidentally permit replay.
MAX_BYTES = 2 * 1024 * 1024
REVIEW_TTL = 120
DISCOVERY_TTL = 120
DISCOVERY_SECONDS = 12
MAX_DISCOVERY_TARGETS = 8
LOCK = threading.RLock()
REVIEWS: dict = {}
DISCOVERIES: dict = {}
RUNNING: set = set()  # Stable hardware UID, across owners and current IPs.
REQUESTS: set = set()  # Reserve request IDs before potentially slow review reads.
PLAYBACK_CURSORS: dict = {}  # Read-only poll fairness; never stores playback state.
PLAYBACK_SECONDS = 10
PLAYBACK_TARGETS = 12
LOCAL = threading.local()
SLOTS = threading.BoundedSemaphore(4)
NETWORKS = tuple(ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
UID = re.compile(r"^[A-Za-z0-9_-]{5,100}$")
REQUEST = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
ACTIONS = {"play", "pause", "stop", "next", "previous", "volume", "mute", "group_volume", "group_mute", "favorite", "join", "leave", "announce", "cancel_announcement"}


def stamp():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _check(check=None):
    if check:
        check()
    if time.monotonic() > getattr(LOCAL, "deadline", float("inf")):
        raise HTTPException(504, "The Sonos operation reached its deadline. No automatic retry runs.")


@contextmanager
def _bounded(check=None):
    old = getattr(LOCAL, "deadline", None)
    admitted = old is None
    if admitted and not SLOTS.acquire(blocking=False):
        raise HTTPException(429, "Four Sonos operations are active. Retry later deliberately.")
    LOCAL.deadline = min(old or float("inf"), time.monotonic() + 24)
    try:
        _check(check)
        yield
    except (OSError, ValueError, KeyError, TypeError, ET.ParseError):
        raise HTTPException(502, "Sonos did not provide a readable response within the operation window. No automatic retry runs.") from None
    finally:
        if old is None:
            del LOCAL.deadline
        else:
            LOCAL.deadline = old
        if admitted:
            SLOTS.release()


def _ip(value):
    try:
        address = ipaddress.ip_address(value)
        if address.version != 4 or not any(address in net for net in NETWORKS):
            raise ValueError()
        return str(address)
    except (ValueError, TypeError):
        raise HTTPException(422, "Use a literal private LAN IPv4 address for the speaker.") from None


def _text(value, limit=120):
    if not isinstance(value, str) or len(value) > limit or any(ord(c) < 32 for c in value):
        raise HTTPException(422, "A Sonos name or identifier is invalid.")
    return value.strip()


def _path(owner):
    if not isinstance(owner, str) or not owner or len(owner) > 256:
        raise HTTPException(401, "A valid TLI owner is required.")
    return Path(S.DATA_DIR) / "sonos" / (hashlib.sha256(owner.encode()).hexdigest() + ".json")


def _load(owner):
    path = _path(owner)
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return {"version": 1, "devices": {}, "receipts": {}}
    except OSError:
        raise HTTPException(503, "Saved Sonos data is unavailable; it was retained.") from None
    try:
        if len(raw) > 16 * MAX_BYTES:
            raise ValueError()
        def pairs(items):
            result = {}
            for key, val in items:
                if key in result:
                    raise ValueError()
                result[key] = val
            return result
        data = json.loads(raw, object_pairs_hook=pairs)
        if data.get("version") != 1 or not isinstance(data.get("devices"), dict) or not isinstance(data.get("receipts"), dict):
            raise ValueError()
        if len(data["devices"]) > MAX_DEVICES or len(data["receipts"]) > MAX_RECEIPTS:
            raise ValueError()
        for ident, device in data["devices"].items():
            if not isinstance(device, dict) or device.get("id") != ident or not UID.fullmatch(device.get("uid", "")):
                raise ValueError()
            _ip(device["ip"])
            if type(device.get("volume_cap")) is not int or not 0 <= device["volume_cap"] <= 100:
                raise ValueError()
        return data
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError, HTTPException):
        raise HTTPException(503, "Saved Sonos data could not be read; it was retained.") from None


def _save(owner, data):
    path = _path(owner)
    temporary = path.with_suffix("." + secrets.token_hex(8) + ".tmp")
    try:
        raw = json.dumps(data, ensure_ascii=False, allow_nan=False).encode()
        if len(raw) > 16 * MAX_BYTES:
            raise HTTPException(507, "Sonos receipt storage is full. No further command was submitted.")
        path.parent.mkdir(parents=True, exist_ok=True)
        with temporary.open("xb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except OSError:
        raise HTTPException(503, "Sonos data could not be saved. Check its receipt before another action.") from None
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def availability():
    music = importlib.util.find_spec("soco") is not None
    clips = sys.version_info >= (3, 11) and importlib.util.find_spec("sonos_websocket") is not None
    return {"music": music, "clips_runtime": clips, "hardware_verified": False,
            "setup": "Install backend/requirements-sonos.txt in the TLI Python environment. Clip overlays also require Python 3.11+ and a speaker reporting AUDIO_CLIP."}


def _xml(raw):
    if isinstance(raw, str):
        raw = raw.encode()
    if len(raw) > MAX_BYTES or b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
        raise HTTPException(502, "Sonos returned unsupported XML.")
    return ET.fromstring(raw)


def _request(ip, method, path, body=None, headers=None, check=None):
    _check(check)
    if not path.startswith("/") or path.startswith("//") or any(c in path for c in "\r\n"):
        raise HTTPException(422, "Invalid Sonos request path.")
    deadline = getattr(LOCAL, "deadline", None)
    timeout = 3 if deadline is None else max(.01, min(3, deadline - time.monotonic()))
    connection = http.client.HTTPConnection(_ip(ip), 1400, timeout=timeout)
    deadline_timer = None
    try:
        connection.connect()
        _check(check)
        peer_socket = connection.sock
        def interrupt_slow_response():
            # A socket inactivity timeout alone lets a slow header/body drip
            # keep a worker indefinitely. Interrupt this exact connection.
            try:
                peer_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        remaining = getattr(LOCAL, "deadline", time.monotonic() + 4) - time.monotonic()
        deadline_timer = threading.Timer(max(.01, min(4, remaining)), interrupt_slow_response)
        deadline_timer.daemon = True
        deadline_timer.start()
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        if response.status != 200:
            raise HTTPException(502, "Sonos did not acknowledge this request. No redirect or retry ran.")
        chunks, total = [], 0
        while True:
            _check(check)
            chunk = response.read1(65536)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_BYTES:
                raise HTTPException(502, "Sonos response exceeded its size limit.")
            chunks.append(chunk)
        _check(check)
        return b"".join(chunks)
    finally:
        if deadline_timer:
            deadline_timer.cancel()
        connection.close()


def _playback_source(uri):
    """Describe the current input without exposing provider URLs or session IDs."""
    uri = uri.lower() if isinstance(uri, str) else ""
    external = uri.startswith("x-sonos-vli:")
    if external:
        kind, label = ("spotify_connect", "Spotify Connect") if ",spotify:" in uri else (
            ("airplay", "AirPlay") if ",airplay:" in uri else ("external", "External app"))
    else:
        kind, label = next(((kind, label) for prefix, kind, label in (
            ("x-sonos-htastream:", "tv", "TV"), ("x-rincon-stream:", "line_in", "Line-in"),
            ("x-file-cifs:", "library", "Music library"), ("x-sonos-spotify:", "spotify", "Spotify on Sonos"),
            ("x-rincon-queue:", "queue", "Sonos queue"), ("x-sonosapi-stream:", "radio", "Internet radio"),
            ("x-rincon-mp3radio:", "radio", "Internet radio"),
        ) if uri.startswith(prefix)), ("sonos", "Sonos music") if uri else ("none", "No source selected"))
    return {"kind": kind, "label": label, "external": external}


class SonosAdapter:
    """Thin optional SoCo codec with fixed endpoints and bounded no-retry I/O."""
    def _player(self, ip):
        try:
            from soco import SoCo
        except ImportError:
            raise HTTPException(503, "Direct Sonos control needs the optional requirements-sonos.txt packages.") from None
        return SoCo(_ip(ip))

    def soap(self, ip, service, action, args, check=None):
        instance = getattr(self._player(ip), service)
        headers, body = instance.build_command(action, args)
        root = _xml(_request(ip, "POST", instance.control_url, body.encode(), headers, check))
        answer = root.find(".//{http://schemas.xmlsoap.org/soap/envelope/}Body")
        if answer is None or len(answer) != 1 or answer[0].tag.rsplit("}", 1)[-1] != action + "Response":
            raise HTTPException(502, "Sonos returned an invalid command response.")
        return {child.tag.rsplit("}", 1)[-1]: child.text or "" for child in answer[0]}

    def identity(self, ip, check=None):
        self._player(ip)  # Missing optional dependency is reported before contact.
        root = _xml(_request(ip, "GET", "/xml/device_description.xml", check=check))
        ns = "{urn:schemas-upnp-org:device-1-0}"
        device = root.find(ns + "device")
        if device is None or "ZonePlayer" not in (device.findtext(ns + "deviceType") or ""):
            raise HTTPException(502, "This address did not identify a Sonos player.")
        uid = (device.findtext(ns + "UDN") or "").removeprefix("uuid:")
        if not UID.fullmatch(uid):
            raise HTTPException(502, "The speaker did not supply a usable stable identity.")
        return {"uid": uid, "ip": _ip(ip), "name": _text(device.findtext(ns + "roomName") or uid),
                "model": _text(device.findtext(ns + "modelName") or "Unknown"),
                "firmware": _text(device.findtext(ns + "softwareVersion") or "Unknown")}

    def topology(self, ip, check=None):
        response = self.soap(ip, "zoneGroupTopology", "GetZoneGroupState", [], check)
        root = _xml(response.get("ZoneGroupState", ""))
        groups = []
        for group in root.iter("ZoneGroup"):
            members = []
            parsed_elements = set()
            def append_member(element, parent_uid=None):
                uid = element.get("UUID", "")
                address = urlsplit(element.get("Location", ""))
                if not UID.fullmatch(uid) or address.scheme != "http" or address.port != 1400 or address.username or address.password:
                    raise HTTPException(502, "Sonos returned an invalid group member.")
                # Only actual nesting establishes a satellite's parent. Flat
                # channel maps and hidden devices must not invent that link.
                if parent_uid:
                    bond_source = "satellite"
                elif element.get("HTSatChanMapSet"):
                    bond_source = "home_theater_map"
                elif element.get("ChannelMapSet"):
                    bond_source = "channel_map"
                elif element.findall("Satellite"):
                    bond_source = "satellite_parent"
                elif element.get("Invisible") == "1":
                    bond_source = "invisible"
                else:
                    bond_source = None
                volume_members = set()
                for mapping in (element.get("ChannelMapSet"), element.get("HTSatChanMapSet")):
                    for entry in (mapping or "").split(";"):
                        if not entry:
                            continue
                        mapped_uid, separator, channels = entry.partition(":")
                        if not separator or not channels or not UID.fullmatch(mapped_uid):
                            raise HTTPException(502, "Sonos returned an invalid bonded room map.")
                        volume_members.add(mapped_uid)
                if len(volume_members) > MAX_DEVICES:
                    raise HTTPException(502, "Sonos returned an oversized bonded room map.")
                members.append({"uid": uid, "ip": _ip(address.hostname), "name": _text(element.get("ZoneName") or uid),
                                "bonded": bond_source is not None, "parent_uid": parent_uid, "bond_source": bond_source,
                                "invisible": element.get("Invisible") == "1", "volume_members": sorted(volume_members)})
                parsed_elements.add(element)
                return uid
            for element in group.findall("ZoneGroupMember"):
                parent_uid = append_member(element)
                for satellite in element.findall("Satellite"):
                    append_member(satellite, parent_uid)
            if any(e not in parsed_elements for e in group.iter() if e.tag in ("ZoneGroupMember", "Satellite")):
                raise HTTPException(502, "Sonos returned an unsupported nested group relationship.")
            if not members or len(members) > MAX_DEVICES or len({m["uid"] for m in members}) != len(members):
                raise HTTPException(502, "Sonos returned an invalid group.")
            groups.append({"coordinator": group.get("Coordinator"), "members": sorted(members, key=lambda m: m["uid"])})
        if not groups or len(groups) > MAX_DEVICES:
            raise HTTPException(502, "Sonos group topology is unavailable.")
        return groups

    def playback_reading(self, device, group, check=None):
        """Transport and track only: safe for the lightweight foreground poll."""
        coordinator = next(m for m in group["members"] if m["uid"] == group["coordinator"])
        transport = self.soap(coordinator["ip"], "avTransport", "GetTransportInfo", [("InstanceID", 0)], check)
        track = self.soap(coordinator["ip"], "avTransport", "GetPositionInfo", [("InstanceID", 0)], check)
        title, artist = "", ""
        meta = track.get("TrackMetaData")
        if meta and meta != "NOT_IMPLEMENTED":
            root = _xml(meta)
            title = root.findtext(".//{http://purl.org/dc/elements/1.1/}title") or ""
            artist = root.findtext(".//{http://purl.org/dc/elements/1.1/}creator") or root.findtext(".//{urn:schemas-upnp-org:metadata-1-0/upnp/}artist") or ""
        return {"playback": transport.get("CurrentTransportState", "UNKNOWN"), "source": _playback_source(track.get("TrackURI")),
                "title": str(title)[:500], "artist": str(artist)[:500], "position": str(track.get("RelTime", ""))[:24]}

    def reading(self, device, group, check=None):
        playback = self.playback_reading(device, group, check)
        volume = self.soap(device["ip"], "renderingControl", "GetVolume", [("InstanceID", 0), ("Channel", "Master")], check)
        mute = self.soap(device["ip"], "renderingControl", "GetMute", [("InstanceID", 0), ("Channel", "Master")], check)
        return {**playback, "volume": int(volume["CurrentVolume"]), "muted": mute.get("CurrentMute") == "1"}

    def favorites(self, ip, check=None):
        from soco.data_structures import to_didl_string
        from soco.data_structures_entry import from_didl_string
        data = self.soap(ip, "contentDirectory", "Browse", [("ObjectID", "FV:2"), ("BrowseFlag", "BrowseDirectChildren"),
            ("Filter", "*"), ("StartingIndex", 0), ("RequestedCount", 100), ("SortCriteria", "")], check)
        raw = data.get("Result", "")
        _xml(raw) if raw else None
        rows = []
        for item in from_didl_string(raw) if raw else []:
            nested = getattr(item, "resource_meta_data", None)
            if not isinstance(nested, str) or len(nested) > 131072:
                raise HTTPException(502, "Sonos favorite metadata is unavailable or too large.")
            _xml(nested)  # Validate nested XML before SoCo parses the reference.
            reference = item.reference
            uri = reference.get_uri()
            # A favorite's resMD omits <res>. SoCo transfers the favorite's
            # resources into reference; serialize that playable item as SoCo's
            # own add_to_queue implementation does.
            meta = to_didl_string(reference)
            if not isinstance(uri, str) or not isinstance(meta, str) or len(uri) > 8192 or len(meta) > 131072:
                raise HTTPException(502, "Sonos favorite metadata is too large.")
            rows.append({"id": _text(item.item_id), "name": _text(item.title, 500), "uri": uri, "meta": meta,
                         "queue": not (uri.startswith(("x-sonosapi-stream:", "x-rincon-mp3radio:", "x-rincon-stream:")) or reference.item_class.startswith("object.item.audioItem.audioBroadcast"))})
        return rows[:100]

    def volume_reading(self, device, check=None):
        args = [("InstanceID", 0), ("Channel", "Master")]
        volume = self.soap(device["ip"], "renderingControl", "GetVolume", args, check)
        mute = self.soap(device["ip"], "renderingControl", "GetMute", args, check)
        return {"volume": int(volume["CurrentVolume"]), "muted": mute.get("CurrentMute") == "1"}

    def perform(self, device, group, action, params, favorite=None, check=None):
        target = next(m for m in group["members"] if m["uid"] == group["coordinator"])
        base = [("InstanceID", 0)]
        if action in {"play", "pause", "stop", "next", "previous"}:
            try:
                media = self.soap(target["ip"], "avTransport", "GetMediaInfo", base, check)
            except HTTPException as error:
                raise SonosCommandNotSent(error.status_code, error.detail) from None
            except Exception:
                raise SonosCommandNotSent(502, "Could not read the current Sonos source. No playback command was sent. Refresh status and try again.") from None
            if _playback_source(media.get("CurrentURI"))["external"]:
                # Spotify Connect/AirPlay own a virtual input, not the Sonos
                # queue. Use its group playback API without loading a URI,
                # taking over the queue, or retrying through another transport.
                from sonos_local import perform
                return perform(device, group, action, lambda: _check(check))
            return self.soap(target["ip"], "avTransport", action.capitalize(), base + ([("Speed", "1")] if action == "play" else []), check)
        if action in {"volume", "mute"}:
            field = "DesiredVolume" if action == "volume" else "DesiredMute"
            value = params["volume"] if action == "volume" else int(params["muted"])
            return self.soap(device["ip"], "renderingControl", "SetVolume" if action == "volume" else "SetMute", base + [("Channel", "Master"), (field, value)], check)
        if action == "join":
            return self.soap(device["ip"], "avTransport", "SetAVTransportURI", base + [("CurrentURI", "x-rincon:" + params["coordinator_uid"]), ("CurrentURIMetaData", "")], check)
        if action == "leave":
            return self.soap(device["ip"], "avTransport", "BecomeCoordinatorOfStandaloneGroup", base, check)
        if action == "favorite":
            if favorite["queue"]:
                self.soap(target["ip"], "avTransport", "RemoveAllTracksFromQueue", base, check)
                self.soap(target["ip"], "avTransport", "AddURIToQueue", base + [("EnqueuedURI", favorite["uri"]), ("EnqueuedURIMetaData", favorite["meta"]), ("DesiredFirstTrackNumberEnqueued", 0), ("EnqueueAsNext", 0)], check)
                uri, metadata = "x-rincon-queue:" + target["uid"] + "#0", ""
            else:
                uri, metadata = favorite["uri"], favorite["meta"]
            self.soap(target["ip"], "avTransport", "SetAVTransportURI", base + [("CurrentURI", uri), ("CurrentURIMetaData", metadata)], check)
            return self.soap(target["ip"], "avTransport", "Play", base + [("Speed", "1")], check)
        if action == "announce":
            return _clip(device, "play", params, check)
        if action == "cancel_announcement":
            return _clip(device, "cancel", params, check)
        raise HTTPException(422, "Unsupported Sonos operation.")


ADAPTER = SonosAdapter()


def _clip(device, operation, params=None, check=None):
    """Use the upstream protocol, overriding its built-in automatic retries."""
    if not availability()["clips_runtime"]:
        if operation == "probe":
            return {"supported": False, "state": "runtime_unavailable"}
        raise HTTPException(503, "Clip overlays require optional Sonos packages on Python 3.11+.")
    async def run():
        import aiohttp
        from sonos_websocket import SonosWebsocket
        from sonos_websocket.exception import Unsupported
        class Once(SonosWebsocket):
            async def send_command(self, command, options=None):
                _check(check)
                if not self.ws or self.ws.closed:
                    await self.connect()
                _check(check)
                await self.ws.send_json([command, options or {}])
                message = await asyncio.wait_for(self.ws.receive(), 4)
                if not isinstance(message.data, (str, bytes)) or len(message.data) > MAX_BYTES:
                    raise ValueError("Invalid clip response")
                result = message.json()
                if not isinstance(result, list) or len(result) != 2 or not isinstance(result[0], dict) or not isinstance(result[1], dict):
                    raise ValueError("Invalid clip response")
                _check(check)
                return result
        trace = aiohttp.TraceConfig()
        async def reject_redirect(*_):
            # aiohttp fires this before following a redirect. Keep even the
            # read-only handshake on the exact enrolled speaker endpoint.
            raise HTTPException(502, "The Sonos clip endpoint redirected. Nothing was forwarded.")
        trace.on_request_redirect.append(reject_redirect)
        session = aiohttp.ClientSession(trace_configs=[trace], trust_env=False,
                                       timeout=aiohttp.ClientTimeout(total=8, connect=4, sock_read=4))
        client = Once(_ip(device["ip"]), session=session, timeout=4)
        try:
            # This read checks AUDIO_CLIP instead of bypassing it with player_id.
            player_id = await client.get_player_id()
            if player_id != device["uid"]:
                raise HTTPException(409, "The Sonos clip endpoint identity changed.")
            if operation == "probe":
                return {"supported": True, "state": "advertised", "hardware_verified": False}
            _check(check)
            if operation == "play":
                # Upstream play_clip omits a zero volume; always send the exact
                # reviewed value, and never inherit a louder current volume.
                response, data = await client.send_command(
                    {"namespace": "audioClip:1", "command": "loadAudioClip", "playerId": player_id},
                    {"name": "TLI speech", "appId": "com.thelegatointelligence.tli", "streamUrl": params["url"], "volume": params["volume"]})
            else:
                response, data = await client.cancel_clip(params["clip_id"])
            if response.get("success") is not True:
                return {"rejected": True, "summary": "The speaker rejected the clip. Music playback was not replaced."}
            return {"clip_id": data.get("id") or data.get("audioClipId"), "clip_state": "scheduled" if operation == "play" else "cancellation_acknowledged"}
        except Unsupported:
            if operation == "probe":
                return {"supported": False, "state": "unsupported"}
            raise HTTPException(422, "This speaker does not advertise clip overlays. Music will not be interrupted.") from None
        finally:
            try:
                await asyncio.wait_for(client.close(), 3)
            finally:
                await session.close()
    try:
        return asyncio.run(asyncio.wait_for(run(), 16))
    except HTTPException:
        raise
    except Exception:
        if operation == "probe":
            return {"supported": False, "state": "unavailable"}
        raise


def list_devices(owner):
    with LOCK:
        rows = list(_load(owner)["devices"].values())
    return {"ok": True, "protocol": PROTOCOL, "devices": rows, "availability": availability(), "live": False}


def resolve_target(owner, text):
    query = " ".join(_text(text, 256).casefold().split())
    rows = list_devices(owner)["devices"]
    matches = [d for d in rows if query in {str(d.get(key, "")).casefold() for key in ("id", "uid", "name", "room")} or query == (d["name"] + " in " + d["room"]).casefold()]
    if len(matches) != 1:
        raise HTTPException(409 if matches else 404, "Several Sonos speakers match; select an exact speaker ID." if matches else "No enrolled Sonos speaker matches that name or ID.")
    return matches[0]


def _device(owner, ident):
    with LOCK:
        device = _load(owner)["devices"].get(ident)
    if not device:
        raise HTTPException(404, "This Sonos speaker is not enrolled for the current owner.")
    return device


def _discovery_hints(check=None):
    """SSDP addresses are bounded hints, never speaker identity or enrollment."""
    found = set()
    packet = b'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n'
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(.2)
        _check(check)
        sock.sendto(packet, ("239.255.255.250", 1900))
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and len(found) < MAX_DISCOVERY_TARGETS:
            _check(check)
            try:
                packet, source = sock.recvfrom(8192)
            except socket.timeout:
                continue
            try:
                ip = _ip(source[0])
                headers = dict(line.split(":", 1) for line in packet.decode("ascii").split("\r\n")[1:] if ":" in line)
                location = urlsplit(next(v.strip() for k, v in headers.items() if k.lower() == "location"))
                if location.hostname == ip and location.port == 1400 and location.scheme == "http" and not location.username:
                    found.add(ip)
            except (HTTPException, ValueError, UnicodeError, StopIteration):
                continue
    _check(check)
    return sorted(found)


def discover(owner, check=None):
    _path(owner)
    _check(check)
    if not availability()["music"]:
        raise HTTPException(503, "Finding Sonos speakers needs the optional requirements-sonos.txt packages.")
    with _bounded(check):
        LOCAL.deadline = min(LOCAL.deadline, time.monotonic() + DISCOVERY_SECONDS)
        hints = _discovery_hints(check)
        partial = len(hints) >= MAX_DISCOVERY_TARGETS
        verified = {}
        for address in hints[:MAX_DISCOVERY_TARGETS]:
            if check:
                check()
            if time.monotonic() >= LOCAL.deadline:
                partial = True
                break
            try:
                info = ADAPTER.identity(_ip(address), check)
                _check(check)
                if not UID.fullmatch(info.get("uid", "")) or info.get("ip") != address:
                    raise HTTPException(502, "Sonos identity did not match the discovered endpoint.")
                # Repeat multicast advertisements and multiple interfaces must
                # produce one choice for the reported stable speaker UID.
                verified.setdefault(info["uid"], info)
            except HTTPException as error:
                if error.status_code not in {422, 502, 503, 504}:
                    raise
                partial = True
            except (OSError, ValueError, TypeError, KeyError, ET.ParseError):
                partial = True
        # A timed-out candidate may leave a useful partial result. Authority is
        # still checked before publishing; no further network request is made.
        if check:
            check()
        with LOCK:
            owned = {d["uid"]: d for d in _load(owner)["devices"].values()}
            for key, value in list(DISCOVERIES.items()):
                if value["expires"] < time.time():
                    del DISCOVERIES[key]
            candidates = []
            for uid, info in verified.items():
                if len(DISCOVERIES) >= 256:
                    partial = True
                    break
                discovery_id = secrets.token_hex(24)
                existing = owned.get(uid)
                DISCOVERIES[discovery_id] = {"owner": owner, "uid": uid, "ip": info["ip"],
                    "expires": time.time() + DISCOVERY_TTL, "used": False}
                candidates.append({"discovery_id": discovery_id, "name": existing["name"] if existing else info["name"],
                    "room": existing["room"] if existing else info["name"], "model": info["model"],
                    "already_enrolled": bool(existing), "device_id": existing["id"] if existing else None})
        if check:
            check()
        return {"ok": True, "protocol": PROTOCOL, "candidates": candidates, "enrolled": False,
                "partial": partial, "expires_in_seconds": DISCOVERY_TTL, "verified_candidates": len(candidates)}


def enroll(owner, ip=None, name="", room="", volume_cap=35, check=None, discovery_id=None):
    if type(volume_cap) is not int or not 0 <= volume_cap <= 100:
        raise HTTPException(422, "Volume ceiling must be an integer from 0 to 100.")
    name, room = _text(name), _text(room)
    with _bounded(check):
        discovery = None
        if discovery_id is not None:
            if ip is not None or name or room or volume_cap != 35:
                raise HTTPException(422, "Choose a discovered speaker without address or metadata overrides.")
            with LOCK:
                _check(check)
                discovery = DISCOVERIES.get(discovery_id) if isinstance(discovery_id, str) else None
                if not discovery or discovery["owner"] != owner or discovery["expires"] < time.time() or discovery["used"]:
                    raise HTTPException(409, "This discovered speaker expired, was selected, or belongs to another owner. Find speakers again.")
                discovery["used"] = True
                ip = discovery["ip"]
        info = ADAPTER.identity(_ip(ip), check)
        if discovery and info["uid"] != discovery["uid"]:
            raise HTTPException(409, "The speaker changed since it was found. Find speakers again; nothing was enrolled.")
        ident = "sonos-" + hashlib.sha256(info["uid"].encode()).hexdigest()[:20]
        row = {**info, "id": ident, "name": name or info["name"], "room": room, "volume_cap": volume_cap, "enrolled_at": stamp(), "revision": secrets.token_hex(16)}
        with LOCK:
            _check(check)
            data = _load(owner)
            if info["uid"] in RUNNING:
                raise HTTPException(409, "This speaker has an active command. Enrollment was not changed.")
            if ident not in data["devices"] and len(data["devices"]) >= MAX_DEVICES:
                raise HTTPException(409, "The Sonos enrollment limit has been reached.")
            if discovery:
                existing = data["devices"].get(ident)
                if existing:
                    # Finding an existing speaker refreshes its address without
                    # discarding the user's names, room or volume restriction.
                    for key in ("name", "room", "volume_cap", "enrolled_at"):
                        row[key] = existing[key]
                else:
                    row["room"] = info["name"]
            data["devices"][ident] = row
            _save(owner, data)
        _check(check)
        return {"ok": True, "protocol": PROTOCOL, "device": row}


def remove(owner, ident, check=None):
    with LOCK:
        _check(check)
        data = _load(owner)
        device = data["devices"].get(ident)
        if device and device["uid"] in RUNNING:
            raise HTTPException(409, "Wait for the active Sonos command before removing this speaker.")
        data["devices"].pop(ident, None)
        _save(owner, data)
    return {"ok": True, "protocol": PROTOCOL}


def _group(device, groups):
    matches = [g for g in groups if any(m["uid"] == device["uid"] and m["ip"] == device["ip"] for m in g["members"])]
    if len(matches) != 1 or not any(m["uid"] == matches[0]["coordinator"] for m in matches[0]["members"]):
        raise HTTPException(409, "Speaker identity or group topology changed; read it again.")
    return matches[0]


def _current(owner, ident, check=None):
    device = _device(owner, ident)
    identity = ADAPTER.identity(device["ip"], check)
    if identity["uid"] != device["uid"]:
        raise HTTPException(409, "A different speaker now uses that address. Enroll the intended speaker again.")
    groups = ADAPTER.topology(device["ip"], check)
    _check(check)
    if _device(owner, ident) != device:
        raise HTTPException(409, "Sonos enrollment changed during this request.")
    return device, groups, _group(device, groups)


def _verify_members(owner, members, check=None):
    """Never contact a topology-supplied endpoint without its owner's enrollment."""
    owned = {d["uid"]: d for d in list_devices(owner)["devices"]}
    for member in members:
        row = owned.get(member["uid"])
        if not row or row["ip"] != member["ip"]:
            raise HTTPException(409, "Enroll every affected room and its current address before controlling this group.")
        _check(check)
        if ADAPTER.identity(row["ip"], check)["uid"] != row["uid"]:
            raise HTTPException(409, "An affected speaker address now belongs to another device. Nothing was sent.")
    return owned


def _public_topology(owner, groups):
    """Owner enrollment labels over reported topology, without network addresses.

    This is presentation evidence from the already-read topology. Command
    authority still uses the complete raw groups and fresh identity checks.
    Unenrolled or moved members contribute only to the reported total count.
    """
    with LOCK:
        owned = {d["uid"]: d for d in _load(owner)["devices"].values()}
    result = []
    for group in groups:
        visible = [m for m in group["members"] if m["uid"] in owned and owned[m["uid"]]["ip"] == m["ip"]]
        if not visible:
            continue
        visible_uids = {m["uid"] for m in visible}
        members = []
        for member in sorted(visible, key=lambda m: m["uid"]):
            device = owned[member["uid"]]
            members.append({"uid": member["uid"], "device_id": device["id"], "name": device["name"],
                "room": device["room"], "model": device["model"], "bonded": bool(member.get("bonded")),
                "parent_uid": member.get("parent_uid") if member.get("parent_uid") in visible_uids else None,
                "bond_source": member.get("bond_source")})
        coordinator = group["coordinator"] if group["coordinator"] in visible_uids else None
        result.append({"coordinator": coordinator, "member_count": len(group["members"]),
            "complete": len(visible) == len(group["members"]) and coordinator is not None, "members": members})
    return {"groups": result, "checked_at": stamp()}


def _room_layout(device, group, check=None, before_local=None):
    """Partition physical devices using explicit bonds, never room labels."""
    members = {member["uid"]: member for member in group["members"]}
    layout, assigned = [], set()
    for member in group["members"]:
        if member.get("parent_uid") or member.get("invisible") or member.get("bond_source") == "invisible":
            continue
        children = {row["uid"] for row in group["members"] if row.get("parent_uid") == member["uid"]}
        mapped = set(member.get("volume_members") or [])
        if member.get("bonded") and not children and not mapped:
            break  # A generic bonded flag does not establish a room master.
        physical = {member["uid"]} | children | mapped
        if not physical <= members.keys() or physical & assigned:
            break
        layout.append({"uid": member["uid"], "member_uids": sorted(physical)})
        assigned.update(physical)
    else:
        if assigned == members.keys() and layout:
            return sorted(layout, key=lambda room: room["uid"])
    # Only exact modern player/device membership may resolve an ambiguous bond.
    if before_local is not None:
        before_local()
    import sonos_local
    return sonos_local.room_members(device, group, lambda: _check(check))


def _room_rows(owned, group, layout):
    by_uid = {member["uid"]: member for member in group["members"]}
    rooms = []
    for room in layout:
        if any(uid not in owned or owned[uid]["ip"] != by_uid[uid]["ip"] for uid in room["member_uids"]):
            raise HTTPException(409, "Enroll every room and its bonded speakers before using group volume.")
        device = owned[room["uid"]]
        rooms.append({"device_id": device["id"], "uid": device["uid"], "name": device["room"] or device["name"],
                      "volume_cap": min(owned[uid]["volume_cap"] for uid in room["member_uids"])})
    return rooms


def _read_room_levels(rooms, owned, check=None, known=None):
    result = []
    for room in rooms:
        _check(check)
        reading = known.get(room["uid"]) if known else None
        if reading is None:
            reading = ADAPTER.volume_reading(owned[room["uid"]], check)
        volume, muted = reading.get("volume"), reading.get("muted")
        if type(volume) is not int or not 0 <= volume <= 100 or type(muted) is not bool:
            raise HTTPException(502, "Sonos did not return usable room volume levels.")
        result.append({**room, "volume": volume, "muted": muted})
    _check(check)
    return result


def _volume_controls(owner, device, group, check=None, known=None):
    """Read enrolled logical rooms; enable group adjustment only when complete."""
    owned = {row["uid"]: row for row in list_devices(owner)["devices"]}
    by_uid = {member["uid"]: member for member in group["members"]}
    enrolled = {uid for uid, member in by_uid.items() if uid in owned and owned[uid]["ip"] == member["ip"]}
    complete = enrolled == by_uid.keys()
    incomplete = "Enroll every room and its bonded speakers to control group volume."
    try:
        if complete:
            _verify_members(owner, group["members"], check)
        def before_local():
            if not complete:
                raise HTTPException(409, incomplete)
        layout = _room_layout(device, group, check, before_local)
        layout = [room for room in layout if set(room["member_uids"]) <= enrolled]
        if not layout:
            return {"rooms": [], "group": None, "reason": incomplete}
        if not complete:
            readable = {uid for room in layout for uid in room["member_uids"]}
            _verify_members(owner, [by_uid[uid] for uid in sorted(readable)], check)
        rooms = _read_room_levels(_room_rows(owned, group, layout), owned, check, known)
    except Exception:
        _check(check)
        return {"rooms": [], "group": None, "reason": "Room volume is unavailable. Refresh status to try again."}
    _check(check)
    if not complete:
        return {"rooms": rooms, "group": None, "reason": incomplete}
    count = len(rooms)
    return {"rooms": rooms, "group": {"volume": (sum(room["volume"] for room in rooms) * 2 + count) // (2 * count),
        "max": sum(room["volume_cap"] for room in rooms) // count, "muted": all(room["muted"] for room in rooms)}}


def _group_volume_targets(rooms, volume):
    """Capped proportional adjustment with an exact, rounded group average.

    Saturated rooms retain their caps; remaining room levels share the remainder
    proportionally. Silent rooms stay silent until nonzero rooms reach their
    caps, or are adjusted evenly when the entire remaining set starts at zero.
    """
    if volume > sum(room["volume_cap"] for room in rooms) // len(rooms):
        raise HTTPException(422, "Requested group volume exceeds the saved room ceilings.")
    remaining, active, targets = volume * len(rooms), list(rooms), {}
    while active:
        total = sum(room["volume"] for room in active)
        weights = {room["uid"]: room["volume"] if total else 1 for room in active}
        denominator = total or len(active)
        saturated = [room for room in active if remaining * weights[room["uid"]] >= room["volume_cap"] * denominator]
        if saturated:
            for room in saturated:
                targets[room["uid"]] = room["volume_cap"]
                remaining -= room["volume_cap"]
                active.remove(room)
            continue
        fractions = []
        for room in active:
            target, remainder = divmod(remaining * weights[room["uid"]], denominator)
            targets[room["uid"]] = target
            fractions.append((remainder, room["uid"]))
        remainder = remaining - sum(targets[room["uid"]] for room in active)
        for _, uid in sorted(fractions, key=lambda value: (-value[0], value[1]))[:remainder]:
            targets[uid] += 1
        break
    return targets


def status(owner, ident, check=None):
    with _bounded(check):
        device, groups, group = _current(owner, ident, check)
        # Only an enrolled coordinator may receive even a read through this owner.
        owned = {d["uid"]: d for d in list_devices(owner)["devices"]}
        coordinator = owned.get(group["coordinator"])
        advertised = next(m for m in group["members"] if m["uid"] == group["coordinator"])
        if coordinator and coordinator["ip"] == advertised["ip"]:
            _verify_members(owner, [advertised], check)
            reading = ADAPTER.reading(device, group, check)
        else:
            reading = {"playback": "UNKNOWN", "reason": "Enroll the group coordinator to read group playback."}
        clips = _clip(device, "probe", check=check)
        topology = _public_topology(owner, groups)
        controls = _volume_controls(owner, device, group, check, {device["uid"]: reading} if "volume" in reading else None)
        _check(check)
        return {"ok": True, "protocol": PROTOCOL, "device": device, "group": group, "topology": topology,
                "reading": reading, "clip_support": clips, "volume_controls": controls, "checked_at": stamp()}


def volume_controls(owner, ident, check=None):
    """Current room/group sliders without playback metadata or clip probing."""
    with _bounded(check):
        with LOCK:
            _check(check)
            enrollments = _load(owner)["devices"]
        device, _, group = _current(owner, ident, check)
        controls = _volume_controls(owner, device, group, check)
        with LOCK:
            _check(check)
            if _load(owner)["devices"] != enrollments:
                raise HTTPException(409, "Sonos enrollment changed during this volume check. Refresh the room controls.")
        _check(check)
        return {"ok": True, "protocol": PROTOCOL, "device_id": device["id"],
                "volume_controls": controls, "checked_at": stamp()}


@contextmanager
def _playback_window(deadline, seconds=2):
    """An offline target cannot consume the whole foreground poll window."""
    previous = getattr(LOCAL, "deadline", None)
    LOCAL.deadline = min(previous or float("inf"), deadline, time.monotonic() + seconds)
    try:
        yield
    finally:
        if previous is None:
            del LOCAL.deadline
        else:
            LOCAL.deadline = previous


def now_playing(owner, check=None):
    """Fresh, bounded enrolled-only playback summary; never runs in background.

    connected_count counts identity-verified enrolled endpoints, not satellites
    inferred online from a topology. Failures never reuse an earlier PLAYING
    value. Cursor rotation shares the bounded work fairly across large homes.
    """
    with _bounded(check):
        with LOCK:
            _check(check)
            devices = sorted(_load(owner)["devices"].values(), key=lambda row: row["uid"])
            key = hashlib.sha256(owner.encode()).hexdigest()
            start = PLAYBACK_CURSORS.get(key, 0) % len(devices) if devices else 0
        owned = {device["uid"]: device for device in devices}
        ordered = devices[start:] + devices[:start]
        deadline = min(getattr(LOCAL, "deadline"), time.monotonic() + PLAYBACK_SECONDS)
        tried, failed, connected, covered, coordinators, reported_members = set(), set(), set(), set(), set(), set()
        rows, partial, visited = [], False, 0

        def current(device):
            _check(check)
            if _device(owner, device["id"]) != device:
                raise HTTPException(409, "Sonos enrollment changed during this playback check.")

        def verify(device):
            current(device)
            if device["uid"] not in tried and len(tried) >= PLAYBACK_TARGETS:
                raise HTTPException(429, "The playback summary reached its target limit.")
            tried.add(device["uid"])
            if ADAPTER.identity(device["ip"], check)["uid"] != device["uid"]:
                raise HTTPException(409, "The enrolled Sonos address changed.")
            connected.add(device["uid"])

        for seed in ordered:
            if seed["uid"] in covered or seed["uid"] in tried:
                continue
            if time.monotonic() >= deadline or len(tried) >= PLAYBACK_TARGETS:
                partial = True
                break
            visited = ordered.index(seed) + 1
            try:
                with _playback_window(deadline):
                    verify(seed)
                    groups = ADAPTER.topology(seed["ip"], check)
                    seed_group = _group(seed, groups)
                    current(seed)
            except Exception:
                _check(check)
                failed.add(seed["uid"])
                partial = True
                continue
            for advertised in groups:
                if time.monotonic() >= deadline:
                    partial = True
                    break
                coordinator = owned.get(advertised["coordinator"])
                member = next((row for row in advertised["members"] if row["uid"] == advertised["coordinator"]), None)
                own_members = {row["uid"] for row in advertised["members"] if row["uid"] in owned and owned[row["uid"]]["ip"] == row["ip"]}
                if not own_members:
                    continue
                covered.update(own_members)
                if not coordinator or not member or coordinator["ip"] != member["ip"]:
                    partial = True
                    continue
                uid = coordinator["uid"]
                if uid in coordinators or uid in failed:
                    continue
                coordinators.add(uid)
                try:
                    with _playback_window(deadline, 3):
                        if uid == seed["uid"]:
                            group = seed_group
                        else:
                            verify(coordinator)
                            group = _group(coordinator, ADAPTER.topology(coordinator["ip"], check))
                        if group["coordinator"] != uid:
                            raise HTTPException(409, "The Sonos coordinator changed during this playback check.")
                        physical = {row["uid"] for row in group["members"]}
                        if physical & reported_members:
                            raise HTTPException(409, "Sonos groups changed during this playback check.")
                        reading = ADAPTER.playback_reading(coordinator, group, check)
                        current(coordinator)
                        playback = reading.get("playback")
                        if playback not in {"PLAYING", "PAUSED_PLAYBACK", "STOPPED", "TRANSITIONING", "NO_MEDIA_PRESENT"}:
                            raise HTTPException(502, "Sonos playback state is unavailable.")
                        names = [owned[row["uid"]]["room"] or owned[row["uid"]]["name"] for row in group["members"]
                            if row["uid"] in owned and owned[row["uid"]]["ip"] == row["ip"] and not row.get("parent_uid")
                            and not row.get("invisible") and row.get("bond_source") != "invisible"]
                        names = list(dict.fromkeys(names))
                        rows.append({"device_id": coordinator["id"], "uid": uid, "name": coordinator["room"] or coordinator["name"],
                            "member_names": names, "playback": playback, "title": str(reading.get("title") or "")[:500],
                            "artist": str(reading.get("artist") or "")[:500], "source": reading.get("source") or _playback_source(""),
                            "checked_at": stamp()})
                        reported_members.update(physical)
                except Exception:
                    _check(check)
                    failed.add(uid)
                    partial = True
        # A changed enrollment invalidates this result instead of exposing names
        # or a control target that no longer belongs to the polling owner.
        with LOCK:
            _check(check)
            latest = sorted(_load(owner)["devices"].values(), key=lambda row: row["uid"])
            if latest != devices:
                raise HTTPException(409, "Sonos enrollment changed during this playback check.")
            if len(PLAYBACK_CURSORS) >= 128 and key not in PLAYBACK_CURSORS:
                PLAYBACK_CURSORS.pop(next(iter(PLAYBACK_CURSORS)))
            PLAYBACK_CURSORS[key] = (start + max(visited, 1)) % len(devices) if devices else 0
        _check(check)
        return {"ok": True, "protocol": PROTOCOL, "devices_count": len(devices), "connected_count": len(connected),
                "groups": rows, "unavailable_count": len(failed), "partial": partial, "checked_at": stamp()}


def favorites(owner, ident, check=None):
    with _bounded(check):
        device, _, _ = _current(owner, ident, check)
        rows = ADAPTER.favorites(device["ip"], check)
        _check(check)
        return {"ok": True, "protocol": PROTOCOL, "items": [{k: r[k] for k in ("id", "name", "queue")} for r in rows], "limit": 100}


def _params(action, params):
    if action not in ACTIONS or not isinstance(params, dict):
        raise HTTPException(422, "Unsupported Sonos action.")
    fields = {"volume": {"volume"}, "mute": {"muted"}, "group_volume": {"volume"}, "group_mute": {"muted"}, "favorite": {"favorite_id", "replace_queue"}, "join": {"target_id"}, "announce": {"url", "volume"}, "cancel_announcement": {"clip_id"}}
    if set(params) != fields.get(action, set()):
        raise HTTPException(422, "Supply only the parameters for the selected Sonos action.")
    if action in {"volume", "group_volume", "announce"} and (type(params["volume"]) is not int or not 0 <= params["volume"] <= 100):
        raise HTTPException(422, "Volume must be an integer from 0 to 100.")
    if action in {"mute", "group_mute"} and type(params["muted"]) is not bool:
        raise HTTPException(422, "Mute must be true or false.")
    if action == "favorite" and (params["replace_queue"] is not True or not _text(params["favorite_id"])):
        raise HTTPException(422, "Review Play now and queue replacement before playing a favorite.")
    if action == "join":
        _text(params["target_id"])
    if action == "announce":
        # Internal caller must issue the URL; the public control endpoint forbids it.
        parsed = urlsplit(_text(params["url"], 2048))
        if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password or parsed.fragment or not parsed.path:
            raise HTTPException(422, "Announcement requires a host-issued media URL.")
        _ip(parsed.hostname)
    if action == "cancel_announcement":
        _text(params["clip_id"])
    return copy.deepcopy(params)


def _snapshot(owner, ident, action, params, check=None):
    device, groups, group = _current(owner, ident, check)
    affected = list(group["members"]) if action in {"play", "pause", "stop", "next", "previous", "favorite", "join", "leave", "group_volume", "group_mute"} else [next(m for m in group["members"] if m["uid"] == device["uid"])]
    selected_groups = [group]
    owned = {d["uid"]: d for d in list_devices(owner)["devices"]}
    effect_params = copy.deepcopy(params)
    favorite = None
    room_layout = None
    if action in {"volume", "mute", "group_volume", "group_mute"}:
        # A local API fallback may read only an owned, checked coordinator.
        coordinator = next(member for member in group["members"] if member["uid"] == group["coordinator"])
        room_layout = _room_layout(device, group, check, lambda: _verify_members(owner, [coordinator], check))
        if action in {"volume", "mute"}:
            selected = next((room for room in room_layout if room["uid"] == device["uid"]), None)
            if selected is None:
                raise HTTPException(422, "Use the room's volume control rather than a bonded satellite.")
            affected = [member for member in group["members"] if member["uid"] in selected["member_uids"]]
            rooms = _room_rows(owned, group, [selected])
            cap = next(room["volume_cap"] for room in rooms if room["uid"] == device["uid"])
            if action == "volume" and params["volume"] > cap:
                raise HTTPException(422, f"Requested volume exceeds this room's ceiling of {cap}.")
        else:
            owned = _verify_members(owner, group["members"], check)
            rooms = _room_rows(owned, group, room_layout)
            levels = _read_room_levels(rooms, owned, check)
            targets = _group_volume_targets(levels, params["volume"]) if action == "group_volume" else {}
            effect_params["room_plan"] = [{"device": owned[room["uid"]], "uid": room["uid"], "name": room["name"],
                "before": room["volume"] if action == "group_volume" else room["muted"],
                "target": targets[room["uid"]] if action == "group_volume" else params["muted"]} for room in levels]
    if action == "join":
        destination, _, other = _current(owner, params["target_id"], check)
        if other == group:
            raise HTTPException(409, "These speakers are already grouped.")
        selected_groups.append(other)
        affected += other["members"]
        effect_params["coordinator_uid"] = other["coordinator"]
    if action in {"join", "leave"} and any(m["bonded"] for g in selected_groups for m in g["members"]):
        raise HTTPException(422, "Stereo pairs and surround bonds must be managed in Sonos. TLI will not rearrange them.")
    owned = _verify_members(owner, affected, check)
    if action in {"volume", "announce"} and params["volume"] > device["volume_cap"]:
        raise HTTPException(422, f"Requested volume exceeds this speaker's ceiling of {device['volume_cap']}.")
    if action == "favorite":
        matches = [f for f in ADAPTER.favorites(device["ip"], check) if f["id"] == params["favorite_id"]]
        if len(matches) != 1:
            raise HTTPException(409, "That exact favorite is unavailable. Read favorites again.")
        favorite = matches[0]
    if action == "announce":
        supported = _clip(device, "probe", check=check)
        if supported.get("supported") is not True:
            raise HTTPException(422, "This speaker has not confirmed AUDIO_CLIP support. Playback will not be interrupted; choose another output.")
    if action == "cancel_announcement":
        with LOCK:
            receipts = _load(owner)["receipts"].values()
            if not any(r.get("device_id") == ident and r.get("action") == "announce" and r.get("clip_id") == params["clip_id"] for r in receipts):
                raise HTTPException(404, "This clip was not created by this owner for this speaker.")
    selected_groups.sort(key=lambda g: g["coordinator"])
    revisions = {m["uid"]: owned[m["uid"]]["revision"] for m in affected}
    snapshot = {"device": device, "groups": selected_groups, "revisions": revisions, "favorite": favorite}
    if room_layout is not None:
        snapshot["room_layout"] = room_layout
    return snapshot, group, sorted({m["uid"] for m in affected}), effect_params


def prepare(owner, ident, action, params=None, check=None):
    params = _params(action, params or {})
    with _bounded(check):
        snapshot, group, affected, _ = _snapshot(owner, ident, action, params, check)
        topology = _public_topology(owner, snapshot["groups"])
        review_id = secrets.token_hex(24)
        review = {"owner": owner, "id": review_id, "device_id": ident, "action": action, "params": params,
                  "snapshot": snapshot, "affected": affected, "expires": time.time() + REVIEW_TTL, "used": False}
        with LOCK:
            for key, value in list(REVIEWS.items()):
                if value["expires"] < time.time():
                    del REVIEWS[key]
            if len(REVIEWS) >= 256:
                raise HTTPException(429, "Too many active Sonos reviews; let one expire before creating another.")
            _check(check)
            REVIEWS[review_id] = review
        return {"ok": True, "protocol": PROTOCOL, "review_id": review_id, "expires_at": review["expires"], "action": action, "topology": topology,
                "device": snapshot["device"], "affected": [{"uid": m["uid"], "name": m["name"]} for g in snapshot["groups"] for m in g["members"] if m["uid"] in affected],
                "effect": "Play now replaces the current source and may replace the group's queue." if action == "favorite" else "Changes grouping of the listed rooms." if action in {"join", "leave"} else "Clip overlay only; no playback-replacement fallback." if action == "announce" else f"{action.capitalize()} on the listed speaker(s).",
                "params": {k: v for k, v in params.items() if k != "url"}, "favorite_name": (snapshot["favorite"] or {}).get("name"), "actions_performed": False}


def _public_receipt(receipt):
    result = copy.deepcopy(receipt)
    result.pop("fingerprint", None)
    result.pop("intent_hash", None)
    if result.get("outcome") == "pending":
        result.update(outcome="unknown", ok=False, summary="The previous command may have reached the speaker. It is never replayed, including after restart.")
    return result


def _playback_result(receipt):
    """Keep command acknowledgement separate from the observed playback state."""
    if receipt["action"] != "play" or receipt["outcome"] != "accepted":
        return
    reading = receipt.get("observed") or {}
    playback = reading.get("playback")
    receipt["playback_confirmed"] = playback == "PLAYING"
    if playback == "PLAYING":
        receipt["summary"] = "Sonos reports playing."
    elif playback == "PAUSED_PLAYBACK":
        receipt["summary"] = "Sonos accepted Play, but playback is still paused. Check the source app and refresh status."
    elif playback == "STOPPED":
        receipt["summary"] = "Sonos accepted Play, but playback is still stopped. Check the source app and refresh status."
    elif playback == "TRANSITIONING":
        receipt["summary"] = "Sonos is starting playback. Refresh status to check when it is playing."
    else:
        receipt["summary"] = "Sonos accepted Play, but playback could not be verified. Refresh status before trying again."


def _retain_receipt(owner, receipt):
    # Retaining known outcomes is private bookkeeping even after access expires.
    with LOCK:
        data = _load(owner)
        data["receipts"][receipt["request_id"]] = receipt
        _save(owner, data)


def _perform_room_plan(owner, group, action, plan, receipt, check=None):
    operation = "volume" if action == "group_volume" else "mute"
    field = "volume" if action == "group_volume" else "muted"
    for index, room in enumerate(plan):
        result = receipt["room_results"][index]
        if room["before"] == room["target"]:
            result["outcome"] = "unchanged"
            continue
        try:
            _check(check)
        except Exception:
            break
        # A restart after this reservation must never resend this room's write.
        result["outcome"] = "unknown"
        _retain_receipt(owner, receipt)
        try:
            _check(check)  # The private save above may have waited for a lock.
        except Exception:
            result["outcome"] = "not_attempted"
            break
        try:
            output = ADAPTER.perform(room["device"], group, operation, {field: room["target"]}, check=check)
        except Exception:
            break
        if isinstance(output, dict) and output.get("rejected") is True:
            result["outcome"] = "failed"
            break
        result["outcome"] = "accepted"
        _retain_receipt(owner, receipt)
    outcomes = [room["outcome"] for room in receipt["room_results"]]
    complete = all(outcome in {"accepted", "unchanged"} for outcome in outcomes)
    outcome = "accepted" if complete else "partial" if "accepted" in outcomes else "unknown" if "unknown" in outcomes else "failed"
    receipt.update(ok=complete, outcome=outcome, summary=(
        "Sonos acknowledged the room volume changes." if complete and operation == "volume" else
        "Sonos acknowledged the room mute changes." if complete else
        "Some rooms may have changed. Remaining rooms were not retried; refresh their levels before another adjustment." if outcome in {"partial", "unknown"} else
        "The group adjustment did not complete. No automatic retry ran."))


def execute(owner, review_id, request_id, check=None):
    if not isinstance(request_id, str) or not REQUEST.fullmatch(request_id):
        raise HTTPException(422, "Use a unique request ID containing 16–128 letters, digits, hyphens or underscores.")
    with LOCK:
        _check(check)
        data = _load(owner)
        old = data["receipts"].get(request_id)
        if old:
            if old.get("review_id") != review_id:
                raise HTTPException(409, "This request ID belongs to another Sonos action.")
            return _public_receipt(old)
        review = REVIEWS.get(review_id)
        if not review or review["owner"] != owner or review["expires"] < time.time() or review["used"]:
            raise HTTPException(409, "This Sonos review expired, was used, or belongs to another owner.")
        if (owner, request_id) in REQUESTS:
            raise HTTPException(409, "This Sonos request is being prepared. No second action was sent.")
        if RUNNING.intersection(review["affected"]):
            raise HTTPException(409, "An affected speaker already has a command in progress.")
        if len(data["receipts"]) >= MAX_RECEIPTS:
            raise HTTPException(507, "Sonos receipt storage is full. No command was submitted.")
        RUNNING.update(review["affected"])
        REQUESTS.add((owner, request_id))
        review["used"] = True
    receipt = None
    try:
        with _bounded(check):
            snapshot, group, affected, params = _snapshot(owner, review["device_id"], review["action"], review["params"], check)
            if snapshot != review["snapshot"] or affected != review["affected"]:
                raise HTTPException(409, "Speaker identity, grouping, favorite or volume ceiling changed. Review the action again; nothing was sent.")
            receipt = {"ok": False, "protocol": PROTOCOL, "request_id": request_id, "review_id": review_id,
                       "device_id": review["device_id"], "action": review["action"], "outcome": "pending", "checked_at": stamp(),
                       "affected": affected, "fingerprint": _digest([review["action"], review["params"], snapshot]),
                       "intent_hash": _digest([review["device_id"], review["action"], review["params"]]),
                       "summary": "Command prepared; delivery is not confirmed.", "hardware_verified": False}
            if review["action"] in {"group_volume", "group_mute"}:
                receipt["room_results"] = [{"device_id": room["device"]["id"], "uid": room["uid"], "name": room["name"],
                    "before": room["before"], "target": room["target"], "outcome": "not_attempted"} for room in params["room_plan"]]
            with LOCK:
                _check(check)
                data = _load(owner)
                if len(data["receipts"]) >= MAX_RECEIPTS:
                    raise HTTPException(507, "Sonos receipt storage is full. No command was submitted.")
                data["receipts"][request_id] = receipt
                _save(owner, data)  # Must succeed before the first mutating network call.
            try:
                grouped = review["action"] in {"group_volume", "group_mute"}
                if grouped:
                    _perform_room_plan(owner, group, review["action"], params["room_plan"], receipt, check)
                    output = {}
                else:
                    output = ADAPTER.perform(snapshot["device"], group, review["action"], params, snapshot["favorite"], check)
                rejected = isinstance(output, dict) and output.get("rejected") is True
                if not grouped:
                    receipt.update(ok=not rejected, outcome="failed" if rejected else "accepted", summary="The speaker rejected this operation." if rejected else "Sonos acknowledged the operation. Audibility and completion are not confirmed.")
                if rejected and output.get("error_code") in {"ERROR_NO_CONTENT", "ERROR_PLAYBACK_NO_CONTENT"}:
                    receipt["summary"] = "The current source has no playable content. Resume music in its app with this Sonos room selected."
                if isinstance(output, dict):
                    for key in ("clip_id", "clip_state"):
                        if isinstance(output.get(key), str):
                            receipt[key] = output[key][:120]
                if review["action"] not in {"announce", "cancel_announcement"}:
                    try:
                        _check(check)
                        current, _, after_group = _current(owner, review["device_id"], check)
                        _verify_members(owner, [m for m in after_group["members"] if m["uid"] == after_group["coordinator"]], check)
                        receipt["observed"] = ADAPTER.reading(current, after_group, check)
                        receipt["observed_at"] = stamp()
                        if review["action"] in {"volume", "mute", "group_volume", "group_mute"}:
                            receipt["volume_controls"] = _volume_controls(owner, current, after_group, check,
                                {current["uid"]: receipt["observed"]})
                    except Exception:
                        receipt["observation_unavailable"] = True
                _playback_result(receipt)
            except SonosCommandNotSent as error:
                receipt.update(ok=False, outcome="failed", summary=error.detail, command_sent=False)
            except Exception:
                receipt.update(ok=False, outcome="unknown", summary="The operation may have reached Sonos or partially completed. No retry ran. Read the current state before another action.")
            with LOCK:
                data = _load(owner)
                data["receipts"][request_id] = receipt
                _save(owner, data)
            _check(check)
            return _public_receipt(receipt)
    finally:
        with LOCK:
            RUNNING.difference_update(review["affected"])
            REQUESTS.discard((owner, request_id))


def receipts(owner, check=None):
    with LOCK:
        _check(check)
        rows = list(_load(owner)["receipts"].values())[-100:]
    return {"ok": True, "protocol": PROTOCOL, "receipts": [_public_receipt(r) for r in reversed(rows)]}


def announce(owner, device_id, url, volume, request_id, check=None):
    """Internal host-media caller; no arbitrary URL route is exposed to models/UI."""
    with LOCK:
        _check(check)
        previous = _load(owner)["receipts"].get(request_id)
        if previous:
            if previous.get("intent_hash") != _digest([device_id, "announce", {"url": url, "volume": volume}]):
                raise HTTPException(409, "Announcement request ID was already used for another command.")
            return _public_receipt(previous)
    review = prepare(owner, device_id, "announce", {"url": url, "volume": volume}, check)
    return execute(owner, review["review_id"], request_id, check)


def cancel_announcement(owner, device_id, clip_id, check=None):
    request_id = "cancel-" + _digest([device_id, clip_id])
    with LOCK:
        previous = _load(owner)["receipts"].get(request_id)
        if previous:
            _check(check)
            return _public_receipt(previous)
    review = prepare(owner, device_id, "cancel_announcement", {"clip_id": clip_id}, check)
    return execute(owner, review["review_id"], request_id, check)
