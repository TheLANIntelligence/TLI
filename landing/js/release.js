// Website fresh-install metadata. This record is deliberately independent of
// latest.json: the application's updater can point to frontend-only packages.
// Final archive hashes are filled during release verification before publishing.
export const PUBLIC_RELEASE = Object.freeze({
  version: '1.4.0-beta',
  releaseDate: '2026-10-11',
  packageType: 'full-install',
  releaseNotesUrl: 'https://github.com/TheLANIntelligence/TLI/releases/tag/v1.4.0-beta',
  windows: Object.freeze({
    url: 'https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.0-beta/TLI_1.4.0-beta_Windows_Onboarding.zip',
    filename: 'TLI_1.4.0-beta_Windows_Onboarding.zip',
    sha256: '29aa7439d8267116d7127f0e8baa1dd24f43c11cad3342468bb6cbb08ebd8f24',
  }),
  macos: Object.freeze({
    url: 'https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.0-beta/TLI_1.4.0-beta_macOS.zip',
    filename: 'TLI_1.4.0-beta_macOS.zip',
    sha256: '3fc0f206e7fa04da2099e4460c4de74cc8252b0aacfc9d7b6d7fc8b8f333a636',
    command: 'curl -fsSL https://thelanintelligence.com/install_mac.sh | bash',
    installerUrl: 'https://thelanintelligence.com/install_mac.sh',
  }),
});
