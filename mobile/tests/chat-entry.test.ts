import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type Element = { type: unknown; props: Record<string, any> };
type HarnessOptions = { paired?: boolean; replacement?: boolean; reviewedCode?: boolean; pair?: (raw: string, name: string) => Promise<void> };

/** Execute actual TSX navigation and button callbacks with inert platform views.
 * This covers entry decisions, not React Native layout, router internals or TLS.
 */
function screen(path: string, options: HarnessOptions = {}) {
  const routes: string[] = [], updates: unknown[] = [];
  let hook = 0;
  const code = { raw: 'synthetic-reviewed-bundle', value: { node_name: 'Study', node_id: 'study', origin: 'https://study.invalid', certificate_der: 'synthetic-certificate' } };
  const pairing = options.paired ? { node_name: 'Study', node_id: 'study', origin: 'https://study.invalid', certificate_der: 'synthetic-certificate' } : null;
  const Tabs = Object.assign(() => undefined, { Screen: 'TabScreen' });
  const jsx = (type: unknown, props: Record<string, any>): Element => ({ type, props: props || {} });
  const modules: Record<string, unknown> = {
    react: { useEffect: () => undefined, useRef: (value: unknown) => ({ current: value }),
      useState: (value: unknown) => [hook++ === 1 && options.reviewedCode ? code : value, (next: unknown) => updates.push(next)] },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { Linking: {}, Platform: { OS: 'android' }, TextInput: 'TextInput', View: 'View', useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1 }) },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
    'expo-camera': { CameraView: 'CameraView', useCameraPermissions: () => [null, () => Promise.reject(new Error('No camera in entry tests'))] },
    'expo-router': { Tabs, Redirect: 'Redirect', useRouter: () => ({ replace: (path: string) => routes.push(path), back: () => undefined }),
      useNavigation: () => ({ dispatch: () => undefined }), useLocalSearchParams: () => options.replacement ? { replace: '1' } : {} },
    'expo-router/react-navigation': { usePreventRemove: () => undefined },
    '@expo/vector-icons/Ionicons': { __esModule: true, default: 'Ionicons' },
  };
  const state = { pairing, foreground: true, connectionError: '', pairingPhase: 'idle', cancelPairing: () => false,
    hasPendingPairing: () => false, pair: options.pair || (() => Promise.reject(new Error('Unexpected pairing action'))) };
  const ui = { Button: 'Button', Card: 'Card', Copy: 'Copy', Label: 'Label', Notice: 'Notice', Screen: 'Screen',
    SettingsButton: 'SettingsButton', styles: { input: {} }, useTheme: () => ({}) };
  const exports: Record<string, any> = {};
  const file = new URL(`../app/${path}`, import.meta.url);
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file.pathname,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  runInNewContext(compiled, { exports, require: (name: string) => {
    if (name.endsWith('/src/state')) return { useCompanion: () => state, errorText: (error: Error) => error.message };
    if (name.endsWith('/src/ui')) return ui;
    if (name.endsWith('/src/protocol')) return { parsePairingCode: () => { throw new Error('Only pre-reviewed synthetic code is used'); } };
    assert.ok(name in modules, `Unexpected screen dependency ${name}`);
    return modules[name];
  } });
  return { tree: exports.default() as Element, routes, updates, Tabs };
}

function find(tree: unknown, predicate: (node: Element) => boolean): Element | undefined {
  if (Array.isArray(tree)) {
    for (const item of tree) { const found = find(item, predicate); if (found) return found; }
  } else if (tree && typeof tree === 'object' && 'props' in tree) {
    const node = tree as Element;
    return predicate(node) ? node : find(node.props.children, predicate);
  }
  return undefined;
}

test('unpaired tab entry requests pairing without starting it', () => {
  const { tree, routes } = screen('(tabs)/_layout.tsx');
  assert.equal(tree.type, 'Redirect'); assert.equal(tree.props.href, '/pair'); assert.deepEqual(routes, []);
});

test('paired tabs open Chat and expose Chat, Today and Home once, with the landing alias hidden', () => {
  const { tree, Tabs } = screen('(tabs)/_layout.tsx', { paired: true });
  assert.equal(tree.type, Tabs); assert.equal(tree.props.initialRouteName, 'ask');
  const tabs = Array.from(tree.props.children as Element[]);
  assert.deepEqual(tabs.filter(node => node.props.options.href !== null).map(node => [node.props.name, node.props.options.title]),
    [['ask', 'Chat'], ['today', 'Today'], ['home', 'Home']]);
  const aliases = tabs.filter(node => node.props.options.href === null);
  assert.equal(aliases.length, 1); assert.equal(aliases[0]!.props.name, 'index');
});

test('root URL redirects to the existing Chat controller', () => {
  const { tree } = screen('(tabs)/index.tsx', { paired: true });
  assert.equal(tree.type, 'Redirect'); assert.equal(tree.props.href, '/ask');
});

for (const [label, paired, replacement, destination] of [
  ['initial pairing', false, false, '/ask'], ['reviewed replacement', true, true, '/settings'],
  ['replacement parameter without an existing pairing', false, true, '/ask'],
] as const) {
  test(`${label} navigates only after verified pairing completes, and coalesces rapid presses`, async () => {
    let complete!: () => void;
    const pending = new Promise<void>(resolve => { complete = resolve; });
    const calls: [string, string][] = [];
    const view = screen('pair.tsx', { paired, replacement, reviewedCode: true,
      pair: (raw, name) => { calls.push([raw, name]); return pending; } });
    const button = find(view.tree, node => node.type === 'Button' && node.props.title === (paired && replacement ? 'Verify and replace connection' : 'Connect to my TLI'));
    assert.ok(button);
    button.props.onPress(); button.props.onPress();
    assert.deepEqual(calls, [['synthetic-reviewed-bundle', 'My Android']]);
    assert.deepEqual(view.routes, []);
    complete(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(view.routes, [destination]);
  });
}

test('failed replacement stays in review and never routes to Chat or Settings', async () => {
  const view = screen('pair.tsx', { paired: true, replacement: true, reviewedCode: true,
    pair: async () => { throw new Error('Synthetic verification failed'); } });
  find(view.tree, node => node.type === 'Button' && node.props.title === 'Verify and replace connection')!.props.onPress();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(view.routes, []); assert.ok(view.updates.includes('Synthetic verification failed'));
});

test('opening pairing with an existing pairing and no replacement intent returns through the Chat landing alias', () => {
  const { tree, routes } = screen('pair.tsx', { paired: true });
  assert.equal(tree.type, 'Redirect'); assert.equal(tree.props.href, '/'); assert.deepEqual(routes, []);
});
