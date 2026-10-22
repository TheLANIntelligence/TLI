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
    "sha256": "a48d547045b92928c31c62c8f5f590504d3f2204606ac8225b3353f81b776269",
    "updater": "guided-v1",
    "size_bytes": 21913270
  },
  "macos": {
    "url": "https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.8-beta/TLI_1.4.8-beta_macOS.zip",
    "filename": "TLI_1.4.8-beta_macOS.zip",
    "sha256": "19198c03bb57f9d6731f03a7e1871ee49bddcb1da38c49ede240ae3173fbfc50",
    "updater": "guided-v1",
    "size_bytes": 29264853,
    "command": "curl -fsSL https://thelanintelligence.com/install_mac.sh | bash",
    "installerUrl": "https://thelanintelligence.com/install_mac.sh"
  }
});
