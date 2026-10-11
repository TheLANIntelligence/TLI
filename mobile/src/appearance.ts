import { useEffect, useSyncExternalStore } from 'react';
import { Platform, useColorScheme } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { useCompanion } from './state';
import { createAppearanceStore, effectiveTheme, migrateAppearance } from './appearance-model';
import type { PaletteId } from './theme';

const key = 'tli_companion_appearance_v1';
const appearance = createAppearanceStore({
  get: async () => Platform.OS === 'web' ? globalThis.localStorage.getItem(key) : SecureStore.getItemAsync(key),
  set: async value => {
    if (Platform.OS === 'web') globalThis.localStorage.setItem(key, value);
    else await SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  },
});

export function useAppearance() {
  const { loading, pairing, preferences } = useCompanion();
  const system = useColorScheme();
  const state = useSyncExternalStore(appearance.subscribe, appearance.getSnapshot, appearance.getSnapshot);
  useEffect(() => {
    if (!loading) void appearance.initialize(migrateAppearance(!!pairing, preferences.theme));
  }, [loading, pairing, preferences.theme]);
  return {
    ...state,
    theme: effectiveTheme(state.preference, system === 'dark'),
    selectPalette: (palette: PaletteId) => appearance.save({ version: 1, mode: 'palette', palette }),
    followSystem: (enabled: boolean) => appearance.save({ ...state.preference, mode: enabled ? 'system' : 'palette' }),
  };
}
