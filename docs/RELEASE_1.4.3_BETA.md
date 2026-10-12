# TLI 1.4.3-beta

Fixes the **Open model library** button in Ask TLI. Previously it could open a
window that stayed on **Loading models…** without requesting the model list;
the window's close controls also did not work correctly. The button now uses
the same model-library controller as Settings, so models load, downloads can
be started, and closing/reopening the window preserves download progress.

If a browser has not loaded the model-library component, the button displays a
clear reload instruction instead of opening an empty window.

Model downloads still begin only when you choose Download. After a download,
choose **Use this model** to check and activate it for chat. Welcome setup works
offline; downloads of missing models or application components require internet.

For an existing Python-based installation, extract the matching new ZIP into a
separate folder. Stop the original TLI host and back up important saved data,
then use the new package's `TLI_Update.bat` (Windows) or `TLI_Update.command`
(Mac) to update the original installation. Keep using the original folder and
shortcuts. See `docs/TLI_UPDATES.md` in the package.

The temporary workaround for 1.4.2 is to reload the TLI page, then open
**Settings → AI & chat → Local AI model → Open model library**.

This patch does not change model files, download sources, model selection,
runtime requirements, or the separate activation check. See the attached
verification report and checksums for the tested release archives.
