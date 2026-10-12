import { PreviewCases } from '../../src/cases-preview';
import { PreviewWorkspace } from '../../src/workspace-preview';
import { PREVIEW_REPORT, PREVIEW_REPORT_FACTS, previewReportSource } from '../../src/report-preview';
import { validateNotePreview } from '../../src/reviewed-note';
import { validSourceRef } from '../../src/answer-evidence';
// Browser-only product preview. This module never opens a network connection,
// reads native pairing storage, or accepts real credentials. Native builds keep
// resolving index.ts and the certificate-pinned Expo module.
import type { NativeRequest, NativeResponse, Transport } from '../../src/client';
import type { Activity, Conversation, Device, Preferences, Report, Scene, ScreenshotOptions, ScreenshotReceipt } from '../../src/types';
import { PreviewNotebook, PreviewNotebookError } from '../../src/notebook-preview';
import { sampleDataHealth } from '../../src/data-health-preview';
import { previewCheckOptions, previewCheckReport, PREVIEW_COMPUTER, PREVIEW_PEER } from '../../src/guided-checks-preview';
import { checkRequest, type CheckRequest } from '../../src/guided-checks';

const node = { id: 'sample-home', name: 'Legato Home' };
const devices: Device[] = [
  { id: 'sample-lamp', source_id: 'reading-lamp', source: 'homepower', name: 'Reading lamp', room: 'Living room', kind: 'smart_device', node_id: node.id },
  { id: 'sample-kitchen', source_id: 'kitchen-lights', source: 'homepower', name: 'Kitchen lights', room: 'Kitchen', kind: 'smart_device', node_id: node.id },
  { id: 'sample-garden', source_id: 'garden-lights', source: 'homepower', name: 'Garden lights', room: 'Garden', kind: 'smart_device', node_id: node.id },
  { id: 'sample-printer', source_id: 'studio-printer', source: 'printer', name: 'Studio printer', room: 'Studio', kind: 'printer', node_id: node.id, status: 'Attention needed · paper path', observed_at: new Date(Date.now() - 12 * 60000).toISOString() },
  { id: PREVIEW_COMPUTER, source_id: node.id, source: 'local_node', name: 'Legato Home', room: 'Studio', kind: 'computer', node_id: node.id },
  { id: PREVIEW_PEER, source_id: 'sample-peer', source: 'mesh', name: 'Sample workshop computer', room: 'Workshop', kind: 'computer', node_id: 'sample-peer' },
];
const scenes: Scene[] = [
  { scene_id: 'sample-evening', name: 'Settle in', description: 'A softer light for a slower evening.', enabled: true, actions: [{ device_id: 'reading-lamp', capability: 'switch.on' }, { device_id: 'kitchen-lights', capability: 'switch.off' }] },
  { scene_id: 'sample-goodnight', name: 'Good night', description: 'Switch off the lights around your home.', enabled: true, actions: [{ device_id: 'reading-lamp', capability: 'switch.off' }, { device_id: 'kitchen-lights', capability: 'switch.off' }, { device_id: 'garden-lights', capability: 'switch.off' }] },
];
const report: Report = {
  id: 'sample-printer-report', kind: 'device', created_at: new Date(Date.now() - 12 * 60000).toISOString(),
  target: { id: 'sample-printer', name: 'Studio printer' }, scope: 'Sample report: these checks illustrate what your TLI host can report. No real device was checked.',
  checks: [
    { id: 'connection', label: 'Network connection', status: 'pass', detail: 'The sample printer responds on the home network.' },
    { id: 'queue', label: 'Print queue', status: 'fail', detail: 'One sample print job is waiting while the printer reports a paper-path warning.' },
    { id: 'paper', label: 'Paper path', status: 'unavailable', detail: 'A photo or physical inspection can help locate the issue; software cannot see inside the printer.' },
  ],
};
const stamp = Date.now() / 1000;
const activity: Activity[] = [
  { title: 'Your printer needs a little attention', body: 'The Studio printer has a waiting job and a paper-path warning. A photo can help TLI understand what you see.', level: 'warn', ts: stamp - 12 * 60, count: 1, sequence: 3, category: 'device', node: node.name, actions: [{ target_id: 'sample-printer' }] },
  { title: 'A quieter evening is ready', body: 'Your Settle in scene is saved with the reading lamp and kitchen lights.', level: 'info', ts: stamp - 45 * 60, count: 1, sequence: 2, category: 'automation', node: node.name },
  { title: 'Your home is up to date', body: 'The latest sample device inventory and diagnostic report are ready to explore.', level: 'ok', ts: stamp - 70 * 60, count: 1, sequence: 1, category: 'system', node: node.name },
];

type HeadersListener = (event: { id: string; status: number; headers: Record<string, string> }) => void;
type ChunkListener = (event: { id: string; chunk: string }) => void;
class PreviewTransport implements Transport {
  private workspace = new PreviewWorkspace();
  private cases = new PreviewCases();
  private guidedReports: Report[] = [];
  private headers = new Set<HeadersListener>();
  private chunks = new Set<ChunkListener>();
  private jobs = new Map<string, { timer?: ReturnType<typeof setTimeout>; reject: (error: Error) => void }>();
  private preferences: Preferences = { favorite_devices: ['sample-lamp', 'sample-printer'], favorite_scenes: ['sample-evening'], theme: typeof location !== 'undefined' && new URLSearchParams(location.search).get('sample_theme') === 'dark' ? 'dark' : 'light' };
  private power: Record<string, boolean> = { 'reading-lamp': true, 'kitchen-lights': false };
  private reviewed = false;
  private notebook = new PreviewNotebook();
  private dataHealthChecks = 0;
  private connectionChecks = 0;
  private photoProvider = { key: 'a'.repeat(64), provider: 'Preview', model: 'Sample vision', destination: 'sample-home.invalid', note: 'Simulated destination. This preview sends no images or network requests.' };
  private providerChanged = false;
  private conversations: Conversation[] = [{
    id: 'sample-conversation', title: 'A little help with the Studio printer', last_updated: new Date(Date.now() - 8 * 60000).toISOString(),
    messages: [
      { role: 'user', content: 'My printer is showing a paper warning. What should I check?' },
      { role: 'assistant', content: 'In this sample home, the Studio printer is reachable and one job is waiting. Check the paper tray and gently inspect the accessible paper path. If there’s an error message, add a photo and select Studio printer so we can discuss it alongside the saved diagnostic report.', model: 'Sample TLI', provider: 'Preview', host: node.name },
    ],
  }];
  async configure(_options: { origin: string; certificateDer: string }) { /* No live connection exists in the web preview. */ }
  async reset() { for (const id of this.jobs.keys()) this.cancel(id); }
  cancel(id: string) { const job = this.jobs.get(id); if (job) { clearTimeout(job.timer); this.jobs.delete(id); job.reject(Object.assign(new Error('The sample response was stopped.'), { code: 'E_CANCELLED' })); } }
  addListener(event: 'onHeaders', listener: HeadersListener): { remove(): void };
  addListener(event: 'onChunk', listener: ChunkListener): { remove(): void };
  addListener(event: 'onHeaders' | 'onChunk', listener: HeadersListener | ChunkListener) {
    if (event === 'onHeaders') { this.headers.add(listener as HeadersListener); return { remove: () => { this.headers.delete(listener as HeadersListener); } }; }
    this.chunks.add(listener as ChunkListener); return { remove: () => { this.chunks.delete(listener as ChunkListener); } };
  }
  private response(body: unknown, status = 200): NativeResponse { return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }; }
  private execute(id: string, capability: string) {
    if (id === 'garden-lights') return { ok: false, device_id: id, capability, error: 'Sample device unavailable · check its power or Wi-Fi.' };
    this.power[id] = capability === 'switch.on';
    return { ok: true, device_id: id, capability, summary: `${id === 'reading-lamp' ? 'Reading lamp' : 'Kitchen lights'} ${this.power[id] ? 'on' : 'off'} · simulated action` };
  }
  private reply(body: Record<string, unknown>): string {
    if (Array.isArray(body.note_refs) && body.note_refs.length) return 'This is a sample Notebook answer. Your explicitly selected notes were provided with this question as user-saved information. The preview does not call an AI model or perform any actions.\n\nOpen a note from the receipt to review its current version. Editing or deleting it does not rewrite this earlier answer.';
    if (body.screenshot) return 'Sample screenshot guidance: the illustrated display shows CHECK PAPER PATH. This snapshot alone cannot confirm the cause. Check the visible tray message and follow the printer’s on-screen instructions. Share another image after taking a step.\n\nThis preview does not analyze images, run diagnostics or control your computer.';
    if (body.image_b64) return 'This is a sample photo walkthrough. The illustrated display shows a paper-path warning. The attached sample report says the printer is reachable and a job is waiting.\n\n1. Check the paper tray is seated and the paper guides are snug.\n2. Look for visible paper in the accessible path; avoid forcing any parts.\n3. Follow the printer’s on-screen instructions, then retry the waiting job.\n\nIn the native app, your selected vision model examines the actual photo. This preview does not analyze images or contact your home.';
    if (body.target_id === 'sample-printer' || /printer|paper|diagnostic/i.test(String(body.message))) return 'In this sample home, the Studio printer is connected, but a paper-path warning has paused a job. Open its diagnostic report to see what was checked, or use the camera button to try a sample photo.\n\nThe real app sends your selected device and saved report alongside your question, then keeps the conversation available on your TLI desktop.';
    if (/light|scene|home/i.test(String(body.message))) return 'Your sample home has a reading lamp, kitchen lights, garden lights, and a Studio printer. Try Settle in from Today, or open Home to run Good night and see how a partial failure is reported.\n\nThese controls are simulated here. In the native app, TLI runs the action on your home network and reports each device’s result.';
    return 'This is an interactive preview of TLI Companion. I can show how you catch up with home activity, control favorite devices and scenes, or work through a printer issue with a photo and diagnostic evidence.\n\nTry Home, open Studio printer, and choose Ask TLI about this device. The native app uses your own TLI model and shares the conversation with your desktop.';
  }
  async request(options: NativeRequest): Promise<NativeResponse> {
    const { path, method } = options;
    const body: Record<string, unknown> = options.body ? JSON.parse(options.body) : {};
    if ((globalThis as any).__TLI_PREVIEW_VERIFY__) { const log = (globalThis as any).__TLI_PREVIEW_REQUESTS__ ||= []; log.push({ path, method, body }); if (log.length > 500) log.shift(); }
    const workspaceResult=this.workspace.request(path,method,body,this.conversations);if(workspaceResult)return workspaceResult;
    if (path === '/api/intelligence/data-health') {
      if (method !== 'GET') return this.response({ detail: 'Data checks are read-only.' }, 405);
      const scenario = typeof location === 'undefined' ? '' : new URLSearchParams(location.search).get('sample_data_health');
      this.dataHealthChecks++;
      if (scenario === 'fail' || scenario === 'fail_after_first' && this.dataHealthChecks > 1) return this.response({ detail: 'Sample data check unavailable. The previous result, if any, is unchanged.' }, 503);
      return { ...this.response(sampleDataHealth(scenario === 'unavailable')), headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } };
    }
    if (path === '/api/intelligence/memory/capabilities') return this.response({ ok: true, protocol: 'tli-memory-continuity-v1', use_conversation_history: true, evidence_context_version: 1 });
    if (path.split('?')[0] === '/api/intelligence/diagnostics/options') {
      const result = previewCheckOptions(new URL(path, 'https://preview.invalid').searchParams.get('computer_id'));
      if ((globalThis as any).__TLI_PREVIEW_VERIFY__ && (globalThis as any).__TLI_PREVIEW_NEXT_CHECK_SCENARIO__ === 'scope_changed') result.options.filter(o => o.kind !== 'performance').forEach(o => o.scope_revision = '9'.repeat(64));
      return this.response(result);
    }
    if (path === '/api/intelligence/diagnostics' && method === 'POST' && body.expected_scope) {
      const choice = previewCheckOptions(body.kind === 'peer_system' ? PREVIEW_PEER : PREVIEW_COMPUTER).options.find(o => o.kind === body.kind);
      if (!choice || choice.kind === 'performance') return this.response({ detail: 'Review a supported sample check.' }, 422);
      const expected = checkRequest(choice, body.internet === true, String(body.request_id || ''));
      if (Object.keys(expected).some(key => expected[key as keyof CheckRequest] !== body[key])) return this.response({ detail: 'Sample check scope changed; review it again.' }, 409);
      if (body.next_check_ref) {
        try {
          const binding = body.next_check_ref as any, g = this.cases.nextCheck({ case_ref: binding.case_ref }).guidance;
          if (binding.selection_sha256 !== g.selection_sha256 || binding.option_id !== g.suggestion?.option_id || binding.option_id !== body.kind || body.internet) return this.response({ detail: 'Sample next-check binding changed; review it again.' }, 409);
        } catch (e) { if (e instanceof PreviewNotebookError) return this.response({ detail: e.message }, e.status); throw e; }
      }
      const scenario = (globalThis as any).__TLI_PREVIEW_VERIFY__ ? (globalThis as any).__TLI_PREVIEW_CHECK_SCENARIO__ : '';
      if (scenario === 'failure') return this.response({ detail: 'Sample check unavailable. The previous saved report is unchanged.' }, 503);
      if (scenario === 'slow') await new Promise(resolve => setTimeout(resolve, 1200));
      const result = previewCheckReport(expected, this.guidedReports.length + 1); this.guidedReports.unshift(result); return this.response(result);
    }
    if (path.startsWith('/api/intelligence/memory/from-chat/')) {
      const ref = body.source_ref;
      if (!validSourceRef(ref)) return this.response({ detail: 'Sample saved source unavailable.' }, 404);
      const conversation = this.conversations.find(c => c.id === ref.conversation_id), message = conversation?.messages?.[ref.message_index];
      if (!message || message.source_ref?.revision !== ref.revision) return this.response({ detail: 'The saved source changed; reopen the conversation.' }, 409);
      const preview = { source: { ...ref, role: message.role }, source_kind: message.role === 'assistant' ? 'ai_suggestion' : 'user_statement', text: message.content, suggested_text: message.content.slice(0, 2000), suggested_title: message.content.slice(0, 80), requires_excerpt: message.content.length > 2000 };
      if (path.endsWith('/preview')) return this.response(validateNotePreview(preview, ref));
      try { return this.response(this.notebook.saveChat(body, message.role === 'assistant' ? 'chat_ai' : 'chat_user')); } catch (e) { if (e instanceof PreviewNotebookError) return this.response({ detail: e.message }, e.status); throw e; }
    }
    if (path === '/api/intelligence/cases/next-check' && (globalThis as any).__TLI_PREVIEW_VERIFY__) {
      const scenario = (globalThis as any).__TLI_PREVIEW_NEXT_CHECK_SCENARIO__;
      if (scenario === 'conflict') return this.response({ detail: 'Sample saved case changed. Review its current version; nothing ran.' }, 409);
      if (scenario === 'slow') await new Promise(resolve => setTimeout(resolve, 1200));
      if (scenario === 'malformed') return this.response({ ok: true, protocol: 'tli-cases-v1', guidance: { status: 'healthy' } });
      if (scenario === 'revoked') return this.response({ detail: 'Sample credential revoked.' }, 401);
    }
    try { const value = this.cases.request(path, method, body); if (value !== undefined) return this.response(value); } catch (e) { if (e instanceof PreviewNotebookError) return this.response({ detail: e.message }, e.status); throw e; }
    try { const result = this.notebook.request(path, method, body); if (result !== undefined) return this.response(result); }
    catch (error) { if (error instanceof PreviewNotebookError) return this.response({ detail: error.message }, error.status); throw error; }
    if (path === '/api/companion/v1/bootstrap') {
      this.connectionChecks++;
      const scenario = typeof location === 'undefined' ? '' : new URLSearchParams(location.search).get('sample_connection');
      if (scenario === 'unreachable' || scenario === 'trust') throw Object.assign(new Error('Sample connection check failed.'), { code: scenario === 'trust' ? 'E_TLS_TRUST' : 'E_NETWORK' });
      if (scenario === 'revoked') return this.response({ detail: 'Sample phone credential was rejected.' }, 401);
      if (scenario === 'fail_after_first' && this.connectionChecks > 1) return this.response({ detail: 'Sample TLI responded, but its connection check could not complete.' }, 503);
      const status = scenario === 'ai_unavailable' ? 'unavailable' : scenario === 'ai_unknown' ? 'unknown' : 'available';
      return this.response({ api_version: scenario === 'version' ? 2 : 1, node,
        capabilities: { vision: status === 'available', chat: status === 'available', home_control: true, preferences: true,conversation_settings:true,documents:true,builder:true,lan_inference:true,host_runs:!!((globalThis as any).__TLI_PREVIEW_VERIFY__&&(globalThis as any).__TLI_PREVIEW_HOST_RUNS__) },
        ai: { status, provider: 'Preview', model: 'Sample TLI', detail: status === 'available' ? 'A simulated model is available in this preview. No inference runs.' : status === 'unavailable' ? 'The sample host is connected, but its model is unavailable. Controls and diagnostics remain separate.' : 'The sample host is connected. Its model has no recent health confirmation.', checked_at: new Date().toISOString() },
        chat: { path: '/api/ai/chat/stream', streaming: true } });
    }
    if (path === '/api/companion/v1/preferences') { if (method === 'PUT') this.preferences = body as unknown as Preferences; return this.response(this.preferences); }
    if (path === '/api/companion/v1/pairings/redeem') return this.response({ detail: 'Pairing a real TLI requires the native companion app.' }, 403);
    if (path === '/api/intelligence/devices') return this.response({ node, devices });
    if (path === '/api/intelligence/screenshots/context') return this.response({ host: node, computers: devices.filter(d => d.kind === 'computer'), provider: this.photoProvider, checked_at: new Date().toISOString() });
    if (path === '/homepower/devices') return this.response({ devices: devices.filter(d => d.source === 'homepower').map(d => ({ device_id: d.source_id, capabilities: ['switch.on', 'switch.off'] })) });
    if (path === '/homepower/scenes') return this.response({ scenes });
    if (path === '/homepower/scenes/run') { const scene = scenes.find(s => s.scene_id === body.scene_id); if (!scene) return this.response({ detail: 'Sample scene not found.' }, 404); const results = (scene.actions || []).map(action => this.execute(action.device_id, action.capability)); return this.response({ ok: results.every(r => r.ok), scene, results }); }
    const power = /^\/homepower\/devices\/([^/]+)\/(status|execute)$/.exec(path);
    if (power) { const id = decodeURIComponent(power[1]!); return this.response(power[2] === 'execute' ? this.execute(id, String(body.capability)) : id === 'garden-lights' ? { ok: false, summary: 'Sample device unavailable' } : { ok: true, on: this.power[id], summary: `${this.power[id] ? 'On' : 'Off'} · sample status` }); }
    if (path === '/dashboard/activity-summary/review') { this.reviewed = true; return this.response({ ok: true }); }
    if (path === '/dashboard/activity-summary') return this.response({ checked_at: Date.now() / 1000, total: this.reviewed ? 0 : 3, warning_count: this.reviewed ? 0 : 1, groups: this.reviewed ? [] : activity, events: this.reviewed ? [] : activity, cursor: { stream_id: 'a'.repeat(32), sequence: 3 }, coverage_note: 'Sample activity for this interactive preview. No live home events are being read.' });
    if (path === '/api/diagnostics/version') {
      const scenario = (globalThis as any).__TLI_PREVIEW_VERIFY__ && (globalThis as any).__TLI_PREVIEW_RELEASE_SCENARIO__;
      if (scenario === 'unavailable') return this.response({ detail: 'Synthetic release unavailable' }, 404);
      return this.response({ release: { schema_version: 1, protocol: 'dependable-computers-v1', source_id: 'a'.repeat(64), backend_id: 'b'.repeat(64), frontend_id: 'c'.repeat(64), started_at: '2026-09-09T12:00:00Z', checked_at: new Date().toISOString(), identity_scope: 'Synthetic application code only; excludes user data and models.', capabilities: ['case_report_review_v1'], compatibility: { state: scenario === 'restart' ? 'restart_required' : 'matched', reasons: scenario === 'restart' ? ['Synthetic files changed after startup. No real host was inspected.'] : [] } } });
    }
    if (path === '/api/intelligence/diagnostics') return this.response(method === 'POST' ? { ...report, target: devices.find(d => d.id === body.target_id) || report.target, created_at: new Date().toISOString() } : { reports: [...this.guidedReports, PREVIEW_REPORT, report] });
    if (path === '/api/intelligence/diagnostics/' + PREVIEW_REPORT.id) return this.response(PREVIEW_REPORT);
    if (path.startsWith('/api/intelligence/diagnostics/sample-guided-')) return this.response(this.guidedReports.find(r => r.id === path.split('/').pop()) || { detail: 'Sample report unavailable.' }, this.guidedReports.some(r => r.id === path.split('/').pop()) ? 200 : 404);
    if (path.startsWith('/api/intelligence/diagnostics/')) return this.response(report);
    if (path === '/api/ai/conversations') return this.response({ conversations: this.conversations.map(({ messages: _messages, ...conversation }) => conversation) });
    if (path.startsWith('/api/ai/conversations/')) { const conversation = this.conversations.find(c => c.id === decodeURIComponent(path.split('/').pop()!)); return conversation ? this.response(conversation) : this.response({ detail: 'Sample conversation not found.' }, 404); }
    if (path === '/api/ai/chat/stream' || path === '/chat') {
      let note_context, caseEvidence;
      try { note_context = this.notebook.resolve(body); caseEvidence = this.cases.context(body); }
      catch (error) { if (error instanceof PreviewNotebookError) return this.response({ detail: error.message }, error.status); throw error; }
      const shot = body.screenshot as ScreenshotOptions | undefined;
      if (/simulate provider change/i.test(String(body.message)) && !this.providerChanged) { this.providerChanged = true; this.photoProvider = { ...this.photoProvider, key: 'b'.repeat(64), model: 'Changed sample vision' }; }
      if (body.image_b64 && (shot?.provider_key || body.image_provider_key) !== this.photoProvider.key) return this.response({ detail: 'The photo destination changed. Recheck and review it before sending again.' }, 409);
      if (shot && body.diagnostic_id) return this.response({ detail: 'This report does not measure the screenshot’s computer. Clear the attached report or choose its host.' }, 409);
      if (/simulate failure/i.test(String(body.message))) return this.response({ detail: 'Sample vision provider unavailable. Your question was not completed.' }, 502);
      const screenshot_context: ScreenshotReceipt | undefined = shot ? { task: shot.task, computer: devices.find(d => d.id === shot.target_id && d.kind === 'computer') || { name: shot.other_computer || 'Unknown computer', node_id: null }, report_id: null, capture: 'user_shared_snapshot', actions_performed: false } : undefined;
      let conversation = this.conversations.find(c => c.id === body.conversation_id);
      if (!conversation) { conversation = { id: `sample-chat-${Date.now()}`, title: String(body.message || 'Sample conversation').slice(0, 60), messages: [] }; this.conversations.unshift(conversation); }
      const response = caseEvidence ? `Synthetic preview: the selected case is ${caseEvidence.case_context.status}. This sample response demonstrates its historical receipt [C1]. No AI, check or repair ran.` : this.reply(body); conversation.last_updated = new Date().toISOString();
      conversation.messages!.push({ role: 'user', content: String(body.message) });
      const evidence = { source_ref: { conversation_id: conversation.id, message_index: conversation.messages!.length, revision: conversation.messages!.length.toString(16).padStart(64, '0') }, memory_context: { use_saved_memory: body.use_saved_memory !== false, status: body.use_saved_memory === false ? 'disabled' : 'none', notes: [], omitted_for_budget: 0 }, conversation_context: { status: body.use_conversation_history === false ? 'disabled' : 'none', ...(body.use_conversation_history === false ? { use_conversation_history: false } : {}), included_messages: 0, included_exchanges: 0, omitted_messages: 0, character_budget: 2000 } };
      const extraEvidence = /show evidence/i.test(String(body.message)) ? {
        observation_context: { schema_version: 1, topic: 'cpu', status: 'stale', host: node, resource: 'CPU on sample host', source: 'Synthetic preview', coverage: 'Sample CPU observation only. No device was checked.', observed_at: '2026-09-08T10:00:00Z', checked_at: '2026-09-08T10:01:00Z' },
        input_budget: { version: 1, provider: 'unknown', estimation: 'heuristic', capacity_status: 'unknown', input_characters: 1200, character_limit: 12000, estimated_input_tokens: 400, reserved_output_tokens: 1024, context_tokens: null, fit: 'unknown', checked_at: '2026-09-08T10:01:00Z' },
        document_context: { actions_performed: false, documents: [{ name: 'Sample setup.md', sha256: 'a'.repeat(64), line_count: 240, chars: 9000, coverage: { mode: 'excerpts', selection: 'question_terms', ranges: [{ start: 80, end: 86 }], included_lines: 7, omitted_lines: 233 } }] },
      } : {};
      Object.assign(evidence, caseEvidence || extraEvidence);
      if (!caseEvidence && body.diagnostic_id === PREVIEW_REPORT.id) Object.assign(evidence, { evidence_context: { version: 1, interpretation: 'ai', citations_checked: true, citations: [], invalid_citations: 0, sources: [previewReportSource()], recorded_report: PREVIEW_REPORT_FACTS, historical_notes: { checked: true, changed: 1, unavailable: 1, references: [{ exchange_index: 1, handle: 'N1', note_id: 'sample-note-changed', title: 'Earlier paper-path note', revision: 'a'.repeat(64), status: 'changed' }, { exchange_index: 2, handle: 'N1', note_id: 'sample-note-deleted', title: 'Earlier driver advice', revision: 'b'.repeat(64), status: 'unavailable' }] } } });
      const assistant = { ...evidence, role: 'assistant' as const, content: response, model: 'Sample TLI', provider: 'Preview', host: node.name, ...(screenshot_context ? { screenshot_context } : {}), ...(note_context ? { note_context } : {}) };
      if (!options.stream) { conversation.messages!.push(assistant); return this.response({ ...evidence, reply: response, conversation_id: conversation.id, model_used: 'Sample TLI', brain_used: 'Preview', ...(screenshot_context ? { screenshot_context } : {}), ...(note_context ? { note_context } : {}) }); }
      const selectedConversation = conversation;
      return new Promise((resolve, reject) => {
        const job = { timer: undefined as ReturnType<typeof setTimeout> | undefined, reject }; this.jobs.set(options.id, job);
        this.headers.forEach(listener => listener({ id: options.id, status: 200, headers: { 'content-type': 'text/event-stream' } }));
        const emit = (event: unknown) => this.chunks.forEach(listener => listener({ id: options.id, chunk: `data: ${JSON.stringify(event)}\n\n` }));
        emit({ ...evidence, type: 'meta', session_id: conversation!.id, model: 'Sample TLI', provider: 'Preview', host: node, ...(screenshot_context ? { screenshot_context } : {}), ...(note_context ? { note_context } : {}) });
        const pieces = response.match(/.{1,30}(?:\s|$)|.{1,30}/gs) || [response]; let index = 0;
        const tick = () => {
          if (!this.jobs.has(options.id)) return;
          if (index === 1 && /simulate interruption/i.test(String(body.message))) { this.jobs.delete(options.id); resolve({ status: 200, headers: {}, body: '' }); return; }
          if (index < pieces.length) { emit({ type: 'delta', text: pieces[index++] }); job.timer = setTimeout(tick, /simulate slow/i.test(String(body.message)) ? 500 : 45); }
          else { selectedConversation.messages!.push(assistant); emit({ type: 'done' }); this.jobs.delete(options.id); resolve({ status: 200, headers: {}, body: '' }); }
        };
        job.timer = setTimeout(tick, 80);
      });
    }
    return this.response({ detail: 'This operation is not part of the sample preview.' }, 404);
  }
}
export default new PreviewTransport();
