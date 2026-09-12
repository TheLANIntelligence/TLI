"""Synthetic binary documents; actual bounded child, no app/server in that child."""
import copy
import hashlib
import io
import json
import subprocess
import sys
import time
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from intelligence import document_extraction as X
from routers import document_extraction_routes as R
from routers.system_routes import require_session

OWNER = 'synthetic-reader'
NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'


def docx(body='<w:p><w:r><w:t>Replace the USB cable.</w:t></w:r></w:p>', extras=None, document=None):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr('word/document.xml', document or f'<w:document xmlns:w="{NS}"><w:body>{body}</w:body></w:document>')
        for name, value in (extras or {}).items(): z.writestr(name, value)
    return output.getvalue()


def pdf(text='The warranty lasts two years.', *, blank=False, encrypted=False):
    pypdf = pytest.importorskip('pypdf')
    from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
    writer = pypdf.PdfWriter(); page = writer.add_blank_page(400, 300)
    if text:
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
        stream = DecodedStreamObject(); stream.set_data(('BT /F1 12 Tf 30 200 Td (' + text + ') Tj ET').encode('ascii'))
        page[NameObject('/Contents')] = writer._add_object(stream)
    if blank: writer.add_blank_page(400, 300)
    if encrypted: writer.encrypt('synthetic-passphrase')
    output = io.BytesIO(); writer.write(output); return output.getvalue()


@pytest.fixture
def api(monkeypatch):
    app = FastAPI(); app.include_router(R.router)
    app.dependency_overrides[require_session] = lambda: OWNER
    monkeypatch.setattr(R, 'require_session', lambda *a, **k: OWNER)
    with TestClient(app) as client: yield client


def test_actual_pdf_child_page_coverage_hash_and_proof(tmp_path, monkeypatch):
    monkeypatch.setenv('TLI_ROOT', str(tmp_path / 'must-not-create'))
    raw = pdf(blank=True); result = X.extract(OWNER, 'warranty.pdf', raw)
    origin = X.verify(OWNER, result['name'], result['text'], result['extraction'])
    assert result['text'] == 'The warranty lasts two years.'
    assert origin['units'] == [{'number': 1, 'start': 1, 'end': 1}]
    assert origin['empty_units'] == [2] and origin['total_units'] == 2
    assert origin['original_sha256'] == hashlib.sha256(raw).hexdigest()
    assert origin['omissions'] == X.PDF_OMISSIONS
    assert not list(tmp_path.iterdir()), 'No TLI imports, identity or plaintext staging'


def test_actual_docx_child_only_main_body_visible_text_and_table_cells():
    raw = docx('<w:p><w:r><w:t>Current fix</w:t></w:r><w:del><w:r><w:t>DELETED SECRET</w:t></w:r></w:del></w:p>'
        '<w:p/><w:tbl><w:tr><w:tc><w:p><w:hyperlink><w:r><w:t>Link display only</w:t></w:r></w:hyperlink>'
        '<w:r><w:instrText>INCLUDETEXT file:///secret</w:instrText></w:r></w:p></w:tc></w:tr></w:tbl>',
        {'word/header1.xml': '<secret>NOT INCLUDED</secret>', 'word/_rels/document.xml.rels': '<Relationships><Relationship Target="http://127.0.0.1:9/never" TargetMode="External"/></Relationships>'})
    result = X.extract(OWNER, 'fix.docx', raw); origin = result['extraction']['origin']
    assert result['text'] == 'Current fix\nLink display only'
    assert origin['empty_units'] == [2]
    assert origin['units'] == [{'number': 1, 'start': 1, 'end': 1}, {'number': 3, 'start': 2, 'end': 2}]
    assert origin['omissions'] == X.DOCX_OMISSIONS


@pytest.mark.parametrize('kind,build,match', [
    ('pdf', lambda: pdf(encrypted=True), 'Encrypted'),
    ('pdf', lambda: pdf(text=''), 'no readable text'),
    ('pdf', lambda: b'not-pdf', 'not a PDF'),
    ('pdf', lambda: b'%PDF-1.7\nPRIVATE_PARSER_ERROR', 'unreadable'),
    ('docx', lambda: b'PRIVATE_CORRUPT_ZIP', 'unreadable'),
    ('docx', lambda: docx(extras={'word/vbaProject.bin': b'no'}), 'Macro'),
    ('docx', lambda: docx(extras={'../escape.xml': b'no'}), 'unsafe'),
    ('docx', lambda: docx(document=('<?xml version="1.0"?><!DOCTYPE d [<!ENTITY secret SYSTEM "file:///never">]><w:document xmlns:w="' + NS + '"><w:body/></w:document>').encode('utf-16')), 'entity/DTD'),
    ('docx', lambda: docx('<w:p><w:r><w:t>' + 'x' * (X.MAX_TEXT_BYTES + 1) + '</w:t></w:r></w:p>'), '64 KiB'),
    ('docx', lambda: docx('<w:p><w:r><w:t>x</w:t></w:r></w:p>' * 501), '500'),
    ('docx', lambda: docx(extras={'word/media/large.dat': b'a' * (X.MAX_ZIP_BYTES + 1)}), '16 MiB'),
])
def test_real_worker_rejects_unreadable_and_unsupported_without_source_echo(kind, build, match):
    with pytest.raises(HTTPException) as error: X.extract(OWNER, 'fixture.' + kind, build())
    assert error.value.status_code == 422
    assert match in error.value.detail
    assert 'PRIVATE_' not in error.value.detail


def test_proof_bound_to_account_original_name_text_scope_expiry_and_server_key(monkeypatch):
    result = X.extract(OWNER, 'fix.docx', docx()); proof = result['extraction']
    for user, name, text, changed in [(OWNER+'-other', 'fix.docx', result['text'], proof),
        (OWNER, 'renamed.docx', result['text'], proof), (OWNER, 'fix.docx', 'changed text', proof)]:
        with pytest.raises(HTTPException, match='409'): X.verify(user, name, text, changed)
    changed = copy.deepcopy(proof); changed['origin']['omissions'][0] = 'Everything verified'
    with pytest.raises(HTTPException): X.verify(OWNER, 'fix.docx', result['text'], changed)
    monkeypatch.setattr(X.time, 'time', lambda: proof['expires_at'])
    with pytest.raises(HTTPException): X.verify(OWNER, 'fix.docx', result['text'], proof)
    monkeypatch.setattr(X.time, 'time', lambda: proof['expires_at'] - 1)
    monkeypatch.setattr(X, '_proof_key', b'changed key')
    with pytest.raises(HTTPException): X.verify(OWNER, 'fix.docx', result['text'], proof)


def test_frozen_and_missing_pdf_dependency_visible_without_spawning(monkeypatch):
    monkeypatch.setattr(X.sys, 'frozen', True, raising=False)
    monkeypatch.setattr(X.subprocess, 'Popen', lambda *a, **k: pytest.fail('Never launch frozen TLI as Python'))
    assert not X.capabilities()['formats']['docx']['available']
    with pytest.raises(HTTPException): X.extract(OWNER, 'x.docx', b'x')
    monkeypatch.setattr(X.sys, 'frozen', False)
    def missing(*a): raise X.importlib.metadata.PackageNotFoundError()
    monkeypatch.setattr(X.importlib.metadata, 'version', missing)
    assert not X.capabilities()['formats']['pdf']['available']
    assert X.capabilities()['formats']['docx']['available']


def test_timeout_stops_owned_worker_once_and_no_automatic_retry(monkeypatch):
    calls = []
    class Child:
        returncode = None
        def communicate(self, input=None, timeout=None):
            calls.append(('communicate', timeout))
            if self.returncode is None: raise subprocess.TimeoutExpired('worker', timeout)
            return b'', None
        def kill(self): calls.append(('kill',)); self.returncode = -1
        def poll(self): return self.returncode
    def start(*args, **kwargs): calls.append(('start', args[0], kwargs)); return Child()
    monkeypatch.setenv('TLI_ROOT', 'private-live-root'); monkeypatch.setenv('OPENAI_API_KEY', 'private'); monkeypatch.setenv('ARBITRARY_PRIVATE_KEY', 'private')
    monkeypatch.setattr(X.subprocess, 'Popen', start)
    with pytest.raises(HTTPException) as error: X.extract(OWNER, 'a.docx', b'x')
    assert 'stopped' in error.value.detail
    assert [c[0] for c in calls].count('start') == [c[0] for c in calls].count('kill') == 1
    assert calls[0][1][1:3] == ['-I', '-B']
    assert 'TLI_ROOT' not in calls[0][2]['env'] and 'OPENAI_API_KEY' not in calls[0][2]['env']
    assert 'ARBITRARY_PRIVATE_KEY' not in calls[0][2]['env']


def test_authenticated_binary_intake_no_persistence_and_no_generation(api, tmp_path):
    result = api.post('/api/ai/documents/extract?name=fix.docx', content=docx(), headers={'Content-Type': 'application/octet-stream'})
    assert result.status_code == 200, result.text
    assert result.headers['cache-control'] == 'no-store'
    data = result.json(); assert data['source_retained'] is data['inference_called'] is data['actions_performed'] is False
    assert data['document']['text'] == 'Replace the USB cable.'
    assert api.get('/api/ai/documents/extraction-capabilities').json()['max_file_bytes'] == 8 * 1024 * 1024


@pytest.mark.parametrize('name,headers,status', [('x.txt', {}, 422), ('../x.pdf', {}, 422), ('x.docx', {'Content-Type':'text/plain'},415), ('x.docx', {'Content-Type':'application/octet-stream','Content-Length':str(X.MAX_FILE_BYTES+1)},413), ('x.docx', {'Origin':'https://other.example'},403)])
def test_invalid_intake_rejected_before_worker(api, monkeypatch, name, headers, status):
    monkeypatch.setattr(X, 'extract', lambda *a: pytest.fail('Invalid intake cannot reach worker'))
    assert api.post('/api/ai/documents/extract', params={'name':name}, content=b'x', headers=headers).status_code == status


def test_expired_session_after_extraction_does_not_return_private_text(api, monkeypatch):
    original = X.extract
    def completed(*args):
        result = original(*args)
        monkeypatch.setattr(R, 'require_session', lambda *a, **k: 'different-owner')
        return result
    monkeypatch.setattr(X, 'extract', completed)
    result = api.post('/api/ai/documents/extract?name=fix.docx', content=docx(), headers={'Content-Type':'application/octet-stream'})
    assert result.status_code == 401 and 'USB' not in result.text


def test_resource_and_effect_guards_are_effective_in_actual_child(tmp_path):
    # This is a trusted synthetic program, never content taken from a document.
    code = 'import sys;sys.path.insert(0,' + repr(str(Path(X.__file__).resolve().parents[1])) + ');from intelligence import document_extraction as x\n'
    code += 'import socket,subprocess,pathlib,os\nx._limits();x._no_effects()\n'
    code += 'checks=[]\n'
    code += 'for action in [lambda:bytearray(600*1024*1024),lambda:socket.socket(),lambda:subprocess.Popen([sys.executable,"-c","pass"]),lambda:open(' + repr(str(tmp_path/'private.txt')) + ',"w"),lambda:os.mkdir(' + repr(str(tmp_path/'directory')) + ')]:\n'
    code += ' try: action();checks.append(False)\n except (MemoryError,PermissionError):checks.append(True)\n'
    code += 'print(checks)\n'
    completed = subprocess.run([sys.executable,'-I','-B','-c',code],capture_output=True,timeout=8,
        **({'creationflags':subprocess.CREATE_NO_WINDOW} if sys.platform=='win32' else {}))
    assert completed.returncode == 0, completed.stderr.decode(errors='replace')
    assert completed.stdout.strip() == b'[True, True, True, True, True]'
    assert not list(tmp_path.iterdir())


def test_duplicate_zip_entries_and_page_limit_fail_explicitly():
    output = io.BytesIO(docx())
    with zipfile.ZipFile(output,'a') as archive:
        archive.writestr('word/document.xml','duplicate content')
    with pytest.raises(HTTPException) as error: X.extract(OWNER,'duplicate.docx',output.getvalue())
    assert 'duplicate' in error.value.detail
    pypdf=pytest.importorskip('pypdf'); writer=pypdf.PdfWriter()
    for _ in range(101): writer.add_blank_page(100,100)
    output=io.BytesIO();writer.write(output)
    with pytest.raises(HTTPException) as error: X.extract(OWNER,'too-many.pdf',output.getvalue())
    assert '100 pages' in error.value.detail


def test_parent_rejects_nonobject_worker_reply(monkeypatch):
    child=SimpleNamespace(returncode=0,communicate=lambda **k:(b'[]',None),poll=lambda:0)
    monkeypatch.setattr(X.subprocess,'Popen',lambda *a,**k:child)
    with pytest.raises(HTTPException) as error: X.extract(OWNER,'x.docx',b'x')
    assert error.value.status_code == 422 and 'invalid extraction metadata' in error.value.detail


def test_intake_busy_rejects_before_buffer_or_worker(api,monkeypatch):
    assert R._intake_slots.acquire(blocking=False); assert R._intake_slots.acquire(blocking=False)
    monkeypatch.setattr(X,'extract',lambda *a:pytest.fail('Busy intake cannot reach worker'))
    try:
        assert api.post('/api/ai/documents/extract?name=x.docx',content=b'x',headers={'Content-Type':'application/octet-stream'}).status_code == 429
    finally:
        R._intake_slots.release();R._intake_slots.release()


def test_slow_upload_and_chunked_oversize_refuse_before_worker(monkeypatch):
    import asyncio
    from starlette.requests import Request
    monkeypatch.setattr(R,'authorize',lambda *a:None)
    monkeypatch.setattr(X,'extract',lambda *a:pytest.fail('Rejected upload cannot reach worker'))
    async def run(slow):
        async def receive():
            if slow: await asyncio.sleep(1)
            return {'type':'http.request','body':b'x' if slow else b'x'*(X.MAX_FILE_BYTES+1),'more_body':False}
        request=Request({'type':'http','method':'POST','path':'/api/ai/documents/extract','headers':[(b'content-type',b'application/octet-stream')],'query_string':b'','server':('testserver',80),'scheme':'http'},receive)
        with pytest.raises(HTTPException) as error: await R.extract(request,'x.docx',OWNER)
        return error.value.status_code
    monkeypatch.setattr(R,'UPLOAD_TIMEOUT',0.01)
    assert asyncio.run(run(True)) == 408
    assert asyncio.run(run(False)) == 413
    # Both rejection paths return the intake lease.
    assert R._intake_slots.acquire(blocking=False); R._intake_slots.release()
