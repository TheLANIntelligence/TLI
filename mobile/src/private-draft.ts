import { Alert, Platform } from 'react-native';
import { useNavigation } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';

export function confirmDiscard(action: () => void) {
  if (Platform.OS === 'web') { if (globalThis.confirm('Discard this unsaved draft? Saved records are unchanged.')) action(); return; }
  Alert.alert('Discard this unsaved draft?', 'Saved records are unchanged. No request is retried when you leave.', [{ text: 'Keep editing', style: 'cancel' }, { text: 'Discard draft', style: 'destructive', onPress: action }]);
}
export function useProtectedDraft(dirty: boolean, busy: boolean, privateSessionActive: boolean) {
  const navigation = useNavigation();
  usePreventRemove(privateSessionActive && (dirty || busy), ({ data }) => {
    if (busy) { Alert.alert('Request still in progress', 'Wait for its result. Leaving would not cancel a save already sent.'); return; }
    confirmDiscard(() => navigation.dispatch(data.action));
  });
}
