import type { DataHealth } from './data-health';

/** Synthetic host checks for the browser preview. No files or backups are inspected. */
export function sampleDataHealth(unavailable = false): DataHealth {
  return {
    schema_version: 1, checked_at: new Date().toISOString(), host: { id: 'sample-home', name: 'Legato Home' },
    scope: 'Sample checks for the paired owner’s Notebook, shared conversations and diagnostic reports. No real host files were read; Vault contents are outside these checks.',
    checks: [
      { id: 'notebook', label: 'Household Notebook', status: unavailable ? 'unavailable' : 'readable', detail: unavailable ? 'Sample encrypted notes could not be read. Preserve the existing files and key before investigating; no new key was created.' : 'The sample owner’s saved notes could be read during this check.' },
      { id: 'conversations', label: 'Shared conversations', status: unavailable ? 'not_checked' : 'readable', detail: unavailable ? 'The sample conversation store was not checked. This is not an empty-history result.' : 'The sample conversation store could be read during this check.' },
      { id: 'diagnostics', label: 'Saved diagnostic reports', status: 'not_created', detail: 'The sample owner has not created a diagnostic report store. This does not confirm a backup exists.' },
    ],
    backup: { status: 'unknown', detail: 'This preview has no backup inventory. TLI has not verified that a separate copy exists or can be restored.' },
    guidance: {
      summary: 'Make a separate copy from the TLI host. This phone is not a backup and cannot restore the installation.',
      steps: [
        'If data appears missing or unreadable, stop making changes and preserve the existing installation.',
        'Stop TLI normally on its host before making a manual copy, so files are not changing during the copy.',
        'Follow the host’s Data & Recovery instructions to copy its data and required key files together to a private, separate location.',
        'Keep the original files intact. Review a recovery copy separately before replacing anything in the working installation.',
      ],
      limitations: ['These sample checks do not inspect Vault contents or prove that a backup is recoverable.', 'The Companion does not download archives, reset stores, generate keys or restore data.'],
    },
  };
}
