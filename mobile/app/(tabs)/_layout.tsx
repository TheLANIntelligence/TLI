import { Tabs, Redirect } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCompanion } from '../../src/state';
import { SettingsButton, useTheme } from '../../src/ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useWindowDimensions } from 'react-native';

export default function TabLayout() {
  const { pairing } = useCompanion(); const t = useTheme(), insets = useSafeAreaInsets(), { fontScale } = useWindowDimensions();
  if (!pairing) return <Redirect href="/pair" />;
  return <Tabs initialRouteName="ask" screenOptions={{ headerStyle: { backgroundColor: t.background }, headerTitleStyle: { color: t.text, fontSize: 17 }, headerShadowVisible: false, headerRight: () => <SettingsButton />, tabBarStyle: { backgroundColor: t.card, borderTopColor: t.border, height: 42 + 18 * Math.max(1, fontScale) + insets.bottom }, tabBarHideOnKeyboard: true, tabBarAllowFontScaling: true, tabBarActiveTintColor: t.emerald, tabBarInactiveTintColor: t.muted, tabBarLabelStyle: { fontSize: 12, lineHeight: 18, minHeight: 18, flexShrink: 0, fontWeight: '600' } }}>
    <Tabs.Screen name="ask" options={{ title: 'Chat', headerTitle: 'TLI', tabBarIcon: ({ color, size }) => <Ionicons name="chatbubble-outline" color={color} size={size} /> }} />
    <Tabs.Screen name="today" options={{ title: 'Today', headerTitle: pairing.node_name, tabBarIcon: ({ color, size }) => <Ionicons name="sunny-outline" color={color} size={size} /> }} />
    <Tabs.Screen name="home" options={{ title: 'Home', tabBarIcon: ({ color, size }) => <Ionicons name="home-outline" color={color} size={size} /> }} />
    <Tabs.Screen name="index" options={{ href: null }} />
  </Tabs>;
}
