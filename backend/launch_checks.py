"""Side-effect-free startup checks, usable before importing the application."""
import argparse
import os
import socket


def check_port(host: str, port: int) -> None:
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    try:
        with socket.socket(family, socket.SOCK_STREAM) as probe:
            if os.name == "nt":
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            probe.bind((host, port))
    except OSError as error:
        raise RuntimeError(
            f"TLI cannot listen on {host}:{port}. The address may be in use or unavailable. "
            "Stop the existing server yourself or choose another TLI_PORT. No process was stopped."
        ) from error


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int)
    parser.add_argument("--host")
    args = parser.parse_args()
    try:
        from startup_config import resolve, validate
        settings = resolve()["effective_next"]
        if args.host is not None:
            settings["host"] = args.host
        if args.port is not None:
            settings["port"] = args.port
        validate(settings)
        check_port(settings["host"], settings["port"])
    except (RuntimeError, ValueError) as error:
        parser.exit(1, str(error) + "\n")
