import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import type { Photo } from './types';

export async function choosePhoto(source: 'camera' | 'library'): Promise<Photo | undefined> {
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new Error('Camera access is turned off. Allow access in your phone settings or choose a photo.');
  }
  // The system photo picker grants access to the selected image only.
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], allowsEditing: false, quality: 1, exif: false };
  const result = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  if (result.canceled || !result.assets[0]) return;
  const asset = result.assets[0];
  const context = ImageManipulator.manipulate(asset.uri);
  // Bound upload memory and preserve readable error labels; server revalidates.
  if (Math.max(asset.width, asset.height) > 2048) context.resize(asset.width >= asset.height ? { width: 2048 } : { height: 2048 });
  let output: { uri: string; base64?: string; width: number; height: number } | undefined;
  try {
    const rendered = await context.renderAsync();
    try { output = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.85, base64: true }); }
    finally { rendered.release(); }
    if (!output.base64 || output.base64.length > 6 * 1024 * 1024 * 4 / 3) throw new Error('This photo is too large. Choose a smaller image.');
    return { uri: output.uri, base64: output.base64, mime: 'image/jpeg', width: output.width, height: output.height };
  } catch (error) { if (output) await disposePhoto(output.uri); throw error; }
  finally { context.release(); if (FileSystem.cacheDirectory && asset.uri.startsWith(FileSystem.cacheDirectory)) await disposePhoto(asset.uri); }
}
export async function disposePhoto(uri: string) { try { if (FileSystem.cacheDirectory && uri.startsWith(FileSystem.cacheDirectory)) await FileSystem.deleteAsync(uri, { idempotent: true }); } catch { /* OS cache cleanup handles already-removed temporary files. */ } }
