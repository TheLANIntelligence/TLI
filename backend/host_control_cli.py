"""Local-only setup/lifecycle entry point. No remote command or configuration API."""
import argparse
import getpass
import json
from pathlib import Path
import time

import host_control as H
import host_launcher as L


def helper_running(root):
    try:
        with H.FileLock(H.path_for(root, "helper.lock")):
            return False
    except H.HostControlError:
        return True


def stop_helper(root):
    try:
        value = H.read_json(H.path_for(root, "helper.json"), 16384)
    except FileNotFoundError:
        return {"helper_running": False, "reason": "Helper is not configured."}
    H.write_json(H.path_for(root, "stop.json"), {"helper_id": value.get("helper_id")})
    deadline = time.monotonic() + 8
    while helper_running(root) and time.monotonic() < deadline:
        time.sleep(0.2)
    if helper_running(root):
        H._fail("Helper has not confirmed stop. No process was killed; inspect helper.log locally.", 503)
    return {"helper_running": False, "reason": "Helper stopped. Backend was not stopped."}


def start_helper(root):
    cfg = H.config(root)
    if helper_running(root):
        return {"helper_running": True, "reason": "An existing helper owns the local lease; no second process was started."}
    L.spawn_fixed(root, "host_control_server.py")
    deadline = time.monotonic() + 8
    while not helper_running(root) and time.monotonic() < deadline:
        time.sleep(0.2)
    if not helper_running(root):
        H._fail("Helper did not acquire its local lease. Inspect helper.log; no automatic retry.", 503)
    # Listener may be unavailable despite a held lease; do not claim network reachability.
    return {"helper_running": True, "port": cfg["port"], "reason": "Helper process started. Check its HTTPS connection from the paired phone; LAN reachability is not yet confirmed."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["enable", "disable", "start", "stop", "status", "prepare", "validate", "stop-backend"])
    parser.add_argument("--port", type=int, default=8001)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    try:
        if args.operation == "enable":
            # A local interactive PIN is never accepted in argv, env, or HTTP.
            pin = getpass.getpass("Existing TLI desktop PIN: ")
            H.verify_local_pin(root, pin)
            stop_helper(root)
            result = H.provision(root, args.port, pin)
            result = {"enabled": True, "port": result["port"], "reason": "Configured. Choose Start helper, then review access in Companion. Start at sign-in is a separate local choice."}
        elif args.operation == "disable":
            H.verify_local_pin(root, getpass.getpass("Existing TLI desktop PIN: "))
            result = stop_helper(root)
            value = H.read_json(H.path_for(root, "helper.json"), 16384)
            value["enabled"] = False
            H.write_json(H.path_for(root, "helper.json"), value)
            result.update(enabled=False)
        elif args.operation == "start":
            result = start_helper(root)
        elif args.operation == "stop":
            result = stop_helper(root)
        elif args.operation == "stop-backend":
            print("Finish or cancel active chats, file changes, scans and device work first. Stopping can interrupt in-progress operations.")
            if input("Stop only this launcher's owned TLI backend now? Type STOP: ") != "STOP":
                result = {"stopped": False, "reason": "No stop requested."}
            else:
                result = L.stop_owned_backend(root)
        elif args.operation == "validate":
            cfg = H.config(root)
            result = {"enabled": True, "port": cfg["port"]}
        elif args.operation == "prepare":
            with H.FileLock(H.path_for(root, "setup.lock")):
                result = {"installation_id": H.installation(root, create=True)["installation_id"]}
        else:
            result = {"backend": L.desktop_status(root, issue_token=False),
                      "helper_running": helper_running(root)}
            try:
                cfg = H.config(root)
                result.update(enabled=True, port=cfg["port"], mode="same_user_sign_in", wake_host=False)
            except Exception as error:
                result.update(enabled=False, reason=str(getattr(error, "detail", error)))
        print(json.dumps(result, indent=2), flush=True)
    except Exception as error:
        print("Host start: " + str(getattr(error, "detail", error)), flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
