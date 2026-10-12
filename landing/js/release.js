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
    "sha256": "2cd97c96e888c9cded6cc436a625de837a4b77fbc9f3fa93457611d4bcafda68",
    "updater": "guided-v1",
    "size_bytes": 21381641
  }),
  "macos": Object.freeze({
    "url": "https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.1-beta/TLI_1.4.1-beta_macOS.zip",
    "filename": "TLI_1.4.1-beta_macOS.zip",
    "sha256": "2de0dc0d56593f0ad6ad9372b75dd40d3b13814e3133d24aed29d730fe61004f",
    "updater": "guided-v1",
    "size_bytes": 28744865,
    "command": "curl -fsSL https://thelanintelligence.com/install_mac.sh | bash",
    "installerUrl": "https://thelanintelligence.com/install_mac.sh"
  })
});
