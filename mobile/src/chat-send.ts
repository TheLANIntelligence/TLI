import type { Client } from './client';
import { chatRoute } from './protocol';
import type { AnswerEvidence, Bootstrap, ChatContext, Message, NoteContext, ScreenshotReceipt } from './types';
import { validateNoteContext } from './notebook';
import { answerEvidence } from './answer-evidence';
import { casePointer, checkCaseCapability, confirmCaseReceipt, validateCaseContext } from './case-context';

type SendTicket = { interrupted?: Error; onInterrupt?: () => void };

/** Cancellation stays busy until transport settles; a new pairing owns a new ticket. */
export class ChatSendGuard {
  private active?: SendTicket;
  get busy() { return !!this.active; }
  begin(): SendTicket {
    if (this.active) throw new Error('A response is already in progress. Wait or stop it before sending again.');
    const ticket = {};
    this.active = ticket;
    return ticket;
  }
  owns(ticket: SendTicket) { return this.active === ticket; }
  accepts(ticket: SendTicket) { return this.owns(ticket) && !ticket.interrupted; }
  interrupt(message: string) { if (this.active && !this.active.interrupted) { this.active.interrupted = new Error(message); this.active.onInterrupt?.(); } }
  invalidate() {
    // Invalidation must not publish another private update to a replaced home.
    if (this.active) this.active.interrupted ||= new Error('The TLI connection changed. Review the conversation before sending again.');
    this.active = undefined;
  }
  assertCurrent(ticket: SendTicket, current: boolean) {
    if (ticket.interrupted) throw ticket.interrupted;
    if (!this.owns(ticket) || !current) throw new Error('The TLI connection or conversation changed. Review it before sending again.');
  }
  finish(ticket: SendTicket) { if (this.owns(ticket)) this.active = undefined; }
}

type SendOptions = {
  client: Pick<Client, 'stream' | 'json'>;
  guard: ChatSendGuard;
  bootstrap: Bootstrap | null;
  conversationId?: string;
  deviceId: string;
  message: string;
  context: ChatContext;
  isCurrent: () => boolean;
  onStart: (assistant: Message) => void;
  onUpdate: (assistant: Message) => void;
  onConversation: (id: string) => void;
  onError: (error: unknown) => void;
  onSettled: () => void;
  now?: () => number;
};

export function hasReviewedImageProvider(context: ChatContext): boolean {
  return /^[a-f0-9]{64}$/.test(context.screenshot?.provider_key || context.image_provider_key || '');
}

/** Resolve only after a complete response; callers retain their draft on rejection. */
export async function sendChat(options: SendOptions): Promise<void> {
  const { client, guard, bootstrap, context, message } = options;
  if (!message.trim()) throw new Error('Write a question before sending.');
  validateCaseContext(context, message);
  validateNoteContext(context);
  if (context.use_saved_memory === false && context.note_refs?.length) throw new Error('Turn on Use saved notes or remove the attached notes before sending.');
  if (context.screenshot && !context.photo) throw new Error('Add the screenshot before sending this guidance request.');
  if (context.photo && !hasReviewedImageProvider(context)) throw new Error('Review the image provider before sending this photo.');
  const ticket = guard.begin();
  const current = () => guard.owns(ticket) && options.isCurrent();
  const accepting = () => guard.accepts(ticket) && options.isCurrent();
  const assistant: Message = { role: 'assistant', content: '', state: 'streaming' };
  const now = options.now || (() => performance.now()), started = now();
  let firstText: number | undefined;
  const measure = () => {
    const elapsed = Math.max(0, now() - started);
    if (assistant.content && firstText === undefined) firstText = elapsed;
    assistant.timing = { elapsed_ms: elapsed, ...(firstText !== undefined ? { first_text_ms: firstText } : {}), outcome: assistant.state === 'streaming' ? firstText === undefined ? 'waiting' : 'streaming' : assistant.state === 'complete' ? 'complete' : 'interrupted' };
  };
  const update = () => { if (current()) options.onUpdate({ ...assistant }); };
  ticket.onInterrupt = () => { assistant.state = 'interrupted'; measure(); update(); };
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    guard.assertCurrent(ticket, options.isCurrent());
    measure(); options.onStart({ ...assistant });
    timer = setInterval(() => { if (accepting()) { measure(); update(); } }, 1000);
    if (context.case_ref) {
      await checkCaseCapability(client, accepting, !!context.case_ref?.report_refs?.length);
      guard.assertCurrent(ticket, options.isCurrent());
    }
    if (context.use_saved_memory === false || context.use_conversation_history === false) {
      const capability = await client.json<{ ok?: boolean; protocol?: string; use_conversation_history?: boolean }>('/api/intelligence/memory/capabilities');
      guard.assertCurrent(ticket, options.isCurrent());
      if (capability?.ok !== true || capability.protocol !== 'tli-memory-continuity-v1') throw new Error('Update the TLI host before asking without saved notes. This question has not been sent.');
      if (context.use_conversation_history === false && capability.use_conversation_history !== true) throw new Error('Update the TLI host before asking without earlier conversation. This question has not been sent.');
    }
    // A selected-note question cannot become a device intent, even when its
    // wording resembles a command. Keep its configured local-provider route.
    const route = chatRoute(bootstrap, !!context.photo, context.note_refs?.length || context.case_ref ? '' : message);
    const payload = {
      message, conversation_id: options.conversationId, device_id: options.deviceId,
      target_id: context.target_id, diagnostic_id: context.diagnostic_id,
      use_saved_memory: context.use_saved_memory !== false,
      use_conversation_history: context.use_conversation_history !== false,
      ...(context.photo ? { image_b64: context.photo.base64, image_mime: context.photo.mime } : {}),
      ...(context.screenshot ? { screenshot: context.screenshot } : {}),
      ...(context.image_provider_key ? { image_provider_key: context.image_provider_key } : {}),
      ...(context.note_refs?.length ? { note_refs: context.note_refs.map(({ id, revision }) => ({ id, revision })) } : {}),
      ...(context.case_ref ? { case_ref: casePointer(context.case_ref) } : {}),
      ...((context.note_refs?.length || context.case_ref) && !route.streaming ? { brain: 'lmstudio' } : {}),
      retention_days: 0,
    };
    if (route.streaming) {
      await client.stream(route.path, payload, event => {
        if (!accepting()) return;
        if (event.session_id || event.conversation_id) options.onConversation((event.conversation_id || event.session_id)!);
        if (event.type === 'delta') assistant.content += event.text || '';
        if (event.provider) assistant.provider = event.provider;
        if (event.model) assistant.model = event.model;
        if (event.mesh_node?.name) assistant.host = event.mesh_node.name;
        else if (event.host) assistant.host = typeof event.host === 'string' ? event.host : event.host.name;
        if (event.screenshot_context) assistant.screenshot_context = event.screenshot_context;
        if (event.note_context) assistant.note_context = event.note_context;
        Object.assign(assistant, answerEvidence(event)); measure(); update();
      });
    } else {
      const result = await client.json<AnswerEvidence & { reply: string; conversation_id: string; model_used?: string; brain_used?: string; screenshot_context?: ScreenshotReceipt; note_context?: NoteContext }>(route.path, 'POST', payload);
      guard.assertCurrent(ticket, options.isCurrent());
      if (!result || typeof result.reply !== 'string' || !result.reply.trim()) throw new Error('TLI returned no answer. Review the conversation before sending again.');
      if (result.conversation_id) options.onConversation(result.conversation_id);
      assistant.content = result.reply; assistant.model = result.model_used; assistant.provider = result.brain_used;
      if (result.screenshot_context) assistant.screenshot_context = result.screenshot_context;
      if (result.note_context) assistant.note_context = result.note_context;
      Object.assign(assistant, answerEvidence(result));
    }
    guard.assertCurrent(ticket, options.isCurrent());
    if (typeof assistant.content !== 'string' || !assistant.content.trim()) throw new Error('TLI returned no answer. Review the conversation before sending again.');
    if (context.case_ref) confirmCaseReceipt(context.case_ref, assistant.case_context, assistant.evidence_context);
    assistant.state = 'complete'; measure(); update();
  } catch (error) {
    const failure = ticket.interrupted || error;
    assistant.state = 'interrupted'; if (!ticket.interrupted) measure(); update();
    if (current()) options.onError(failure);
    throw failure;
  } finally {
    if (timer) clearInterval(timer);
    const notify = current();
    guard.finish(ticket);
    if (notify) options.onSettled();
  }
}
