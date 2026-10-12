import React from 'react';
import { Text, View } from 'react-native';
import type { PreviewProps } from './index';
export type { PreviewProps, CheckResult } from './index';
/** Browser fixtures are separate; a web fallback must never receive real credentials. */
export default function TliPreview(props: PreviewProps) {
  return <View style={props.style}><Text>Open the native Android app to run an isolated preview.</Text></View>;
}
