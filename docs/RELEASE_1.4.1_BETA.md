# TLI 1.4.1-beta — one release, across Windows and Mac

This release brings the recent desktop updates together in fresh Windows and
macOS packages: guided onboarding, clearer computer connections and messages,
updates that preserve your installation, and a complete uninstall workflow.

## What's included

- Guided welcome with appearance previews, optional PIN protection, AI setup,
  resume support and a soundtrack with playback controls. Windows setup prepares
  prerequisites and opens the workspace automatically when ready; an optional
  local AI issue keeps its repair guidance without blocking welcome setup.
- A computer connection request flow with a code to compare on both computers,
  clearer discovered names, and separate consent for messaging. Chat drafts stay
  in place during setup. LAN inference still requires explicit reviewed access
  and a selected resource; pairing does not silently grant inference authority.
- Guided Windows and Mac updates with a hashed package inventory, an explicit
  destination and confirmation, and backups of replaced application files for
  rollback. Your data, models, settings and original shortcuts stay in place.
- Uninstall controls and platform launchers that explain what will be removed,
  require the host to stop first, and offer a way to preserve saved data.
- The current Ask TLI workspace, Files, Vault, Free Space, connected tools,
  reviewed manual routines and small web-app Builder from the 1.4.0 beta.

## Fresh installation

- **Windows:** download `TLI_1.4.1-beta_Windows.zip`, extract the entire ZIP into
  a new writable folder, open **TLI.exe**, then choose **Set up TLI**. Requires
  64-bit Windows 10/11 and internet access for initial dependencies.
- **Mac:** download `TLI_1.4.1-beta_macOS.zip`, extract into a new writable
  folder, and open **TLI_Start.command**. Install Python 3.10+ first; python.org
  users should also run **Install Certificates.command** from their Python
  folder in Applications. The bundled runtime requires macOS 14+ on Apple
  Silicon or macOS 13.3+ on Intel. Keep Terminal open; Control+C stops TLI.

Use the named platform ZIPs, not GitHub's automatic source-code archives. Both
packages contain prepared inference runtimes; model weights are downloaded
separately. Read **START_HERE.md** before setup.

The optional website Mac installer downloads the same official Mac ZIP,
verifies SHA-256 and creates a fresh folder beside existing installations.

## Updating an existing installation

Download and extract the matching new ZIP separately. Stop the original TLI
through its own local controls or Terminal. Open **TLI_Update.bat** (Windows)
or **TLI_Update.command** (Mac) from the **new package**, select the original
installation folder, review the destination and type **UPDATE**. Restart TLI
from the original folder or shortcut. Startup may need internet access to
prepare changed dependencies.

Updater-equipped installations can check for future compatible packages in
**Settings → Software Updates**. Older releases must obtain this package from
the website first; their legacy updater is not pointed at these new ZIPs.
Back up important saved data before updating. An application-file rollback
backup does not replace a data or Vault backup.

## Verification and beta limits

Release assets are accompanied by SHA-256 checksums and platform verification
reports. Checks cover clean dependency setup, extracted application identity,
static assets and the bundled native inference runtimes on Windows, Apple
Silicon and Intel macOS. Isolated tests cover pairing, messaging, guided updates,
rollback, onboarding and uninstall behavior.

These checks do not certify model quality, every physical device or delivery
between a particular pair of computers. Windows launchers remain unsigned;
the Mac package is a Python-based Terminal installation, not a notarized app.
Phone Companion builds are separate and are not included in these desktop ZIPs.
