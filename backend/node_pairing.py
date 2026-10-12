"""Opt-in, expiring Node pairing with approval exclusively in the local console.

The object itself is the approval authority; no request header, cookie, peer
signature or remote route can acquire it. Closed objects remain installed so a
late request can never fall through to the full-host pairing policy.
"""
from __future__ import annotations

import json
import secrets
import threading
import time
from contextlib import contextmanager

from fastapi import HTTPException
from starlette.requests import Request

import peer_pairing as pairing
import peer_trust as P
import tli_state as S


class PairingWindow:
    def __init__(self, marker, *, review_update=False, read_line=None, write_line=None):
        self.marker = dict(marker)
        self.review_update = review_update is True
        self.read_line = read_line or input
        self.write_line = write_line or (lambda line: print(line, flush=True))
        self.closed = True
        self.accepting = True
        self.expires = 0
        self.stop_event = threading.Event()
        self.thread = None
        # This credential exists only in process, never on a network or disk.
        self._request = Request({'type':'http', 'method':'POST', 'path':'/local-node-console', 'scheme':'https',
            'headers':[(b'cookie', ('tli_session='+secrets.token_hex(32)).encode())], 'query_string':b''})

    def start(self, *, console=True):
        with P.LOCK:
            if pairing._NODE_PAIRING is not None and pairing._NODE_PAIRING is not self:
                raise RuntimeError('Another Node pairing policy is already installed.')
            if self.expires:
                raise RuntimeError('A Node pairing window cannot be reopened.')
            self.closed = False
            self.expires = time.monotonic() + pairing.TTL
            pairing._NODE_PAIRING = self
        if console:
            self.thread = threading.Thread(target=self._console, name='tli-node-pairing', daemon=True)
            self.thread.start()

    def check(self, *, incoming=False, init=None):
        if pairing._NODE_PAIRING is not self or self.closed or time.monotonic() >= self.expires:
            pairing._fail(404, 'pairing_window_closed', 'The Node pairing window is closed. Start it locally with run --pair.')
        if incoming:
            if not self.accepting:
                pairing._fail(409, 'pairing_window_used', 'This Node pairing window already approved a connection.')
            if (not isinstance(init, dict) or init.get('protocol') != pairing.PROTOCOL_V2
                    or init.get('grants') != ['inference']):
                pairing._fail(422, 'pairing_inference_only', 'This Node pairs with updated full TLI hosts for inference only.')
            if init.get('review_update') is True and not self.review_update:
                pairing._fail(409, 'pairing_local_review_required', 'Restart Node pairing with --review-update to review a replacement locally.')
            if any(item.get('node_authority') is self and not item['cancelled'] and item['expires'] > time.monotonic()
                   for item in pairing._REQUESTS.values()):
                pairing._fail(409, 'pairing_exists', 'Review the pending request in the Node terminal before accepting another.')

    def validate_local_card(self, card):
        self.check()
        if (card['capabilities'] != P.INFERENCE_CAPABILITIES
                or any(card[key] != self.marker[key] for key in ('origin', 'node_id', 'name', 'identity_fingerprint', 'certificate_sha256'))):
            pairing._fail(409, 'pairing_local_changed', 'The saved Node identity or certificate changed. Stop and review the Node locally.')

    def local_setup(self):
        self.check()
        from tls_cert import lan_listener_addresses, stable_lan_origins
        import lan_endpoints
        from urllib.parse import urlsplit
        origin = self.marker['origin']
        parsed = urlsplit(origin)
        available = bool(S.TLS_ENABLED and parsed.port == S.server_port() and (
            origin in stable_lan_origins(parsed.port) if lan_endpoints.stable_name(parsed.hostname)
            else parsed.hostname in lan_listener_addresses()))
        if not available:
            pairing._fail(409, 'pairing_local_changed', 'The Node listener or private LAN adapter changed. Start a fresh connection review.')
        self.validate_local_card(P.local_card(origin, capabilities=P.INFERENCE_CAPABILITIES, existing_only=True))
        return {'ready':True, 'code':'ready', 'reason':None, 'origins':[origin], 'selected_origin':origin}

    def _owned(self, request_id):
        self.check()
        pairing._clean()
        item = pairing._REQUESTS.get(request_id)
        if not item or item.get('node_authority') is not self or item['direction'] != 'incoming':
            pairing._fail(404, 'pairing_expired', 'This Node connection request expired or belongs to another console.')
        pairing._local_unchanged(item, self._request)
        return item

    def views(self):
        with P.LOCK:
            self.check()
            pairing._clean()
            return [pairing._view(item) for item in pairing._REQUESTS.values()
                    if item.get('node_authority') is self and item['transcript'] and not item['cancelled']]

    def confirm(self, request_id, code):
        self.check()
        with self._admin_lock(), P.LOCK:
            item = self._owned(request_id)
            if item['init']['protocol'] != pairing.PROTOCOL_V2 or item['init'].get('grants') != ['inference']:
                pairing._fail(422, 'pairing_inference_only', 'Only the reviewed inference permission can be approved.')
            if item['init'].get('review_update') and not self.review_update:
                pairing._fail(409, 'pairing_local_review_required', 'This console was not opened for replacement review.')
            self.check()
            result = pairing._confirm(item, code, True, 'local-node-console', self._request, grants=['inference'])
            self.accepting = False
            return result

    @contextmanager
    def _admin_lock(self):
        # Trust/revoke are separate local CLI processes. Their OS lock makes the
        # revision comparison and write atomic against those legitimate writers.
        from tli_node import NodeError, _lock, _root
        try:
            with _lock(_root(S.BASE_DIR), '.node-admin.lock'):
                yield
        except NodeError:
            pairing._fail(409, 'pairing_local_busy', 'Another local Node administration command is active. Start a fresh review.')

    def decline(self, request_id):
        with P.LOCK:
            self._owned(request_id)['cancelled'] = True

    def stop(self):
        self.stop_event.set()
        with P.LOCK:
            self.closed = True
            # Do not clear pairing._NODE_PAIRING: its closed policy fails shut.
            for item in pairing._REQUESTS.values():
                if item.get('node_authority') is self and not item['local_confirmed']:
                    item['cancelled'] = True

    def _console(self):
        self.write_line('Node pairing is open for five minutes. On the full TLI host, choose Connect device > Inference Node.')
        self.write_line('Only inference can be approved here. Compare the entire code on both screens.')
        if self.review_update:
            self.write_line('Replacement review is enabled. Confirmation replaces the saved peer identity, certificate and inference permission.')
        shown = set()
        try:
            while not self.stop_event.wait(0.25):
                rows = self.views()
                for row in rows:
                    if row['request_id'] in shown:
                        continue
                    shown.add(row['request_id'])
                    # Remote names/IDs may contain control characters. JSON
                    # quoting prevents terminal escape sequences or fake prompts.
                    safe = lambda value: json.dumps(value, ensure_ascii=True)
                    self.write_line('Host: '+safe(row['peer']['name'])+'  ID: '+safe(row['peer']['id']))
                    self.write_line('HTTPS: '+safe(row['peer']['origin']))
                    self.write_line('Permission: inference only. Code: '+row['code'])
                    if row['review_update']:
                        self.write_line('This replaces saved trust for this host. Compare on the intended host screen before approving.')
                    response = self.read_line('Type '+row['code']+' to approve inference, or anything else to decline: ')
                    try:
                        if response.strip().upper() == row['code']:
                            self.confirm(row['request_id'], row['code'])
                            self.write_line('Inference permission saved here. Confirm the matching code on the host. New requests are now closed; status remains available until this window expires.')
                            return
                        self.decline(row['request_id'])
                        self.write_line('Request declined. No permission was granted.')
                    except HTTPException:
                        self.write_line('This review expired or changed. No new permission was granted; start a fresh review.')
        except (EOFError, KeyboardInterrupt):
            self.write_line('Local input ended. The Node pairing window is closed.')
        except HTTPException:
            self.write_line('The five-minute Node pairing window is closed. Inference continues for reviewed peers.')
        finally:
            if self.accepting:
                self.stop()
