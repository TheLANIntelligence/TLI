// Browser-only inert observations; native transport never imports this fixture.
import type { Report } from './types';
import type { RecordedReport } from './report-facts';
export const PREVIEW_REPORT_REVISION = '2'.repeat(64);
export const PREVIEW_REPORT_FACTS: RecordedReport = {
  version: 1, basis: 'saved_report', report_id: 'sample-performance-report', kind: 'performance', host: { id: 'sample-home', name: 'Legato Home' }, target: null,
  process: { name: 'Synthetic compile process', pid: 81, create_time: 1788868800 }, recorded_at: '2026-09-08T12:00:07Z', started_at: '2026-09-08T12:00:00Z', finished_at: '2026-09-08T12:00:07Z', duration_seconds: 7, requested_duration_seconds: 30,
  status: 'stopped', status_label: 'Observation stopped', recorded_samples: 7, expected_samples: 30, raw_samples_included: 0, checks: [], omitted_checks: 0,
  measurements: [{ key: 'host_cpu_percent', label: 'Host CPU', scope: 'host', unit: 'percent', valid_samples: 7, minimum: 60, mean: 88, maximum: 98 }, { key: 'process_cpu_percent', label: 'Selected process CPU (whole host capacity)', scope: 'selected_process', unit: 'percent', valid_samples: 6, minimum: 40, mean: 52, maximum: 65 }, { key: 'process_rss_bytes', label: 'Selected process resident memory', scope: 'selected_process', unit: 'bytes', valid_samples: 0, minimum: null, mean: null, maximum: null }],
  limitations: ['Synthetic browser preview. No real process, measurement or action.', 'Stopped after seven samples; one process CPU sample and all resident-memory samples are unavailable.'],
};
export const PREVIEW_REPORT: Report = { id: PREVIEW_REPORT_FACTS.report_id, kind: 'performance', host: { id: 'sample-home', name: 'Legato Home' }, created_at: PREVIEW_REPORT_FACTS.recorded_at!, checks: [], scope: 'Synthetic saved performance observation, not a live check.', recorded_facts: PREVIEW_REPORT_FACTS };
export const previewReportSource = () => ({ handle: 'R1', kind: 'report', id: PREVIEW_REPORT.id, revision: PREVIEW_REPORT_REVISION, label: 'Synthetic stopped observation', provenance: 'diagnostic', saved_at: PREVIEW_REPORT.created_at, host_id: 'sample-home', target_id: null, ranges: [] });
