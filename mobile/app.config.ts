import type { ExpoConfig } from 'expo/config';

const variant = process.env.TLI_APP_VARIANT || 'production';
if (variant !== 'production' && variant !== 'beta') throw new Error('TLI_APP_VARIANT must be production or beta.');
const isBeta = variant === 'beta';

const config: ExpoConfig = {
  name: isBeta ? 'TLI Companion Beta' : 'TLI Companion', slug: 'tli-companion', version: '0.1.0', scheme: isBeta ? 'tli-companion-beta' : 'tli-companion',
  owner: 'sergeantseven', extra: { eas: { projectId: 'd9f0d676-6556-4615-a459-3589c83e3c08' } },
  platforms: ['ios', 'android', 'web'],
  web: { bundler: 'metro', output: 'single' },
  icon: './assets/icon.png', backgroundColor: '#0C1915',
  orientation: 'portrait', userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: isBeta ? 'com.thelegatointelligence.companion.beta' : 'com.thelegatointelligence.companion', supportsTablet: true,
    infoPlist: {
      NSLocalNetworkUsageDescription: 'Connect securely to your paired TLI on your home Wi-Fi.',
      NSAppTransportSecurity: {
        NSAllowsLocalNetworking: true,
        NSExceptionDomains: Object.fromEntries(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'].map(address => [address, { NSExceptionAllowsInsecureHTTPLoads: true }])),
      },
      ITSAppUsesNonExemptEncryption: true,
    },
  },
  android: {
    package: isBeta ? 'com.thelegatointelligence.companion.beta' : 'com.thelegatointelligence.companion',
    permissions: ['android.permission.INTERNET', 'android.permission.ACCESS_NETWORK_STATE', 'android.permission.CAMERA'],
    blockedPermissions: ['android.permission.RECORD_AUDIO', 'android.permission.READ_MEDIA_AUDIO', 'android.permission.READ_MEDIA_VIDEO'],
  },
  plugins: [
    'expo-router', 'expo-secure-store', 'expo-font',
    ['expo-camera', { cameraPermission: 'Scan the pairing code shown on your TLI desktop.', microphonePermission: false, recordAudioAndroid: false }],
    ['expo-image-picker', { photosPermission: 'Choose an image to discuss with your TLI.', cameraPermission: 'Take a photo to discuss with your TLI.', microphonePermission: false }],
  ],
  experiments: { typedRoutes: true },
};
// Both variants keep the existing EAS project/slug. The automatic development
// launcher scheme uses that slug, so beta must register only its own scheme.
if (isBeta) config.plugins!.push(['expo-dev-client', { addGeneratedScheme: false }]);
export default config;
