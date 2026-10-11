# Contributing to TLI

Start with the [README](README.md) for source setup and [AGENTS.md](AGENTS.md)
for architecture, development commands and project constraints. TLI is a
general-purpose AI; connected computer and smart-device tools extend ordinary
conversation rather than being required to use it.

## Issues and pull requests

Use [GitHub Issues](https://github.com/TheLANIntelligence/TLI/issues) for
reproducible bugs and feature proposals. Include the version or commit,
operating system, steps to reproduce, expected behavior and observed behavior.
Use synthetic examples and remove private information from logs or screenshots.
For a vulnerability, follow [SECURITY.md](SECURITY.md).

Keep a pull request focused on one problem. Explain the resulting behavior,
the checks performed and any unverified hardware or platform requirements.
Update user-facing documentation when a workflow changes. Work from a separate
development installation and preserve existing user data.

## Local checks

After the runtime dependencies in `backend/requirements.txt`, install
`backend/requirements-test.txt` into the same virtual environment. From the
repository root on Windows:

```powershell
.\backend\.venv\Scripts\python.exe -m pip install -r backend\requirements-test.txt
.\backend\.venv\Scripts\python.exe -m pytest backend/tests/
node --test (Get-ChildItem frontend/tests -Filter '*.test.cjs').FullName
```

On macOS or Linux, use `backend/.venv/bin/python` in place of the Windows Python
path and run `node --test frontend/tests/*.test.cjs`. Use Node.js 22.13 or newer
for the desktop tests and Companion tooling. The browser interface itself
has no npm build step. Native Companion development has its own
[setup and checks](mobile/README.md).

The backend test fixtures redirect runtime state to temporary directories and
disable live integrations. Preserve that isolation. Tests should use synthetic
files, conversations, peers and devices; do not make a test depend on a personal
installation, a live household device or downloaded model weights.

Run checks relevant to the change and describe their scope. Automated tests and
browser previews do not substitute for physical-device, native-app or
cross-platform acceptance. Keep hardware trials and release verification
separate from ordinary source tests.

## Boundaries to preserve

- Keep JSON runtime data, credentials, certificates, conversation history,
  models, generated packages and dependency directories out of source commits.
- Use authenticated services and existing review flows for file, device and
  system actions. Report command acknowledgement separately from verified state.
- LAN discovery does not authorize a peer. Preserve reviewed identities,
  certificate pins, explicit grants and deliberate model selection.
- Keep backend and frontend SSE fields consistent with
  [the protocol](docs/SSE_SCHEMA.md).
- Use `process_utils.hidden_process_kwargs()` for background Windows subprocesses
  while retaining explicitly requested visible GUI applications.
- Keep generated Builder code inside the isolated browser preview. Preserve
  ownership and revision checks at the API boundary.

The project license is recorded in [LICENSE](LICENSE). Dependencies, models and
other third-party assets retain their own licenses.
