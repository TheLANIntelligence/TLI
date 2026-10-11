import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('retrospective', Path(__file__).resolve().parents[1] / 'build_retrospective.py')
exhibit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exhibit)


def test_archived_controls_and_network_content_are_inert():
    tree = exhibit.Tree('<section id="fixture"><script>fetch("/vault/reset")</script><form action="/run"><input value="secret"></form><button onclick="run()">Run</button><a href="https://example.com">Link</a><img src="https://example.com/tracker"><div style="background:url(https://example.com)">FOX 192.168.1.2</div></section>')
    rendered = exhibit.render(tree.root.find('fixture'))
    assert 'script' not in rendered and 'fetch' not in rendered
    assert 'form' not in rendered and 'secret' not in rendered
    assert 'onclick' not in rendered and 'href=' not in rendered and 'src=' not in rendered
    assert '<button disabled="">Run</button>' in rendered
    assert 'example.com' not in rendered
    assert 'Study 192.0.2.10' in rendered


def test_css_cannot_load_external_fonts_or_resources():
    assert 'example.com' not in exhibit.css_safe('@import "https://example.com/font.css"; .x{background:url(https://example.com/a)}')


def test_generated_gallery_has_no_controllers_and_is_locally_sandboxed():
    gallery = (exhibit.ROOT / 'frontend/history/index.html').read_text(encoding='utf-8')
    assert '<script' not in gallery
    assert gallery.count('<img alt=') == 10
    assert '<iframe' not in gallery
    assert 'earliest retained Git snapshot' in gallery
    assert 'form-action' in gallery
