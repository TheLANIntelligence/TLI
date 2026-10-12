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
# HTTPS is explicitly enabled with TLI_ENABLE_TLS=1. A requested but invalid
# HTTPS configuration must never fall back to HTTP.

from __future__ import annotations

import ipaddress
import os
import socket
import base64
from datetime import datetime, timezone
from pathlib import Path


def validate_tls_certificate(cert_path: str, key_path: str):
    """Read a usable matching certificate/key without repairing or replacing it."""
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization

    try:
        cert = x509.load_pem_x509_certificate(Path(cert_path).read_bytes())
        key = serialization.load_pem_private_key(Path(key_path).read_bytes(), password=None)
    except Exception as exc:
        raise ValueError("TLI's HTTPS certificate or private key is missing or invalid. Repair it on the desktop.") from exc
    now = datetime.now(timezone.utc)
    if now < cert.not_valid_before_utc or now >= cert.not_valid_after_utc:
        raise ValueError("TLI's HTTPS certificate is expired or not yet valid. Check the clock or renew it on the desktop.")
    pub_format = serialization.PublicFormat.SubjectPublicKeyInfo
    if key.public_key().public_bytes(serialization.Encoding.DER, pub_format) != cert.public_key().public_bytes(serialization.Encoding.DER, pub_format):
        raise ValueError("TLI's HTTPS certificate does not match its private key.")
    return cert


def certificate_bundle(cert_path: str, key_path: str, host: str) -> dict[str, str]:
    """Provision public trust material only for an address covered by the cert."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization

    cert = validate_tls_certificate(cert_path, key_path)
    try:
        names = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            matches = host.rstrip(".").casefold() in {name.rstrip(".").casefold() for name in names.get_values_for_type(x509.DNSName)}
        else:
            matches = address in names.get_values_for_type(x509.IPAddress)
    except x509.ExtensionNotFound:
        matches = False
    if not matches:
        raise ValueError("This LAN address is not covered by TLI's HTTPS certificate. Update the certificate on the desktop and pair again.")
    return {
        "certificate_der": base64.b64encode(cert.public_bytes(serialization.Encoding.DER)).decode("ascii"),
        "fingerprint": cert.fingerprint(hashes.SHA256()).hex(),
    }


def lan_listener_addresses() -> list[str]:
    """Private adapters actually covered by the running IPv4 listener."""
    import tli_state as S
    from lan_endpoints import private_ip
    bind = getattr(S, 'SERVER_BIND_HOST', None)
    if bind != '0.0.0.0' and not private_ip(bind):
        return []
    return sorted({ip for value in _local_ipv4_addresses() if (ip := private_ip(value))
                   and (bind == '0.0.0.0' or bind == ip)})


def stable_lan_origins(port: int) -> list[str]:
    """Existing certificate-covered machine names; never renew trust on a read."""
    import tli_state as S
    from lan_endpoints import stable_name
    if not S.TLS_ENABLED or not lan_listener_addresses():
        return []
    name = socket.gethostname().rstrip('.').lower()
    name = name if name.endswith('.local') else name + '.local'
    if not stable_name(name):
        return []
    try:
        certificate_bundle(S.TLS_CERT_PATH, S.TLS_KEY_PATH, name)
    except (ValueError, OSError):
        return []
    return [f"https://{name}:{port}"]


def ensure_tls_cert(cert_path: str, key_path: str) -> bool:
    """
    Ensure a self-signed TLS cert exists.  Generates one if missing.
    Returns True when the cert is ready (existing or freshly generated).
    Returns False if generation/validation fails. The caller must fail closed.
    """
    try:
        if os.path.exists(cert_path) or os.path.exists(key_path):
            validate_tls_certificate(cert_path, key_path)
            return True
        import datetime

        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID

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
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .sign(key, hashes.SHA256())
        )

        Path(cert_path).parent.mkdir(parents=True, exist_ok=True)

        Path(key_path).parent.mkdir(parents=True, exist_ok=True)
        # Exclusive creation preserves an existing identity, even if another
        # process initialized TLS while the certificate was being generated.
        descriptor = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as f:
            f.write(key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.TraditionalOpenSSL,
                serialization.NoEncryption(),
            ))
        with open(cert_path, "xb") as f:
            f.write(cert.public_bytes(serialization.Encoding.PEM))
        validate_tls_certificate(cert_path, key_path)

        print(f"[TLS] Certificate generated → {cert_path}", flush=True)
        return True

    except Exception as e:
        print(f"[TLS] Could not generate certificate: {e}", flush=True)
        return False


def _local_ipv4_addresses() -> list[str]:
    """Return all local IPv4 addresses detected on this machine."""
    ips: set[str] = set()
    try:
        import psutil
        for addresses in psutil.net_if_addrs().values():
            for address in addresses:
                if address.family == socket.AF_INET:
                    ips.add(str(ipaddress.IPv4Address(address.address)))
    except Exception:
        pass
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
    return sorted(ips)
