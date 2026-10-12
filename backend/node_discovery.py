"""Optional DNS-SD advertisement for the compute-only process; no host services.

This exposes a public routing hint and never reads/changes reviewed peer grants.
Adapter changes replace the advertisement while its saved name/key/pin stay fixed.
"""
from __future__ import annotations

import json
import secrets
import socket
import threading
import time
from urllib.parse import urlsplit

import lan_endpoints
import tls_cert

SERVICE_TYPE = '_tli._tcp.local.'


def private_adapters():
    import psutil
    stats = psutil.net_if_stats()
    return sorted({ip for name, values in psutil.net_if_addrs().items() if name not in stats or stats[name].isup
                   for value in values if value.family == socket.AF_INET and (ip := lan_endpoints.private_ip(value.address))})


class Advertiser:
    def __init__(self, marker):
        self.marker = dict(marker)
        self.stop_event = threading.Event()
        self.lock = threading.RLock()
        self.thread = None
        self.zeroconf = self.service = self.signature = None
        self.generation = secrets.token_hex(12)

    def close(self):
        with self.lock:
            zeroconf, service = self.zeroconf, self.service
            self.zeroconf = self.service = self.signature = None
            if zeroconf:
                try:
                    if service:
                        zeroconf.unregister_service(service)
                finally:
                    zeroconf.close()

    def refresh(self, force=False):
        try:
            from zeroconf import Zeroconf, ServiceInfo, IPVersion
        except ImportError:
            return False
        try:
            origin = self.marker['origin']
            parsed = urlsplit(origin)
            addresses = private_adapters()
            if not lan_endpoints.stable_name(parsed.hostname):
                addresses = [ip for ip in addresses if ip == parsed.hostname]
                name = socket.gethostname().rstrip('.').lower()
                hostname = name if name.endswith('.local') else name + '.local'
            else:
                hostname = parsed.hostname
                # Changed hostnames/certificates are never advertised as the old identity.
                if origin not in tls_cert.stable_lan_origins(parsed.port):
                    addresses = []
            signature = (tuple(addresses), hostname, parsed.port, self.generation)
            with self.lock:
                if self.stop_event.is_set() or (not force and self.signature == signature):
                    return True
                self.close()
                if not addresses:
                    return True
                self.zeroconf = Zeroconf(interfaces=addresses, ip_version=IPVersion.V4Only)
                self.service = ServiceInfo(SERVICE_TYPE, self.marker['node_id'] + '.' + SERVICE_TYPE,
                    addresses=[socket.inet_aton(ip) for ip in addresses], port=parsed.port, server=hostname+'.',
                    properties={'id':self.marker['node_id'], 'name':self.marker['name'], 'origin':origin, 'tls':'1',
                                'endpoint_protocol':'tli-endpoint-v1', 'capabilities':json.dumps(['inference_v1'],separators=(',',':')),
                                'discovery_generation':self.generation})
                self.zeroconf.register_service(self.service, allow_name_change=False)
                self.signature = signature
            return True
        except Exception:
            self.close()
            # Public card exchange remains available if multicast is unavailable.
            return True

    def _loop(self):
        previous = None
        last, renewed = time.time(), time.monotonic()
        while not self.stop_event.is_set():
            now, adapters = time.time(), tuple(private_adapters())
            changed = previous is not None and (adapters != previous or now-last > 15 or now < last)
            force = changed or time.monotonic()-renewed > 300
            if changed:
                self.generation = secrets.token_hex(12)
                lan_endpoints.invalidate()
            if force:
                renewed = time.monotonic()
            if not self.refresh(force=force):
                return
            previous, last = adapters, now
            self.stop_event.wait(5)

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._loop, name='tli-node-mdns', daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.close()
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(2)
