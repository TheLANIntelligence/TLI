import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, TextInput } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCompanion, errorText } from './state';
import { Button, Card, ConnectionNotice, Copy, Label, Notice, Screen, Section, styles, useTheme } from './ui';
import { formatTime } from './protocol';

type ConversationItem = { id: string; title: string; last_updated?: string; snippet?: string };
type Page = { items: ConversationItem[]; cursor?: string | null; next_cursor?: string | null; coverage?: { scanned_conversations: number; owned_conversations: number } };

export function ConversationLibrary({ library = false }: { library?: boolean }) {
  const state = useCompanion(), router = useRouter(), t = useTheme();
  const [query, setQuery] = useState(''), [items, setItems] = useState<ConversationItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [coverage, setCoverage] = useState(''), [loaded, setLoaded] = useState(false);
  const epoch = useRef(0), pending = useRef(false), focused = useRef(false);
  const queryRef = useRef(query), cursorRef = useRef(cursor), current = useRef(state);
  queryRef.current = query; cursorRef.current = cursor; current.current = state;

  useEffect(() => { epoch.current++; pending.current = false; queryRef.current = ''; cursorRef.current = null; setBusy(false); setItems([]); setCursor(null); setCoverage(''); setError(''); setLoaded(false); setQuery(''); }, [state.client]);

  const search = useCallback(async (more = false) => {
    const session = current.current, api = session.client;
    if (!api || pending.current || !focused.current || !session.foreground || session.connection !== 'connected') return;
    const token = ++epoch.current;
    const valid = () => token === epoch.current && focused.current && current.current.client === api && current.current.foreground && current.current.connection === 'connected';
    pending.current = true; setBusy(true); setError('');
    try {
      const result = await api.json<Page>('/api/intelligence/conversation-search?q=' + encodeURIComponent(queryRef.current) + '&limit=20' + (more && cursorRef.current ? '&cursor=' + encodeURIComponent(cursorRef.current) : ''));
      if (!valid()) return;
      if (!Array.isArray(result.items) || result.items.some(item => typeof item.id !== 'string' || typeof item.title !== 'string')) throw new Error('Conversation search returned an invalid result.');
      setItems(old => more ? [...old, ...result.items] : result.items); setCursor(result.cursor || result.next_cursor || null); setLoaded(true);
      setCoverage(result.coverage ? `${result.coverage.scanned_conversations} of ${result.coverage.owned_conversations} conversations inspected.` : '');
    } catch (error) { if (valid()) setError(errorText(error)); }
    finally { if (token === epoch.current) { pending.current = false; setBusy(false); } }
  }, []);

  useFocusEffect(useCallback(() => {
    focused.current = true;
    void search();
    return () => { focused.current = false; epoch.current++; pending.current = false; setBusy(false); };
  }, [search, state.client, state.foreground, state.connection]));

  const remove = (item: ConversationItem) => {
    const api = state.client, token = epoch.current;
    if (!api || state.connection !== 'connected' || !state.foreground || busy || state.sending) return;
    Alert.alert('Delete conversation?', `Remove “${item.title}” and its saved messages?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => {
        if (current.current.client !== api || !current.current.foreground || current.current.connection !== 'connected' || token !== epoch.current || !focused.current) return;
        void api.json('/conversations/' + encodeURIComponent(item.id), 'DELETE').then(() => {
          if (token === epoch.current && current.current.client === api && current.current.foreground && focused.current) setItems(old => old.filter(value => value.id !== item.id));
        }).catch(error => { if (token === epoch.current && current.current.client === api && current.current.foreground && focused.current) setError(errorText(error)); });
      } },
    ]);
  };
  const unavailable = !state.client || !state.foreground || state.connection !== 'connected';
  return <Screen>
    <Section title={library ? 'Your library' : 'Your conversations'} detail="The same conversations and notes on your phone and computer." />
    <ConnectionNotice />
    {library && <Card><Label>Notes & fixes</Label><Copy muted size={14}>Keep ideas, useful answers and details you want TLI to remember.</Copy><Button secondary title="Open Notes & fixes" icon="book-outline" onPress={() => router.push('/notebook')} /></Card>}
    <Section title="Conversations" detail="Pick up where you left off. Your current Chat draft stays in place." />
    <TextInput accessibilityLabel="Search conversations" placeholder="Search your conversations" placeholderTextColor={t.muted} value={query} onChangeText={value => { epoch.current++; pending.current = false; queryRef.current = value; cursorRef.current = null; setQuery(value); setCursor(null); setItems([]); setCoverage(''); setLoaded(false); setBusy(false); setError(''); }} maxLength={120} onSubmitEditing={() => void search()} returnKeyType="search" style={[styles.input, { color: t.text, borderColor: t.border }]} />
    <Button secondary title={query.trim() ? 'Search conversations' : 'Refresh conversations'} busy={busy} disabled={unavailable} onPress={() => void search()} />
    {error && <Notice error>{error}</Notice>}
    {loaded && !items.length && <Notice>{query.trim() ? 'No conversations matched. Try another word.' : 'Your conversations will appear here after you chat with TLI.'}</Notice>}
    {items.map(item => <Card key={item.id}><Copy weight="700">{item.title}</Copy><Copy muted size={12}>{formatTime(item.last_updated)}</Copy>{item.snippet && <Copy size={14}>{item.snippet}</Copy>}<Button secondary title="Continue conversation" disabled={unavailable || state.sending} onPress={() => router.push({ pathname: '/ask', params: { conversation: item.id } })} /><Button secondary title="Delete conversation" disabled={unavailable || busy || state.sending} onPress={() => remove(item)} /></Card>)}
    {cursor && <Button secondary title="Load more" busy={busy} disabled={unavailable} onPress={() => void search(true)} />}
    {coverage && <Copy muted size={12}>{coverage}</Copy>}
  </Screen>;
}
