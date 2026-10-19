import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as release from '../src/release-info';

type Element = { type: unknown; props: Record<string, any> };
function find(tree: any, predicate: (node: Element) => boolean): Element | undefined {
  if (Array.isArray(tree)) { for (const child of tree) { const match = find(child, predicate); if (match) return match; } }
  else if (tree && typeof tree === 'object' && tree.props) return predicate(tree) ? tree : find(tree.props.children, predicate);
}
function textOf(tree: any): string {
  if (Array.isArray(tree)) return tree.map(textOf).join(' ');
  if (tree && typeof tree === 'object') return textOf(tree.props?.children);
  return typeof tree === 'string' ? tree : '';
}
function view(file: string, exported: string, initial: any, props = {}) {
  let state = initial, stateIndex = 0, refIndex = 0, effectIndex = 0, callbackIndex = 0;
  const values: any[] = [], refs: any[] = [], effects: { deps: unknown[]; cleanup?: () => void }[] = [], callbacks: { deps: unknown[]; fn: any }[] = [], pending: (() => void)[] = [];
  const opened: string[] = [], routes: unknown[] = [], alerts: any[][] = [];
  const changed = (a: unknown[], b: unknown[]) => a.length !== b.length || a.some((value, index) => value !== b[index]);
  const effect = (fn: () => void | (() => void), deps: unknown[]) => {
    const index = effectIndex++, previous = effects[index];
    if (!previous || changed(previous.deps, deps)) { effects[index] = { deps }; pending.push(() => { previous?.cleanup?.(); const cleanup = fn(); if (cleanup) effects[index]!.cleanup = cleanup; }); }
  };
  const jsx = (type: unknown, elementProps: any) => ({ type, props: elementProps || {} });
  const ui = Object.fromEntries(['Button', 'Card', 'ConnectionNotice', 'Copy', 'Label', 'Notice', 'Screen', 'Section'].map(name => [name, name]));
  const modules: Record<string, unknown> = {
    react: {
      useState: (initial: any) => { const index = stateIndex++; if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial; return [values[index], (next: any) => { values[index] = typeof next === 'function' ? next(values[index]) : next; }]; },
      useRef: (initial: any) => refs[refIndex++] ||= { current: initial }, useEffect: effect,
      useCallback: (fn: any, deps: unknown[]) => { const index = callbackIndex++, previous = callbacks[index]; if (!previous || changed(previous.deps, deps)) callbacks[index] = { deps, fn }; return callbacks[index]!.fn; },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { TextInput: 'TextInput', Platform: { OS: 'android' }, Alert: { alert: (...args: any[]) => alerts.push(args) }, Linking: { openURL: async (url: string) => { opened.push(url); } } },
    'expo-router': { useFocusEffect: (fn: any) => effect(fn, [fn]), useRouter: () => ({ push: (route: unknown) => routes.push(route) }) },
    'expo-application': { nativeApplicationVersion: '0.2.0', nativeBuildVersion: '14', applicationId: 'com.thelegatointelligence.companion.beta' },
    './state': { useCompanion: () => state, errorText: (error: Error) => error.message },
    './ui': { ...ui, styles: { input: {} }, useTheme: () => ({}) },
    './protocol': { formatTime: (value: string) => value || 'Unknown' }, './release-info': release,
  };
  const exports: Record<string, any> = {}, source = new URL('../src/' + file, import.meta.url);
  const compiled = ts.transpileModule(readFileSync(source, 'utf8'), { fileName: source.pathname, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  runInNewContext(compiled, { exports, require: (name: string) => { assert.ok(name in modules, `Unexpected dependency ${name}`); return modules[name]; } });
  const render = () => { stateIndex = refIndex = effectIndex = callbackIndex = 0; return exports[exported](props) as Element; };
  const result = { tree: render(), opened, routes, alerts,
    render(next = state) { state = next; result.tree = render(); return result.tree; },
    async settle() { pending.splice(0).forEach(fn => fn()); await new Promise(resolve => setImmediate(resolve)); result.tree = render(); },
  };
  return result;
}
const session = (client: unknown) => ({ client, foreground: true, connection: 'connected', sending: false, pairing: { device_id: 'phone' } });
const response = { items: [{ id: 'chat-a', title: 'Weekend ideas', last_updated: '2026-10-16T00:00:00Z' }] };

test('Library loads existing conversations on entry, and notes and conversation navigation submit no work', async () => {
  const calls: string[] = [], client = { json: async (path: string) => { calls.push(path); return response; } };
  const screen = view('conversation-library.tsx', 'ConversationLibrary', session(client), { library: true });
  await screen.settle();
  assert.deepEqual(calls, ['/api/intelligence/conversation-search?q=&limit=20']);
  assert.match(textOf(screen.tree), /Weekend ideas/);
  find(screen.tree, node => node.props.title === 'Open Notes & fixes')!.props.onPress();
  find(screen.tree, node => node.props.title === 'Continue conversation')!.props.onPress();
  assert.equal(screen.routes[0], '/notebook');
  assert.equal((screen.routes[1] as any).params.conversation, 'chat-a');
  assert.equal(calls.length, 1);
});

test('Library keeps search explicit and ignores a delayed list after backgrounding', async () => {
  let complete!: (value: unknown) => void;
  const calls: string[] = [], client = { json: (path: string) => { calls.push(path); return new Promise(resolve => { complete = resolve; }); } };
  const initial = session(client), screen = view('conversation-library.tsx', 'ConversationLibrary', initial);
  await screen.settle();
  find(screen.tree, node => node.type === 'TextInput')!.props.onChangeText('private words');
  screen.render(); await screen.settle(); assert.equal(calls.length, 1);
  screen.render({ ...initial, foreground: false }); await screen.settle();
  complete(response); await screen.settle();
  assert.doesNotMatch(textOf(screen.tree), /Weekend ideas/);
  assert.equal(calls.length, 1);
});

test('a new pairing clears the old search before its initial private read', async () => {
  const calls: string[] = [], first = { json: async () => response }, second = { json: async (path: string) => { calls.push(path); return { items: [] }; } };
  const screen = view('conversation-library.tsx', 'ConversationLibrary', session(first));
  await screen.settle();
  find(screen.tree, node => node.type === 'TextInput')!.props.onChangeText('old owner search'); screen.render();
  screen.render(session(second)); await screen.settle();
  assert.deepEqual(calls, ['/api/intelligence/conversation-search?q=&limit=20']);
  assert.doesNotMatch(textOf(screen.tree), /Weekend ideas/);
});

test('a pending delete confirmation cannot cross background or pairing changes', async () => {
  const calls: [string, string?][] = [], client = { json: async (path: string, method?: string) => { calls.push([path, method]); return response; } };
  const initial = session(client), screen = view('conversation-library.tsx', 'ConversationLibrary', initial);
  await screen.settle();
  find(screen.tree, node => node.props.title === 'Delete conversation')!.props.onPress();
  screen.render({ ...initial, foreground: false }); await screen.settle();
  screen.alerts[0]![2].find((button: any) => button.text === 'Delete').onPress();
  assert.equal(calls.length, 1);
});

test('confirmed Library deletion uses the existing host route and removes only the selected row', async () => {
  const calls: [string, string?][] = [], client = { json: async (path: string, method?: string) => {
    calls.push([path, method]);
    return method === 'DELETE' ? { ok: true, existed: true } : { items: [
      { id: 'chat one', title: 'First saved chat' }, { id: 'chat-two', title: 'Retained saved chat' }] };
  } };
  const screen = view('conversation-library.tsx', 'ConversationLibrary', session(client));
  await screen.settle();
  find(screen.tree, node => node.props.title === 'Delete conversation')!.props.onPress();
  assert.equal(calls.length, 1);
  screen.alerts[0]![2].find((button: any) => button.text === 'Delete').onPress();
  await screen.settle();
  assert.deepEqual(calls[1], ['/conversations/chat%20one', 'DELETE']);
  assert.doesNotMatch(textOf(screen.tree), /First saved chat/);
  assert.match(textOf(screen.tree), /Retained saved chat/);
});

test('Android update link is available without a pairing and uses native installed build facts without host requests', async () => {
  let requests = 0;
  const screen = view('app-update-info.tsx', 'AppUpdateInfo', { ...session({ json: async () => { requests++; } }), pairing: null, connection: 'offline' });
  await screen.settle();
  assert.match(textOf(screen.tree), /0.2.0 · build 14/);
  const update = find(screen.tree, node => node.props.title === 'Get Android update')!;
  assert.equal(!!update.props.disabled, false); update.props.onPress();
  assert.deepEqual(screen.opened, [release.ANDROID_DOWNLOAD_URL]);
  assert.equal(requests, 0);
});

test('editing a pending search discards its rows and pagination before searching the new query', async () => {
  let complete!: (value: unknown) => void;
  const calls: string[] = [], client = { json: (path: string) => { calls.push(path); return new Promise(resolve => { complete = resolve; }); } };
  const screen = view('conversation-library.tsx', 'ConversationLibrary', session(client));
  await screen.settle();
  find(screen.tree, node => node.type === 'TextInput')!.props.onChangeText('new query'); screen.render();
  complete({ ...response, cursor: 'old-query-cursor' }); await screen.settle();
  assert.doesNotMatch(textOf(screen.tree), /Weekend ideas/);
  assert.equal(find(screen.tree, node => node.props.title === 'Load more'), undefined);
  find(screen.tree, node => node.props.title === 'Search conversations')!.props.onPress();
  assert.deepEqual(calls, ['/api/intelligence/conversation-search?q=&limit=20', '/api/intelligence/conversation-search?q=new%20query&limit=20']);
});
