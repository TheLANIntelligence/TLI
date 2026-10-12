import React from 'react';
import { Platform, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';

export type CheckResult = { passed: boolean; error?: string };
export type PreviewProps = { html: string; headers: Record<string, string>; token: string; revisionKey: string; onCheckResult?: (result: CheckResult) => void; style?: StyleProp<ViewStyle> };
type NativeProps = Omit<PreviewProps, 'onCheckResult'> & { onCheckResult?: (event: { nativeEvent: CheckResult & { revisionKey: string } }) => void };
const NativeView = Platform.OS === 'android' ? requireNativeViewManager<NativeProps>('TliPreview') : null;

/** Content is passed as data. This component never receives a TLI credential or URL. */
export default function TliPreview(props: PreviewProps) {
  if (!NativeView) return <View style={props.style}><Text>Isolated app preview is available in the Android build.</Text></View>;
  return <NativeView {...props} onCheckResult={event => {
    if (event.nativeEvent.revisionKey === props.revisionKey) props.onCheckResult?.({ passed: event.nativeEvent.passed === true, error: event.nativeEvent.error });
  }} />;
}
