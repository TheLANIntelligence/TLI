// Verified desktop CI artifacts. Older clients use browser download and the new ZIP included updater.
export const PUBLIC_RELEASE = Object.freeze({
  "version": "1.4.5-beta",
  "releaseDate": "2026-10-12",
  "packageType": "full-install",
  "updater": "manual",
  "notes": "Share your home TLI workspace with Android: continue Chat, use selected documents, review conversation settings, and create or improve small apps in Builder. Connect device guides phone, computer and inference Node setup. Saved and nearby connections distinguish discovery, reviewed access and verified availability; bounded recovery checks reconnect to the same reviewed identity and recover the status of existing work. Computer trust and network changes remain explicit desktop-owner decisions, and LAN inference still needs a selected model. Update the home host first and keep it running on the same home network. Physical phone installation, pairing retention and Wi-Fi/sleep recovery remain beta testing areas. The desktop ZIP includes an inference runtime, but Python, dependencies and model weights may need separate downloads. Back up saved data, stop the original host, and use TLI_Update from the extracted new package to preserve an existing installation.",
  "releaseNotesUrl": "https://github.com/TheLANIntelligence/TLI/releases/tag/v1.4.5-beta",
  "windows": Object.freeze({
    "url": "https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.5-beta/TLI_1.4.5-beta_Windows.zip",
    "filename": "TLI_1.4.5-beta_Windows.zip",
    "sha256": "f24d8fc4ba2f6efb1bb5a7b0b7149e8e77d718e57a8655e5d95da52a20ba68c8",
    "updater": "manual",
    "size_bytes": 21488903
  }),
  "macos": Object.freeze({
    "url": "https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.5-beta/TLI_1.4.5-beta_macOS.zip",
    "filename": "TLI_1.4.5-beta_macOS.zip",
    "sha256": "f89a529ee05e1c7233249e3f45304311f1531d257bd0a625e6c23c6894310209",
    "updater": "manual",
    "size_bytes": 28845536,
    "command": "curl -fsSL https://thelanintelligence.com/install_mac.sh | bash",
    "installerUrl": "https://thelanintelligence.com/install_mac.sh"
  })
});
