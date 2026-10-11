# Anniversary source distribution checkpoint

The full source package previously printed `frontend_only: true` in its suggested update metadata. That would cause the updater to copy only interface files, leaving existing backend code in place. Full builds now print `false`; `--frontend-only` explicitly limits both package contents and metadata to interface changes. Dependency changes still require installation of the included requirements before restart. Frozen/native installers need separate validation.

The packager excludes both test suites, environment files, private key/certificate files, and developer tooling. Runtime executable exceptions no longer include model weights, logs or keys simply because they sit in the runtime directory. Linked files/directories are excluded, and excluded directories are pruned during traversal. Shell launchers and Unix runtime binaries receive Unix executable permissions in Windows-built archives. ZIP entries now use the requested compression.

## Repeatable extracted-build check

From the repository root:

```powershell
backend\.venv\Scripts\python.exe scripts/verify_release.py
```

Each run creates a separate directory under `build_work/release-checks/`, containing a source candidate ZIP, an extracted installation, a test log and a JSON report. It does not publish, install over, or restart the running application.

The check validates required runtime files and static asset references, then adds an external test harness to the extracted installation. The harness establishes temporary persistence and inert integrations before application imports. It exercises startup/shutdown, degraded inference, chat streaming, storage scans, memory, device context and image validation using the existing Python environment. It does not install dependencies, run actual model inference or issue real device commands. The repository-only prior-actions-reader test remains in the main regression suite because it requires Git history.

On September 6, the candidate contained 209 files, all 50 referenced script/style assets were present, and the extracted installation passed 40 checks. Packaging regression tests separately verify full-versus-interface-only contents, private-file exclusion, linked-file exclusion and executable permissions.

Still required before release: native Windows/macOS/Linux installation and dependencies, real phone/device/mesh workflows, and full installation rollback. Existing JSON-format compatibility checks do not establish a complete rollback guarantee. Version remains 1.3.5-beta; no release was published.
