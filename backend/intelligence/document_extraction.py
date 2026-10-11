"""Bounded host extraction of explicitly uploaded PDF/DOCX, without persistence.

The worker is a separate Python interpreter. OS limits precede document parsing;
it never imports TLI, resolves links, renders images, starts programs or uses AI.
"""
from __future__ import annotations

import hashlib
import hmac
import importlib.metadata
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import stat
import subprocess
import sys
import threading
import time
import unicodedata
import zipfile
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

PROTOCOL = "tli-document-extraction-v1"
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_TEXT_BYTES = 64 * 1024
MAX_ZIP_BYTES = 16 * 1024 * 1024
MAX_PART_BYTES = 4 * 1024 * 1024
MAX_ENTRIES = 1000
MAX_PAGES = 100
MAX_PARAGRAPHS = 500
TIMEOUT = 15
MAX_MEMORY = 512 * 1024 * 1024
MAX_REPLY = 256 * 1024
PROOF_TTL = 1800
_proof_key = secrets.token_bytes(32)
_slots = threading.BoundedSemaphore(2)
_worker_job = None

PDF_OMISSIONS = ["Text extraction only; no OCR or image contents.", "Reading order, columns, tables and formatting may differ from the page.", "Embedded attachments, annotations, scripts and external links are not loaded."]
DOCX_OMISSIONS = ["Main document paragraphs and table-cell text only; table layout is flattened.", "Headers, footers, footnotes, endnotes, comments, text boxes, drawings and embedded files are excluded.", "Deleted tracked text and field instructions are excluded; inserted text and existing field results may appear.", "Macros are rejected. External references are never opened or refreshed."]


class ReaderError(ValueError):
    """A deliberate, content-free extraction refusal safe to show to the user."""


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Unit(Strict):
    number: int = Field(ge=1, le=MAX_PARAGRAPHS)
    start: int = Field(ge=1, le=MAX_TEXT_BYTES)
    end: int = Field(ge=1, le=MAX_TEXT_BYTES)


class Origin(Strict):
    version: Literal[1]
    format: Literal["pdf", "docx"]
    original_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    original_bytes: int = Field(ge=1, le=MAX_FILE_BYTES)
    text_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    parser: str = Field(min_length=1, max_length=64)
    unit_kind: Literal["page", "paragraph"]
    total_units: int = Field(ge=1, le=MAX_PARAGRAPHS)
    units: list[Unit] = Field(min_length=1, max_length=MAX_PARAGRAPHS)
    empty_units: list[int] = Field(max_length=MAX_PARAGRAPHS)
    omissions: list[str] = Field(min_length=1, max_length=6)

    @model_validator(mode="after")
    def coherent(self):
        expected = PDF_OMISSIONS if self.format == "pdf" else DOCX_OMISSIONS
        if self.omissions != expected or self.unit_kind != ("page" if self.format == "pdf" else "paragraph") or self.format == "pdf" and self.total_units > MAX_PAGES:
            raise ValueError("Unsupported document extraction scope")
        numbers, line = [], 0
        for unit in self.units:
            if unit.number in numbers or unit.number > self.total_units or unit.start != line + 1 or unit.end < unit.start:
                raise ValueError("Invalid extracted origin ranges")
            numbers.append(unit.number); line = unit.end
        if numbers != sorted(numbers) or any(type(n) is not int for n in self.empty_units) or len(set(self.empty_units)) != len(self.empty_units):
            raise ValueError("Invalid empty origin ranges")
        if set(numbers).intersection(self.empty_units) or sorted(numbers + self.empty_units) != list(range(1, self.total_units + 1)):
            raise ValueError("Incomplete extraction coverage")
        return self


class Proof(Strict):
    origin: Origin
    expires_at: int = Field(ge=1)
    signature: str = Field(pattern=r"^[a-f0-9]{64}$")


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def _signature(user, name, origin, expiry):
    return hmac.new(_proof_key, _canonical([user, name, origin, expiry]), hashlib.sha256).hexdigest()


def verify(user, name, text, proof):
    try:
        proof = proof if isinstance(proof, Proof) else Proof.model_validate(proof)
        origin = proof.origin.model_dump()
        if (proof.expires_at <= int(time.time()) or not name.lower().endswith('.' + origin["format"])
                or hashlib.sha256(text.encode("utf-8")).hexdigest() != origin["text_sha256"]
                or len(text.split('\n')) != origin["units"][-1]["end"]
                or not hmac.compare_digest(proof.signature, _signature(user, name, origin, proof.expires_at))):
            raise ValueError("Changed/expired extraction")
        return origin
    except (ValidationError, ValueError, UnicodeError):
        raise HTTPException(409, "The extracted document changed, expired or was prepared for another account/server session. Choose the original file and review it again; nothing was sent to AI.") from None


def capabilities():
    common = None
    if getattr(sys, "frozen", False):
        common = "This packaged runtime cannot launch the isolated document reader. Use text/Markdown or a Python/source TLI installation."
    elif os.name != "nt" and not sys.platform.startswith(("linux", "darwin")):
        common = "Resource-limited document extraction is unavailable on this operating system."
    else:
        try:
            if os.name == "nt":
                import ctypes
                if not hasattr(ctypes, "WinDLL"):
                    raise ImportError()
            else:
                import resource  # noqa: F401
        except ImportError:
            common = "The operating-system limits required for document extraction are unavailable."
    pdf_reason, parser = common, None
    try:
        parser = importlib.metadata.version("pypdf")
        parts = tuple(int(v) for v in parser.split('.')[:3])
        if not (parts >= (6, 18, 0) and parts < (7,)):
            pdf_reason = pdf_reason or "Install the supported pypdf runtime requirement before reading PDFs."
    except (importlib.metadata.PackageNotFoundError, ValueError):
        pdf_reason = pdf_reason or "PDF text extraction needs the pypdf runtime requirement. Text/Markdown and DOCX remain separate capabilities."
    return {"protocol": PROTOCOL, "formats": {"pdf": {"available": pdf_reason is None, "reason": pdf_reason, "parser": parser},
            "docx": {"available": common is None, "reason": common, "parser": "bounded WordprocessingML"}},
            "max_file_bytes": MAX_FILE_BYTES, "max_text_bytes": MAX_TEXT_BYTES, "max_pages": MAX_PAGES,
            "max_paragraphs": MAX_PARAGRAPHS, "timeout_seconds": TIMEOUT,
            "scope": "Files are uploaded to this TLI host for isolated text extraction only. No AI request, OCR, document program or external reference is used. OS limits are required; failures reject the extraction."}


def _limits():
    global _worker_job
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        class Basic(ctypes.Structure):
            _fields_ = [("ProcessTime", ctypes.c_longlong), ("JobTime", ctypes.c_longlong), ("Flags", wintypes.DWORD),
                        ("MinWorkingSet", ctypes.c_size_t), ("MaxWorkingSet", ctypes.c_size_t), ("ActiveProcesses", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("Priority", wintypes.DWORD), ("Scheduling", wintypes.DWORD)]
        class IO(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in ('ReadOps','WriteOps','OtherOps','ReadBytes','WriteBytes','OtherBytes')]
        class Extended(ctypes.Structure):
            _fields_ = [("Basic", Basic), ("IO", IO), ("ProcessMemory", ctypes.c_size_t), ("JobMemory", ctypes.c_size_t),
                        ("PeakProcessMemory", ctypes.c_size_t), ("PeakJobMemory", ctypes.c_size_t)]
        k = ctypes.WinDLL('kernel32', use_last_error=True)
        k.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]; k.CreateJobObjectW.restype = wintypes.HANDLE
        k.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]; k.SetInformationJobObject.restype = wintypes.BOOL
        k.GetCurrentProcess.restype = wintypes.HANDLE
        k.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]; k.AssignProcessToJobObject.restype = wintypes.BOOL
        info = Extended(); info.Basic.Flags = 0x100 | 0x8 | 0x2 | 0x2000
        info.Basic.ActiveProcesses = 1; info.Basic.ProcessTime = (TIMEOUT + 1) * 10_000_000; info.ProcessMemory = MAX_MEMORY
        job = k.CreateJobObjectW(None, None)
        if not job or not k.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)) or not k.AssignProcessToJobObject(job, k.GetCurrentProcess()):
            raise ReaderError("Operating-system document limits could not be established.")
        _worker_job = job  # Keep the job alive through the bounded worker's lifetime.
    else:
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (MAX_MEMORY, MAX_MEMORY))
        resource.setrlimit(resource.RLIMIT_CPU, (TIMEOUT + 1, TIMEOUT + 1))
        resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def _no_effects():
    """Parser defense in depth; OS memory/time limits are enforced separately."""
    def audit(event, args):
        if event.startswith(('socket.', 'subprocess.', 'os.exec', 'os.spawn')) or event in ('os.system','os.fork','os.posix_spawn'):
            raise PermissionError("Document worker cannot contact a network or start programs")
        if event in ('os.remove', 'os.rmdir', 'os.mkdir', 'os.rename', 'os.link', 'os.symlink', 'os.chmod', 'os.chown', 'os.truncate'):
            raise PermissionError("Document worker cannot alter filesystem entries")
        if event == 'open':
            mode, flags = args[1], args[2]
            if isinstance(mode, str) and any(v in mode for v in 'wax+') or isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
                raise PermissionError("Document worker cannot write files")
    sys.dont_write_bytecode = True
    sys.addaudithook(audit)


def _units(parts, format, raw, parser):
    lines, units, empty = [], [], []
    for number, content in enumerate(parts, 1):
        text = content.replace('\r\n', '\n').replace('\r', '\n').replace('\f', '\n').strip()
        if not text:
            empty.append(number); continue
        if any(unicodedata.category(c) == 'Cc' and c not in '\n\t' for c in text):
            raise ReaderError("Extracted text has unsupported control characters. Export a readable plain-text copy instead.")
        start = len(lines) + 1; lines.extend(text.split('\n'))
        if len('\n'.join(lines).encode('utf-8')) > MAX_TEXT_BYTES:
            raise ReaderError("Extracted text exceeds 64 KiB. Choose a smaller document or a reviewed text excerpt; no content was silently cut.")
        units.append({"number": number, "start": start, "end": len(lines)})
    if not lines:
        raise ReaderError("This file contains no readable text in the supported scope. Scanned images need OCR, which TLI does not run here.")
    text = '\n'.join(lines)
    return {"text": text, "origin": {"version": 1, "format": format, "original_sha256": hashlib.sha256(raw).hexdigest(),
            "original_bytes": len(raw), "text_sha256": hashlib.sha256(text.encode('utf-8')).hexdigest(), "parser": parser,
            "unit_kind": "page" if format == 'pdf' else "paragraph", "total_units": len(parts), "units": units, "empty_units": empty,
            "omissions": PDF_OMISSIONS if format == 'pdf' else DOCX_OMISSIONS}}


def _pdf(raw):
    from pypdf import PdfReader, __version__
    if not raw.startswith(b'%PDF-'):
        raise ReaderError("This file is not a PDF document.")
    reader = PdfReader(io.BytesIO(raw), strict=True)
    if reader.is_encrypted:
        raise ReaderError("Encrypted/password-protected PDFs are unsupported. Export an unlocked copy deliberately before selecting it.")
    if not 1 <= len(reader.pages) <= MAX_PAGES:
        raise ReaderError("PDF extraction supports up to 100 pages. Choose a smaller PDF.")
    parts, total = [], 0
    for page in reader.pages:
        content = page.get_contents()
        if content is not None:
            size = len(content.get_data()); total += size
            if size > MAX_PART_BYTES or total > MAX_ZIP_BYTES:
                raise ReaderError("PDF page content exceeds the supported uncompressed size.")
        parts.append(page.extract_text() or '')
        if sum(len(s.encode('utf-8')) for s in parts) > MAX_TEXT_BYTES:
            raise ReaderError("Extracted PDF text exceeds 64 KiB. Choose a smaller document; no text was silently cut.")
    return _units(parts, 'pdf', raw, 'pypdf ' + __version__)


def _xml(raw):
    from xml.etree import ElementTree as ET
    if len(raw) > MAX_PART_BYTES:
        raise ReaderError("A DOCX XML part exceeds its supported size.")
    # Decode before rejecting declarations, including UTF-16 document parts.
    text = raw.decode('utf-16' if raw.startswith((b'\xff\xfe', b'\xfe\xff')) else 'utf-8-sig', errors='strict')
    if re.search(r'<!\s*(DOCTYPE|ENTITY)', text, re.I):
        raise ReaderError("DOCX entity/DTD declarations are unsupported.")
    if re.search(r'<\?xml[^>]*encoding\s*=\s*[\"\'](?!utf-8|utf-16)[^\"\']+', text, re.I):
        raise ReaderError("DOCX XML must use UTF-8 or UTF-16 encoding.")
    return ET.fromstring(text)


def _docx(raw):
    ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        rows = archive.infolist(); names = [r.filename for r in rows]
        if not rows or len(rows) > MAX_ENTRIES or len(set(names)) != len(names):
            raise ReaderError("DOCX has duplicate or too many archive entries.")
        if sum(r.file_size for r in rows) > MAX_ZIP_BYTES:
            raise ReaderError("DOCX uncompressed contents exceed 16 MiB.")
        for row in rows:
            name = row.filename
            if ('\\' in name or ':' in name or name.startswith('/') or '..' in PurePosixPath(name).parts
                    or stat.S_ISLNK(row.external_attr >> 16) or row.flag_bits & 1
                    or row.file_size > MAX_ZIP_BYTES or row.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)):
                raise ReaderError("DOCX contains an unsupported, encrypted or unsafe archive entry.")
            if 'vbaproject' in name.lower() or name.lower().endswith('.docm'):
                raise ReaderError("Macro-enabled documents are unsupported.")
        if 'word/document.xml' not in names or '[Content_Types].xml' not in names:
            raise ReaderError("This file is not a supported DOCX document.")
        types = _xml(archive.read('[Content_Types].xml'))
        if any('macroEnabled' in value for child in types.iter() for value in child.attrib.values()):
            raise ReaderError("Macro-enabled documents are unsupported.")
        document = _xml(archive.read('word/document.xml'))
        body = document.find(ns + 'body')
        if document.tag != ns + 'document' or body is None:
            raise ReaderError("DOCX has no supported main document body.")
        paragraphs = []
        def blocks(element):
            for child in element:
                if child.tag == ns + 'p':
                    paragraphs.append(child)
                    if len(paragraphs) > MAX_PARAGRAPHS:
                        raise ReaderError("DOCX extraction supports up to 500 main-body/table paragraphs.")
                elif child.tag in {ns + tag for tag in ('tbl','tr','tc','sdt','sdtContent','ins')}:
                    blocks(child)
        blocks(body)
        parts = []
        def text_of(element):
            if element.tag in {ns + tag for tag in ('del','drawing','pict','object','txbxContent','instrText')}:
                return ''
            if element.tag == ns + 't':
                return element.text or ''
            if element.tag == ns + 'tab':
                return '\t'
            if element.tag in (ns + 'br', ns + 'cr'):
                return '\n'
            return ''.join(text_of(child) for child in element)
        for paragraph in paragraphs:
            parts.append(text_of(paragraph))
        return _units(parts, 'docx', raw, 'WordprocessingML main-body v1')


def _worker(format):
    try:
        _limits(); _no_effects()
        raw = sys.stdin.buffer.read(MAX_FILE_BYTES + 1)
        if not 0 < len(raw) <= MAX_FILE_BYTES:
            raise ReaderError("Choose a nonempty document of at most 8 MiB.")
        result = _pdf(raw) if format == 'pdf' else _docx(raw)
        Origin.model_validate(result['origin'])
        output = _canonical({"ok": True, **result})
        if len(output) > MAX_REPLY:
            raise ReaderError("Extracted document metadata exceeds its supported size.")
    except (MemoryError, RecursionError):
        output = _canonical({"ok": False, "detail": "The document exceeded the isolated reader's resource limits. Choose a simpler document."})
    except Exception as exc:
        safe = str(exc) if type(exc) is ReaderError else "The document is unreadable or uses unsupported features. Original files are unchanged."
        output = _canonical({"ok": False, "detail": safe[:300]})
    sys.stdout.buffer.write(output); sys.stdout.buffer.flush()


def extract(user, name, raw):
    format = name.rsplit('.', 1)[-1].lower()
    info = capabilities()['formats'].get(format)
    if not info or not info['available']:
        raise HTTPException(503, info['reason'] if info else "Choose a PDF or DOCX file.")
    if not 0 < len(raw) <= MAX_FILE_BYTES:
        raise HTTPException(413, "Choose a nonempty document of at most 8 MiB.")
    if not _slots.acquire(blocking=False):
        raise HTTPException(429, "The document reader is busy. Wait for the current extraction to finish and retry deliberately.")
    child = None
    try:
        # No provider, household, account or shell credentials are inherited.
        allowed = {'SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'}
        env = {k: v for k, v in os.environ.items() if k.upper() in allowed}
        child = subprocess.Popen([sys.executable, '-I', '-B', str(Path(__file__).resolve()), '--worker', format],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env,
                                 **({'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}))
        try:
            output, _ = child.communicate(input=raw, timeout=TIMEOUT)
        except subprocess.TimeoutExpired:
            child.kill(); child.communicate(timeout=3)
            raise HTTPException(422, "Document extraction exceeded 15 seconds and was stopped. Choose a simpler document; no retry or AI request ran.") from None
        if child.returncode or len(output) > MAX_REPLY:
            raise HTTPException(422, "The isolated document reader exceeded a limit or stopped unexpectedly. Choose a simpler document.")
        try:
            result = json.loads(output)
            if not isinstance(result, dict):
                raise ValueError('Invalid worker response')
            if result.get('ok') is not True:
                raise HTTPException(422, str(result.get('detail') or 'The document could not be read.')[:300])
            origin = Origin.model_validate(result['origin'])
            text = result['text']
            if (not isinstance(text, str) or not 0 < len(text.encode('utf-8')) <= MAX_TEXT_BYTES
                    or origin.format != format or origin.original_sha256 != hashlib.sha256(raw).hexdigest() or origin.original_bytes != len(raw)
                    or origin.text_sha256 != hashlib.sha256(text.encode('utf-8')).hexdigest()):
                raise ValueError('Invalid worker identity')
        except (ValueError, KeyError, TypeError, ValidationError):
            raise HTTPException(422, "The document reader returned invalid extraction metadata. No text was attached.") from None
        expiry = int(time.time()) + PROOF_TTL
        proof = {"origin": origin.model_dump(), "expires_at": expiry, "signature": _signature(user, name, origin.model_dump(), expiry)}
        verify(user, name, text, proof)
        return {"name": name, "text": text, "extraction": proof}
    finally:
        if child is not None and child.poll() is None:
            child.kill()
            child.wait(timeout=3)
        _slots.release()


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--worker' and sys.argv[2] in ('pdf', 'docx'):
        _worker(sys.argv[2])
    else:
        raise SystemExit('This module is only an isolated document worker.')
