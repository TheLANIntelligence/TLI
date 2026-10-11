import socket
import pytest
from launch_checks import check_port


def test_busy_port_refuses_without_disturbing_the_listener():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        with pytest.raises(RuntimeError, match="No process was stopped"):
            check_port("127.0.0.1", port)
        assert listener.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) == 1


def test_available_port_check_releases_its_socket():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    check_port("127.0.0.1", port)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", port))


def test_backend_preflight_rejects_busy_port_before_server_launch(monkeypatch):
    import main
    import uvicorn
    monkeypatch.setenv("TLI_HOST", "127.0.0.1")
    monkeypatch.setattr(uvicorn, "run", lambda *a, **kw: pytest.fail("Started on a busy port"))
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        monkeypatch.setenv("TLI_PORT", str(listener.getsockname()[1]))
        with pytest.raises(RuntimeError, match="No process was stopped"):
            main._tli_run_server()
