// Verified fresh-install and guided-update metadata; independent of legacy latest.json.
export const PUBLIC_RELEASE = Object.freeze({
  "version": "1.4.1-beta",
  "releaseDate": "2026-10-11",
  "packageType": "full-install",
  "updater": "guided-v1",
  "notes": "Guided welcome with music; clearer computer connections and LAN messages; verified updates that keep the original installation and saved data; Windows uninstall controls and Mac removal guidance. Models install separately. Back up important saved data, stop the original host, and run TLI_Update from the extracted new package to update an existing Python-based installation.",
  "releaseNotesUrl": "https://github.com/TheLANIntelligence/TLI/releases/tag/v1.4.1-beta",
  "windows": Object.freeze({
    "url": "https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.1-beta/TLI_1.4.1-beta_Windows.zip",
    "filename": "TLI_1.4.1-beta_Windows.zip",
    "sha256": "d82ba375275dc5cd09325d9b97bca2ee3c318c41e4b219a462c06e219087c3d2",
    "updater": "guided-v1",
    "size_bytes": 21380434
  }),
  "macos": Object.freeze({
    "url": "https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.1-beta/TLI_1.4.1-beta_macOS.zip",
    "filename": "TLI_1.4.1-beta_macOS.zip",
    "sha256": "e741edf32293d8867af38260773e75f6e72e39859b154ef831f37fcf55422ae0",
    "updater": "guided-v1",
    "size_bytes": 28743564,
    "command": "curl -fsSL https://thelanintelligence.com/install_mac.sh | bash",
    "installerUrl": "https://thelanintelligence.com/install_mac.sh"
  })
});
