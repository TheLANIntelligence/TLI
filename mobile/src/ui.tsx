import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, useColorScheme, type TextStyle, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useCompanion } from './state';
import { formatTime } from './protocol';

const palettes = {
  light: { background: '#F3F7F4', card: '#FFFFFF', text: '#173A30', muted: '#557267', border: '#D8E5DD', emerald: '#11664C', soft: '#E4F2E9', contrast: '#FFFFFF', amber: '#80500E', danger: '#A82A36' },
  dark: { background: '#0C1915', card: '#142820', text: '#E3F4E9', muted: '#A3BDB0', border: '#2D483B', emerald: '#8BD9AF', soft: '#213E30', contrast: '#0E2B20', amber: '#F4C171', danger: '#FFA5AB' },
};
export function useTheme() { const system = useColorScheme(); const { preferences } = useCompanion(); const dark = (preferences.theme === 'system' ? system : preferences.theme) === 'dark'; return { ...palettes[dark ? 'dark' : 'light'], dark }; }
export function Copy({ children, size = 16, muted = false, weight = '400', style, ...props }: React.ComponentProps<typeof Text> & { size?: number; muted?: boolean; weight?: TextStyle['fontWeight'] }) { const t = useTheme(); return <Text {...props} style={[{ fontSize: size, lineHeight: size * 1.45, color: muted ? t.muted : t.text, fontWeight: weight }, style]}>{children}</Text>; }
export function Screen({ children, ...props }: React.ComponentProps<typeof ScrollView>) { const t = useTheme(); return <ScrollView {...props} keyboardShouldPersistTaps="handled" style={[{ flex: 1, backgroundColor: t.background }, props.style]} contentContainerStyle={[styles.screen, props.contentContainerStyle]}>{children}</ScrollView>; }
export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) { const t = useTheme(); return <View style={[styles.card, { backgroundColor: t.card, borderColor: t.border }, style]}>{children}</View>; }
export function Row({ children, style }: { children: React.ReactNode; style?: ViewStyle }) { return <View style={[styles.row, style]}>{children}</View>; }
export function Label({ children }: { children: React.ReactNode }) { return <Copy size={12} weight="700" muted style={{ letterSpacing: 1.8, textTransform: 'uppercase' }}>{children}</Copy>; }
export function Button({ title, onPress, icon, secondary = false, disabled = false, busy = false, accessibilityLabel }: { title: string; onPress: () => void; icon?: React.ComponentProps<typeof Ionicons>['name']; secondary?: boolean; disabled?: boolean; busy?: boolean; accessibilityLabel?: string }) {
  const t = useTheme(); return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel || title} accessibilityState={{ disabled: disabled || busy, busy }} disabled={disabled || busy} onPress={onPress} style={({ pressed }) => [styles.button, { backgroundColor: secondary ? t.soft : t.emerald, opacity: disabled || busy ? 0.5 : pressed ? 0.75 : 1 }]}>
    {busy ? <ActivityIndicator color={secondary ? t.emerald : t.contrast} /> : icon ? <Ionicons name={icon} size={20} color={secondary ? t.emerald : t.contrast} /> : null}<Text style={{ color: secondary ? t.emerald : t.contrast, fontSize: 16, fontWeight: '600', flexShrink: 1 }}>{title}</Text>
  </Pressable>;
}
export function IconButton({ icon, label, onPress, selected = false, disabled = false }: { icon: React.ComponentProps<typeof Ionicons>['name']; label: string; onPress: () => void; selected?: boolean; disabled?: boolean }) { const t = useTheme(); return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ minHeight: 48, minWidth: 48, padding: 10, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.45 : pressed ? 0.6 : 1 })}><Ionicons name={icon} size={23} color={t.emerald} /></Pressable>; }
export function Notice({ children, error = false }: { children: React.ReactNode; error?: boolean }) { const t = useTheme(); return <View accessibilityLiveRegion="polite" style={{ backgroundColor: t.soft, borderRadius: 16, padding: 16, gap: 6 }}><Copy size={14} style={error ? { color: t.danger } : undefined}>{children}</Copy></View>; }
export function Section({ title, detail }: { title: string; detail?: string }) { return <View style={{ gap: 4, marginTop: 4 }}><Copy size={22} weight="600">{title}</Copy>{detail && <Copy size={14} muted>{detail}</Copy>}</View>; }
export function SettingsButton() { const router = useRouter(); return <IconButton icon="options-outline" label="Connection and settings" onPress={() => router.push('/settings')} />; }
export function ConnectionNotice() {
  const state = useCompanion(); const t = useTheme();
  if (state.connection === 'connected' && state.foreground) return null;
  return <View style={{ padding: 14, borderBottomWidth: 1, borderColor: t.border, backgroundColor: t.soft, gap: 8 }}><Copy size={14}>{state.connection === 'checking' ? state.pairingPhase !== 'idle' ? 'Verifying your reviewed replacement connection…' : 'Checking your home connection…' : state.connectionProblem?.title || 'Connection unavailable. Shown information may be out of date.'}</Copy>{state.pairing && <Copy selectable muted size={12}>Address: {state.pairing.origin}</Copy>}{!!state.connectionProblem && <Copy muted size={12}>{state.connectionProblem.detail}</Copy>}{state.connectionAttemptAt && <Copy muted size={12}>Connection check started {formatTime(state.connectionAttemptAt)}</Copy>}{state.checkedAt && <Copy size={12} muted>Last connected {formatTime(state.checkedAt)}</Copy>}{state.connection === 'offline' && <Button secondary title="Check connection" disabled={state.pairingPhase !== 'idle'} onPress={() => void state.refresh()} />}</View>;
}
export function AIReadinessNotice() {
  const state = useCompanion(), ai = state.bootstrap?.ai;
  const stale = state.connection !== 'connected' || !state.foreground;
  if (!state.bootstrap) return <View style={{ gap: 6 }}><Copy size={14} weight="600">AI readiness has not been checked</Copy><Copy muted size={13}>Reconnect to TLI first.</Copy></View>;
  return <View style={{ gap: 6 }}><Copy size={14} weight="600">{stale ? 'Previous AI readiness' : 'AI readiness'}: {ai?.status === 'available' ? 'available at check time' : ai?.status === 'unavailable' ? 'unavailable' : 'unknown'}</Copy><Copy muted size={13}>{ai?.detail || 'This TLI version did not provide a current AI readiness check. You can deliberately try a question; no model is started by this status view.'}</Copy>{!!ai?.checked_at && <Copy muted size={12}>Checked {formatTime(ai.checked_at)}</Copy>}<Copy muted size={12}>{stale ? 'Check the host connection again for current information.' : 'Host access and AI readiness are separate. Existing device controls and diagnostic requests can work without an AI model.'}</Copy></View>;
}
export function Loading() { const t = useTheme(); return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.background, gap: 12 }}><ActivityIndicator color={t.emerald} /><Copy muted>Connecting to your home…</Copy></View>; }
export const styles = StyleSheet.create({ screen: { padding: 22, paddingBottom: 40, gap: 20, flexGrow: 1 }, card: { borderRadius: 24, padding: 20, borderWidth: 1, gap: 14 }, row: { flexDirection: 'row', alignItems: 'center', gap: 12 }, button: { flexDirection: 'row', gap: 9, minHeight: 50, borderRadius: 15, paddingHorizontal: 18, paddingVertical: 13, alignItems: 'center', justifyContent: 'center' }, input: { minHeight: 52, borderRadius: 15, padding: 14, fontSize: 16, borderWidth: 1 } });
