import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

spec = importlib.util.spec_from_file_location('isolated_eval', Path(__file__).resolve().parents[1] / 'evaluate_isolated_model.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def test_runtime_environment_cannot_inherit_model_provider_or_network_overrides(monkeypatch):
    for name in ('LLAMA_ARG_HOST', 'LLAMA_ARG_RPC', 'LLAMA_ARG_MODEL', 'TLI_ROOT', 'HTTPS_PROXY', 'HTTP_PROXY', 'PYTHONPATH'):
        monkeypatch.setenv(name, 'must-not-inherit')
    result = runner.child_environment()
    assert not any('must-not-inherit' == value for value in result.values())


def test_insufficient_resources_prevent_process_launch(tmp_path, monkeypatch):
    model, runtime = tmp_path / 'fixture.gguf', tmp_path / 'runtime.exe'
    model.write_bytes(b'synthetic weights')
    runtime.write_bytes(b'synthetic executable')
    monkeypatch.setattr(runner, 'resources', lambda *args: {'sufficient': False})
    monkeypatch.setattr(runner.subprocess, 'Popen', lambda *args, **kwargs: pytest.fail('No process may launch'))
    result = runner.run(SimpleNamespace(source_root=tmp_path, model_file=model, runtime=runtime,
                                       context=4096, threads=4, output=tmp_path / 'output'))
    assert result['status'] == 'blocked'
    assert result['selection_changed'] is False and result['live_tli_contacted'] is False
    assert (tmp_path / 'output/runtime-manifest.json').is_file()
    assert model.read_bytes() == b'synthetic weights'


def test_existing_results_are_never_overwritten(tmp_path):
    model, runtime = tmp_path / 'fixture.gguf', tmp_path / 'runtime.exe'
    model.touch()
    runtime.touch()
    output = tmp_path / 'output'
    output.mkdir()
    marker = output / 'answers.json'
    marker.write_text('keep')
    with pytest.raises(FileExistsError):
        runner.run(SimpleNamespace(source_root=tmp_path, model_file=model, runtime=runtime, context=4096, threads=4, output=output))
    assert marker.read_text() == 'keep'
