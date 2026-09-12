"""Bounded read-only checks of saved owner data, not backup certification."""
from __future__ import annotations

import base64
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import data_protection as protection
import tli_state as S
from intelligence.store import LOCK

MAX_STORE_BYTES = 16 * 1024 * 1024


class CheckLimit(Exception):
    pass


def _host():
    """Identify the existing host without configuration initialization helpers."""
    fallback = {'id': 'unknown', 'name': 'Unknown TLI host'}
    try:
        with Path(S.NODE_CONFIG_PATH).open('rb') as handle:
            raw = handle.read(64 * 1024 + 1)
        if len(raw) > 64 * 1024:
            return fallback
        cfg = S.NodeConfig.model_validate(json.loads(raw))
        if not cfg.node_id or len(cfg.node_id) > 256:
            return fallback
        name = cfg.node_name
    except Exception:
        return fallback
    # Device names may override the node label. Failure to read optional name
    # metadata does not change or invent the persisted node identity.
    try:
        with (Path(S.DATA_DIR) / 'intelligence' / 'device_context.json').open('rb') as handle:
            raw = handle.read(1024 * 1024 + 1)
        if len(raw) <= 1024 * 1024:
            override = json.loads(raw).get(f'node-{cfg.node_id}', {}).get('name')
            if isinstance(override, str) and override.strip():
                name = override
    except Exception:
        pass
    return {'id': cfg.node_id, 'name': (name or 'TLI host')[:256]}


def _read(path: Path, key_name: str, aad=None):
    with path.open('rb') as handle:
        raw = handle.read(MAX_STORE_BYTES + 1)
    if len(raw) > MAX_STORE_BYTES:
        raise CheckLimit()
    value = json.loads(raw)
    encrypted = isinstance(value, dict) and bool(value.get('_tli_enc'))
    if encrypted:
        blob = base64.b64decode(value['data'], validate=True)
        key = protection.load_existing_key(Path(S.DATA_DIR) / key_name)
        value = json.loads(AESGCM(key).decrypt(blob[:12], blob[12:], aad))
    return value, encrypted


def _valid(value, kind, owner):
    if kind == 'notebook':
        from memory_validation import validate_memory_structure
        validate_memory_structure(value)
        return bool(value['facts'])
    if kind == 'conversations':
        if not isinstance(value, dict) or any(not isinstance(c, dict) or not isinstance(c.get('messages', []), list) for c in value.values()):
            raise ValueError('Invalid conversations')
        allowed = {'local', 'bundled-ai'} if owner == 'local' else {owner}
        return any(c.get('user_id') in allowed for c in value.values())
    if not isinstance(value, list) or any(not isinstance(r, dict) for r in value):
        raise ValueError('Invalid diagnostic history')
    return bool(value)


def _check(kind, label, path, key_name, owner, aad=None):
    row = {'id': kind, 'label': label}
    try:
        # Keep missing stores distinct from a missing encryption key. No helper
        # here is permitted to initialize keys or create a storage directory.
        try:
            path.stat()
        except FileNotFoundError:
            return {**row, 'status': 'not_created', 'detail': 'No saved data was found for this account in this area. This does not verify any backup.'}
        value, encrypted = _read(path, key_name, aad)
        if kind == 'diagnostics' and not encrypted:
            raise ValueError('Diagnostic history requires its encrypted envelope')
        owns_data = _valid(value, kind, owner)
        if not owns_data:
            return {**row, 'status': 'not_created', 'detail': 'No saved entries were found for this account in this area. This does not verify any backup.'}
        return {**row, 'status': 'readable', 'detail':
                'The saved data can be read using the persisted key on this host. This is not a backup or a restore test.' if encrypted else
                'The saved data can be read. It uses an older unencrypted format; this check leaves it unchanged. This is not a backup or a restore test.'}
    except CheckLimit:
        return {**row, 'status': 'not_checked', 'detail': 'This store exceeds the 16 MiB inspection limit. Its contents were not fully checked or changed.'}
    except Exception:
        return {**row, 'status': 'unavailable', 'detail': 'The saved data or its matching encryption key could not be read. This check changed no files. Keep the originals and follow the recovery guidance below.'}


def inspect(owner: str):
    with LOCK:
        notes = _check('notebook', 'Household Notebook', Path(S.memory_path_for_user(owner)), 'memory_key.bin', owner)
        diagnostics = _check('diagnostics', 'Saved diagnostic reports',
                             Path(S.DATA_DIR) / 'intelligence' / f'diagnostics-{hashlib.sha256(owner.encode()).hexdigest()}.json',
                             'memory_key.bin', owner, f'diagnostics:{owner}'.encode())
    with S.CONVERSATIONS_LOCK:
        conversations = _check('conversations', 'Conversation history', Path(S.CONVERSATIONS_FILE), 'conversations_key.bin', owner)
    host = _host()
    return {
        'schema_version': 1,
        'checked_at': datetime.now(timezone.utc).isoformat(),
        'host': {'id': host['id'], 'name': host['name']},
        'scope': 'A read-only check of saved Notebook, conversation and diagnostic data for your account on this TLI host. Vault contents, node identity, device configuration and other files are not inspected.',
        'checks': [notes, conversations, diagnostics],
        'backup': {'status': 'unknown', 'detail': 'This saved-data check does not verify a backup or a live restoration. A separate uploaded Notebook & history archive can be verified in desktop Settings; that result applies only to that archive and its named scope. Companion is not a separate copy of your saved data.'},
        'guidance': {
            'summary': 'Keep a separate copy before upgrading or attempting recovery. These manual full-installation steps are guidance; this saved-data check does not copy, export, restore or reset data. The separate Notebook & history backup controls cover only their explicitly named areas.',
            'steps': [
                'On the TLI host, record the installation location, the operating-system account that runs it, and any separately configured model or data locations. Keep the Vault passphrase safe and separate from the backup.',
                'Stop TLI normally and wait for it to exit before copying files, so the saved files and their encryption keys come from the same stopped installation.',
                'Copy the installation and its complete data folder, including encryption keys, to a separate protected destination. Include legacy vault_meta.json from the folder TLI was launched in; copying data alone can miss that file. Include separately configured data locations. Model weights alone do not protect your saved data.',
                'Keep the original installation and backup intact. Test a separate copy using the matching TLI version and original operating-system account. Never extract a backup over a running installation or merge encryption keys from different copies.',
                'If data is unavailable, preserve the files and matching keys. Check storage access, the original account and your backup. Do not delete a key, reset the Vault or initialize replacement data as a recovery shortcut.'
            ],
            'limitations': [
                'Windows-protected keys are bound to the original Windows account and installation context. Copying files to a different computer or creating an account with the same name does not establish decryptability. This is not a portable recovery archive.',
                'A successful check proves only that the selected saved areas are readable at the displayed time. It does not prove backup completeness, future readability, Vault passphrase recovery or restoration on another platform.',
                'The existing Vault encrypted-file export covers Vault files, not this entire installation or the Notebook, conversations, pairing and model configuration. A lost Vault passphrase cannot be recovered by this screen.'
            ]
        }
    }
