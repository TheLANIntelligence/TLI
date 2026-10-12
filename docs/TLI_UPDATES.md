# Updating and recovering TLI

Keep using your original TLI folder and shortcuts after an update. The extracted
new package supplies the updater; it does not become a second home for your data.
This workflow supports updater-equipped Python-based desktop ZIP installations.
It does not update an installed native phone Companion or an old frozen backend.

## Update from TLI

1. Open **Settings → Software Updates → Check now** in your existing app. Review
   the version and release notes. Automatic startup checks only check; they do not
   install updates.
2. Prepare the offered desktop update. TLI downloads and verifies the archive,
   then shows the extracted package. Your running application is unchanged at
   this point. An older app can instead download the matching Windows or Mac ZIP
   from the [official TLI releases](https://github.com/TheLANIntelligence/TLI/releases)
   without registering again, and extract the entire ZIP into a separate
   folder. Compare the published SHA-256 checksum before using a manual download.
3. Back up important saved data. Finish chats, downloads and other work, then
   stop the **original TLI host** through its local controls. On Mac, press
   **Control+C** in its Terminal window. On Windows, use **Stop TLI** in Local
   Setup. Closing a browser tab alone leaves the Windows host running. Stop the
   optional host-start helper too if it is enabled.
4. Open **TLI_Update.bat** on Windows or **TLI_Update.command** on Mac in the
   **newly extracted package**. Choose your original TLI folder. If a destination
   is suggested, read it carefully; you can type a different path. Review the
   final destination and version and type **UPDATE** to proceed.
5. Open TLI from your **original folder or existing shortcut**. First start may
   prepare new Python dependencies and need internet access. The update is
   installed on disk before startup has been checked; reopen the app and confirm
   its version in Settings.

Do not start TLI from the staging folder or move your old `data/` into it. You do
not need to register again, recreate your PIN, pair the same devices again or
download your models again merely to update application code. Saved files stay
with the original installation and operating-system account.

If the release has no **TLI_Update** launcher or **TLI_RELEASE.json**, it predates
this update mechanism. Keep your old installation and use a newer package that
contains them. Existing published archives are not retroactively update-capable.
Do not give a platform ZIP to an older app's legacy direct-copy updater.

## What the updater changes

The updater verifies the source package inventory and each application file's
size and SHA-256 before installation. It rejects unsafe destinations, links and
protected state paths, and requires the existing host to be stopped. It replaces
reviewed application files in the original folder and records a backup of
replaced files under `data/updates/backups/` for recovery. Your saved data, model weights, local configuration and
`backend/.venv` are preserved. Dependency preparation happens during normal
startup, so an installation without internet may need to reconnect before a
release requiring new components can start.

The application-file backup is **not a backup of conversations, Vault or other
saved data**. Continue using the existing backup tools for those. Rolling back
application code does not undo data changes made after running the new release
or package changes made to the Python environment.

## If an update cannot finish

- **TLI is still running:** return to the original installation, finish active
  work, stop the host and helper, then rerun the update launcher. The updater
  does not forcibly terminate processes.
- **Package verification failed:** download the complete official package again
  into a separate folder and compare its published checksum. Do not bypass the
  inventory check or mix files from different releases.
- **The destination is wrong:** cancel before typing UPDATE and run the launcher
  again with the original folder. Keep both folders until the result is verified.
- **Files are locked or access is denied:** close the original launcher and any
  tools using that folder, then retry. Use an installation folder your own account
  can write to.
- **Updated components cannot be prepared:** keep the original folder and its
  data, check the setup error and internet connection, then start TLI normally
  again. Do not reset security files or run a fresh setup over saved data.

For code rollback, stop TLI first and run the installed updater's rollback mode
from the original installation folder. It displays the recovery details and asks
you to type **ROLLBACK** before restoring the saved application files:

```powershell
# Windows, from the original TLI folder
.\backend\.venv\Scripts\python.exe .\backend\update_install.py --target . --rollback
```

```bash
# Mac/Linux, from the original TLI folder
backend/.venv/bin/python backend/update_install.py --target . --rollback
```

Keep the downloaded package until the update has been verified; its
`backend/update_install.py` can also be used with an explicit `--target` if the
installed updater cannot be opened.

## Publishing an update-capable release

Build and verify a **new** package before advertising update support. The
release version must be newer than the installed version; replacing an archive
under the same version does not produce an update notification. Never change
the bytes or checksum of an already published release to add update support.
The reviewed `build_dist.py` packager generates `TLI_RELEASE.json` for every archive.
It contains `schema_version: 1`, the version, platform (`windows`, `macos`, or
`all`), and a `files` inventory of normalized relative paths, byte sizes,
SHA-256 hashes and permission modes. Hashes describe the actual archived bytes,
including normalized Unix newlines. The inventory does not hash itself. Local
`update-target.json` hints and any older generated inventory are never packaged.

For platform releases, prepare the matching launcher/runtime and run:

```powershell
python build_dist.py --platform windows --dry-run
python build_dist.py --platform windows --out TLI_<version>_Windows.zip
python build_dist.py --platform macos --dry-run
python build_dist.py --platform macos --out TLI_<version>_macOS.zip
```

Review the file list and verify both a fresh extraction and an update of a
synthetic older installation, including preservation of data/models and rollback.
After publishing those verified archives, update `landing/downloads.json` with
the matching version, URLs and archive checksums, and add **`"updater":
"guided-v1"`** to each supported platform entry (or the manifest's top level).
This marker tells the current app that the package supports preparation for the
guided updater. Never add it to older published packages lacking the inventory
and updater. Publishing source changes alone does not modify already downloaded
installations or already published archives.

Keep the legacy `latest.json` channel separate from this platform update flow.
An older direct-copy updater must never apply these platform packages while TLI
is running. A frontend-only package is not a complete desktop update.
