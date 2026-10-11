import { useEffect, useRef, useState } from 'react';
import { Image, Keyboard, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, Switch, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useCompanion, useResource, errorText } from '../../src/state';
import { AIReadinessNotice, Button, Card, Hero, ConnectionNotice, Copy, IconButton, Label, Notice, Row, Screen, Section, styles, useTheme } from '../../src/ui';
import { choosePhoto, disposePhoto } from '../../src/photos';
import { formatTime } from '../../src/protocol';
import { ImageDestination, PhotoReview, useImageReview } from '../../src/photo-review';
import { imageTasks, reviewedImageContext, screenshotReceiptText } from '../../src/screenshot-help';
import { noteReceiptText, validateNoteContext } from '../../src/notebook';
import { answerReport, evidenceLines, evidenceSources, timingText, validSourceRef } from '../../src/answer-evidence';
import { ReportFacts } from '../../src/report-facts-view';
import { confirmDiscard } from '../../src/private-draft';
import { SaveNoteReview } from '../../src/save-note-review';
import { CaseContextReview } from '../../src/case-context-review';
import { validateCaseContext } from '../../src/case-context';
import type { Conversation, Device, ImageTask, Photo, Report, Message, SourceRef } from '../../src/types';

export default function AskScreen() {
  const t = useTheme(), router = useRouter(), state = useCompanion(), headerHeight = useHeaderHeight();
  const params = useLocalSearchParams<{ target?: string; report?: string; conversation?: string; prompt?: string; photo?: string }>();
  const inventory = useResource<{ devices: Device[] }>('/api/intelligence/devices');
  const reports = useResource<{ reports: Report[] }>('/api/intelligence/diagnostics');
  const conversations = useResource<{ conversations: Conversation[] }>('/api/ai/conversations');
  const [useHistory, setUseHistory] = useState(true);
  const [useSaved, setUseSaved] = useState(true), [saveSource, setSaveSource] = useState<SourceRef>();
  const [reviewCase, setReviewCase] = useState<string>();
  const [draft, setDraft] = useState(''), [target, setTarget] = useState<string>(), [reportId, setReportId] = useState<string>();
  const [photo, setPhoto] = useState<Photo>(), [photoBusy, setPhotoBusy] = useState(false), [error, setError] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false), [imageTask, setImageTask] = useState<ImageTask>('photo');
  const [computer, setComputer] = useState('unknown'), [otherComputer, setOtherComputer] = useState('');
  const imageReview = useImageReview(photo);
  const [panel, setPanel] = useState<'context' | 'status' | null>(null);
  const [compactChat, setCompactChat] = useState(false);
  const [chooser, setChooser] = useState<'devices' | 'conversations' | null>(null);
  const photoRef = useRef<Photo | undefined>(undefined), mounted = useRef(true); const list = useRef<ScrollView>(null);
  const submitting = useRef(false), draftRef = useRef(draft), clientRef = useRef(state.client);
  const previousClient = useRef(state.client);
  const hadCase = useRef(false); if (state.selectedCase) hadCase.current = true;
  const navigationEpoch = useRef(0), foregroundRef = useRef(state.foreground);
  const pendingSheetAction = useRef<{ run: () => void; client: typeof state.client } | null>(null);
  foregroundRef.current = state.foreground;
  clientRef.current = state.client;
  const updateDraft = (text: string) => { draftRef.current = text; setDraft(text); };
  const targetDevice = inventory.data?.devices.find(d => d.id === target);
  const report = reports.data?.reports.find(r => r.id === reportId);
  const contextCount = state.selectedNotes.length + Number(!!state.selectedCase) + Number(!!photo) + Number(!!target) + Number(!!reportId);
  const contextConflict = !!state.selectedCase && !!(photo || target || reportId || state.selectedNotes.length) || !!state.selectedNotes.length && !!(photo || target || reportId);
  const contextSummary = [state.selectedCase?.title, state.selectedNotes.length ? `${state.selectedNotes.length} selected notes` : '', photo ? 'Photo' : '', target ? targetDevice?.name || 'Selected device' : '', reportId ? 'Saved report' : ''].filter(Boolean).join(' · ');
  const sharingSummary = [!useSaved ? 'Saved-note recall off' : '', !useHistory ? 'Earlier conversation off' : ''].filter(Boolean).join(' · ');
  const openPanel = (next: 'context' | 'status') => { Keyboard.dismiss(); setPanel(next); };
  const leaveContext = (action: () => void) => {
    // iOS must finish dismissing its native sheet before presenting a picker
    // or another review sheet. A changed session discards that pending intent.
    if (Platform.OS === 'ios') pendingSheetAction.current = { run: action, client: state.client };
    setPanel(null);
    if (Platform.OS !== 'ios') action();
  };
  const contextDismissed = () => { const pending = pendingSheetAction.current; pendingSheetAction.current = null; if (pending && mounted.current && foregroundRef.current && clientRef.current === pending.client) pending.run(); };
  const canSend = !contextConflict && state.connection === 'connected' && state.foreground && !state.sending && !state.loadingConversation && !photoBusy && !!draft.trim() && (!photo || !imageReview.busy && !!imageReview.data?.provider);
  const paramsKey = JSON.stringify(params);
  useEffect(() => {
    const hasDraft = !!draftRef.current.trim() || !!photoRef.current;
    if (!hasDraft) {
      if (params.target) { setTarget(params.target); setReportId(params.report); }
      else if (params.report) setReportId(params.report);
      if (params.prompt) updateDraft(params.prompt);
    } else if (params.target || params.report || params.prompt) setError('Your current draft and context were kept. Finish them before opening another suggested question.');
    if (params.conversation) void changeConversation(params.conversation);
    if (params.photo) setPanel('context');
    if (params.photo && !state.bootstrap?.capabilities.vision) setError('Photo help needs an available vision model. Configure a vision model on your TLI desktop, then refresh your connection.');
    // Remove consumed navigation parameters so tab revisits never reload or resend.
    if (Object.keys(params).length) router.setParams({ target: undefined, report: undefined, conversation: undefined, prompt: undefined, photo: undefined });
    // The key represents new navigation context, not unrelated resource refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pendingSheetAction.current = null; if (photoRef.current) void disposePhoto(photoRef.current.uri); }; }, []);
  const replacePhoto = (next?: Photo) => { if (photoRef.current) void disposePhoto(photoRef.current.uri); photoRef.current = next; setPhoto(next); setReviewOpen(false); setImageTask('photo'); setComputer('unknown'); setOtherComputer(''); };
  useEffect(() => {
    // A revoked or changed pairing must not carry a private draft into another home.
    if (previousClient.current !== state.client) { replacePhoto(); updateDraft(''); setTarget(undefined); setReportId(undefined); setError(''); setUseSaved(true); setUseHistory(true); setSaveSource(undefined); setPanel(null); setChooser(null); setReviewCase(undefined); pendingSheetAction.current = null; navigationEpoch.current++; }
    previousClient.current = state.client;
  }, [state.client]);
  useEffect(() => { if (!state.foreground && hadCase.current) { replacePhoto(); updateDraft(''); setReviewCase(undefined); setTarget(undefined); setReportId(undefined); setError(''); hadCase.current = false; } }, [state.foreground]);
  useEffect(() => { if (!state.foreground) { setPanel(null); setChooser(null); setReviewOpen(false); setSaveSource(undefined); setReviewCase(undefined); pendingSheetAction.current = null; navigationEpoch.current++; } }, [state.foreground]);
  const changeConversation = async (id?: string) => {
    if (draftRef.current.trim() || photoRef.current || state.selectedCase) { setError('Your draft is still here. Send it or explicitly clear the draft and remove selected case context before replacing this conversation.'); return; }
    const token = ++navigationEpoch.current, client = state.client, text = draftRef.current, selected = photoRef.current;
    try {
      await state.openConversation(id);
      if (!mounted.current || clientRef.current !== client || token !== navigationEpoch.current) return;
      setChooser(null); setTarget(undefined); setReportId(undefined); setUseHistory(true);
      if (draftRef.current === text) updateDraft('');
      if (photoRef.current === selected) replacePhoto();
    } catch (error) { if (mounted.current && clientRef.current === client && token === navigationEpoch.current) setError(errorText(error)); }
  };
  const pick = async (source: 'camera' | 'library') => {
    if (photoBusy || state.sending || state.loadingConversation) return; setPhotoBusy(true); setError('');
    const client = state.client;
    try { const next = await choosePhoto(source); if (next) { if (mounted.current && clientRef.current === client) { replacePhoto(next); setReviewOpen(true); } else await disposePhoto(next.uri); } }
    catch (error) { if (mounted.current && clientRef.current === client) setError(errorText(error)); }
    finally { if (mounted.current) setPhotoBusy(false); }
  };
  const submit = async () => {
    if (!canSend || submitting.current) return;
    submitting.current = true;
    const text = draft, selected = photo, client = state.client;
    setError('');
    try {
      const reviewedContext = { target_id: target, diagnostic_id: reportId, photo: selected, note_refs: state.selectedNotes.map(({ id, revision }) => ({ id, revision })), case_ref: state.selectedCase?.ref, use_saved_memory: useSaved, use_conversation_history: useHistory };
      validateCaseContext(reviewedContext, text);
      validateNoteContext(reviewedContext);
      const context = reviewedImageContext(reviewedContext, imageReview.data, imageTask, computer, otherComputer);
      // Keep the composer intact until a complete response. Late completions
      // cannot remove an attachment or draft belonging to a newer question.
      await state.send(text, context);
      if (mounted.current && clientRef.current === client) {
        if (draftRef.current === text) updateDraft('');
        if (photoRef.current === selected) replacePhoto();
        setUseHistory(true);
        void conversations.reload();
      }
    } catch (error) { if (mounted.current && clientRef.current === client) setError(errorText(error)); }
    finally { submitting.current = false; }
  };
  const selectTarget = (device?: Device) => { setTarget(device?.id); setReportId(device ? reports.data?.reports.find(r => r.target?.id === device.id)?.id : undefined); setChooser(null); };
  return <KeyboardAvoidingView testID="chat-screen" style={{ flex: 1, minHeight: 0, backgroundColor: t.background }} behavior={Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight : 0}>
    <View style={{ flex: 1, minHeight: 0 }} onLayout={event => setCompactChat(event.nativeEvent.layout.height < 330)}>
    <View testID="chat-status" style={{ paddingHorizontal: 16, paddingVertical: 4, borderBottomWidth: 1, borderColor: t.border }}>
      <Row style={{ gap: 8 }}><View style={{ flex: 1, minWidth: 0 }}><Copy size={13} weight="600" numberOfLines={1}>{state.bootstrap?.node.name || state.pairing?.node_name || 'Your TLI'}</Copy><Copy size={12} muted numberOfLines={2}>{!state.foreground ? 'Paused · earlier status' : state.connection === 'checking' ? 'Checking connection…' : state.connection !== 'connected' ? 'Connection unavailable · draft kept' : state.bootstrap?.ai?.status === 'available' ? 'Connected · AI available at last check' : state.bootstrap?.ai?.status === 'unavailable' ? 'Connected · AI unavailable' : 'Connected · AI readiness unknown'}</Copy></View><ChatAction title="Details" accessibilityLabel="Connection details" onPress={() => openPanel('status')} /></Row>
    </View>
    {!compactChat && <Row style={{ paddingHorizontal: 12, gap: 6, borderBottomWidth: 1, borderColor: t.border }}><Copy size={12} muted style={{ flex: 1 }}>{state.conversationId ? 'Shared chat' : 'New chat'}</Copy><ChatAction title="New chat" disabled={state.sending || state.loadingConversation} onPress={() => void changeConversation()} /><ChatAction title="History" accessibilityLabel="History" disabled={state.sending} onPress={() => { Keyboard.dismiss(); setChooser('conversations'); void conversations.reload(); }} /></Row>}
    <ScrollView testID="chat-messages" ref={list} style={{ flex: 1, minHeight: 0 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={{ padding: 16, gap: 14, flexGrow: 1 }} onContentSizeChange={() => { if (state.sending) list.current?.scrollToEnd({ animated: false }); }}>
      {!state.messages.length && <Hero eyebrow="Your private AI" title="What's on your mind?" detail="Think it through. Make something. Or simply ask." icon="sparkles-outline">
        <Row style={{ flexWrap: 'wrap', gap: 8 }}>{([
          ['Explain something', 'Help me understand '], ['Help me write', 'Help me write '], ['Make a plan', 'Help me plan '],
        ] as const).map(([title, prompt]) => <Pressable key={title} accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: !!draft.trim() }} disabled={!!draft.trim()} onPress={() => { if (!draftRef.current.trim()) updateDraft(prompt); }} style={({ pressed }) => ({ paddingHorizontal: 12, paddingVertical: 11, minHeight: 44, borderWidth: 1, borderColor: t.heroMuted, borderRadius: 13, backgroundColor: t.hero, opacity: draft.trim() ? .55 : pressed ? .8 : 1 })}><Copy size={13} weight="600" tone="hero">{title}</Copy></Pressable>)}</Row>
      </Hero>}
      {state.messages.map((message, index) => <View key={index} style={{ padding: 14, borderRadius: 18, borderBottomRightRadius: message.role === 'user' ? 6 : 22, borderTopLeftRadius: message.role === 'assistant' ? 6 : 22, backgroundColor: message.role === 'user' ? t.soft : t.card, borderColor: t.border, borderWidth: 1, marginLeft: message.role === 'user' ? 18 : 0, marginRight: message.role === 'assistant' ? 8 : 0, gap: 9 }}>
        <Label>{message.role === 'user' ? 'You' : 'TLI'}</Label>
        {message.photo && <Copy size={12} muted>Photo attached to this question · no image retention</Copy>}
        {message.role === 'assistant' && answerReport(message).supplied && <ReportFacts value={answerReport(message).facts} compact />}
        <Copy selectable>{message.content || (message.state === 'streaming' ? 'Waiting for TLI to respond…' : 'No response text was received.')}</Copy>
        {message.state === 'interrupted' && <Copy size={13} style={{ color: t.amber }}>Response interrupted · may be incomplete</Copy>}
        {message.role === 'assistant' && <AnswerDetails message={message} />}
        {message.role === 'assistant' && validSourceRef(message.source_ref) && message.state !== 'streaming' && message.state !== 'interrupted' && <MessageActions disabled={state.sending} saveDisabled={state.connection !== 'connected'} save={() => setSaveSource(message.source_ref)} link={() => router.push({ pathname: '/cases', params: { kind: 'chat', evidence: message.source_ref!.conversation_id, message_index: String(message.source_ref!.message_index) } })} />}
        {message.role === 'assistant' && (message.model || message.host || message.provider) && <Copy muted size={12}>{[message.host, message.provider, message.model].filter(Boolean).join(' · ')}</Copy>}
        {message.role === 'assistant' && screenshotReceiptText(message.screenshot_context) && <Copy muted size={12}>{screenshotReceiptText(message.screenshot_context)}</Copy>}
        {message.role === 'assistant' && noteReceiptText(message.note_context) && <View style={{ gap: 8 }}><Copy muted size={12}>{noteReceiptText(message.note_context)}</Copy>{message.note_context!.notes.map(note => <Button secondary key={note.id} title={`Open note: ${note.title || 'Untitled note'}`} onPress={() => router.push({ pathname: '/notebook', params: { note: note.id, revision: note.revision } })} disabled={state.sending} />)}</View>}
      </View>)}
      {!!(error || state.chatError) && <Notice error>{error || state.chatError}</Notice>}
      {state.loadingConversation && <Notice>Loading your shared conversation…</Notice>}
      {error.toLowerCase().includes('access') && <Button secondary title="Open phone settings" onPress={() => void Linking.openSettings()} />}
    </ScrollView>
    <View testID="chat-composer" style={{ marginHorizontal: 10, marginBottom: 8, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 12, gap: 6, flexShrink: 0, backgroundColor: t.card, borderWidth: 1, borderColor: t.borderStrong, borderRadius: 24, boxShadow: `0px 5px 18px ${t.dark ? "#00000024" : "#173f3114"}` }}>
      <Row style={{ gap: 8 }}><ChatAction title={contextCount ? `Context · ${contextCount}` : 'Add context'} accessibilityLabel={contextCount ? `Context · ${contextCount}` : 'Add context'} onPress={() => openPanel('context')} disabled={state.sending || state.loadingConversation} /><View style={{ flex: 1, minWidth: 0 }}><Copy muted size={12} numberOfLines={1}>{contextSummary || 'Photos, notes & devices'}</Copy>{!!sharingSummary && <Copy muted size={11} numberOfLines={2}>{sharingSummary}</Copy>}</View></Row>
      {contextConflict && <Copy size={12} style={{ color: t.danger }}>Selected context conflicts. Review it before sending.</Copy>}
      <Row style={{ gap: 8, alignItems: 'flex-end' }}><TextInput testID="chat-message-input" accessibilityLabel="Message to TLI" placeholder="Message to TLI" placeholderTextColor={t.muted} multiline value={draft} onChangeText={updateDraft} maxLength={16000} editable={!state.sending && !state.loadingConversation} style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.background, flex: 1, minWidth: 0, maxHeight: compactChat ? 72 : 120, minHeight: 52, textAlignVertical: 'top', paddingHorizontal: 12 }]} /><Button title={state.sending ? 'Stop' : photo ? 'Send photo' : 'Send'} accessibilityLabel={state.sending ? 'Stop waiting' : photo ? 'Send message and photo' : 'Send message'} disabled={!state.sending && !canSend} onPress={() => state.sending ? state.stop() : void submit()} /></Row>
    </View>
    </View>
    <Modal visible={!!panel && state.foreground} animationType="slide" presentationStyle="pageSheet" onDismiss={contextDismissed} onRequestClose={() => setPanel(null)}><SafeAreaView testID={panel === 'context' ? 'chat-context-sheet' : 'chat-status-sheet'} style={{ flex: 1, backgroundColor: t.background }}><View style={{ paddingHorizontal: 18, borderBottomWidth: 1, borderColor: t.border }}><Row style={{ justifyContent: 'space-between' }}><Copy size={20} weight="600">{panel === 'context' ? 'Message context' : 'Connection details'}</Copy><IconButton icon="close-outline" label={panel === 'context' ? 'Close message context' : 'Close connection details'} onPress={() => setPanel(null)} /></Row></View><Screen contentContainerStyle={{ padding: 18, gap: 16 }}>
      {panel === 'status' ? <><Copy weight="600">{state.bootstrap?.node.name || state.pairing?.node_name || 'Your TLI'}</Copy><ConnectionNotice /><Copy selectable muted size={13}>{state.pairing?.origin}</Copy><Copy muted size={12}>Last connected {formatTime(state.checkedAt)}</Copy><AIReadinessNotice /><Copy muted size={13}>Replies use your TLI host and its configured provider. A connected host does not guarantee an available AI model.</Copy></> : <>
      <Copy muted size={14}>Optional context for your next message. Nothing is sent until you press Send.</Copy>
      {state.selectedCase && <Card><Label>Case selected for this question</Label><Copy weight="600">{state.selectedCase.title}</Copy><Copy muted size={12}>Saved {formatTime(state.selectedCase.updated_at)} · {state.selectedCase.ref.step_ids.length} whole steps · {state.selectedCase.ref.evidence_refs.length} link descriptions · resolution {state.selectedCase.ref.include_resolution ? 'included' : 'excluded'}. Linked bodies, earlier conversation and automatic saved-note recall are excluded.</Copy><Button secondary title="Review case selection" disabled={state.sending || state.loadingConversation} onPress={() => leaveContext(() => setReviewCase(state.selectedCase!.ref.id))} /><Button secondary title="Remove selected case" disabled={state.sending || state.loadingConversation} onPress={() => { try { state.selectCase(); } catch (e) { setError(errorText(e)); } }} />{(photo || target || reportId || !!state.selectedNotes.length) && <Notice error>Cases need their own question. Remove the other attached context or remove this case; nothing is removed automatically.</Notice>}</Card>}
      {!!state.selectedNotes.length && <Card><Label>Notes attached to this question</Label><Copy muted size={12}>Reviewed versions · provided to AI only when you send · no device actions.</Copy>{state.selectedNotes.map(note => <Row key={note.id}><View style={{ flex: 1 }}><Copy size={14}>{note.title}</Copy><Copy muted size={12}>{note.updated_at ? formatTime(note.updated_at) : 'Updated time unavailable'}</Copy></View><IconButton icon="close-outline" label={`Remove attached note ${note.title}`} disabled={state.sending || state.loadingConversation} onPress={() => { try { state.selectNotes(state.selectedNotes.filter(item => item.id !== note.id)); } catch (error) { setError(errorText(error)); } }} /></Row>)}
        {(photo || target || reportId) && <><Notice error>Notes need their own question. Remove the photo, device and report context, or remove the notes before sending.</Notice><Button secondary title="Remove photo, device and report context" disabled={state.sending} onPress={() => { replacePhoto(); setTarget(undefined); setReportId(undefined); }} /></>}
      </Card>}
      {photo && <>
        <Row><Image source={{ uri: photo.uri }} style={{ width: 72, height: 72, borderRadius: 12 }} accessibilityLabel="Photo preview to send to TLI" /><View style={{ flex: 1 }}><Copy size={14} weight="600">{imageTasks.find(item => item.id === imageTask)?.label}</Copy><Copy size={12} muted>{imageTask === 'photo' ? 'Sent only with your next message.' : computer === 'other' ? otherComputer || 'Another computer' : imageReview.data?.computers.find(item => item.id === computer)?.name || 'Unknown computer'}</Copy></View><IconButton icon="close-outline" label="Remove photo" onPress={() => replacePhoto()} disabled={state.sending} /></Row>
        <ImageDestination review={imageReview} />
        <Button secondary title="Review image and help" disabled={state.sending} onPress={() => leaveContext(() => setReviewOpen(true))} />
      </>}
      {target && (!photo || imageTask === 'photo') && <Row><View style={{ flex: 1 }}><Copy size={13} weight="600">About {targetDevice?.name || 'selected device'}</Copy>{reportId && <Copy size={12} muted>Includes saved diagnostic evidence{report ? ` · ${formatTime(report.created_at)}` : ''}</Copy>}</View><IconButton icon="close-outline" label="Remove device and report context" disabled={state.sending} onPress={() => { setTarget(undefined); setReportId(undefined); }} /></Row>}
      {reportId && (!target || photo && imageTask !== 'photo') && <Row><View style={{ flex: 1 }}><Copy size={13}>Diagnostic report attached{report ? ` · ${formatTime(report.created_at)}` : ''}</Copy></View><IconButton icon="close-outline" label="Remove diagnostic report" onPress={() => setReportId(undefined)} disabled={state.sending} /></Row>}
      <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}><Row><IconButton icon="camera-outline" label="Take a photo" disabled={!state.bootstrap?.capabilities.vision || state.sending || photoBusy} onPress={() => leaveContext(() => void pick('camera'))} /><IconButton icon="images-outline" label="Choose photo from library" disabled={!state.bootstrap?.capabilities.vision || state.sending || photoBusy} onPress={() => leaveContext(() => void pick('library'))} />{(!photo || imageTask === 'photo') && <Button secondary title="Device" icon="add-outline" disabled={state.sending || state.loadingConversation} onPress={() => leaveContext(() => setChooser('devices'))} />}</Row>{photoBusy && <Copy size={12} muted>Preparing photo…</Copy>}</Row>
      {!state.bootstrap?.capabilities.vision && <Copy size={12} muted>Photo help is unavailable. Start a vision model in TLI desktop Settings, then refresh.</Copy>}
      <Row><Switch accessibilityLabel="Use saved notes" value={useSaved} disabled={state.sending || state.loadingConversation} onValueChange={setUseSaved} /><Copy style={{ flex: 1 }}>Use saved notes</Copy></Row><Copy muted size={12}>Recall relevant saved notes for this question. This does not change earlier-conversation sharing.</Copy>
      <Row><Switch accessibilityLabel="Use earlier conversation" value={useHistory} disabled={state.sending || state.loadingConversation} onValueChange={setUseHistory} /><Copy style={{ flex: 1 }}>Use earlier conversation</Copy></Row><Copy muted size={12}>For ordinary text questions, include previous exchanges and follow-up context. Turning it off leaves saved conversations unchanged. Returns to on after a completed answer. Selected references and images keep their separate sharing rules.</Copy>
      <Button secondary title="Notes & fixes" icon="book-outline" disabled={state.sending || state.loadingConversation} onPress={() => leaveContext(() => router.push('/notebook'))} />
      <Button secondary title="Troubleshooting cases" icon="list-outline" disabled={state.sending || state.loadingConversation} onPress={() => leaveContext(() => router.push('/cases'))} />
      {compactChat && <Row style={{ flexWrap: 'wrap' }}><ChatAction title="New chat" disabled={state.sending || state.loadingConversation} onPress={() => leaveContext(() => void changeConversation())} /><ChatAction title="History" disabled={state.sending} onPress={() => leaveContext(() => { setChooser('conversations'); void conversations.reload(); })} /></Row>}
      {!!draft.trim() && !state.sending && <Button secondary title="Discard current Chat draft" disabled={state.loadingConversation} onPress={() => confirmDiscard(() => { updateDraft(''); replacePhoto(); })} />}
      </>}
    </Screen></SafeAreaView></Modal>
    <Modal visible={!!chooser} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setChooser(null)}><SafeAreaView style={{ flex: 1, backgroundColor: t.background }}><Screen><Row style={{ justifyContent: 'space-between' }}><Section title={chooser === 'devices' ? 'Choose a device' : 'Your conversations'} /><IconButton icon="close-outline" label="Close chooser" onPress={() => setChooser(null)} /></Row>
      {chooser === 'devices' ? <><Copy muted>The latest saved diagnostic for this device will be attached when available.</Copy><Button secondary title="No device context" onPress={() => selectTarget()} />{inventory.data?.devices.map(device => <Card key={device.id}><Copy weight="600">{device.name}</Copy><Copy muted size={13}>{device.room || device.kind}</Copy><Button secondary title="Choose this device" onPress={() => selectTarget(device)} /></Card>)}{inventory.error && <Notice error>{inventory.error}</Notice>}</> : <><Copy muted>These conversations are shared with your TLI desktop.</Copy>{conversations.data?.conversations.map(conversation => <Card key={conversation.id}><Copy weight="600">{conversation.title}</Copy><Copy muted size={12}>{formatTime(conversation.last_updated)}</Copy><Button secondary title="Continue conversation" disabled={state.loadingConversation} onPress={() => void changeConversation(conversation.id)} /></Card>)}{conversations.error && <Notice error>{conversations.error}</Notice>}{!conversations.busy && !conversations.data?.conversations.length && <Copy muted>No saved conversations yet.</Copy>}</>}
    </Screen></SafeAreaView></Modal>
    <SaveNoteReview source={saveSource} close={() => setSaveSource(undefined)} />
    <CaseContextReview caseId={reviewCase} close={() => setReviewCase(undefined)} />
    {photo && <PhotoReview photo={photo} open={reviewOpen} onClose={() => setReviewOpen(false)} disabled={state.sending} review={imageReview} task={imageTask} setTask={setImageTask} computer={computer} setComputer={setComputer} other={otherComputer} setOther={setOtherComputer} reportId={reportId} clearReport={() => setReportId(undefined)} />}
  </KeyboardAvoidingView>;
}

function AnswerDetails({ message }: { message: Message }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const lines = evidenceLines(message), timing = timingText(message.timing);
  return <View style={{ gap: 8 }}>{timing && <Copy muted size={12}>{timing}</Copy>}{message.state === 'interrupted' && <Copy muted size={12}>Partial text is kept. Stopping the phone’s wait does not confirm server actions were cancelled. Review history and current device status before sending again.</Copy>}{lines.length > 0 && <><Button secondary title={open ? 'Hide answer evidence' : 'Answer evidence'} onPress={() => setOpen(!open)} />{open && lines.map((line, index) => <Copy selectable muted size={13} key={index}>{line}</Copy>)}{open && message.state !== 'streaming' && message.state !== 'interrupted' && evidenceSources(message).filter(source => source.kind === 'note' || source.kind === 'report' || source.kind === 'case').map(source => <Button secondary key={source.handle} title={source.kind === 'note' ? `Open current note: ${source.label}` : source.kind === 'case' ? `Open current case: ${source.label}` : `Open saved report: ${source.label}`} onPress={() => source.kind === 'note' ? router.push({ pathname: '/notebook', params: { note: source.id, revision: source.revision } }) : source.kind === 'case' ? router.push({ pathname: '/cases', params: { id: source.id } }) : router.push({ pathname: '/report/[id]', params: { id: source.id } })} />)}</>}</View>;
}

function ChatAction({ title, accessibilityLabel, onPress, disabled = false }: { title: string; accessibilityLabel?: string; onPress: () => void; disabled?: boolean }) {
  const t = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel || title} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8, opacity: disabled ? 0.45 : pressed ? 0.7 : 1 })}><Copy size={13} weight="600" style={{ color: t.emerald }}>{title}</Copy></Pressable>;
}

function MessageActions({ disabled, saveDisabled, save, link }: { disabled: boolean; saveDisabled: boolean; save: () => void; link: () => void }) {
  const [open, setOpen] = useState(false);
  return <View style={{ gap: 4 }}><ChatAction title={open ? 'Hide message options' : 'Message options'} onPress={() => setOpen(!open)} />{open && <><Button secondary title="Save to Notes & fixes" disabled={disabled || saveDisabled} onPress={save} /><Button secondary title="Link to Troubleshooting" disabled={disabled} onPress={link} /></>}</View>;
}
