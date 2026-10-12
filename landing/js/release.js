// Verified CI artifact metadata for fresh installs and guided updates; independent of legacy latest.json.
export const PUBLIC_RELEASE = Object.freeze({
  "version": "1.4.2-beta",
  "releaseDate": "2026-10-11",
  "packageType": "full-install",
  "updater": "guided-v1",
  "notes": "Complete welcome setup offline with music once required components are installed. Reuse existing local models or providers for AI. Prepared installations reuse their dependencies. The ZIP is not a fully self-contained offline installer: missing Python, components and model weights need downloads; optional online services need internet. Includes clearer computer connections and LAN messages, guided updates that preserve the original installation and saved data, Windows uninstall controls and Mac removal guidance. Back up important saved data, stop the original host, and run TLI_Update from the extracted new package to update an existing Python-based installation.",
  "releaseNotesUrl": "https://github.com/TheLANIntelligence/TLI/releases/tag/v1.4.2-beta",
  "windows": Object.freeze({
    "url": "https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.2-beta/TLI_1.4.2-beta_Windows.zip",
    "filename": "TLI_1.4.2-beta_Windows.zip",
    "sha256": "a98480b4fe4e9f334a07536806fe1d56e290a0f4ce4a782e0c5d9f66ad8d152a",
    "updater": "guided-v1",
    "size_bytes": 21382009
  }),
  "macos": Object.freeze({
    "url": "https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.2-beta/TLI_1.4.2-beta_macOS.zip",
    "filename": "TLI_1.4.2-beta_macOS.zip",
    "sha256": "87b7420313edc822e6f728b57be93a5079c537006da09426bc7c977be0680843",
    "updater": "guided-v1",
    "size_bytes": 28745128,
    "command": "curl -fsSL https://thelanintelligence.com/install_mac.sh | bash",
    "installerUrl": "https://thelanintelligence.com/install_mac.sh"
  })
});
