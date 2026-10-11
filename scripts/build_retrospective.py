"""Create inert historical exhibits from retained source, using synthetic values.

Archived controllers are never copied or executed. Generated pages permit no
scripts, requests, forms, embedded media or external styles. This is an exhibit,
not an older application installation.
"""
from __future__ import annotations
import hashlib
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
REVISION = 'ff6c4e51a2b8476b1100a89fd964a4413b248afa'
PANELS = {'dashboard': ('Dashboard', 'panel-dashboard2'), 'chat': ('AI Chat', 'panel-main'),
          'vault': ('Vault', 'panel-vault'), 'files': ('Files', 'panel-files'), 'settings': ('Settings', 'panel-settings')}
VOID = {'input', 'br', 'hr', 'meta', 'link', 'img', 'source', 'wbr'}
ALLOWED = set('section div span p strong b em i small h1 h2 h3 h4 label button input textarea select option optgroup details summary ul ol li table thead tbody tr td th a br hr code pre aside main nav svg path circle rect line polyline polygon'.split())


class Element:
    def __init__(self, tag, attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []
    def find(self, ident):
        if self.attrs.get('id') == ident:
            return self
        for child in self.children:
            if isinstance(child, Element):
                found = child.find(ident)
                if found:
                    return found
    def text(self, value):
        self.children = [value]


class Tree(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.root = Element('document')
        self.stack = [self.root]
        self.feed(source)
    def handle_starttag(self, tag, attrs):
        item = Element(tag, attrs)
        self.stack[-1].children.append(item)
        if tag not in VOID:
            self.stack.append(item)
    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)
    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                self.stack = self.stack[:index]
                break
    def handle_data(self, text):
        self.stack[-1].children.append(text)


def safe_text(value):
    value = re.sub(r'\b(?:\d{1,3}\.){3}\d{1,3}\b', '192.0.2.10', value)
    value = value.replace('RyzenUppercut', 'Study').replace('FOX', 'Study')
    return html.escape(value)


def css_safe(value):
    value = re.sub(r'@import\s+[^;]+;', '', value, flags=re.I)
    return re.sub(r'url\([^)]*\)', 'none', value, flags=re.I).replace('</style', '')


def render(node):
    if isinstance(node, str):
        return safe_text(node)
    if node.tag not in ALLOWED:
        return ''
    attrs = {k: v for k, v in node.attrs.items() if k in {
        'id', 'class', 'style', 'hidden', 'title', 'placeholder', 'type', 'role', 'aria-label',
        'colspan', 'rowspan', 'viewbox', 'd', 'cx', 'cy', 'r', 'x', 'y', 'width', 'height',
        'fill', 'stroke', 'stroke-width', 'points', 'x1', 'y1', 'x2', 'y2'}}
    if 'style' in attrs:
        attrs['style'] = css_safe(attrs['style'] or '')
    if node.tag in {'button', 'input', 'select', 'textarea'}:
        attrs['disabled'] = ''
    if node.tag in {'a', 'summary'}:
        attrs['tabindex'] = '-1'
    if node.tag == 'input' and attrs.get('type') in {'file', 'hidden'}:
        return ''
    opening = '<' + node.tag + ''.join(' ' + key + ('' if value is None else '="' + html.escape(value, quote=True) + '"') for key, value in attrs.items()) + '>'
    children = '' if node.tag == 'textarea' else ''.join(render(c) for c in node.children)
    return opening + ('' if node.tag in VOID else children + '</' + node.tag + '>')


def fixture(panel):
    replacements = {
        'nd-statement-text': 'Your home, connected. A quiet moment in the Study.',
        'nd-status-label': 'EXAMPLE', 'nd-meta-line': 'Synthetic exhibit · No live readings',
        'ndv-node-val': 'Study', 'ndv-node-sub': 'Example TLI host',
        'ndv-storage-val': '42%', 'ndv-storage-sub': 'Example drive · 210 GB of 500 GB',
        'ndv-smart-val': '2', 'ndv-smart-sub': 'Desk lamp · Reading lamp',
        'ndv-ai-val': 'Bundled', 'ndv-ai-sub': 'Synthetic status, not a running provider',
        'nd-actions': 'Ask TLI · Review storage · Open Vault',
        'nd-feed': '09:41 · Example computer connected.\n09:38 · A saved note was updated.',
        'activity-count': '2 example events · Synthetic timeline',
        'activity-checked-at': 'This exhibit contains no live activity.',
        'activity-summary': '09:41 · Study connected.\n09:38 · Printer setup detail saved.',
        'dashboard-places-mount': 'Saved places · Printer setup · Study documents',
        'vault-message': 'Synthetic exhibit. No files or secrets are loaded.',
        'vault-auth-hint': '',
        'vault-backups-mount': 'Backup & recovery · Check Vault, create and verify a portable archive, or recover a separate copy. Controls are available in the current application.',
    }
    for ident, text in replacements.items():
        item = panel.find(ident)
        if item:
            item.text(text)
    chat = panel.find('chat-output')
    if chat:
        chat.children = [Element('div', [('class', 'chat-message user')]), Element('div', [('class', 'chat-message assistant')])]
        chat.children[0].text('Where did I save the printer setup details?')
        chat.children[1].text('Example conversation: keep the paper size and the last useful fix together so you can find them again. This exhibit is not connected to AI.')
    for ident in ('vault-auth-section',):
        item = panel.find(ident)
        if item:
            item.attrs['style'] = 'margin-top:14px'
    panel.attrs.pop('hidden', None)
    panel.attrs['class'] = panel.attrs.get('class', '') + ' active exhibit-panel'


def build():
    destination = ROOT / 'frontend/history'
    destination.mkdir(exist_ok=True)
    records = []
    for edition in ('early', 'anniversary'):
        def read(name):
            return (subprocess.check_output(['git', 'show', f'{REVISION}:frontend/{name}'], cwd=ROOT).decode('utf-8')
                    if edition == 'early' else (ROOT / 'frontend' / name).read_text(encoding='utf-8'))
        source = read('index.html')
        tree = Tree(source)
        styles = []
        source_files = {'index.html': hashlib.sha256(source.encode()).hexdigest()}
        for name in dict.fromkeys(re.findall(r'href=["\']/?([^"\'?]+\.css)(?:\?[^"\']*)?["\']', source)):
            if '..' in name or ':' in name:
                continue
            try:
                text = read(name)
            except (FileNotFoundError, subprocess.CalledProcessError):
                continue
            source_files[name] = hashlib.sha256(text.encode()).hexdigest()
            styles.append(css_safe(text))
        styles.extend(css_safe(s) for s in re.findall(r'<style[^>]*>(.*?)</style>', source, flags=re.S | re.I))
        for slug, (label, ident) in PANELS.items():
            panel = tree.root.find(ident)
            if panel is None:
                raise RuntimeError(f'Missing retained panel {ident}')
            fixture(panel)
            title = 'v1.3.5-beta · May 3, 2026' if edition == 'early' else 'Anniversary edition · September 2026'
            page = '<!doctype html><html lang="en" data-theme="emeraldLight"><head><meta charset="utf-8">' + \
                '<meta name="viewport" content="width=device-width,initial-scale=1">' + \
                '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'">' + \
                f'<title>{label} — {title}</title><style>' + '\n'.join(styles) + \
                '\nhtml,body{height:auto!important;overflow:auto!important}body{display:block!important;padding:22px;background:var(--bg-main);color:var(--text-main)}' + \
                '.exhibit-banner{font:13px/1.7 system-ui;margin-bottom:24px;border-bottom:1px solid var(--border-subtle);padding-bottom:16px}' + \
                '.exhibit-panel{display:block!important;max-width:1350px!important;margin:auto!important;opacity:1!important;transform:none!important}' + \
                '*{animation:none!important;transition:none!important;caret-color:transparent}button,input,select,textarea,summary{pointer-events:none}' + \
                '</style></head><body>' + f'<header class="exhibit-banner"><strong>{label} · {title}</strong><br>Read-only source exhibit · Synthetic content · Controls do not operate</header>' + \
                render(panel) + '</body></html>'
            name = f'{edition}-{slug}.html'
            (destination / name).write_text(page, encoding='utf-8')
            records.append({'edition': edition, 'panel': slug, 'file': name, 'sha256': hashlib.sha256(page.encode()).hexdigest(), 'source_files': source_files})
    (destination / 'provenance.json').write_text(json.dumps({'schema_version': 1, 'earliest_retained_commit': REVISION,
        'retained_commit_date': '2026-05-03T14:13:09-04:00', 'historical_version': 'v1.3.5-beta',
        'synthetic_content': True, 'archived_scripts_executed': False, 'views': records}, indent=2) + '\n', encoding='utf-8')
    print(f'Built {len(records)} inert source exhibits.')


if __name__ == '__main__':
    build()
