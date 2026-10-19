// Verified desktop packages; existing clients use the version-aware update feed.
export const PUBLIC_RELEASE = Object.freeze({
  "version": "1.4.7-beta",
  "releaseDate": "2026-10-19",
  "packageType": "full-install",
  "updater": "guided-v1",
  "notes": "Updates now offer Download update and Install and restart inside TLI. Review the version and original host address, finish active work, then confirm. Saved data, settings, identities and models stay in place; changed Python dependencies may need internet access. This release hides HomeLab from everyday navigation, clarifies Task tools inside chat, and adds concrete Game Optimizer trials with your own before/after measurements. Existing 1.4.5 installations first receive the 1.4.6 updater migration with one final manual completion; subsequent updates can finish inside TLI. Android Companion is updated separately.",
  "releaseNotesUrl": "https://github.com/TheLANIntelligence/TLI/releases/tag/v1.4.7-beta",
  "windows": {
    "url": "https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.7-beta/TLI_1.4.7-beta_Windows.zip",
    "filename": "TLI_1.4.7-beta_Windows.zip",
    "sha256": "0e07e30575db5b11921d1c7c58eba37d1f8d250985d045a2fa4faa89dbf69b1c",
    "updater": "guided-v1",
    "size_bytes": 21910787
  },
  "macos": {
    "url": "https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.7-beta/TLI_1.4.7-beta_macOS.zip",
    "filename": "TLI_1.4.7-beta_macOS.zip",
    "sha256": "580bd9d056c9f76015c7b926149bde09b7495e8ef94c1f14a87b29a6f50bf6f3",
    "updater": "guided-v1",
    "size_bytes": 29261213,
    "command": "curl -fsSL https://thelanintelligence.com/install_mac.sh | bash",
    "installerUrl": "https://thelanintelligence.com/install_mac.sh"
  }
});
