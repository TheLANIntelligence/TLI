# backend/tls_cert.py
# Self-signed TLS certificate generator for TLI local HTTPS.
#
# On first run, generates a 2048-bit RSA cert valid for 10 years.
# SANs include localhost, the machine hostname, hostname.local, and all
# detected local IPv4 addresses so LAN access by IP also works.
#
# Users accessing from another device will see an "untrusted cert" warning
# the first time and need to click through once (or trust the cert).
# The cert file is served at /system/tls/cert so it can be downloaded and
# added to other devices' trust stores.
#
# Set env TLI_NO_TLS=1 to disable and fall back to plain HTTP.

from __future__ import annotations

import ipaddress
import os
import socket
from pathlib import Path


def ensure_tls_cert(cert_path: str, key_path: str) -> bool:
    """
    Ensure a self-signed TLS cert exists.  Generates one if missing.
    Returns True when the cert is ready (existing or freshly generated).
    Returns False if generation fails — caller falls back to HTTP.
    """
    if os.path.exists(cert_path) and os.path.exists(key_path):
        return True

    try:
        import datetime

        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID

        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

        hostname = socket.gethostname()
        subject = issuer = x509.Name([
            x509.NameAttribute(NameOID.COMMON_NAME, "TLI Local"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "TheLANIntelligence"),
        ])

        san: list = [
            x509.DNSName("localhost"),
            x509.DNSName(hostname),
            x509.DNSName(f"{hostname}.local"),
            x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
        ]
        for ip_str in _local_ipv4_addresses():
            try:
                san.append(x509.IPAddress(ipaddress.IPv4Address(ip_str)))
            except Exception:
                pass

        cert = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(datetime.datetime.utcnow())
            .not_valid_after(datetime.datetime.utcnow() + datetime.timedelta(days=3650))
            .add_extension(x509.SubjectAlternativeName(san), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .sign(key, hashes.SHA256())
        )

        Path(cert_path).parent.mkdir(parents=True, exist_ok=True)

        with open(cert_path, "wb") as f:
            f.write(cert.public_bytes(serialization.Encoding.PEM))
        with open(key_path, "wb") as f:
            f.write(key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.TraditionalOpenSSL,
                serialization.NoEncryption(),
            ))

        print(f"[TLS] Certificate generated → {cert_path}", flush=True)
        return True

    except Exception as e:
        print(f"[TLS] Could not generate certificate: {e}", flush=True)
        return False


def _local_ipv4_addresses() -> list[str]:
    """Return all local IPv4 addresses detected on this machine."""
    ips: set[str] = set()
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None):
            addr = info[4][0]
            try:
                ipaddress.IPv4Address(addr)
                ips.add(addr)
            except Exception:
                pass
    except Exception:
        pass
    return list(ips)
