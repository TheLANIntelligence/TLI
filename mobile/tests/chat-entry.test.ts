import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { parsePairingCode } from '../src/protocol';
import { redirectPairingLink, takePairingLink } from '../src/pairing-link';

type Element = { type: unknown; props: Record<string, any> };
type HarnessOptions = { paired?: boolean; replacement?: boolean; reviewedCode?: boolean; changedCertificate?: boolean; changedIdentity?: boolean; incoming?: string; pendingPairing?: boolean; pair?: (raw: string, name: string) => Promise<void> };

/** Execute actual TSX navigation and button callbacks with inert platform views.
 * This covers entry decisions, not React Native layout, router internals or TLS.
 */
function screen(path: string, options: HarnessOptions = {}) {
  const routes: string[] = [], updates: unknown[] = [];
  let hook = 0, refHook = 0, effectHook = 0;
  const values: unknown[] = [], refs: {current:unknown}[] = [], dependencies: unknown[][] = [], effects: (()=>void)[] = [];
  const code = { raw: 'synthetic-reviewed-bundle', value: { node_name: 'Study', node_id: options.changedIdentity ? 'other-study' : 'study', origin: 'https://study.invalid', certificate_der: options.changedCertificate ? 'changed-certificate' : 'synthetic-certificate' } };
  const pairing = options.paired ? { node_name: 'Study', node_id: 'study', origin: 'https://study.invalid', certificate_der: 'synthetic-certificate' } : null;
  const Tabs = Object.assign(() => undefined, { Screen: 'TabScreen' });
  const jsx = (type: unknown, props: Record<string, any>): Element => ({ type, props: props || {} });
  const modules: Record<string, unknown> = {
    react: { useEffect: (effect:()=>void,deps:unknown[]) => {const index=effectHook++;if(!dependencies[index]||deps.some((value,i)=>value!==dependencies[index]![i])){dependencies[index]=deps;effects.push(effect);}}, useRef: (value: unknown) => refs[refHook++] ||= ({ current: value }),
      useState: (value: unknown) => {const index=hook++;if(!(index in values))values[index]=index===1&&options.reviewedCode?code:value;return [values[index],(next:unknown)=>{values[index]=typeof next==='function'?next(values[index]):next;updates.push(next);}];} },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { Linking: {}, Platform: { OS: 'android' }, TextInput: 'TextInput', View: 'View', useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1 }) },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
    'expo-camera': { CameraView: 'CameraView', useCameraPermissions: () => [null, () => Promise.reject(new Error('No camera in entry tests'))] },
    'expo-router': { Tabs, Redirect: 'Redirect', useRouter: () => ({ replace: (path: string) => routes.push(path), back: () => undefined }),
      useNavigation: () => ({ dispatch: () => undefined }), useLocalSearchParams: () => ({...(options.replacement?{replace:'1'}:{}),...(options.incoming?{incoming:options.incoming}:{})}) },
    'expo-router/react-navigation': { usePreventRemove: () => undefined },
    '@expo/vector-icons/Ionicons': { __esModule: true, default: 'Ionicons' },
  };
  const state = { pairing, foreground: true, connectionError: '', pairingPhase: 'idle', cancelPairing: () => false,
    hasPendingPairing: () => !!options.pendingPairing, pair: options.pair || (() => Promise.reject(new Error('Unexpected pairing action'))) };
  const ui = { Button: 'Button', Card: 'Card', Copy: 'Copy', Hero: 'Hero', Label: 'Label', Notice: 'Notice', Screen: 'Screen',
    SettingsButton: 'SettingsButton', styles: { input: {} }, useTheme: () => ({}) };
  const exports: Record<string, any> = {};
  const file = new URL(`../app/${path}`, import.meta.url);
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file.pathname,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  runInNewContext(compiled, { exports, require: (name: string) => {
    if (name.endsWith('/src/state')) return { useCompanion: () => state, errorText: (error: Error) => error.message };
    if (name.endsWith('/src/ui')) return ui;
    if (name.endsWith('/src/protocol')) return { parsePairingCode };
    if (name.endsWith('/src/pairing-link')) return { takePairingLink };
    if (name.endsWith('/src/app-update-info')) return { AppUpdateInfo: 'AppUpdateInfo' };
    assert.ok(name in modules, `Unexpected screen dependency ${name}`);
    return modules[name];
  } });
  const render=()=>{hook=refHook=effectHook=0;return exports.default() as Element;};
  const result={tree:render(),routes,updates,Tabs,flushEffects(){effects.splice(0).forEach(effect=>effect());result.tree=render();}};
  return result;
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

test('paired tabs open Chat and expose Chat, Library and More while preserving older routes', () => {
  const { tree, Tabs } = screen('(tabs)/_layout.tsx', { paired: true });
  assert.equal(tree.type, Tabs); assert.equal(tree.props.initialRouteName, 'ask');
  const tabs = Array.from(tree.props.children as Element[]);
  assert.deepEqual(tabs.filter(node => node.props.options.href !== null).map(node => [node.props.name, node.props.options.title]),
    [['ask', 'Chat'], ['library', 'Library'], ['tools', 'More']]);
  const aliases = tabs.filter(node => node.props.options.href === null);
  assert.deepEqual(aliases.map(node => node.props.name), ['today', 'home', 'index']);
});

test('root URL redirects to the existing Chat controller', () => {
  const { tree } = screen('(tabs)/index.tsx', { paired: true });
  assert.equal(tree.type, 'Redirect'); assert.equal(tree.props.href, '/ask');
});

test('pairing keeps public app updates available before connection and manual entry behind Advanced', () => {
  const initial = screen('pair.tsx');
  assert.ok(find(initial.tree, node => node.type === 'AppUpdateInfo'));
  assert.equal(find(initial.tree, node => node.props.accessibilityLabel === 'Pairing bundle'), undefined);
  find(initial.tree, node => node.type === 'Button' && node.props.title === 'Advanced connection')!.props.onPress();
  initial.flushEffects();
  assert.ok(find(initial.tree, node => node.props.accessibilityLabel === 'Pairing bundle'));
  assert.deepEqual(initial.routes, []);
});

test('changed certificate and installation warnings remain visible without opening connection details', () => {
  const reviewed = screen('pair.tsx', { paired: true, replacement: true, reviewedCode: true, changedCertificate: true, changedIdentity: true });
  assert.ok(find(reviewed.tree, node => node.type === 'Notice' && typeof node.props.children === 'string' && node.props.children.includes('certificate has changed')));
  assert.ok(find(reviewed.tree, node => node.type === 'Notice' && typeof node.props.children === 'string' && node.props.children.includes('different TLI installation')));
  assert.ok(find(reviewed.tree, node => node.type === 'Button' && node.props.title === 'Connection details'));
  assert.deepEqual(reviewed.routes, []);
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

function incoming() {
  const fragment=new URLSearchParams({v:'1',c:'A'.repeat(256),t:'b'.repeat(43),e:String(Math.floor(Date.now()/1000)+300),i:'new-host',n:'New reviewed host',o:'https://192.168.1.2:8000'});
  return redirectPairingLink('tli-companion-beta:///pair#'+fragment)!.split('=')[1]!;
}
for(const paired of [false,true])test(`native invitation opens explicit ${paired?'replacement':'initial'} review without connecting`,async()=>{
  const calls:string[]=[];let complete!:()=>void;const pending=new Promise<void>(resolve=>{complete=resolve;});
  const view=screen('pair.tsx',{paired,incoming:incoming(),pair:raw=>{calls.push(raw);return pending;}});
  view.flushEffects();assert.deepEqual(calls,[]);assert.deepEqual(view.routes,[]);
  assert.ok(find(view.tree,node=>node.type==='Copy'&&node.props.children==='New reviewed host'));
  if(paired)assert.ok(find(view.tree,node=>node.type==='Label'&&node.props.children==='Current pairing'));
  const button=find(view.tree,node=>node.type==='Button'&&node.props.title===(paired?'Verify and replace connection':'Connect to my TLI'));
  assert.ok(button);assert.equal(JSON.stringify(view.tree).includes('b'.repeat(43)),false);
  button.props.onPress();button.props.onPress();assert.equal(calls.length,1);assert.equal(parsePairingCode(calls[0]!).node_id,'new-host');
  assert.deepEqual(view.routes,[]);complete();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(view.routes,[paired?'/settings':'/ask']);
});
test('incoming invitation cannot replace an in-progress verification or be reviewed twice',()=>{
  const id=incoming(),calls:string[]=[];
  const busy=screen('pair.tsx',{paired:true,incoming:id,pendingPairing:true,pair:async raw=>{calls.push(raw);}});
  busy.flushEffects();assert.ok(busy.updates.some(value=>typeof value==='string'&&value.includes('Finish the current verification')));
  assert.equal(find(busy.tree,node=>node.type==='Button'&&node.props.title==='Verify and replace connection'),undefined);
  const reused=screen('pair.tsx',{paired:true,incoming:id,pair:async raw=>{calls.push(raw);}});reused.flushEffects();
  assert.ok(reused.updates.some(value=>typeof value==='string'&&value.includes('no longer available')));assert.deepEqual(calls,[]);
});
