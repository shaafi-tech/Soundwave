package com.shaafi.soundwave;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;

public class SoundWavePlugins {

    @CapacitorPlugin(
        name = "SoundWaveMediaStore",
        permissions = {
            @Permission(alias = "audio", strings = { Manifest.permission.READ_MEDIA_AUDIO }),
            @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE })
        }
    )
    public static class SoundWaveMediaStorePlugin extends Plugin {
        @PluginMethod
        public void requestPermissions(PluginCall call) {
            String alias = Build.VERSION.SDK_INT >= 33 ? "audio" : "storage";
            if (getPermissionState(alias) == PermissionState.GRANTED) {
                JSObject ret = new JSObject();
                ret.put(alias, "granted");
                call.resolve(ret);
                return;
            }
            requestPermissionForAlias(alias, call, "permCallback");
        }

        @PermissionCallback
        private void permCallback(PluginCall call) {
            String alias = Build.VERSION.SDK_INT >= 33 ? "audio" : "storage";
            JSObject ret = new JSObject();
            ret.put(alias, getPermissionState(alias) == PermissionState.GRANTED ? "granted" : "denied");
            call.resolve(ret);
        }

        @PluginMethod
        public void scanAudio(PluginCall call) {
            Context ctx = getContext();
            if (ctx == null) {
                call.reject("Context unavailable");
                return;
            }
            ContentResolver resolver = ctx.getContentResolver();
            Uri collection = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
                : MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;

            String[] projection = new String[] {
                MediaStore.Audio.Media._ID,
                MediaStore.Audio.Media.TITLE,
                MediaStore.Audio.Media.ARTIST,
                MediaStore.Audio.Media.ALBUM,
                MediaStore.Audio.Media.ALBUM_ID,
                MediaStore.Audio.Media.DURATION,
                MediaStore.Audio.Media.DATE_ADDED,
                MediaStore.Audio.Media.DATA
            };

            JSArray tracks = new JSArray();
            try (Cursor cursor = resolver.query(
                collection, projection, MediaStore.Audio.Media.IS_MUSIC + " != 0",
                null, MediaStore.Audio.Media.DATE_ADDED + " DESC"
            )) {
                if (cursor != null) {
                    int idCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media._ID);
                    int titleCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE);
                    int artistCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST);
                    int albumCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM);
                    int albumIdCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM_ID);
                    int durCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION);
                    int dateCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_ADDED);
                    int dataCol = cursor.getColumnIndex(MediaStore.Audio.Media.DATA);
                    Uri artworkBase = Uri.parse("content://media/external/audio/albumart");

                    while (cursor.moveToNext()) {
                        long id = cursor.getLong(idCol);
                        long albumId = cursor.getLong(albumIdCol);
                        Uri contentUri = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id);
                        Uri artUri = ContentUris.withAppendedId(artworkBase, albumId);
                        String path = dataCol >= 0 ? cursor.getString(dataCol) : "";
                        String folderPath = "Device Music";
                        String folderName = "Music";
                        if (path != null && !path.isEmpty()) {
                            File parent = new File(path).getParentFile();
                            if (parent != null) {
                                folderPath = parent.getAbsolutePath();
                                folderName = parent.getName();
                            }
                        }
                        JSObject obj = new JSObject();
                        obj.put("id", String.valueOf(id));
                        obj.put("title", cursor.getString(titleCol));
                        obj.put("artist", cursor.getString(artistCol));
                        obj.put("album", cursor.getString(albumCol));
                        obj.put("duration", cursor.getLong(durCol));
                        obj.put("dateAdded", cursor.getLong(dateCol));
                        obj.put("uri", contentUri.toString());
                        obj.put("path", path);
                        obj.put("folderPath", folderPath);
                        obj.put("folderName", folderName);
                        obj.put("albumArtUri", artUri.toString());
                        tracks.put(obj);
                    }
                }
            } catch (Exception e) {
                call.reject("MediaStore scan error: " + e.getMessage());
                return;
            }
            JSObject result = new JSObject();
            result.put("tracks", tracks);
            call.resolve(result);
        }
    }

    @CapacitorPlugin(name = "SoundWaveAudioFocus")
    public static class SoundWaveAudioFocusPlugin extends Plugin {
        private AudioManager audioManager;
        private AudioFocusRequest focusRequest;
        private BroadcastReceiver noisyReceiver;

        private final AudioManager.OnAudioFocusChangeListener focusListener = focusChange -> {
            JSObject data = new JSObject();
            if (focusChange == AudioManager.AUDIOFOCUS_LOSS) data.put("focus", "loss");
            else if (focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) data.put("focus", "loss_transient");
            else if (focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) data.put("focus", "loss_transient_can_duck");
            else if (focusChange == AudioManager.AUDIOFOCUS_GAIN) data.put("focus", "gain");
            notifyListeners("audioFocusChange", data);
        };

        @Override
        public void load() {
            Context ctx = getContext();
            if (ctx == null) return;
            audioManager = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            noisyReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) {
                        notifyListeners("becomingNoisy", new JSObject());
                    }
                }
            };
            IntentFilter filter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                ctx.registerReceiver(noisyReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                ctx.registerReceiver(noisyReceiver, filter);
            }
        }

        @PluginMethod
        public void requestFocus(PluginCall call) {
            if (audioManager == null) {
                JSObject r = new JSObject();
                r.put("granted", true);
                call.resolve(r);
                return;
            }
            int res;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build();
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attrs)
                    .setAcceptsDelayedFocusGain(true)
                    .setOnAudioFocusChangeListener(focusListener)
                    .build();
                res = audioManager.requestAudioFocus(focusRequest);
            } else {
                res = audioManager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
            }
            JSObject ret = new JSObject();
            ret.put("granted", res == AudioManager.AUDIOFOCUS_REQUEST_GRANTED);
            call.resolve(ret);
        }

        @PluginMethod
        public void abandonFocus(PluginCall call) {
            if (audioManager != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusRequest != null) {
                    audioManager.abandonAudioFocusRequest(focusRequest);
                } else {
                    audioManager.abandonAudioFocus(focusListener);
                }
            }
            call.resolve();
        }
    }
}
