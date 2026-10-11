"""Independent optional HTTPS helper. Run locally via TLI_Setup.ps1 -Action StartHelper."""
from __future__ import annotations

from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import socket
import ssl
import threading
import time
from urllib.parse import parse_qs, urlsplit

import host_control as H


class HelperServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False
    request_queue_size = 8

    def __init__(self, address, controller, context):
        self.controller, self.tls_context = controller, context
        self.slots, self.rates, self.rate_lock = threading.BoundedSemaphore(8), OrderedDict(), threading.Lock()
        super().__init__(address, Handler)

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            request.close(); return
        super().process_request(request, address)

    def process_request_thread(self, request, address):
        try:
            request.settimeout(3)
            with self.tls_context.wrap_socket(request, server_side=True) as secure:
                super().process_request_thread(secure, address)
        except (OSError, ssl.SSLError):
            request.close()
        finally:
            self.slots.release()

    def rate_allowed(self, address):
        now = time.monotonic()
        with self.rate_lock:
            values = [stamp for stamp in self.rates.pop(address, []) if now - stamp < 60]
            allowed = len(values) < 60
            values.append(now)
            self.rates[address] = values[-61:]
            while len(self.rates) > 256:
                self.rates.popitem(last=False)
            return allowed


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "TLI-Host-Start/1"
    sys_version = ""

    def log_message(self, *args):
        pass  # never log bearer credentials, request bodies, or private names

    def respond(self, status, value):
        raw = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(raw)
        self.close_connection = True

    def execute(self, mutation=False):
        try:
            if not isinstance(self.connection, ssl.SSLSocket):
                H._fail("HTTPS is required.", 403)
            if not self.server.rate_allowed(self.client_address[0]):
                H._fail("Too many helper requests. Wait one minute.", 429)
            if self.headers.get("Origin") is not None or self.headers.get("Transfer-Encoding") is not None:
                H._fail("This endpoint accepts only the reviewed native helper request.", 403)
            headers = self.headers.get_all("Authorization", [])
            if len(headers) != 1 or not headers[0].startswith("Bearer "):
                H._fail("A restricted host-start credential is required.", 401)
            token = headers[0][7:]
            url = urlsplit(self.path)
            if url.scheme or url.netloc or url.fragment:
                H._fail("Unsupported request target.", 404)
            if mutation:
                if url.path != H.PREFIX + "/start" or url.query:
                    H._fail("Unsupported helper operation.", 404)
                lengths = self.headers.get_all("Content-Length", [])
                if len(lengths) != 1 or not lengths[0].isdigit() or not 1 <= int(lengths[0]) <= 2048 or self.headers.get_content_type() != "application/json":
                    H._fail("A bounded JSON request is required.", 422)
                # Authenticate before reading any body; revoked credentials cannot
                # cause intent receipts, port inspection or process creation.
                H.authorize(self.server.controller.root, token)
                raw = self.rfile.read(int(lengths[0]))
                payload = H.decode_json(raw)
                value = self.server.controller.start(token, payload)
                self.respond(202 if value["backend_state"] == "starting" else 200, value)
            else:
                query = parse_qs(url.query, strict_parsing=True)
                if url.path != H.PREFIX + "/status" or set(query) != {"helper_id", "node_id"} or any(len(values) != 1 for values in query.values()):
                    H._fail("Name the reviewed helper and host for this status request.", 422)
                self.respond(200, self.server.controller.status(token, query["helper_id"][0], query["node_id"][0]))
        except H.HostControlError as error:
            self.respond(error.status, {"schema_version": 1, "detail": error.detail})
        except (ValueError, UnicodeError):
            self.respond(422, {"schema_version": 1, "detail": "Invalid helper request."})
        except Exception:
            self.respond(503, {"schema_version": 1, "detail": "Helper state is unavailable. Inspect setup locally; nothing was automatically retried."})

    def do_GET(self):
        self.execute()

    def do_POST(self):
        self.execute(True)


def tls_context(root):
    H.config(root)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(str(root / "data/tls/cert.pem"), str(root / "data/tls/key.pem"))
    return context


def serve(root):
    root = H.root_path(root)
    with H.FileLock(H.path_for(root, "helper.lock")):
        cfg = H.config(root)
        # Stop is a local filesystem lifecycle command, never a network endpoint.
        H.write_json(H.path_for(root, "stop.json"), {"helper_id": None})
        controller = H.Controller(root)
        with HelperServer(("0.0.0.0", cfg["port"]), controller, tls_context(root)) as server:
            server.timeout = 0.5
            print("TLI host-start helper listening with HTTPS; no backend start requested.", flush=True)
            while True:
                try:
                    current = H.config(root)
                    stop = H.read_json(H.path_for(root, "stop.json"), 16384)
                    if current["helper_id"] != cfg["helper_id"] or stop.get("helper_id") == cfg["helper_id"]:
                        break
                except Exception:
                    break  # disabling/PIN/TLS/identity changes terminate helper
                server.handle_request()


if __name__ == "__main__":
    from pathlib import Path
    try:
        serve(Path(__file__).resolve().parent.parent)
    except Exception as error:
        print("Host-start helper stopped: " + str(getattr(error, "detail", error)), flush=True)
        raise SystemExit(1)
