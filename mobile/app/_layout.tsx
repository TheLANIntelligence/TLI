import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Platform, Text, View } from 'react-native';
import { CompanionProvider, useCompanion } from '../src/state';
import { Loading, useTheme } from '../src/ui';
import { useAppearance } from '../src/appearance';

export default function Layout() { return <SafeAreaProvider><CompanionProvider><Navigation /></CompanionProvider></SafeAreaProvider>; }
function Navigation() {
  const t = useTheme(); const { loading } = useCompanion(), appearance = useAppearance();
  // Read the saved phone palette before mounting navigation. This readiness gate
  // never closes again for a theme or System-mode change, so active screens stay mounted.
  if (loading || !appearance.loaded) return <Loading />;
  const screens = <><StatusBar style={t.dark ? 'light' : 'dark'} /><Stack screenOptions={{ headerStyle: { backgroundColor: t.background }, headerTintColor: t.text, headerShadowVisible: false, contentStyle: { backgroundColor: t.background } }}>
    <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    <Stack.Screen name="pair" options={{ headerShown: false }} />
    <Stack.Screen name="settings" options={{ title: 'Your companion' }} />
    <Stack.Screen name="notebook" options={{ title: 'Notes & fixes' }} />
    <Stack.Screen name="builder" options={{title:'Build an app'}}/>
    <Stack.Screen name="history" options={{title:'Conversations'}}/>
    <Stack.Screen name="computers" options={{ title: 'Computers' }} />
    <Stack.Screen name="cases" options={{ title: 'Troubleshooting' }} />
    <Stack.Screen name="data-recovery" options={{ title: 'Data & Recovery' }} />
    <Stack.Screen name="device/[id]" options={{ title: 'Device' }} />
    <Stack.Screen name="report/[id]" options={{ title: 'Diagnostic report' }} />
  </Stack></>;
  if (Platform.OS !== 'web') return screens;
  return <View style={{ flex: 1, backgroundColor: t.dark ? '#07120E' : '#E3ECE6' }}><View style={{ flex: 1, width: '100%', maxWidth: 480, alignSelf: 'center', backgroundColor: t.background, borderLeftWidth: 1, borderRightWidth: 1, borderColor: t.border }}><View style={{ paddingHorizontal: 12, paddingVertical: 10, backgroundColor: t.soft, borderBottomWidth: 1, borderColor: t.border }}><Text style={{ color: t.emerald, fontSize: 12, fontWeight: '600', textAlign: 'center' }}>Interactive preview · sample home</Text></View>{screens}</View></View>;
}
