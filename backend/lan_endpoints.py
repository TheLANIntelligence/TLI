"""Reviewed LAN authorities and untrusted, short-lived route hints.

DNS and discovery select sockets only. TLS still authenticates the reviewed
hostname and exact certificate before a caller sends any HTTP bytes.
"""
from __future__ import annotations

import http.client
import ipaddress
import re
import socket
import ssl
import threading
import time
from urllib.parse import urlsplit

_PRIVATE = tuple(ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
_NAME = re.compile(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local\Z")
_HINTS = {}
_LOCK = threading.Lock()
_DNS = {}
_DNS_PENDING = {}
_DNS_SLOTS = threading.BoundedSemaphore(4)
_VERIFIED = {}
_GENERATION = 0


class RouteResolutionError(OSError):
    """No current private socket candidate for the reviewed authority."""


def private_ip(value):
    try:
        ip = ipaddress.IPv4Address(value)
        return str(ip) if any(ip in net for net in _PRIVATE) else None
    except (ValueError, TypeError):
        return None


def stable_name(value):
    return isinstance(value, str) and bool(_NAME.fullmatch(value))


def canonical_origin(value):
    parsed = urlsplit(value)
    host = parsed.hostname
    if (parsed.scheme != "https" or parsed.username is not None or parsed.password is not None
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment
            or not (private_ip(host) or stable_name(host))):
        raise ValueError("Use a private IPv4 or reviewed .local HTTPS address.")
    port = 443 if parsed.port is None else parsed.port
    if not 1 <= port <= 65535:
        raise ValueError("Invalid HTTPS port")
    return f"https://{host}:{port}"


def remember(hostname, addresses, *, source='legacy', interface=None, ttl=120):
    if not stable_name(hostname):
        return
    candidates = sorted({ip for value in addresses if (ip := private_ip(value))})[:8]
    with _LOCK:
        now = time.monotonic()
        for name in list(_HINTS):
            _HINTS[name] = {key:value for key,value in _HINTS[name].items() if value > now}
            if not _HINTS[name]:
                del _HINTS[name]
        if len(_HINTS) < 128 or hostname in _HINTS:
            values = _HINTS.setdefault(hostname, {})
            for ip in candidates:
                values[(ip, str(source)[:64], str(interface or '')[:64])] = now + min(300, max(5, ttl))
            while len(values) > 24:
                del values[min(values, key=values.get)]


def invalidate():
    """A network transition invalidates routes, never reviewed identities."""
    global _GENERATION
    with _LOCK:
        _GENERATION += 1
        _HINTS.clear(); _DNS.clear(); _VERIFIED.clear()


def note_verified(hostname, port, address):
    if stable_name(hostname) and private_ip(address):
        with _LOCK:
            if len(_VERIFIED) >= 128 and (hostname, port) not in _VERIFIED:
                del _VERIFIED[next(iter(_VERIFIED))]
            _VERIFIED[(hostname, port)] = (address, time.monotonic()+120)


def _dns(hostname, port, wait):
    """Bound caller latency and outstanding resolver workers, including hung OS DNS."""
    key = (hostname, port)
    with _LOCK:
        cached = _DNS.get(key)
        if cached and cached[0] > time.monotonic():
            return list(cached[1])
        pending = _DNS_PENDING.get(key)
        if pending is None and len(_DNS_PENDING) < 128 and _DNS_SLOTS.acquire(blocking=False):
            event, generation = threading.Event(), _GENERATION
            _DNS_PENDING[key] = pending = (event, generation)
            def lookup():
                values = []
                try:
                    values = [row[4][0] for row in socket.getaddrinfo(hostname, port, socket.AF_INET, socket.SOCK_STREAM)]
                    values = list(dict.fromkeys(ip for value in values if (ip := private_ip(value))))[:8]
                except OSError:
                    pass
                finally:
                    with _LOCK:
                        if generation == _GENERATION:
                            if len(_DNS) >= 128 and key not in _DNS:
                                del _DNS[next(iter(_DNS))]
                            _DNS[key] = (time.monotonic()+(60 if values else 5), values)
                        if _DNS_PENDING.get(key) is pending:
                            _DNS_PENDING.pop(key, None)
                    event.set()
                    _DNS_SLOTS.release()
            threading.Thread(target=lookup, daemon=True, name='tli-lan-resolve').start()
    if pending:
        pending[0].wait(max(0, min(.5, wait)))
    with _LOCK:
        cached = _DNS.get(key)
        return list(cached[1]) if cached and cached[0] > time.monotonic() else []


def resolve(hostname, port):
    literal = private_ip(hostname)
    if literal:
        return [literal]
    if not stable_name(hostname):
        raise ValueError("Unreviewed DNS authority")
    with _LOCK:
        saved = _HINTS.get(hostname, {})
        candidates = list(dict.fromkeys(key[0] for key, expires in saved.items() if expires > time.monotonic()))
        preferred = _VERIFIED.get((hostname, port))
    candidates.extend(_dns(hostname, port, .1 if candidates else .5))
    if preferred and preferred[1] > time.monotonic():
        candidates = [preferred[0]] + [ip for ip in candidates if ip != preferred[0]]
    # Resolve once, validate every socket destination, then connect numerically.
    return list(dict.fromkeys(ip for value in candidates if (ip := private_ip(value))))[:8]


class LANHTTPSConnection(http.client.HTTPSConnection):
    def connect(self):
        if self._tunnel_host:
            raise OSError("LAN proxies are unsupported")
        last = None
        identity_error = None
        deadline = time.monotonic() + float(self.timeout)
        fixed = getattr(self, 'route_addresses', None)
        if fixed is not None:
            if not isinstance(fixed, (list, tuple)) or not 1 <= len(fixed) <= 8 or any(not private_ip(ip) for ip in fixed):
                raise ValueError('Invalid fixed LAN route')
            addresses = list(dict.fromkeys(fixed))
        else:
            addresses = resolve(self.host, self.port)
        for index, address in enumerate(addresses):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if identity_error is not None:
                    raise identity_error
                raise TimeoutError('LAN connection deadline expired')
            try:
                # Reserve time for alternatives before any authenticated bytes.
                attempt = min(1.0, remaining / min(4, len(addresses)-index)) if len(addresses)-index > 1 else remaining
                raw = socket.create_connection((address, self.port), attempt, self.source_address)
                try:
                    raw.settimeout(max(.001, min(attempt, deadline - time.monotonic())))
                    self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
                    self.route_address = address
                    verifier = getattr(self, 'verify_peer', None)
                    if verifier:
                        # A socket timeout is per read; also bound a slow-drip
                        # public identity response before authenticated bytes.
                        secured = self.sock
                        expired = threading.Event()
                        def expire(secured=secured, expired=expired):
                            expired.set()
                            try:
                                secured.shutdown(socket.SHUT_RDWR)
                            except OSError:
                                pass
                        timer = threading.Timer(max(.001, min(attempt, deadline-time.monotonic())), expire)
                        timer.daemon = True
                        timer.start()
                        try:
                            verifier(self)
                        finally:
                            timer.cancel()
                        if expired.is_set() or time.monotonic() >= deadline:
                            raise TimeoutError('LAN identity verification deadline expired')
                        note_verified(self.host, self.port, address)
                    self.sock.settimeout(max(.001, deadline-time.monotonic())) if hasattr(self.sock, 'settimeout') else None
                except Exception:
                    raw.close()
                    raise
                return
            except Exception as exc:
                self.close()
                last = exc
                detail = getattr(exc, 'detail', None)
                if isinstance(exc, ssl.SSLCertVerificationError) or (isinstance(detail,dict) and detail.get('code') in {'peer_identity_changed','peer_certificate_changed'}):
                    identity_error = exc
        if identity_error is not None:
            raise identity_error
        if last is not None:
            raise last
        raise RouteResolutionError("No current private route for this reviewed LAN name")


def connection(hostname):
    return LANHTTPSConnection if stable_name(hostname) else http.client.HTTPSConnection
