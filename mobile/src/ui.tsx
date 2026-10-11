import React, { createContext, useContext } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useCompanion } from './state';
import { formatTime } from './protocol';
import { useAppearance } from './appearance';
import { mixColors } from './theme';

const SurfaceTone = createContext<'surface' | 'hero'>('surface');
export function useTheme() { return useAppearance().theme; }
export function Copy({ children, size = 16, muted = false, weight = '400', tone, style, ...props }: React.ComponentProps<typeof Text> & { size?: number; muted?: boolean; weight?: TextStyle['fontWeight']; tone?: 'hero' | 'heroMuted' }) {
  const t = useTheme(), surface = useContext(SurfaceTone);
  const hero = !!tone || surface === 'hero';
  const color = hero ? muted || tone === 'heroMuted' ? t.heroMuted : t.heroText : muted ? t.muted : t.text;
  return <Text {...props} style={[{ fontSize: size, lineHeight: size * 1.45, color, fontWeight: weight, letterSpacing: size >= 22 ? -0.65 : 0 }, style]}>{children}</Text>;
}
export function Screen({ children, ...props }: React.ComponentProps<typeof ScrollView>) {
  const t = useTheme();
  return <ScrollView {...props} keyboardShouldPersistTaps="handled" style={[{ flex: 1, backgroundColor: t.background }, props.style]} contentContainerStyle={[styles.screen, props.contentContainerStyle]}>{children}</ScrollView>;
}
export function Card({ children, style, variant = 'surface' }: { children: React.ReactNode; style?: ViewStyle; variant?: 'surface' | 'hero' }) {
  const t = useTheme(), hero = variant === 'hero';
  return <SurfaceTone.Provider value={hero ? 'hero' : 'surface'}><View style={[styles.card, { backgroundColor: hero ? t.hero : t.card, borderColor: hero ? mixColors(t.glow, t.hero, 0.28) : t.border, shadowColor: t.nav, shadowOpacity: t.dark ? 0.2 : 0.07, shadowOffset: { width: 0, height: 8 }, shadowRadius: 20, elevation: 2 }, hero && { overflow: 'hidden', padding: 24 }, style]}>
    {hero && <View pointerEvents="none" importantForAccessibility="no-hide-descendants" style={styles.heroDecoration}><View style={{ position: 'absolute', width: 260, height: 260, borderRadius: 130, right: -110, top: -165, backgroundColor: mixColors(t.glow, t.hero, 0.1), borderColor: mixColors(t.glow, t.hero, 0.2), borderWidth: 1 }} /><View style={{ position: 'absolute', width: 340, height: 340, borderRadius: 170, right: -150, top: -205, borderColor: mixColors(t.glow, t.hero, 0.08), borderWidth: 1 }} /></View>}
    {children}
  </View></SurfaceTone.Provider>;
}
export function Hero({ eyebrow, title, detail, icon, children, style }: { eyebrow?: string; title?: string; detail?: string; icon?: React.ComponentProps<typeof Ionicons>['name']; children?: React.ReactNode; style?: ViewStyle }) {
  const t = useTheme();
  return <Card variant="hero" style={style}>{(eyebrow || icon) && <Row style={{ justifyContent: 'space-between' }}>{eyebrow && <Copy size={11} weight="700" style={{ color: t.glow, letterSpacing: 1.8, textTransform: 'uppercase', flex: 1 }}>{eyebrow}</Copy>}{icon && <View style={{ padding: 10, borderRadius: 14, backgroundColor: mixColors(t.glow, t.hero, 0.12), borderWidth: 1, borderColor: mixColors(t.glow, t.hero, 0.25) }}><Ionicons name={icon} size={22} color={t.glow} /></View>}</Row>}{title && <Copy size={32} weight="600" style={{ lineHeight: 37 }}>{title}</Copy>}{detail && <Copy size={15} muted>{detail}</Copy>}{children}</Card>;
}
export function Row({ children, style }: { children: React.ReactNode; style?: ViewStyle }) { return <View style={[styles.row, style]}>{children}</View>; }
export function Label({ children }: { children: React.ReactNode }) { return <Copy size={11} weight="700" muted style={{ letterSpacing: 1.8, textTransform: 'uppercase' }}>{children}</Copy>; }
export function Button({ title, onPress, icon, secondary = false, disabled = false, busy = false, accessibilityLabel }: { title: string; onPress: () => void; icon?: React.ComponentProps<typeof Ionicons>['name']; secondary?: boolean; disabled?: boolean; busy?: boolean; accessibilityLabel?: string }) {
  const t = useTheme(), hero = useContext(SurfaceTone) === 'hero';
  const background = hero ? secondary ? mixColors(t.glow, t.hero, 0.12) : t.glow : secondary ? t.soft : t.accent;
  const ink = hero ? secondary ? t.heroText : t.hero : secondary ? t.accent : t.contrast;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel || title} accessibilityState={{ disabled: disabled || busy, busy }} disabled={disabled || busy} onPress={onPress} style={({ pressed }) => [styles.button, { backgroundColor: background, borderWidth: 1, borderColor: hero ? mixColors(t.glow, t.hero, 0.24) : secondary ? t.border : t.accent, opacity: disabled || busy ? 0.5 : pressed ? 0.8 : 1 }]}>
    {busy ? <ActivityIndicator color={ink} /> : icon ? <Ionicons name={icon} size={20} color={ink} /> : null}<Text style={{ color: ink, fontSize: 16, fontWeight: '600', flexShrink: 1 }}>{title}</Text>
  </Pressable>;
}
export function IconButton({ icon, label, onPress, selected = false, disabled = false }: { icon: React.ComponentProps<typeof Ionicons>['name']; label: string; onPress: () => void; selected?: boolean; disabled?: boolean }) {
  const t = useTheme(), hero = useContext(SurfaceTone) === 'hero';
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ minHeight: 48, minWidth: 48, padding: 10, borderRadius: 14, backgroundColor: selected || pressed ? hero ? mixColors(t.glow, t.hero, 0.12) : t.soft : 'transparent', alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.45 : pressed ? 0.7 : 1 })}><Ionicons name={icon} size={23} color={hero ? t.glow : t.accent} /></Pressable>;
}
export function Notice({ children, error = false, structured = false }: { children: React.ReactNode; error?: boolean; structured?: boolean }) { const t = useTheme(); return <SurfaceTone.Provider value="surface"><View accessibilityLiveRegion="polite" style={{ backgroundColor: error ? t.dangerSoft : t.soft, borderRadius: 16, padding: 16, gap: 6, borderWidth: 1, borderColor: error ? mixColors(t.danger, t.dangerSoft, 0.25) : t.border }}>{structured ? children : <Copy size={14} style={error ? { color: t.danger } : undefined}>{children}</Copy>}</View></SurfaceTone.Provider>; }
export function Section({ title, detail }: { title: string; detail?: string }) { return <View style={{ gap: 6, marginTop: 4 }}><Copy size={26} weight="600">{title}</Copy>{detail && <Copy size={14} muted>{detail}</Copy>}</View>; }
export function SettingsButton() { const router = useRouter(); return <IconButton icon="options-outline" label="Connection and settings" onPress={() => router.push('/settings')} />; }
export function ConnectionNotice() {
  const state = useCompanion(); const t = useTheme(); const router = useRouter();
  if (state.connection === 'connected' && state.foreground) return null;
  return <View style={{ padding: 14, borderBottomWidth: 1, borderColor: t.border, backgroundColor: t.soft, gap: 8 }}><Copy size={14}>{state.connection === 'checking' ? state.pairingPhase !== 'idle' ? 'Verifying your reviewed replacement connection…' : 'Checking your home connection…' : state.connectionProblem?.title || 'Connection unavailable. Shown information may be out of date.'}</Copy>{state.pairing && <Copy selectable muted size={12}>Address: {state.pairing.origin}</Copy>}{!!state.connectionProblem && <Copy muted size={12}>{state.connectionProblem.detail}</Copy>}{state.connectionAttemptAt && <Copy muted size={12}>Connection check started {formatTime(state.connectionAttemptAt)}</Copy>}{state.checkedAt && <Copy size={12} muted>Last connected {formatTime(state.checkedAt)}</Copy>}{state.connection === 'offline' && <><Button secondary title="Check connection" disabled={state.pairingPhase !== 'idle'} onPress={() => void state.refresh()} /><Button secondary title="Open Host Start options" disabled={state.pairingPhase !== 'idle'} onPress={() => router.push('/settings')} /></>}</View>;
}
export function AIReadinessNotice() {
  const state = useCompanion(), ai = state.bootstrap?.ai;
  const stale = state.connection !== 'connected' || !state.foreground;
  if (!state.bootstrap) return <View style={{ gap: 6 }}><Copy size={14} weight="600">AI readiness has not been checked</Copy><Copy muted size={13}>Reconnect to TLI first.</Copy></View>;
  return <View style={{ gap: 6 }}><Copy size={14} weight="600">{stale ? 'Previous AI readiness' : 'AI readiness'}: {ai?.status === 'available' ? 'available at check time' : ai?.status === 'unavailable' ? 'unavailable' : 'unknown'}</Copy><Copy muted size={13}>{ai?.detail || 'This TLI version did not provide a current AI readiness check. You can deliberately try a question; no model is started by this status view.'}</Copy>{!!ai?.checked_at && <Copy muted size={12}>Checked {formatTime(ai.checked_at)}</Copy>}<Copy muted size={12}>{stale ? 'Check the host connection again for current information.' : 'Host access and AI readiness are separate. Existing device controls and diagnostic requests can work without an AI model.'}</Copy></View>;
}
export function Loading() { const t = useTheme(); return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.background, gap: 12 }}><ActivityIndicator color={t.accent} /><Copy muted>Connecting to your home…</Copy></View>; }
export const styles = StyleSheet.create({
  screen: { padding: 20, paddingBottom: 40, gap: 20, flexGrow: 1 },
  card: { borderRadius: 22, padding: 20, borderWidth: 1, gap: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  button: { flexDirection: 'row', gap: 9, minHeight: 50, borderRadius: 14, paddingHorizontal: 18, paddingVertical: 13, alignItems: 'center', justifyContent: 'center' },
  input: { minHeight: 52, borderRadius: 15, padding: 14, fontSize: 16, borderWidth: 1 },
  heroDecoration: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, overflow: 'hidden', borderRadius: 22 },
});
