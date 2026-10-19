"""Bounded Pi-hole v6 API transport and detached, strict observations.

Only an explicit private literal HTTPS origin is contacted. Credentials are sent
after certificate verification; no DNS, proxies, redirects, retries or persistence.
The client API replaces memberships and has no per-client timer. Wire contracts:
https://github.com/pi-hole/FTL/tree/master/src/api/docs/content/specs
"""
from __future__ import annotations

import hashlib
import hmac
import http.client
import ipaddress
import json
import math
import re
import socket
import ssl
import threading
import time
import unicodedata
from urllib.parse import parse_qsl, quote, unquote, urlsplit

from fastapi import HTTPException

MAX_RESPONSE = 2 * 1024 * 1024
MAX_CLIENTS = 2000
MAX_GROUPS = 256
MAX_QUERIES = 100
REQUEST_TIMEOUT = 8
IO_TIMEOUT = 3
HTTP_SLOTS = threading.BoundedSemaphore(4)
LAN_NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"))
NETWORKS = LAN_NETWORKS + (ipaddress.ip_network("127.0.0.0/8"), ipaddress.ip_network("::1/128"))
MAX_INTEGER = 2**53 - 1


def _access(check):
    if not callable(check):
        raise HTTPException(403, "Current browser authority is required for Pi-hole access.")
    try:
        check()
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(403, "Browser authority is unavailable. Unlock and start a new request.") from None


def _address(value, networks=LAN_NETWORKS):
    if not isinstance(value, str) or "%" in value:
        raise ValueError()
    address = ipaddress.ip_address(value)
    if not any(address.version == network.version and address in network for network in networks):
        raise ValueError()
    return address


def configuration(origin, certificate_sha256=""):
    """Normalize an origin; the optional fingerprint must be independently reviewed."""
    try:
        if (not isinstance(origin, str) or len(origin) > 256 or
                not re.fullmatch(r"https://(?:\[[0-9a-fA-F:]+\]|[0-9.]+)(?::[0-9]{1,5})?", origin, re.I)):
            raise ValueError()
        parsed = urlsplit(origin)
        address = _address(parsed.hostname, NETWORKS)
        port = parsed.port if parsed.port is not None else 443
        if not 1 <= port <= 65535:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(422, "Use an HTTPS private LAN or loopback literal IP origin. Hostnames, paths, credentials, queries and public or link-local addresses are unsupported.") from None
    if not isinstance(certificate_sha256, str) or (certificate_sha256 and not (
            re.fullmatch(r"[0-9a-fA-F]{64}", certificate_sha256) or
            re.fullmatch(r"(?:[0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}", certificate_sha256))):
        raise HTTPException(422, "Use an independently checked SHA-256 certificate fingerprint, or leave it empty for system certificate verification.")
    host = str(address)
    authority = f"[{host}]" if address.version == 6 else host
    return {"origin": f"https://{authority}:{port}", "host": host, "port": port,
            "family": socket.AF_INET6 if address.version == 6 else socket.AF_INET,
            "fingerprint": certificate_sha256.replace(":", "").lower()}


def _text(value, maximum=256, nullable=False, empty=False):
    if value is None and nullable:
        return None
    if (not isinstance(value, str) or len(value) > maximum or (not value and not empty) or
            any(unicodedata.category(char) in ("Cc", "Cs", "Cf") for char in value)):
        raise ValueError()
    return value


def _integer(value, minimum=0, maximum=MAX_INTEGER):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError()
    return value


def _number(value):
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= MAX_INTEGER:
        raise ValueError()
    return value


def _groups(value):
    if not isinstance(value, list) or len(value) > MAX_GROUPS:
        raise ValueError()
    result = [_integer(item) for item in value]
    if len(set(result)) != len(result):
        raise ValueError()
    return result


def _request(method, path, sid, body):
    """Whitelist request shapes, including bounded server-generated query filters."""
    try:
        if not isinstance(path, str) or len(path) > 2048:
            raise ValueError()
        if method == "POST" and path == "/api/auth":
            if sid is not None or not isinstance(body, dict) or set(body) != {"password"}:
                raise ValueError()
            _text(body["password"], 512)
        else:
            if not isinstance(sid, str) or not re.fullmatch(r"[A-Za-z0-9+/=_-]{1,256}", sid):
                raise ValueError()
            if method == "GET" and path in ("/api/clients", "/api/groups"):
                if body is not None:
                    raise ValueError()
            elif method == "GET" and path.startswith("/api/queries?"):
                if body is not None:
                    raise ValueError()
                parsed = urlsplit(path)
                if parsed.path != "/api/queries" or parsed.fragment:
                    raise ValueError()
                pairs = parse_qsl(parsed.query, strict_parsing=True, keep_blank_values=True)
                params = dict(pairs)
                required = {"client_ip", "length", "from", "until", "disk"}
                if len(pairs) != len(params) or not required <= set(params) or set(params) - required - {"cursor"}:
                    raise ValueError()
                _address(params["client_ip"])
                if not re.fullmatch(r"[0-9]{1,3}", params["length"]) or not 1 <= int(params["length"]) <= MAX_QUERIES:
                    raise ValueError()
                for key in ("from", "until"):
                    if not re.fullmatch(r"[0-9]{1,12}(?:\.[0-9]{1,6})?", params[key]):
                        raise ValueError()
                start, end, now = float(params["from"]), float(params["until"]), time.time()
                if not 0 <= end - start <= 900 or start < now - 960 or end > now + 60:
                    raise ValueError()
                if params["disk"] != "false" or ("cursor" in params and (
                        not re.fullmatch(r"[0-9]{1,16}", params["cursor"]) or int(params["cursor"]) > MAX_INTEGER)):
                    raise ValueError()
            elif method == "DELETE" and path == "/api/auth":
                if body is not None:
                    raise ValueError()
            elif method == "PUT" and path.startswith("/api/clients/"):
                selector = unquote(path[len("/api/clients/"):], errors="strict")
                _address(selector)
                if path != "/api/clients/" + quote(selector, safe=""):
                    raise ValueError()
                if not isinstance(body, dict) or set(body) != {"comment", "groups"}:
                    raise ValueError()
                _text(body["comment"], 1024, nullable=True, empty=True)
                _groups(body["groups"])
            else:
                raise ValueError()
        return None if body is None else json.dumps(body, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise HTTPException(422, "The Pi-hole request is outside the supported client, group or recent-activity contract.") from None


def _json(raw):
    def pairs(rows):
        result = {}
        for key, value in rows:
            if key in result:
                raise ValueError()
            result[key] = value
        return result

    def invalid(_):
        raise ValueError()

    def number(value):
        value = float(value)
        if not math.isfinite(value):
            raise ValueError()
        return value

    value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_float=number, parse_constant=invalid)
    if not isinstance(value, dict) or "error" in value or "errors" in value:
        raise ValueError()
    return value


def exchange(config, method, path, check, *, sid=None, body=None, on_attempt=None):
    """One bounded exchange. on_attempt marks a PUT as uncertain before any bytes."""
    _access(check)
    try:
        validated = configuration(config["origin"], config["fingerprint"])
        if type(config) is not dict or config != validated:
            raise ValueError()
    except HTTPException:
        _access(check)
        raise
    except (KeyError, TypeError, ValueError):
        _access(check)
        raise HTTPException(422, "Invalid Pi-hole connection configuration.") from None
    try:
        encoded = _request(method, path, sid, body)
    except HTTPException:
        _access(check)
        raise
    if on_attempt is not None and (method != "PUT" or not callable(on_attempt)):
        _access(check)
        raise HTTPException(422, "Invalid Pi-hole submission callback.")
    _access(check)
    if not HTTP_SLOTS.acquire(False):
        _access(check)
        raise HTTPException(429, "Four Pi-hole requests are active. Start another explicitly when one finishes.")
    sockets = []
    connection = response = timer = None
    timed_out = threading.Event()
    deadline = time.monotonic() + REQUEST_TIMEOUT

    def checkpoint(sock=None):
        _access(check)
        remaining = deadline - time.monotonic()
        if timed_out.is_set() or remaining <= 0:
            raise TimeoutError()
        if sock is not None:
            sock.settimeout(min(IO_TIMEOUT, remaining))

    def stop():
        timed_out.set()
        for sock in tuple(sockets):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    try:
        checkpoint()
        timer = threading.Timer(REQUEST_TIMEOUT, stop)
        timer.daemon = True
        timer.start()
        raw = socket.socket(config["family"], socket.SOCK_STREAM)
        sockets.append(raw)
        checkpoint(raw)
        raw.connect((config["host"], config["port"]))
        checkpoint(raw)
        if ipaddress.ip_address(raw.getpeername()[0]) != ipaddress.ip_address(config["host"]):
            raise ValueError()
        if config["fingerprint"]:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        else:
            context = ssl.create_default_context()
        secure = context.wrap_socket(raw, server_hostname=config["host"], do_handshake_on_connect=False)
        sockets.append(secure)
        checkpoint(secure)
        secure.do_handshake()
        checkpoint(secure)
        if config["fingerprint"] and not hmac.compare_digest(
                hashlib.sha256(secure.getpeercert(binary_form=True)).hexdigest(), config["fingerprint"]):
            raise HTTPException(502, "The Pi-hole certificate fingerprint did not match. No credentials were sent.")
        connection = http.client.HTTPConnection(config["host"], config["port"])
        connection.auto_open = 0
        connection.sock = secure
        headers = {"Accept": "application/json", "Accept-Encoding": "identity", "Connection": "close"}
        if sid is not None:
            headers["X-FTL-SID"] = sid
        if encoded is not None:
            headers["Content-Type"] = "application/json"
        checkpoint(secure)
        if on_attempt is not None:
            on_attempt()
            checkpoint(secure)
        connection.request(method, path, body=encoded, headers=headers)
        checkpoint(secure)
        response = connection.getresponse()
        checkpoint(secure)
        if 300 <= response.status < 400:
            raise HTTPException(502, "Pi-hole redirected the request. Redirects and credential forwarding are disabled.")
        if response.status in (401, 403):
            raise HTTPException(502, "Pi-hole rejected the session or its permissions. Reconnect explicitly; no retry ran.")
        if method == "DELETE" and response.status == 204:
            checkpoint()
            return {}
        if response.status != 200:
            raise HTTPException(502, "Pi-hole did not confirm the request. No automatic retry ran.")
        if response.getheader("Content-Encoding", "identity").lower() not in ("", "identity"):
            raise ValueError()
        if response.getheader("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise ValueError()
        length = response.getheader("Content-Length")
        transfer = response.getheader("Transfer-Encoding")
        if (length is not None and (not re.fullmatch(r"[0-9]{1,10}", length) or int(length) > MAX_RESPONSE) or
                length is not None and transfer is not None or
                transfer is not None and transfer.lower().strip() != "chunked"):
            raise ValueError()
        data = bytearray()
        while True:
            checkpoint(secure)
            chunk = response.read1(min(65536, MAX_RESPONSE + 1 - len(data)))
            checkpoint()
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > MAX_RESPONSE:
                raise ValueError()
            if response.isclosed():
                break
        if length is not None and len(data) != int(length):
            raise ValueError()
        result = _json(data)
        checkpoint()
        return result
    except HTTPException:
        _access(check)
        raise
    except (TimeoutError, socket.timeout):
        _access(check)
        raise HTTPException(504, "The Pi-hole request exceeded its request window. No automatic retry ran.") from None
    except (OSError, ValueError, http.client.HTTPException, RecursionError):
        _access(check)
        if timed_out.is_set() or time.monotonic() >= deadline:
            raise HTTPException(504, "The Pi-hole request exceeded its request window. No automatic retry ran.") from None
        raise HTTPException(502, "Pi-hole could not be verified or returned an unreadable response. No automatic retry ran.") from None
    finally:
        if timer:
            timer.cancel()
        try:
            for resource in (response, connection, *sockets):
                if resource is not None:
                    try:
                        resource.close()
                    except OSError:
                        pass
        finally:
            HTTP_SLOTS.release()


def _array(value, key, maximum):
    if (not isinstance(value, dict) or "error" in value or "errors" in value or
            not isinstance(value.get(key), list) or len(value[key]) > maximum):
        raise ValueError()
    return value[key]


def project_clients(value):
    try:
        result, ids, selectors, editable_addresses = [], set(), set(), set()
        for source in _array(value, "clients", MAX_CLIENTS):
            if not isinstance(source, dict):
                raise ValueError()
            row = {"id": _integer(source["id"]), "client": _text(source["client"]),
                   "comment": _text(source["comment"], 1024, nullable=True, empty=True),
                   "groups": _groups(source["groups"]),
                   "date_added": _integer(source["date_added"]),
                   "date_modified": _integer(source["date_modified"]), "editable": False}
            if row["id"] in ids or row["client"] in selectors:
                raise ValueError()
            ids.add(row["id"])
            selectors.add(row["client"])
            try:
                canonical = str(_address(row["client"]))
            except ValueError:
                pass
            else:
                if canonical in editable_addresses:
                    raise ValueError()
                editable_addresses.add(canonical)
                row["editable"] = True
            result.append(row)
        return result
    except (ValueError, TypeError, KeyError, OverflowError):
        raise HTTPException(502, "Pi-hole returned an invalid client inventory. No empty inventory was substituted.") from None


def project_groups(value):
    try:
        result, ids, names = [], set(), set()
        for source in _array(value, "groups", MAX_GROUPS):
            if not isinstance(source, dict) or type(source.get("enabled")) is not bool:
                raise ValueError()
            row = {"id": _integer(source["id"]), "name": _text(source["name"]),
                   "enabled": source["enabled"],
                   "description": _text(source["comment"], 1024, nullable=True, empty=True),
                   "date_added": _integer(source["date_added"]),
                   "date_modified": _integer(source["date_modified"])}
            if row["id"] in ids or row["name"] in names:
                raise ValueError()
            ids.add(row["id"])
            names.add(row["name"])
            result.append(row)
        return result
    except (ValueError, TypeError, KeyError, OverflowError):
        raise HTTPException(502, "Pi-hole returned an invalid group inventory. No empty inventory was substituted.") from None


def project_queries(value, client_ip, *, start=None, until=None):
    """Fail closed if Pi-hole ignores the client filter; never guess an identity."""
    try:
        address = _address(client_ip)
        if start is not None or until is not None:
            _number(start)
            _number(until)
            if not 0 <= until - start <= 900:
                raise ValueError()
        items = []
        for source in _array(value, "queries", MAX_QUERIES):
            if not isinstance(source, dict) or not isinstance(source.get("client"), dict):
                raise ValueError()
            client = source["client"]
            if _address(client["ip"]) != address:
                raise ValueError()
            row = {"time": _number(source["time"]), "domain": _text(source["domain"], 253),
                   "type": _text(source["type"], 32),
                   "status": _text(source["status"], 64, nullable=True),
                   "client": {"ip": str(address), "name": _text(client.get("name"), nullable=True)}}
            if start is not None and not start <= row["time"] <= until:
                raise ValueError()
            if "reply" in source:
                reply = source["reply"]
                if not isinstance(reply, dict):
                    raise ValueError()
                elapsed = reply.get("time")
                if elapsed is not None and (type(elapsed) not in (int, float) or not math.isfinite(elapsed) or not -1 <= elapsed <= MAX_INTEGER):
                    raise ValueError()
                row["reply"] = {"type": _text(reply.get("type"), 32, nullable=True), "time": elapsed}
            items.append(row)
        return {"items": items,
                "cursor": _integer(value["cursor"]) if value.get("cursor") is not None else None,
                "records_filtered": _integer(value["recordsFiltered"]) if value.get("recordsFiltered") is not None else None}
    except (ValueError, TypeError, KeyError, OverflowError):
        raise HTTPException(502, "Pi-hole returned invalid activity or activity outside the selected client and time window. No DNS activity was disclosed.") from None


def validate_session(value):
    try:
        if not isinstance(value, dict) or "error" in value or "errors" in value:
            raise ValueError()
        session = value["session"]
        if not isinstance(session, dict) or session.get("valid") is not True:
            raise ValueError()
        sid = session["sid"]
        if not isinstance(sid, str) or not re.fullmatch(r"[A-Za-z0-9+/=_-]{1,256}", sid):
            raise ValueError()
        return {"sid": sid, "validity": _integer(session["validity"], 1, 86400)}
    except (ValueError, TypeError, KeyError):
        raise HTTPException(502, "Pi-hole did not establish an authenticated session. Use its application password and reconnect explicitly.") from None
