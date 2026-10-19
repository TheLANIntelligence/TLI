import { useState } from 'react';
import { Linking, Platform } from 'react-native';
import * as Application from 'expo-application';
import { Button, Card, Copy, Label, Notice } from './ui';
import { ANDROID_DOWNLOAD_URL, nativeBuildLabel } from './release-info';

/** Public browser navigation remains available without a pairing or live host. */
export function AppUpdateInfo() {
  const [error, setError] = useState('');
  const app = nativeBuildLabel(Application, Platform.OS === 'web');
  return <Card><Label>Your installed app</Label><Copy weight="600">{app.label}</Copy>
    {Platform.OS !== 'ios' && <><Button secondary title="Get Android update" icon="download-outline" onPress={() => { setError(''); void Linking.openURL(ANDROID_DOWNLOAD_URL).catch(() => setError('The download page could not open. Try again when internet access is available.')); }} /><Copy muted size={13}>Opens the official beta download page. Install the update over this app and keep its data. Updating your computer does not update the phone app.</Copy></>}
    {!!error && <Notice error>{error}</Notice>}
  </Card>;
}
