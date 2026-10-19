import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import ignore from 'ignore';

const appRoot = resolve(__dirname, '..');
const configCache = new Map<string, any>();
function configProcess(variant: string) {
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
  return spawnSync(process.execPath, [join(appRoot, 'node_modules/expo/bin/cli'), 'config', '--type', 'introspect', '--json'], {
    cwd: appRoot, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, [pathKey]: dirname(process.execPath) + delimiter + process.env[pathKey], TLI_APP_VARIANT: variant, EXPO_NO_DOTENV: '1', CI: '1' },
  });
}
function resolvedConfig(variant: string) {
  if (!configCache.has(variant)) {
    // Expo introspection evaluates generated plist/manifest mods without
    // writing native projects, downloading dependencies, or contacting EAS.
    const result = configProcess(variant);
    assert.equal(result.status, 0, result.stderr);
    configCache.set(variant, JSON.parse(result.stdout));
  }
  return configCache.get(variant);
}
function nativeSchemes(config: any) {
  const mods = config._internal.modResults;
  return {
    ios: mods.ios.infoPlist.CFBundleURLTypes.flatMap((item: any) => item.CFBundleURLSchemes),
    android: mods.android.manifest.manifest.application.flatMap((app: any) => app.activity || []).flatMap((activity: any) => activity['intent-filter'] || []).flatMap((filter: any) => filter.data || []).map((item: any) => item.$['android:scheme']).filter(Boolean),
  };
}

test('default and explicit production configuration keep the existing app identity and EAS project', () => {
  for (const variant of ['', 'production']) {
    const config = resolvedConfig(variant);
    assert.equal(config.name, 'TLI Companion'); assert.equal(config.scheme, 'tli-companion');
    assert.equal(config.ios.bundleIdentifier, 'com.thelegatointelligence.companion');
    assert.equal(config.android.package, 'com.thelegatointelligence.companion');
    assert.equal(config.slug, 'tli-companion'); assert.equal(config.version, JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).version);
    assert.equal(config.extra.eas.projectId, 'd9f0d676-6556-4615-a459-3589c83e3c08');
    assert.ok(nativeSchemes(config).ios.includes('tli-companion'));
  }
});

test('beta generates a distinct native identity and schemes without shared storage entitlements', () => {
  const config = resolvedConfig('beta'), mods = config._internal.modResults, schemes = nativeSchemes(config);
  assert.equal(config.name, 'TLI Companion Beta'); assert.equal(config.scheme, 'tli-companion-beta');
  assert.equal(config.ios.bundleIdentifier, 'com.thelegatointelligence.companion.beta');
  assert.equal(config.android.package, 'com.thelegatointelligence.companion.beta');
  assert.equal(config.slug, 'tli-companion'); assert.equal(config.extra.eas.projectId, 'd9f0d676-6556-4615-a459-3589c83e3c08');
  assert.equal(mods.ios.infoPlist.CFBundleDisplayName, 'TLI Companion Beta');
  for (const platform of ['ios', 'android'] as const) {
    assert.ok(schemes[platform].includes('tli-companion-beta'));
    for (const productionScheme of ['tli-companion', 'exp+tli-companion', 'com.thelegatointelligence.companion']) assert.equal(schemes[platform].includes(productionScheme), false);
  }
  assert.equal(mods.ios.entitlements['keychain-access-groups'], undefined);
  assert.equal(mods.ios.entitlements['com.apple.security.application-groups'], undefined);
  assert.equal(mods.android.manifest.manifest.$['android:sharedUserId'], undefined);
  const app = mods.android.manifest.manifest.application[0].$;
  assert.equal(app['android:fullBackupContent'], '@xml/secure_store_backup_rules');
  assert.equal(app['android:dataExtractionRules'], '@xml/secure_store_data_extraction_rules');
});

test('unknown app variants fail instead of accidentally selecting the production identity', () => {
  const result = configProcess('beeta'); assert.notEqual(result.status, 0); assert.match(result.stderr, /TLI_APP_VARIANT must be production or beta/);
});

test('beta is an internal release with remote increments and Android transport tests; existing profiles stay intact', () => {
  const eas = JSON.parse(readFileSync(join(appRoot, 'eas.json'), 'utf8'));
  assert.equal(eas.cli.appVersionSource, 'remote');
  assert.deepEqual(eas.build.development, { developmentClient: true, distribution: 'internal', node: '22.16.0' });
  assert.deepEqual(eas.build.preview, { distribution: 'internal', node: '22.16.0', android: { buildType: 'apk', gradleCommand: ':tli-transport:testReleaseUnitTest :tli-preview:testReleaseUnitTest :app:assembleRelease' } });
  assert.deepEqual(eas.build.simulator, { extends: 'preview', ios: { simulator: true } });
  assert.deepEqual(eas.build.production, { autoIncrement: true, node: '22.16.0' });
  const beta = { ...eas.build[eas.build.beta.extends], ...eas.build.beta };
  assert.equal(beta.distribution, 'internal'); assert.equal(beta.autoIncrement, true); assert.equal(beta.developmentClient, false);
  assert.equal(beta.env.TLI_APP_VARIANT, 'beta'); assert.equal(beta.android.buildType, 'apk');
  assert.match(beta.android.gradleCommand, /:tli-transport:testReleaseUnitTest/);
  assert.match(beta.android.gradleCommand, /:tli-preview:testReleaseUnitTest/);
  assert.equal(eas.submit, undefined);
});

test('repository and app-root EAS allowlists retain required sources and reject synthetic private files', () => {
  const rootRules = ignore().add(readFileSync(join(appRoot, '../.easignore'), 'utf8'));
  const appRules = ignore().add(readFileSync(join(appRoot, '.easignore'), 'utf8'));
  const required = ['app', 'app/(tabs)', 'app/(tabs)/ask.tsx', 'src/state.tsx', 'src/pairing-recovery.ts', 'assets/icon.png', 'package.json', 'package-lock.json', 'app.config.ts', 'eas.json', 'tsconfig.json', 'expo-env.d.ts', '.easignore', '.gitignore', 'modules/tli-transport/index.ts', 'modules/tli-transport/expo-module.config.json', 'modules/tli-transport/ios/TliTransport.podspec', 'modules/tli-transport/ios/TliTransportModule.swift', 'modules/tli-transport/ios/Tests/TransportPolicyTests.swift', 'modules/tli-transport/android/build.gradle', 'modules/tli-transport/android/src/main/AndroidManifest.xml', 'modules/tli-transport/android/src/test/java/expo/modules/tlitransport/PinnedClientTest.kt'];
  for (const path of required) { assert.equal(appRules.ignores(path), false, path); assert.equal(rootRules.ignores(`mobile/${path}`), false, path); }
  const denied = ['notes.txt', 'data/key', 'data/conversations.json', 'backend/main.py', 'node_modules/example/index.js', 'tests/connection.test.ts', 'android/app/build.gradle', 'ios/Podfile', 'dist/index.html', 'dist-beta/index.html', 'build-inspect/archive.tar.gz', 'src/data/notes.json', 'src/secrets/account.json', 'src/conversations.json', 'src/tli_model_config.json', 'src/node_identity.json', 'assets/models/qwen.gguf', 'assets/extra.gguf', 'src/weights.bin', 'src/checkpoint.safetensors', 'src/session.db', 'src/backup/copy.json', 'src/snapshots/owner.json', 'src/.env.local', 'src/.ssh/config', 'src/credentials.json', 'modules/tli-transport/debug.p12', 'modules/tli-transport/android/release.keystore', 'assets/certificate.pem', 'assets/private.key', 'assets/old.apk', 'src/output.log', 'modules/tli-transport/android/build/intermediates/result.class', 'modules/tli-transport/android/.gradle/cache.bin'];
  for (const path of denied) { assert.equal(appRules.ignores(path), true, path); assert.equal(rootRules.ignores(`mobile/${path}`), true, path); }
  for (const path of ['data', 'data/key', 'backend/main.py', 'frontend/index.html', 'TLI_Installer/package.json', 'docs/recovery.md', '.env', 'models/qwen.gguf', 'archive.zip']) assert.equal(rootRules.ignores(path), true, path);
});
