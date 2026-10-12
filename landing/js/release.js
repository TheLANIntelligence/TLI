// Verified CI artifact metadata for fresh installs and guided updates; independent of legacy latest.json.
export const PUBLIC_RELEASE = Object.freeze({
  "version": "1.4.4-beta",
  "releaseDate": "2026-10-11",
  "packageType": "full-install",
  "updater": "guided-v1",
  "notes": "Fixes update certificate-trust failures by combining bundled trusted roots with the system certificate store while keeping HTTPS verification enabled. Automatic checks, when enabled, prompt for newer releases at startup and every six hours while TLI runs; you choose when to download and install, and dismissed releases stay quiet for the page session. Fixes opening the model library from chat so available models load correctly. Complete welcome setup offline with music once required components are installed. Reuse existing local models or providers for AI. Prepared installations reuse their dependencies. The ZIP is not a fully self-contained offline installer: missing Python, components and model weights need downloads; optional online services need internet. Includes clearer computer connections and LAN messages, guided updates that preserve the original installation and saved data, Windows uninstall controls and Mac removal guidance. Back up important saved data, stop the original host, and run TLI_Update from the extracted new package to update an existing Python-based installation.",
  "releaseNotesUrl": "https://github.com/TheLANIntelligence/TLI/releases/tag/v1.4.4-beta",
  "windows": Object.freeze({
    "url": "https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.4-beta/TLI_1.4.4-beta_Windows.zip",
    "filename": "TLI_1.4.4-beta_Windows.zip",
    "sha256": "0f2b756f2213392e3cd32ba693e5ec31f57d75edf4dd707706a2f377a9ebd122",
    "updater": "guided-v1",
    "size_bytes": 21383832
  }),
  "macos": Object.freeze({
    "url": "https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.4-beta/TLI_1.4.4-beta_macOS.zip",
    "filename": "TLI_1.4.4-beta_macOS.zip",
    "sha256": "519309b36087a90079d24f65bd197dd61bc812f4912a0bc14984e713d51b8bc1",
    "updater": "guided-v1",
    "size_bytes": 28746949,
    "command": "curl -fsSL https://thelanintelligence.com/install_mac.sh | bash",
    "installerUrl": "https://thelanintelligence.com/install_mac.sh"
  })
});
