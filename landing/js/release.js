// Website fresh-install metadata. This record is deliberately independent of
// latest.json: the application's updater can point to frontend-only packages.
// Final archive hashes are filled during release verification before publishing.
export const PUBLIC_RELEASE = Object.freeze({
  version: '1.4.0-beta',
  releaseDate: '2026-10-11',
  packageType: 'full-install',
  releaseNotesUrl: 'https://github.com/TheLANIntelligence/TLI/releases/tag/v1.4.0-beta',
  windows: Object.freeze({
    url: 'https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.0-beta/TLI_1.4.0-beta_Windows.zip',
    filename: 'TLI_1.4.0-beta_Windows.zip',
    sha256: 'SHA256_WINDOWS_PENDING',
  }),
  macos: Object.freeze({
    url: 'https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.0-beta/TLI_1.4.0-beta_macOS.zip',
    filename: 'TLI_1.4.0-beta_macOS.zip',
    sha256: 'SHA256_MACOS_PENDING',
    command: 'curl -fsSL https://thelanintelligence.com/install_mac.sh | bash',
    installerUrl: 'https://thelanintelligence.com/install_mac.sh',
  }),
});
