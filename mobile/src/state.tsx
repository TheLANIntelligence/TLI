import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import NativeTransport from '../modules/tli-transport/index';
import { Client, ApiError } from './client';
import type { Transport } from './client';
import { ChatSendGuard, hasReviewedImageProvider, sendChat } from './chat-send';
import type { Bootstrap, ChatContext, Conversation, Message, NoteSummary, Pairing, Preferences } from './types';
import { validateNoteContext } from './notebook';
import { casePointer, type SelectedCase } from './case-context';
import { connectionIssue, LatestConnectionCheck, readConnection, type ConnectionIssue } from './connection';
import { clearPairingAndReset, clearSavedPairing, loadSavedPairing, orderedPairingStore, PairingReplacement, PairingReplacementError, PairingTransitions, type PairingPhase } from './pairing-recovery';

const transport = NativeTransport as Transport;
const storeOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
export const pairingStore = orderedPairingStore({
  get: key => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value, storeOptions),
  remove: key => SecureStore.deleteItemAsync(key),
});
const DEFAULTS: Preferences = { favorite_devices: [], favorite_scenes: [], theme: 'system' };
const PREVIEW_PAIRING: Pairing = { version: 1, origin: 'https://192.168.50.10:8000', certificate_der: 'sample-preview-no-certificate', node_id: 'sample-home', node_name: 'Legato Home', device_id: 'sample-browser', owner_id: 'sample-owner', credential: 'sample-preview-no-credential' };
const SessionContext = createContext<ReturnType<typeof useSessionState> | null>(null);
export const errorText = (error: unknown) => error instanceof Error ? error.message : 'TLI could not finish this request.';

function useSessionState() {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [client, setClient] = useState<Client | null>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [preferences, setPreferences] = useState<Preferences>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<'connected' | 'checking' | 'offline' | 'unpaired'>('unpaired');
  const [connectionError, setConnectionError] = useState('');
  const [connectionProblem, setConnectionProblem] = useState<ConnectionIssue | null>(null);
  const [pairingPhase, setPairingPhase] = useState<PairingPhase>('idle');
  const [checkedAt, setCheckedAt] = useState<string>(), [connectionAttemptAt, setConnectionAttemptAt] = useState<string>();
  const [foreground, setForeground] = useState(Platform.OS === 'web' || AppState.currentState === 'active');
  const [revision, setRevision] = useState(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [sending, setSending] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [chatError, setChatError] = useState('');
  // Only reviewed identifiers and receipt metadata live in this phone session.
  // Note bodies stay in the owner's TLI store and are never written to phone storage.
  const [selectedNotes, setSelectedNotes] = useState<NoteSummary[]>([]);
  const selectedNotesRef = useRef<NoteSummary[]>([]);
  const clearSelectedNotes = () => { selectedNotesRef.current = []; setSelectedNotes([]); };
  const [selectedCase, setSelectedCase] = useState<SelectedCase>();
  const selectedCaseRef = useRef<SelectedCase | undefined>(undefined);
  const clearSelectedCase = () => { selectedCaseRef.current = undefined; setSelectedCase(undefined); };
  const clearReferences = () => { clearSelectedNotes(); clearSelectedCase(); };
  const generation = useRef(0), sends = useRef(new ChatSendGuard()), preferenceBusy = useRef(false);
  const conversationEpoch = useRef(0), conversationLoading = useRef(false);
  const activeClient = useRef<Client | null>(null), isForeground = useRef(foreground);
  const activePairing = useRef<Pairing | null>(null), transportReady = useRef(false), restoringTransport = useRef<Promise<void> | null>(null);
  const connectionChecks = useRef(new LatestConnectionCheck()), replacement = useRef(new PairingReplacement()), pairingTransitions = useRef(new PairingTransitions());
  const invalidate = useCallback(() => {
    if (pairingTransitions.current.busy) return;
    void pairingTransitions.current.run(async () => {
    generation.current++; sends.current.invalidate();
    connectionChecks.current.invalidate(); activeClient.current?.pause(); activePairing.current = null; transportReady.current = false;
    clearReferences();
    activeClient.current = null;
    conversationEpoch.current++; conversationLoading.current = false; setLoadingConversation(false);
    setClient(null); setPairing(null); setBootstrap(null); setMessages([]); setConversationId(undefined); setSending(false);
    const issue = connectionIssue(new ApiError('Phone access rejected', 401));
    setPreferences(DEFAULTS); setConnection('unpaired'); setConnectionProblem(issue); setConnectionError(issue.detail);
    // Keep the same transition reserved until both operations settle. A late
    // tombstone or reset must never erase or disconnect a replacement pairing.
    const cleanup = await clearPairingAndReset(Platform.OS === 'web' ? null : pairingStore, transport, restoringTransport.current);
    const details = [issue.detail];
    if (cleanup.storage.status === 'rejected') details.push('The rejected credential could not be removed from protected phone storage.');
    else if (!cleanup.storage.value.legacy_removed) details.push('An unused older credential could not be removed from protected phone storage.');
    if (cleanup.reset.status === 'rejected') details.push('The old secure connection could not be reset. Review a new connection before using TLI.');
    setConnectionError(details.join(' '));
    }).catch(() => {});
  }, []);

  const refreshClient = useCallback(async (api: Client, epoch: number) => {
    const saved = activePairing.current;
    if (!saved || !isForeground.current || pairingTransitions.current.busy) return;
    const ticket = connectionChecks.current.begin(); api.invalidateObservations();
    const current = () => connectionChecks.current.accepts(ticket, generation.current === epoch && activeClient.current === api && isForeground.current && !pairingTransitions.current.busy);
    setConnectionAttemptAt(new Date().toISOString()); setConnection('checking'); setConnectionProblem(null); setConnectionError('');
    try {
      if (!transportReady.current) {
        restoringTransport.current ||= transport.configure({ origin: saved.origin, certificateDer: saved.certificate_der }).finally(() => { restoringTransport.current = null; });
        await restoringTransport.current;
        if (!current()) return;
        transportReady.current = true; api.resume();
      }
      // Neutral probe callbacks cannot invalidate a working pairing from an
      // older refresh. Only the latest foreground ticket may publish its result.
      const checked = await readConnection(new Client(transport, api.credential), saved);
      if (!current()) return;
      setBootstrap(checked.bootstrap); setPreferences(checked.preferences); setCheckedAt(new Date().toISOString()); setConnection('connected'); setConnectionError(''); setConnectionProblem(null); setRevision(r => r + 1);
    } catch (error) {
      if (!current()) return;
      const issue = connectionIssue(error);
      if (issue.kind === 'credential') { invalidate(); return; }
      setConnection('offline'); setConnectionProblem(issue); setConnectionError(issue.detail);
    }
  }, [invalidate]);
  const connect = useCallback(async (saved: Pairing, checked?: Awaited<ReturnType<typeof readConnection>>) => {
    const epoch = ++generation.current;
    setCheckedAt(undefined); setConnectionAttemptAt(undefined);
    connectionChecks.current.invalidate();
    sends.current.invalidate(); setSending(false);
    clearReferences();
    activeClient.current?.pause(); activeClient.current = null;
    conversationEpoch.current++; conversationLoading.current = false; setLoadingConversation(false);
    setMessages([]); setConversationId(undefined);
    const api = new Client(transport, saved.credential, () => { if (generation.current === epoch && !pairingTransitions.current.busy) invalidate(); }, error => {
      if (generation.current !== epoch || pairingTransitions.current.busy || !isForeground.current) return;
      const issue = connectionIssue(error); setConnection('offline'); setConnectionProblem(issue); setConnectionError(issue.detail);
    });
    activeClient.current = api; activePairing.current = saved; setPairing(saved); setClient(api);
    transportReady.current = !!checked;
    if (checked) {
      setBootstrap(checked.bootstrap); setPreferences(checked.preferences); setCheckedAt(new Date().toISOString()); setConnection(isForeground.current ? 'connected' : 'offline'); setConnectionProblem(null); setConnectionError(''); setRevision(r => r + 1); return;
    }
    await refreshClient(api, epoch);
  }, [invalidate, refreshClient]);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        if (Platform.OS === 'web') { if (mounted) await connect(PREVIEW_PAIRING); return; }
        const saved = await loadSavedPairing(pairingStore);
        if (mounted && saved) await connect(saved);
      } catch (error) { if (mounted) { const issue = connectionIssue(error); setConnectionProblem(issue); setConnectionError(issue.detail); } }
      finally { if (mounted) setLoading(false); }
    })();
    return () => { mounted = false; };
  }, [connect]);

  const refresh = useCallback(async () => { if (client) await refreshClient(client, generation.current); }, [client, refreshClient]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      isForeground.current = state === 'active';
      setForeground(state === 'active');
      if (state !== 'active') {
        clearSelectedCase();
        connectionChecks.current.invalidate(); replacement.current.cancel(); activeClient.current?.invalidateObservations();
        const message = 'Response interrupted while the app was in the background. Review the conversation before sending again.';
        sends.current.interrupt(message);
        client?.cancelAll();
        if (sends.current.busy) {
          setChatError(message);
          setMessages(old => old.map((entry, index) => index === old.length - 1 && entry.state === 'streaming' ? { ...entry, state: 'interrupted', ...(entry.timing ? { timing: { ...entry.timing, outcome: 'interrupted' as const } } : {}) } : entry));
        }
      } else if (client && !pairingTransitions.current.busy) void refreshClient(client, generation.current);
    });
    return () => subscription.remove();
  }, [client, refreshClient]);

  const pair = async (raw: string, name: string) => {
    if (Platform.OS === 'web') throw new Error('This browser preview uses a sample home. Pair a real TLI from the native companion app.');
    if (loading || pairingTransitions.current.busy || connection === 'checking' || !isForeground.current || sends.current.busy || preferenceBusy.current || conversationLoading.current || restoringTransport.current) throw new Error('Wait for the current request to finish, then keep the app open while reviewing this connection.');
    return pairingTransitions.current.run(async () => {
    const previous = activePairing.current, previousClient = activeClient.current, previousStatus = connection, epoch = generation.current;
    connectionChecks.current.invalidate(); setConnection('checking');
    try {
      const result = await replacement.current.run({ raw, name, platform: Platform.OS === 'ios' ? 'ios' : 'android', transport, store: pairingStore, previous, previousClient,
        isCurrent: () => generation.current === epoch && isForeground.current, onPhase: setPairingPhase });
      await connect(result.pairing, result);
    } catch (error) {
      transportReady.current = error instanceof PairingReplacementError ? error.recovery.transport_restored : transportReady.current;
      setConnection(previous ? transportReady.current && isForeground.current ? previousStatus : 'offline' : 'unpaired');
      const issue = connectionIssue(error); setConnectionProblem(issue); setConnectionError(issue.detail);
      throw error;
    }
    });
  };
  const cancelPairing = () => replacement.current.cancel();
  const hasPendingPairing = () => replacement.current.busy;
  const forget = async () => {
    if (loading || restoringTransport.current) throw new Error('Wait for the secure connection check to finish before forgetting this pairing.');
    await pairingTransitions.current.run(async () => {
    // Prevent refresh callbacks and competing session changes before the first
    // storage await. On failure the same in-memory pairing remains usable.
    connectionChecks.current.invalidate();
    const previousClient = activeClient.current, previousStatus = connection;
    previousClient?.pause(); setConnection('checking');
    let legacyRemoved = true;
    try { if (Platform.OS !== 'web') legacyRemoved = (await clearSavedPairing(pairingStore)).legacy_removed; }
    catch { previousClient?.resume(); setConnection(isForeground.current && previousStatus !== 'checking' ? previousStatus : 'offline'); throw new Error('Removal from protected storage could not be confirmed. This session still has its previous pairing.'); }
    generation.current++; sends.current.invalidate();
    connectionChecks.current.invalidate(); activePairing.current = null; transportReady.current = false;
    clearReferences();
    activeClient.current = null;
    conversationEpoch.current++; conversationLoading.current = false; setLoadingConversation(false);
    setClient(null); setPairing(null); setBootstrap(null); setPreferences(DEFAULTS); setMessages([]); setConversationId(undefined); setSending(false); setChatError(''); setConnectionError(legacyRemoved ? '' : 'This TLI is no longer selected. An unused older credential could not be removed from protected phone storage.'); setConnectionProblem(null); setConnection('unpaired');
    try { await transport.reset(); }
    catch { setConnectionError('This pairing was removed from protected storage, but the old secure connection could not be reset. Review a new pairing before using TLI.'); }
    });
    if (Platform.OS === 'web') await connect(PREVIEW_PAIRING);
  };
  const savePreferences = async (patch: Partial<Preferences>) => {
    if (!client || connection !== 'connected' || pairingTransitions.current.busy) throw new Error('Reconnect to TLI to save your preferences.');
    if (preferenceBusy.current) throw new Error('Your previous preference change is still being saved.');
    preferenceBusy.current = true;
    const epoch = generation.current;
    try { const saved = await client.json<Preferences>('/api/companion/v1/preferences', 'PUT', { ...preferences, ...patch }); if (epoch === generation.current) setPreferences(saved); }
    finally { preferenceBusy.current = false; }
  };
  const openConversation = async (id?: string) => {
    if (pairingTransitions.current.busy) throw new Error('Wait for the connection change to finish before opening a conversation.');
    if (sends.current.busy) throw new Error('Wait for the current response to finish stopping before opening another conversation.');
    const view = ++conversationEpoch.current;
    setChatError('');
    if (!id) { clearReferences(); conversationLoading.current = false; setLoadingConversation(false); setConversationId(undefined); setMessages([]); return; }
    if (!client) throw new Error('Connect to TLI to open a conversation.');
    const epoch = generation.current;
    conversationLoading.current = true; setLoadingConversation(true);
    try {
      const conversation = await client.json<Conversation>(`/api/ai/conversations/${encodeURIComponent(id)}`);
      if (generation.current !== epoch || conversationEpoch.current !== view || !isForeground.current) return;
      clearReferences(); setConversationId(conversation.id); setMessages((conversation.messages || []).filter(m => m.role === 'user' || m.role === 'assistant'));
    } finally { if (conversationEpoch.current === view) { conversationLoading.current = false; setLoadingConversation(false); } }
  };
  const send = async (message: string, context: ChatContext): Promise<void> => {
    if (!client || client !== activeClient.current || !pairing || connection !== 'connected' || !isForeground.current || pairingTransitions.current.busy) throw new Error('Reconnect to TLI before sending.');
    if (conversationLoading.current) throw new Error('Wait for the selected conversation to load before sending.');
    if (context.photo && !bootstrap?.capabilities.vision && !hasReviewedImageProvider(context)) throw new Error('An available vision model is required. Configure it on your TLI desktop first.');
    const epoch = generation.current, view = conversationEpoch.current, notes = selectedNotesRef.current, caseSelection = selectedCaseRef.current;
    await sendChat({
      client, guard: sends.current, bootstrap, conversationId, deviceId: pairing.device_id, message, context,
      isCurrent: () => generation.current === epoch && conversationEpoch.current === view,
      onStart: assistant => { setSending(true); setChatError(''); setMessages(old => [...old, { role: 'user', content: message, photo: !!context.photo }, assistant]); },
      onUpdate: assistant => setMessages(old => [...old.slice(0, -1), assistant]),
      onConversation: setConversationId,
      onError: error => setChatError(error instanceof ApiError ? error.message : `${errorText(error)} The message was not automatically resent.`),
      onSettled: () => setSending(false),
    });
    if (generation.current === epoch && conversationEpoch.current === view && selectedNotesRef.current === notes && context.note_refs?.length) clearSelectedNotes();
    if (generation.current === epoch && conversationEpoch.current === view && selectedCaseRef.current === caseSelection && context.case_ref) clearSelectedCase();
  };
  const selectCase = (selection?: SelectedCase) => {
    if (sends.current.busy || conversationLoading.current || !isForeground.current || !activeClient.current) throw new Error('Wait for the current question and reconnect before changing the case selection.');
    const next = selection ? { title: selection.title, updated_at: selection.updated_at, ref: casePointer(selection.ref) } : undefined;
    selectedCaseRef.current = next; setSelectedCase(next);
  };
  const selectNotes = (notes: NoteSummary[]) => {
    if (sends.current.busy || conversationLoading.current) throw new Error('Wait for the current response or conversation to finish before changing attached notes.');
    validateNoteContext({ note_refs: notes });
    const metadata = notes.map(({ id, revision, title, category, source, updated_at, device_id }) => ({ id, revision, title, category, source, updated_at, device_id }));
    selectedNotesRef.current = metadata; setSelectedNotes(metadata);
  };
  const stop = () => {
    const message = 'Stopped waiting on this phone. Server actions may still finish. Review history and device status before sending again.';
    sends.current.interrupt(message); client?.cancelAll(); setChatError(message);
    setMessages(old => old.map((entry, index) => index === old.length - 1 && entry.state === 'streaming' ? { ...entry, state: 'interrupted', ...(entry.timing ? { timing: { ...entry.timing, outcome: 'interrupted' as const } } : {}) } : entry));
  };
  const isCurrentPairing = (saved: Pairing) => activePairing.current === saved && isForeground.current && !pairingTransitions.current.busy;
  return { pairing, client, bootstrap, preferences, loading, connection, connectionError, connectionProblem, pairingPhase, checkedAt, connectionAttemptAt, foreground, revision, pair, cancelPairing, hasPendingPairing, forget, refresh, savePreferences, messages, conversationId, sending, loadingConversation, chatError, openConversation, send, stop, selectedNotes, selectNotes, selectedCase, selectCase, isCurrentPairing };
}

export function CompanionProvider({ children }: { children: React.ReactNode }) { const value = useSessionState(); return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>; }
export function useCompanion() { const value = useContext(SessionContext); if (!value) throw new Error('CompanionProvider missing'); return value; }

export function useResource<T>(path: string) {
  const { client, foreground, revision, connection } = useCompanion();
  const [data, setData] = useState<T>(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [checkedAt, setCheckedAt] = useState<string>();
  const requestId = useRef(0);
  const reload = useCallback(async () => {
    if (!client || !foreground || connection !== 'connected') return;
    const id = ++requestId.current; setBusy(true); setError('');
    try { const result = await client.json<T>(path); if (id === requestId.current) { setData(result); setCheckedAt(new Date().toISOString()); } }
    catch (error) { if (id === requestId.current) setError(errorText(error)); }
    finally { if (id === requestId.current) setBusy(false); }
  }, [client, path, foreground, connection]);
  useEffect(() => { setData(undefined); setCheckedAt(undefined); return () => { requestId.current++; }; }, [client, path]);
  useEffect(() => { if (connection === 'connected') void reload(); return () => { requestId.current++; }; }, [reload, revision, connection]);
  return { data, error, busy, checkedAt, reload, stale: !foreground || connection !== 'connected' || !!error };
}
