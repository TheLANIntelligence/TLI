#!/usr/bin/env bash
# Local removal guidance for source/portable installations on Linux and macOS.
# No port-based process killing or recursive deletion: neither proves ownership.
set -eu
tli_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
printf '\nTLI removal - this installation:\n%s\n\n' "$tli_dir"
cat <<'GUIDE'
1. Export and verify the Settings and Vault backups you want to keep.
   Keep backups outside this installation folder. A Settings backup alone
   does not include the entire Vault, credentials or model library.
2. Finish active work, then press Control+C in the Terminal window that
   launched TLI. Closing the browser does not stop the host.
3. Remove only this installation's login/startup entry and launcher shortcuts
   if you created them. Stop its optional helper separately, if present.
4. Once it has stopped, use your file manager to remove the exact folder
   printed above. Review any personal files or linked folders first.
   Removing this folder deletes saved work, settings, Vault and models inside it.
5. Remove the TLI browser extension or phone app separately if installed.
   Clear this host's browser site data if you also want browser history and
   preferences removed. External models and shared software stay installed.

This guide has not stopped programs or removed files. Automatic removal is
currently provided by the Windows release's native uninstaller.
GUIDE
