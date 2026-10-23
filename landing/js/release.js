// Verified desktop packages; existing clients use the version-aware update feed.
export const PUBLIC_RELEASE = Object.freeze({
  "version": "1.4.9-beta",
  "releaseDate": "2026-10-22",
  "packageType": "full-install",
  "updater": "guided-v1",
  "notes": "Fresh TLI installations now choose and remember an available local port when the default port 8000 is occupied or unavailable. The launcher opens the verified TLI address and leaves the other application running. Existing installations, saved addresses and explicit port choices stay unchanged. Both Windows and macOS packages include the fix and the existing Intel Mac setup repair. Working 1.4.6 through 1.4.8 installations can use Settings > Software Updates > Download update > Install and restart. Version 1.4.5 still receives the 1.4.6 migration first. Saved data, settings and models stay in the original folder. Android Companion is updated separately.",
  "releaseNotesUrl": "https://github.com/TheLANIntelligence/TLI/releases/tag/v1.4.9-beta",
  "windows": {
    "url": "https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.9-beta/TLI_1.4.9-beta_Windows.zip",
    "filename": "TLI_1.4.9-beta_Windows.zip",
    "sha256": "768f3740bfa57d9b055801f0ff1c796771c4c63efd8eb4278015f6d1d6e5cd9b",
    "updater": "guided-v1",
    "size_bytes": 21914811
  },
  "macos": {
    "url": "https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.9-beta/TLI_1.4.9-beta_macOS.zip",
    "filename": "TLI_1.4.9-beta_macOS.zip",
    "sha256": "470ae6aec3789719c1d5b8ca2a9e689bffdb5e19d8a5dc1cfa9fd8ddbe77400c",
    "updater": "guided-v1",
    "size_bytes": 29266419,
    "command": "curl -fsSL https://thelanintelligence.com/install_mac.sh | bash",
    "installerUrl": "https://thelanintelligence.com/install_mac.sh"
  }
});
