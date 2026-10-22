// Verified desktop packages; existing clients use the version-aware update feed.
export const PUBLIC_RELEASE = Object.freeze({
  "version": "1.4.8-beta",
  "releaseDate": "2026-10-22",
  "packageType": "full-install",
  "updater": "guided-v1",
  "notes": "Intel Mac setup now uses a verified prebuilt encryption component instead of compiling it locally. The Mac launcher selects supported standard Python 3.10 through 3.14, preferring 3.13, and explains how to preserve and repair an existing unsupported environment. Working 1.4.6 and 1.4.7 installations can use Settings > Software Updates > Download update > Install and restart. Existing 1.4.5 users still receive the 1.4.6 migration first. Saved data, settings and models stay in the original folder. The corrected Intel component requires one internet download. Android Companion is updated separately.",
  "releaseNotesUrl": "https://github.com/TheLANIntelligence/TLI/releases/tag/v1.4.8-beta",
  "windows": {
    "url": "https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.8-beta/TLI_1.4.8-beta_Windows.zip",
    "filename": "TLI_1.4.8-beta_Windows.zip",
    "sha256": "5886120879a63c0ceea475cda21f3c5a240ec53e7852a0180e3a85a1d31a7c95",
    "updater": "guided-v1",
    "size_bytes": 21913271
  },
  "macos": {
    "url": "https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.8-beta/TLI_1.4.8-beta_macOS.zip",
    "filename": "TLI_1.4.8-beta_macOS.zip",
    "sha256": "6355e36963f9f9e54cf89fa30f09d8b0276a1961fe6593d22fcaac3a5eb56bf8",
    "updater": "guided-v1",
    "size_bytes": 29264876,
    "command": "curl -fsSL https://thelanintelligence.com/install_mac.sh | bash",
    "installerUrl": "https://thelanintelligence.com/install_mac.sh"
  }
});
