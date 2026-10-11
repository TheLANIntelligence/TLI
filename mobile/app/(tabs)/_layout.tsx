import { Tabs, Redirect } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCompanion } from '../../src/state';
import { SettingsButton, useTheme } from '../../src/ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useWindowDimensions } from 'react-native';

export default function TabLayout() {
  const { pairing } = useCompanion(); const t = useTheme(), insets = useSafeAreaInsets(), { fontScale } = useWindowDimensions();
  if (!pairing) return <Redirect href="/pair" />;
  return <Tabs initialRouteName="ask" screenOptions={{ headerStyle: { backgroundColor: t.background }, headerTitleStyle: { color: t.text, fontSize: 19, fontWeight: '600' }, headerShadowVisible: false, headerRight: () => <SettingsButton />, tabBarStyle: { backgroundColor: t.nav, borderTopColor: t.navSelected, paddingTop: 8, height: 52 + 18 * Math.max(1, fontScale) + insets.bottom }, tabBarItemStyle: { borderRadius: 14, marginHorizontal: 7, marginBottom: 5 }, tabBarHideOnKeyboard: true, tabBarAllowFontScaling: true, tabBarActiveTintColor: t.glow, tabBarInactiveTintColor: t.navMuted, tabBarActiveBackgroundColor: t.navSelected, tabBarLabelStyle: { fontSize: 12, lineHeight: 18, minHeight: 18, flexShrink: 0, fontWeight: '600' } }}>
    <Tabs.Screen name="ask" options={{ title: 'Chat', headerTitle: 'Ask TLI', tabBarIcon: ({ color, size, focused }) => <Ionicons name={focused ? 'chatbubble' : 'chatbubble-outline'} color={color} size={size} /> }} />
    <Tabs.Screen name="today" options={{ title: 'Today', headerTitle: pairing.node_name, tabBarIcon: ({ color, size, focused }) => <Ionicons name={focused ? 'sunny' : 'sunny-outline'} color={color} size={size} /> }} />
    <Tabs.Screen name="home" options={{ title: 'Home', tabBarIcon: ({ color, size, focused }) => <Ionicons name={focused ? 'home' : 'home-outline'} color={color} size={size} /> }} />
    <Tabs.Screen name="index" options={{ href: null }} />
  </Tabs>;
}
