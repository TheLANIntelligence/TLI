"""Public connection invitations. Import supplies hints, never saved trust.

The existing signed-card and bilateral comparison protocol remains the only
approval path. This module can export invitations in the compute-only Node.
"""
from __future__ import annotations

import base64
import json
import re
from urllib.parse import urlsplit

import lan_endpoints
import node_identity
import peer_trust as P
import tli_state as S

PROTOCOL = 'tli-connection-invitation-v1'
PREFIX = 'TLI-CONNECT-1.'
MAX_TEXT = 60000


def _addresses(values):
    if (not isinstance(values, list) or not 1 <= len(values) <= 8
            or any(not isinstance(value, str) or lan_endpoints.private_ip(value) != value for value in values)
            or len(set(values)) != len(values)):
        P.fail(422, 'invitation_routes', 'The invitation must contain 1–8 distinct private LAN addresses.')
    return list(values)


def encode(card, addresses):
    card = P.validate_card(card)
    values = _addresses(addresses)
    hostname = urlsplit(card['origin']).hostname
    if lan_endpoints.private_ip(hostname) and values != [hostname]:
        P.fail(422, 'invitation_routes', 'An IP connection invitation must use its exact reviewed address.')
    envelope = {'protocol': PROTOCOL, 'card': card, 'addresses': values}
    envelope['signature'] = node_identity.sign(P.canonical(envelope))
    # A mismatched local signer must not produce an unusable invitation.
    if not node_identity.verify(P.canonical({k: v for k, v in envelope.items() if k != 'signature'}),
                                envelope['signature'], card['public_key']):
        P.fail(409, 'invitation_identity', 'The local identity changed. Reopen connection setup.')
    text = PREFIX + base64.urlsafe_b64encode(P.canonical(envelope)).decode('ascii').rstrip('=')
    if len(text) > MAX_TEXT:
        P.fail(413, 'invitation_limit', 'This public invitation exceeds the supported size.')
    return text


def decode(text):
    if not isinstance(text, str) or len(text) > MAX_TEXT:
        P.fail(422, 'invitation_invalid', 'Paste a TLI connection invitation.')
    text = text.strip()
    if not text.startswith(PREFIX) or not re.fullmatch(r'[A-Za-z0-9_-]+', text[len(PREFIX):]):
        P.fail(422, 'invitation_invalid', 'Paste the complete TLI connection invitation.')
    try:
        encoded = text[len(PREFIX):]
        raw = base64.b64decode(encoded + '=' * (-len(encoded) % 4), altchars=b'-_', validate=True)
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError('Duplicate field')
                result[key] = value
            return result
        value = json.loads(raw, object_pairs_hook=unique)
    except (ValueError, UnicodeError, RecursionError):
        P.fail(422, 'invitation_invalid', 'This connection invitation is unreadable.')
    if (not isinstance(value, dict) or set(value) != {'protocol', 'card', 'addresses', 'signature'}
            or value['protocol'] != PROTOCOL):
        P.fail(422, 'invitation_invalid', 'This invitation format is unsupported. Update both computers.')
    card = P.validate_card(value['card'])
    addresses = _addresses(value['addresses'])
    hostname = urlsplit(card['origin']).hostname
    if lan_endpoints.private_ip(hostname) and addresses != [hostname]:
        P.fail(422, 'invitation_routes', 'The invitation address does not match its public card.')
    if not node_identity.verify(P.canonical({k: v for k, v in value.items() if k != 'signature'}),
                                value['signature'], card['public_key']):
        P.fail(403, 'invitation_signature', 'The public invitation signature could not be verified.')
    return card, addresses


def export(origin=None):
    import tls_cert
    origins = tls_cert.stable_lan_origins(S.server_port())
    addresses = tls_cert.lan_listener_addresses()
    origins += [f'https://{ip}:{S.server_port()}' for ip in addresses]
    if not origins or origin is not None and origin not in origins:
        P.fail(409, 'invitation_setup', 'Enable secure LAN access before creating a connection invitation.')
    selected = origin or origins[0]
    card = P.local_card(selected, existing_only=True)
    host = urlsplit(selected).hostname
    routes = [host] if lan_endpoints.private_ip(host) else addresses[:8]
    return {'protocol': PROTOCOL, 'invitation': encode(card, routes), 'origin': selected}


def import_invitation(text):
    card, addresses = decode(text)
    if card['node_id'] == S.load_node_config().node_id or card['public_key'] == node_identity.public_key_hex():
        P.fail(422, 'same_computer', 'Use the invitation from the other computer.')
    # Host-only import; the Node export path never imports discovery or routers.
    import lan_discovery
    port = urlsplit(card['origin']).port
    for address in addresses:
        lan_discovery._upsert_peer(card['node_id'], card['name'], address, port,
                                  endpoint_origin=card['origin'], advertised_capabilities=card['capabilities'], source='invitation')
    entry = S.load_mesh_directory().get(card['node_id'], {})
    return {'protocol': PROTOCOL, 'device_id': card['node_id'], 'name': card['name'],
            'peer_profile': 'inference_node' if card['capabilities'] == P.INFERENCE_CAPABILITIES else 'full_host',
            'review_update': entry.get('status') == 'blocked' or bool(entry.get('peer_trust')),
            'trust_granted': False}
