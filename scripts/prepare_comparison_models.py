"""Pinned catalogue weights for an explicitly requested, isolated comparison.

Writes only build_work/dependable-troubleshooting/model-weights. Never changes
TLI selection, live model files or runtime. No inference is started here.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'build_work/dependable-troubleshooting/model-weights'
PINS = [
 ('lite', 'bartowski/Qwen2.5-1.5B-Instruct-GGUF', '9eadc66189c7641e1ddd226b8267a9119b2ce2d4', 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf', 986048768, '1adf0b11065d8ad2e8123ea110d1ec956dab4ab038eab665614adba04b6c3370', 8),
 ('standard', 'bartowski/Qwen2.5-3B-Instruct-GGUF', 'f302c64a2269a69fb27b2f9473b362f5bb8e78d8', 'Qwen2.5-3B-Instruct-Q4_K_M.gguf', 1929903264, '9c9f56a391a3abbd5b89d0245bf6106081bcc3173119d4229235dd9d23253f94', 12),
 ('power', 'bartowski/Qwen2.5-7B-Instruct-GGUF', '8911e8a47f92bac19d6f5c64a2e2095bd2f7d031', 'Qwen2.5-7B-Instruct-Q4_K_M.gguf', 4683074240, '65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423', 16),
 ('qwen3_1_7b', 'Qwen/Qwen3-1.7B-GGUF', '90862c4b9d2787eaed51d12237eafdfe7c5f6077', 'Qwen3-1.7B-Q8_0.gguf', 1834426016, '061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a', 8),
 ('qwen3_4b', 'Qwen/Qwen3-4B-GGUF', 'bc640142c66e1fdd12af0bd68f40445458f3869b', 'Qwen3-4B-Q4_K_M.gguf', 2497280256, '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5', 12),
 ('qwen3_8b', 'Qwen/Qwen3-8B-GGUF', '7c41481f57cb95916b40956ab2f0b139b296d974', 'Qwen3-8B-Q4_K_M.gguf', 5027783488, 'd98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785', 16),
]


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        while chunk := stream.read(4 * 1024**2):
            digest.update(chunk)
    return digest.hexdigest()


def valid(path, size, digest):
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size != size:
            return False
        with path.open('rb') as stream:
            magic, version, tensors, metadata = struct.unpack('<4sIQQ', stream.read(24))
        return magic == b'GGUF' and version in (2, 3) and 0 < tensors < 1_000_000 and 0 < metadata < 1_000_000 and sha256(path) == digest
    except (OSError, ValueError, struct.error):
        return False


class PublisherRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, url):
        parsed = urllib.parse.urlsplit(url)
        host = (parsed.hostname or '').lower()
        if parsed.scheme != 'https' or parsed.username or parsed.password or not (
                host in ('huggingface.co', 'hf.co') or host.endswith('.huggingface.co') or host.endswith('.hf.co')):
            raise ValueError('The artifact redirected outside the approved publisher delivery hosts')
        return super().redirect_request(request, fp, code, msg, headers, url)


def install(row, destination, *, reuse=None, opener=None):
    """Stream to a new staged file; publish only exact pinned bytes, without replacement."""
    ident, repo, revision, filename, size, digest, minimum = row
    if not filename or Path(filename).name != filename or '/' in filename or '\\' in filename:
        raise ValueError('Evaluation artifact filename must stay inside its destination')
    target = destination / filename
    if target.exists():
        if valid(target, size, digest):
            return 'already_verified'
        raise ValueError('An existing evaluation file differs; it was retained')
    if shutil.disk_usage(destination).free < size + 2 * 1024**3:
        raise ValueError('Insufficient free space for the staged model and reserve')
    part = destination / (filename + '.part-' + uuid.uuid4().hex)
    source = reuse / filename if reuse else None
    copied = bool(source and valid(source, size, digest))
    url = f'https://huggingface.co/{repo}/resolve/{revision}/{filename}'
    try:
        stream = source.open('rb') if copied else (opener or urllib.request.build_opener(PublisherRedirect())).open(url, timeout=60)
        with stream, part.open('xb') as output:
            received = 0
            digesting = hashlib.sha256()
            next_progress = 256 * 1024**2
            while chunk := stream.read(4 * 1024**2):
                received += len(chunk)
                if received > size:
                    raise ValueError('Artifact exceeds its pinned size')
                output.write(chunk); digesting.update(chunk)
                if received >= next_progress:
                    print(json.dumps({'preset': ident, 'received_bytes': received, 'total_bytes': size}), flush=True)
                    next_progress += 256 * 1024**2
            output.flush(); os.fsync(output.fileno())
        if received != size or digesting.hexdigest() != digest or not valid(part, size, digest):
            raise ValueError('Artifact failed pinned size, checksum or GGUF validation')
        # Both names are on the same volume; hard-link publication cannot replace
        # a file created concurrently. The transient staging name is then removed.
        os.link(part, target)
        return 'copied_verified_existing' if copied else 'downloaded_verified'
    finally:
        part.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--reuse-model-dir', type=Path)
    args = parser.parse_args(argv)
    if not args.download:
        print(json.dumps({'pins': PINS, 'downloads_started': False}, indent=2)); return 0
    OUTPUT.mkdir(parents=True, exist_ok=True)
    if OUTPUT.is_symlink() or OUTPUT.resolve() != (ROOT / 'build_work/dependable-troubleshooting/model-weights').absolute():
        raise ValueError('The isolated evaluation directory is not a plain contained folder')
    import psutil
    from evaluate_isolated_model import resources
    # Read metadata only; no model is loaded by this compatibility preflight.
    manifest = {'schema_version': 1, 'created_at': datetime.now(timezone.utc).isoformat(),
                'live_selection_changed': False, 'runtime_started': False, 'models': []}
    for row in PINS:
        ident, repo, revision, filename, size, digest, minimum = row
        resource = resources(size, 4096)
        record = {'id': ident, 'repository': repo, 'revision': revision, 'filename': filename,
                  'size_bytes': size, 'sha256': digest, 'min_ram_gb': minimum,
                  'source_url': f'https://huggingface.co/{repo}/tree/{revision}',
                  'metadata_url': f'https://huggingface.co/api/models/{repo}/revision/{revision}?blobs=true',
                  'resources': resource, 'runtime_support': 'rechecked_before_evaluation'}
        try:
            if resource['total_ram_bytes'] < minimum * 1024**3 or not resource['sufficient']:
                record['status'] = 'insufficient_resources'
            else:
                record['status'] = install(row, OUTPUT, reuse=args.reuse_model_dir)
        except Exception as error:
            record.update(status='failed', error_type=type(error).__name__, detail='The evaluation artifact was not published; existing files remain unchanged.')
        manifest['models'].append(record)
        (OUTPUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'preset': ident, 'status': record['status']}), flush=True)
    return 0 if all(x['status'] in ('already_verified', 'copied_verified_existing', 'downloaded_verified') for x in manifest['models']) else 1


if __name__ == '__main__':
    raise SystemExit(main())
