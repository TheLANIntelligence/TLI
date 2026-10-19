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
    "sha256": "8a50bc28ec59983321f110d6b23c5b110da103cc7f78e24934f0c33a6f878c39",
    "updater": "guided-v1",
    "size_bytes": 21910587
  },
  "macos": {
    "url": "https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.7-beta/TLI_1.4.7-beta_macOS.zip",
    "filename": "TLI_1.4.7-beta_macOS.zip",
    "sha256": "114ac7f9e6ae10bda5982f4857e613a5d231fb705d8564afde799e2c582d1f75",
    "updater": "guided-v1",
    "size_bytes": 29260998,
    "command": "curl -fsSL https://thelanintelligence.com/install_mac.sh | bash",
    "installerUrl": "https://thelanintelligence.com/install_mac.sh"
  }
});
