import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import NativeTransport from '../modules/tli-transport/index';
import { Client, ApiError } from './client';
import { configurePairing } from './paired-transport';
import type { Transport } from './client';
import { ChatSendGuard, hasReviewedImageProvider, sendChat } from './chat-send';
import type { Bootstrap, ChatContext, Conversation, Message, NoteSummary, Pairing, Preferences } from './types';
import { validateNoteContext } from './notebook';
import { casePointer, type SelectedCase } from './case-context';
import { connectionIssue, LatestConnectionCheck, readConnection, type ConnectionIssue } from './connection';
import { clearPairingAndReset, clearSavedPairing, loadSavedPairing, orderedPairingStore, PairingReplacement, PairingReplacementError, PairingTransitions, type PairingPhase } from './pairing-recovery';
import { settings,terminalRun,validateRun,runMessage,workspacePage,type ComputeSelection,type HostRun } from './workspace-model';
import { watchHostRun } from './host-runs';
import { followChatRun } from './chat-run-recovery';
import { isConnectionError } from './client';

const transport = NativeTransport as Transport;
const storeOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
export const pairingStore = orderedPairingStore({
  get: key => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value, storeOptions),
  remove: key => SecureStore.deleteItemAsync(key),
});
const DEFAULTS: Preferences = { favorite_devices: [], favorite_scenes: [], theme: 'system' };
const ACTIVE_RUN_KEY='tli_companion_active_run_v1';
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
  const [computeSelection,setComputeSelection]=useState<ComputeSelection|null>(null),[settingsRevision,setSettingsRevision]=useState(0);
  const [workspaceNotice,setWorkspaceNotice]=useState('');
  const activeRun=useRef<{id:string;epoch:number}|null>(null),recoveredClient=useRef<Client|null>(null);
  const connectionRef=useRef(connection);connectionRef.current=connection;
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
  const networkGeneration = useRef(0);
  const recoveryFailures = useRef(0);
  const connectionChecks = useRef(new LatestConnectionCheck()), replacement = useRef(new PairingReplacement()), pairingTransitions = useRef(new PairingTransitions());
  const invalidate = useCallback(() => {
    if (pairingTransitions.current.busy) return;
    void pairingTransitions.current.run(async () => {
    generation.current++; sends.current.invalidate();activeRun.current=null;setComputeSelection(null);setSettingsRevision(0);setWorkspaceNotice('');
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
    const ticket = connectionChecks.current.begin(), network = networkGeneration.current; api.invalidateObservations();
    const current = () => network === networkGeneration.current && connectionChecks.current.accepts(ticket, generation.current === epoch && activeClient.current === api && isForeground.current && !pairingTransitions.current.busy);
    setConnectionAttemptAt(new Date().toISOString()); setConnection('checking'); setConnectionProblem(null); setConnectionError('');
    try {
      if (!transportReady.current) {
        restoringTransport.current ||= configurePairing(transport, saved).finally(() => { restoringTransport.current = null; });
        await restoringTransport.current;
        if (!current()) return;
        transportReady.current = true; api.resume();
      }
      // Neutral probe callbacks cannot invalidate a working pairing from an
      // older refresh. Only the latest foreground ticket may publish its result.
      const checked = await readConnection(new Client(transport, api.credential), saved);
      if (!current()) return;
      recoveryFailures.current=0;
      setBootstrap(checked.bootstrap); setPreferences(checked.preferences); setCheckedAt(new Date().toISOString()); setConnection('connected'); setConnectionError(''); setConnectionProblem(null); setRevision(r => r + 1);
    } catch (error) {
      if (!current()) return;
      const issue = connectionIssue(error);
      if (issue.kind === 'credential') { invalidate(); return; }
      if (issue.kind === 'unreachable' || issue.kind === 'trust') transportReady.current = false;
      setConnection('offline'); setConnectionProblem(issue); setConnectionError(issue.detail);
    }
  }, [invalidate]);
  const connect = useCallback(async (saved: Pairing, checked?: Awaited<ReturnType<typeof readConnection>>) => {
    const epoch = ++generation.current;
    setCheckedAt(undefined); setConnectionAttemptAt(undefined);
    connectionChecks.current.invalidate();
    sends.current.invalidate(); setSending(false);activeRun.current=null;setComputeSelection(null);setSettingsRevision(0);setWorkspaceNotice('');
    clearReferences();
    activeClient.current?.pause(); activeClient.current = null;
    conversationEpoch.current++; conversationLoading.current = false; setLoadingConversation(false);
    setMessages([]); setConversationId(undefined);
    const api = new Client(transport, saved.credential, () => { if (generation.current === epoch && !pairingTransitions.current.busy) invalidate(); }, error => {
      if (generation.current !== epoch || pairingTransitions.current.busy || !isForeground.current) return;
      const issue = connectionIssue(error);
      if (issue.kind === 'unreachable' || issue.kind === 'trust') transportReady.current = false;
      setConnection('offline'); setConnectionProblem(issue); setConnectionError(issue.detail);
    });
    activeClient.current = api; activePairing.current = saved; setPairing(saved); setClient(api);
    transportReady.current = !!checked;
    if (checked) {
      setBootstrap(checked.bootstrap); setPreferences(checked.preferences); setCheckedAt(new Date().toISOString()); setConnection(isForeground.current ? 'connected' : 'offline'); setConnectionProblem(null); setConnectionError(''); setRevision(r => r + 1); return;
    }
    await refreshClient(api, epoch);
  }, [invalidate, refreshClient]);

  useEffect(() => {
    if (!client || !foreground || connection !== 'offline' || connectionProblem?.kind !== 'unreachable') return;
    // Read-only recovery rechecks the pin and signed identity before a saved
    // credential can use a new DHCP route. A trust failure requires review.
    const delay=Math.min(30000,5000*2**Math.min(recoveryFailures.current++,3));
    const timer = setTimeout(() => { if (!pairingTransitions.current.busy) void refreshClient(client, generation.current); }, delay);
    return () => clearTimeout(timer);
  }, [client, foreground, connection, connectionProblem, refreshClient]);

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
    if (Platform.OS !== 'android') return;
    let timer: ReturnType<typeof setTimeout> | undefined, mounted=true;
    const subscription = NativeTransport.addListener('onNetworkChanged', () => {
      const network=++networkGeneration.current;
      recoveryFailures.current=0;
      transportReady.current=false; connectionChecks.current.invalidate();
      if (pairingTransitions.current.busy || !activeClient.current) return;
      activeClient.current.pause();
      // Preserve the accepted run/conversation and unsent draft. Cancellation
      // detaches reads; no submitted action is sent again on a new network.
      if (isForeground.current) setConnection('checking');
      if(timer)clearTimeout(timer);
      timer=setTimeout(()=>void(async()=>{
        await restoringTransport.current?.catch(()=>{});
        const current=activeClient.current;
        if(mounted && current && network===networkGeneration.current && isForeground.current && !pairingTransitions.current.busy)
          await refreshClient(current,generation.current);
      })(),500);
    });
    return()=>{mounted=false;if(timer)clearTimeout(timer);subscription.remove();};
  },[refreshClient]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      isForeground.current = state === 'active';
      setForeground(state === 'active');
      if (state !== 'active') {
        clearSelectedCase();
        connectionChecks.current.invalidate(); replacement.current.cancel(); activeClient.current?.invalidateObservations();
        const message = 'Response interrupted while the app was in the background. Review the conversation before sending again.';
        if(!activeRun.current)sends.current.interrupt(message);
        client?.cancelAll();
        if (sends.current.busy&&!activeRun.current) {
          setChatError(message);
          setMessages(old => old.map((entry, index) => index === old.length - 1 && entry.state === 'streaming' ? { ...entry, state: 'interrupted', ...(entry.timing ? { timing: { ...entry.timing, outcome: 'interrupted' as const } } : {}) } : entry));
        }
      } else if (client && !pairingTransitions.current.busy) {
        transportReady.current=false;
        void (async()=>{await restoringTransport.current?.catch(()=>{});if(isForeground.current&&activeClient.current===client&&!pairingTransitions.current.busy)await refreshClient(client,generation.current);})();
      }
    });
    return () => subscription.remove();
  }, [client, refreshClient]);

  const pair = async (raw: string, name: string) => {
    if (Platform.OS === 'web') throw new Error('This browser preview uses a sample home. Pair a real TLI from the native companion app.');
    if (loading || pairingTransitions.current.busy || connection === 'checking' || !isForeground.current || sends.current.busy || preferenceBusy.current || conversationLoading.current || restoringTransport.current) throw new Error('Wait for the current request to finish, then keep the app open while reviewing this connection.');
    const network=networkGeneration.current;
    try { return await pairingTransitions.current.run(async () => {
    const previous = activePairing.current, previousClient = activeClient.current, previousStatus = connection, epoch = generation.current;
    connectionChecks.current.invalidate(); setConnection('checking');
    try {
      const result = await replacement.current.run({ raw, name, platform: Platform.OS === 'ios' ? 'ios' : 'android', transport, store: pairingStore, previous, previousClient,
        isCurrent: () => generation.current === epoch && isForeground.current && networkGeneration.current === network, onPhase: setPairingPhase });
      await connect(result.pairing, networkGeneration.current === network ? result : undefined);
    } catch (error) {
      transportReady.current = error instanceof PairingReplacementError ? error.recovery.transport_restored : transportReady.current;
      setConnection(previous ? transportReady.current && isForeground.current ? previousStatus : 'offline' : 'unpaired');
      const issue = connectionIssue(error); setConnectionProblem(issue); setConnectionError(issue.detail);
      throw error;
    }
    }); } finally {
      // A network callback during the non-cancellable protected-store commit
      // must not publish an older connection check as current readiness.
      if(networkGeneration.current !== network && activeClient.current) {
        transportReady.current=false;activeClient.current.pause();
        if(isForeground.current)void refreshClient(activeClient.current,generation.current);
      }
    }
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
    generation.current++; sends.current.invalidate();activeRun.current=null;setComputeSelection(null);setSettingsRevision(0);setWorkspaceNotice('');
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
    if (sends.current.busy||activeRun.current) throw new Error('Wait for the current response to finish stopping before opening another conversation.');
    const view = ++conversationEpoch.current;
    setChatError('');
    if (!id) { clearReferences();setComputeSelection(null);setSettingsRevision(0); conversationLoading.current = false; setLoadingConversation(false); setConversationId(undefined); setMessages([]); return; }
    if (!client) throw new Error('Connect to TLI to open a conversation.');
    const epoch = generation.current;
    conversationLoading.current = true; setLoadingConversation(true);
    try {
      const conversation = await client.json<Conversation>(`/api/ai/conversations/${encodeURIComponent(id)}`);
      const configuration=bootstrap?.capabilities.conversation_settings?settings(await client.json(`/api/ai/conversations/${encodeURIComponent(id)}/settings`)):null;
      if (generation.current !== epoch || conversationEpoch.current !== view || !isForeground.current) return;
      clearReferences(); setConversationId(conversation.id); setMessages((conversation.messages || []).filter(m => m.role === 'user' || m.role === 'assistant'));
      setComputeSelection(configuration?.compute_selection||null);setSettingsRevision(configuration?.settings_revision||0);setWorkspaceNotice('');
    } finally { if (conversationEpoch.current === view) { conversationLoading.current = false; setLoadingConversation(false); } }
  };
  const saveComputeSelection=async(value:ComputeSelection|null)=>{
    if(!client||!isForeground.current||connection!=='connected'||sends.current.busy||activeRun.current||conversationLoading.current)throw new Error('Reconnect and finish the current request before changing AI.');
    const epoch=generation.current,view=conversationEpoch.current;
    const configuration=conversationId&&bootstrap?.capabilities.conversation_settings?settings(await client.json(`/api/ai/conversations/${encodeURIComponent(conversationId)}/settings`,'PATCH',{compute_selection:value,expected_settings_revision:settingsRevision})):{compute_selection:value,settings_revision:settingsRevision};
    if(generation.current!==epoch||conversationEpoch.current!==view)return;
    setComputeSelection(configuration.compute_selection);setSettingsRevision(configuration.settings_revision);
  };
  const send = async (message: string, context: ChatContext): Promise<void> => {
    if(activeRun.current)throw new Error('An accepted answer is still running on your home TLI. Wait or request cancellation before sending again.');
    if (!client || client !== activeClient.current || !pairing || connection !== 'connected' || !isForeground.current || pairingTransitions.current.busy) throw new Error('Reconnect to TLI before sending.');
    if (conversationLoading.current) throw new Error('Wait for the selected conversation to load before sending.');
    if (context.photo && !bootstrap?.capabilities.vision && !hasReviewedImageProvider(context)) throw new Error('An available vision model is required. Configure it on your TLI desktop first.');
    const epoch = generation.current, view = conversationEpoch.current, notes = selectedNotesRef.current, caseSelection = selectedCaseRef.current;
    await sendChat({
      client, guard: sends.current, bootstrap, conversationId, deviceId: pairing.device_id, message, context:{...context,lan_inference:computeSelection},
      isCurrent: () => generation.current === epoch && conversationEpoch.current === view,
      onStart: assistant => { setSending(true); setChatError(''); setMessages(old => [...old, { role: 'user', content: message, photo: !!context.photo }, assistant]); },
      onUpdate: assistant => setMessages(old => [...old.slice(0, -1), assistant]),
      onConversation: setConversationId,
      onError: error => setChatError(error instanceof ApiError ? error.message : `${errorText(error)} The message was not automatically resent.`),
      onSettled: () => setSending(false),
      ...(bootstrap?.capabilities.host_runs?{runRequest:async(payload:Record<string,unknown>,path:string,event:(event:import('./types').ChatEvent)=>void)=>{
        const requestId=Crypto.randomUUID();
        const pointer={node_id:pairing.node_id,owner_id:pairing.owner_id,id:requestId};
        if(Platform.OS!=='web')await pairingStore.set(ACTIVE_RUN_KEY,JSON.stringify(pointer));
        if(generation.current!==epoch||conversationEpoch.current!==view||!isForeground.current)throw new Error('The workspace changed or the phone entered the background before this request was sent. Review your draft before trying again.');
        activeRun.current={id:requestId,epoch};let initial:HostRun|undefined;
        try{initial=validateRun(await client.json('/api/runs','POST',{request_id:requestId,kind:'chat',payload,chat_path:path}),requestId);activeRun.current={id:initial.id,epoch};}
        catch(error){if(!isConnectionError(error)&&(error as any)?.code!=='E_CANCELLED'){activeRun.current=null;throw error;}}
        let shown='';
        try{const result=await watchHostRun(client,initial?.id||requestId,{initial,current:()=>generation.current===epoch&&conversationEpoch.current===view,foreground:()=>isForeground.current,update:run=>{
          activeRun.current={id:run.id,epoch};if(run.conversation_id)setConversationId(run.conversation_id);
          event({type:'meta',...run.metadata,conversation_id:run.conversation_id});
          const text=run.text||run.result?.reply||'';if(text.startsWith(shown)){const delta=text.slice(shown.length);if(delta)event({type:'delta',text:delta});shown=text;}
          if(terminalRun(run))setWorkspaceNotice(run.status==='completed'?'Answer saved on your home TLI.':run.error||`Answer ${run.status}.`);
        }});
        if(result.status!=='completed')throw new Error(result.error||`The host run was ${result.status}. It was not resent.`);
        event({type:'done'});
        if(result.conversation_id&&generation.current===epoch&&bootstrap?.capabilities.conversation_settings){try{const config=settings(await client.json(`/api/ai/conversations/${encodeURIComponent(result.conversation_id)}/settings`));if(generation.current===epoch&&conversationEpoch.current===view){setSettingsRevision(config.settings_revision);setComputeSelection(config.compute_selection);}}catch{setWorkspaceNotice('Answer saved. Refresh this conversation before changing its AI selection.');}}
        }finally{if(activeRun.current?.epoch===epoch)activeRun.current=null;}
      }}:{}),
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
    if(activeRun.current&&client){const run=activeRun.current;setChatError('Requesting cancellation on your home TLI…');void client.json('/api/runs/'+encodeURIComponent(run.id)+'/cancel','POST').catch(error=>setChatError(errorText(error)+' The host outcome is not confirmed.'));return;}
    const message = 'Stopped waiting on this phone. Server actions may still finish. Review history and device status before sending again.';
    sends.current.interrupt(message); client?.cancelAll(); setChatError(message);
    setMessages(old => old.map((entry, index) => index === old.length - 1 && entry.state === 'streaming' ? { ...entry, state: 'interrupted', ...(entry.timing ? { timing: { ...entry.timing, outcome: 'interrupted' as const } } : {}) } : entry));
  };
  const isCurrentPairing = (saved: Pairing) => activePairing.current === saved && isForeground.current && !pairingTransitions.current.busy;
  const attachChatRun=async(id:string,stillCurrent:()=>boolean=()=>true)=>{
    if(!client||!pairing||!bootstrap?.capabilities.host_runs||pairingTransitions.current.busy||sends.current.busy||activeRun.current||conversationLoading.current)throw new Error('Reconnect and finish the current request before opening saved work.');
    if(!id||id.length>128)throw new Error('The saved run identifier is invalid.');
    const api=client,epoch=generation.current,view=++conversationEpoch.current;
    const current=()=>stillCurrent()&&epoch===generation.current&&view===conversationEpoch.current&&activeClient.current===api;
    let ownedId=id,savedMessages:Message[]=[],alreadyCompleted=false;
    activeRun.current={id,epoch};conversationLoading.current=true;setLoadingConversation(true);setSending(true);setChatError('');
    try{
      const result=await followChatRun(api,id,{current,ready:()=>isForeground.current&&connectionRef.current==='connected',sharedSettings:!!bootstrap.capabilities.conversation_settings,
        context:(conversation,configuration,run)=>{
          ownedId=run.id;activeRun.current={id:run.id,epoch};alreadyCompleted=run.status==='completed';savedMessages=(conversation?.messages||[]).filter(m=>m.role==='user'||m.role==='assistant');
          clearReferences();setConversationId(run.conversation_id);setMessages(savedMessages);setComputeSelection(configuration?.compute_selection||null);setSettingsRevision(configuration?.settings_revision||0);
          conversationLoading.current=false;setLoadingConversation(false);
          if(Platform.OS!=='web')void pairingStore.set(ACTIVE_RUN_KEY,JSON.stringify({node_id:pairing.node_id,owner_id:pairing.owner_id,id:run.id})).catch(()=>{if(current())setWorkspaceNotice('Saved work is open. This phone could not remember it for automatic restoration.');});
        },
        update:run=>{if(terminalRun(run))setChatError('');if(!alreadyCompleted)setMessages([...savedMessages,runMessage(run)]);if(run.conversation_id)setConversationId(run.conversation_id);setWorkspaceNotice(terminalRun(run)?run.status==='completed'?'Answer completed on your home TLI.':run.error||`Answer ${run.status}.`:`Host answer ${run.status}. Accepted work continues when this phone is in the background.`);},
        reconcile:conversation=>setMessages((conversation.messages||[]).filter(m=>m.role==='user'||m.role==='assistant')),
      });
      return result;
    }catch(error){if(current())setChatError(errorText(error));throw error;}
    finally{if(activeRun.current?.id===ownedId&&activeRun.current.epoch===epoch){activeRun.current=null;setSending(false);}if(view===conversationEpoch.current){conversationLoading.current=false;setLoadingConversation(false);}}
  };
  useEffect(()=>{
    if(!client||!bootstrap?.capabilities.host_runs||recoveredClient.current===client||Platform.OS==='web')return;
    recoveredClient.current=client;const epoch=generation.current,view=conversationEpoch.current;let alive=true;
    void(async()=>{try{const raw=await SecureStore.getItemAsync(ACTIVE_RUN_KEY);if(!raw)return;const pointer=JSON.parse(raw);if(pointer.node_id!==pairing?.node_id||pointer.owner_id!==pairing?.owner_id||typeof pointer.id!=='string'||sends.current.busy||!alive)return;
      if(epoch!==generation.current||view!==conversationEpoch.current||sends.current.busy||activeRun.current)return;
      await attachChatRun(pointer.id,()=>alive);
    }catch(error){if(alive&&epoch===generation.current)setChatError(errorText(error));}})();
    return()=>{alive=false;};
  },[client,!!bootstrap?.capabilities.host_runs]);
  useEffect(()=>{
    if(!client||!foreground||connection!=='connected'||!bootstrap?.capabilities.workspace_events)return;
    let alive=true,timer:ReturnType<typeof setTimeout>|undefined,cursor=0,eventEpoch='';
    const poll=async()=>{try{const page=workspacePage(await client.json('/api/workspace/events?after='+cursor+(eventEpoch?'&epoch='+encodeURIComponent(eventEpoch):'')));if(!alive)return;const first=!eventEpoch;eventEpoch=page.epoch;cursor=page.cursor;if(!first&&(page.reset||page.events.length)){setRevision(r=>r+1);setWorkspaceNotice('Shared work changed on your home TLI. Refresh the conversation to review it.');}}catch{/* A later read can recover; never retry a command. */}finally{if(alive)timer=setTimeout(()=>void poll(),5000);}};void poll();return()=>{alive=false;if(timer)clearTimeout(timer);};
  },[client,foreground,connection,!!bootstrap?.capabilities.workspace_events]);
  return { pairing, client, bootstrap, preferences, loading, connection, connectionError, connectionProblem, pairingPhase, checkedAt, connectionAttemptAt, foreground, revision, pair, cancelPairing, hasPendingPairing, forget, refresh, savePreferences, messages, conversationId, sending, loadingConversation, chatError, openConversation, attachChatRun, send, stop, selectedNotes, selectNotes, selectedCase, selectCase, isCurrentPairing,computeSelection,saveComputeSelection,workspaceNotice };
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
