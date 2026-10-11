import { DEFAULT_PALETTE, isPaletteId, paletteById, type PaletteId } from './theme';

export type AppearancePreference = Readonly<{ version: 1; mode: 'palette' | 'system'; palette: PaletteId }>;
export type AppearanceSnapshot = Readonly<{ preference: AppearancePreference; loaded: boolean; saving: boolean; error: string }>;
export type AppearanceStorage = { get: () => Promise<string | null>; set: (value: string) => Promise<void> };
export const DEFAULT_APPEARANCE: AppearancePreference = Object.freeze({ version: 1, mode: 'palette', palette: DEFAULT_PALETTE });

export function parseAppearance(raw: string | null): AppearancePreference | null {
  try {
    const value: unknown = JSON.parse(raw || 'null');
    if (!value || typeof value !== 'object') return null;
    const item = value as Record<string, unknown>;
    if (item.version !== 1 || !['palette', 'system'].includes(String(item.mode)) || !isPaletteId(item.palette)) return null;
    return { version: 1, mode: item.mode as AppearancePreference['mode'], palette: item.palette };
  } catch { return null; }
}
export function migrateAppearance(paired: boolean, legacyTheme: unknown): AppearancePreference {
  if (!paired) return DEFAULT_APPEARANCE;
  if (legacyTheme === 'system') return { version: 1, mode: 'system', palette: DEFAULT_PALETTE };
  return { version: 1, mode: 'palette', palette: legacyTheme === 'dark' ? 'midnight' : DEFAULT_PALETTE };
}
export function effectiveTheme(preference: AppearancePreference, darkSystem: boolean) {
  return paletteById(preference.mode === 'system' ? darkSystem ? 'midnight' : DEFAULT_PALETTE : preference.palette);
}

/** Phone-local appearance only. Saving never touches host preferences or credentials. */
export function createAppearanceStore(storage: AppearanceStorage) {
  let snapshot: AppearanceSnapshot = { preference: DEFAULT_APPEARANCE, loaded: false, saving: false, error: '' };
  let initialization: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: AppearanceSnapshot) => { snapshot = Object.freeze(next); listeners.forEach(listener => listener()); };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    initialize(fallback: AppearancePreference): Promise<void> {
      if (initialization) return initialization;
      initialization = (async () => {
        let raw: string | null;
        try { raw = await storage.get(); }
        catch { publish({ preference: fallback, loaded: true, saving: false, error: 'Saved appearance could not be read. Choose a theme to save it again.' }); return; }
        const stored = parseAppearance(raw);
        if (stored) { publish({ preference: stored, loaded: true, saving: false, error: '' }); return; }
        try { await storage.set(JSON.stringify(fallback)); publish({ preference: fallback, loaded: true, saving: false, error: '' }); }
        catch { publish({ preference: fallback, loaded: true, saving: false, error: 'Appearance could not be saved on this phone. Choose a theme to try again.' }); }
      })();
      return initialization;
    },
    async save(preference: AppearancePreference): Promise<boolean> {
      if (!snapshot.loaded || snapshot.saving) return false;
      const previous = snapshot.preference;
      publish({ ...snapshot, saving: true, error: '' });
      try {
        await storage.set(JSON.stringify(preference));
        publish({ preference, loaded: true, saving: false, error: '' });
        return true;
      } catch {
        publish({ preference: previous, loaded: true, saving: false, error: 'Your theme could not be saved. The previous appearance is still selected. Try again.' });
        return false;
      }
    },
  };
}
