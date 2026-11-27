// Run after "cap add android" / "cap sync android".
//  1. Adds the Android permissions needed for MediaStore scanning, background playback & notification.
//  2. Copies android-native/SoundWavePlugins.java into the app and registers the custom plugins
//     (SoundWaveMediaStore, SoundWaveAudioFocus) in MainActivity - Capacitor does NOT find them by itself.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';

const MANIFEST = 'android/app/src/main/AndroidManifest.xml';
if (!existsSync(MANIFEST)) {
  console.log('android/ not found yet. Run "npm run android:add" first.');
  process.exit(0);
}

// ---------- 1) permissions ----------
const PERMISSIONS = [
  'android.permission.INTERNET',
  'android.permission.WAKE_LOCK',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.READ_MEDIA_AUDIO',
  'android.permission.READ_EXTERNAL_STORAGE'
];

let xml = readFileSync(MANIFEST, 'utf8');
const missing = PERMISSIONS.filter((p) => !xml.includes(`android:name="${p}"`));

if (missing.length) {
  const lines = missing
    .map((p) =>
      p === 'android.permission.READ_EXTERNAL_STORAGE'
        ? `    <uses-permission android:name="${p}" android:maxSdkVersion="32" />`
        : `    <uses-permission android:name="${p}" />`
    )
    .join('\n');
  xml = xml.replace(/(\s*)<application/, `\n${lines}\n$1<application`);
  writeFileSync(MANIFEST, xml);
  console.log('Added permissions:\n - ' + missing.join('\n - '));
} else {
  console.log('AndroidManifest.xml already has every permission.');
}

// ---------- 2) custom native plugins ----------
const PKG_DIR = 'android/app/src/main/java/com/shaafi/soundwave';
const SRC_JAVA = 'android-native/SoundWavePlugins.java';

if (!existsSync(SRC_JAVA)) {
  console.warn(`warning: ${SRC_JAVA} not found - device music scan will not work.`);
} else {
  mkdirSync(PKG_DIR, { recursive: true });
  copyFileSync(SRC_JAVA, `${PKG_DIR}/SoundWavePlugins.java`);

  const MAIN_ACTIVITY = `package com.shaafi.soundwave;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Custom plugins must be registered BEFORE super.onCreate()
        registerPlugin(SoundWavePlugins.SoundWaveMediaStorePlugin.class);
        registerPlugin(SoundWavePlugins.SoundWaveAudioFocusPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`;
  writeFileSync(`${PKG_DIR}/MainActivity.java`, MAIN_ACTIVITY);
  console.log('Copied SoundWavePlugins.java and registered the plugins in MainActivity.java');
}
