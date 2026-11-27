FREE MUSIC SOURCES (latest)
- Search now shows one block per source: Audius, Jamendo, Internet Archive (each loads on its own,
  so one slow or broken source never hides the others).
- Home (Listen Now) has a "Free music to discover" section: Audius trending this week,
  Jamendo popular, Internet Archive most downloaded. Lists are cached for 10 minutes.
- Every online song has the usual menu: Add to Up Next, Save Offline, favourite.
- JAMENDO needs a free client id: https://devportal.jamendo.com  -> create an app -> copy the client id.
  Paste it in the app (the Jamendo block asks for it once), or set it in index.html:
  window.SOUNDWAVE_CONFIG = { jamendoClientId: 'YOUR_ID' }
- To add another source: add one object to EXTRA_SOURCES at the bottom of js/sources.js
  (id, label, search(query), trending()) returning tracks like the others.
- Not included on purpose: no public/legal API exists for NCS, Bandcamp, YouTube Audio Library
  or Free Music Archive. Songs from YouTube/Spotify/Tidal rips are copyrighted, so they are not supported.
- Songs stay owned by their artists. Many Creative Commons licences require credit (artist + title is
  shown in the app) and some forbid commercial use: keep SoundWave non-commercial, or check each licence.

SOUNDWAVE - PART 2 UPGRADE NOTES

LATEST PASS (Part 2 audit + refinements)
- js/native.js      Notification / status-bar artwork is now prepared properly: https URLs are passed
                    through, data: URLs keep their real type, SVG placeholder covers are drawn to PNG,
                    blob: covers are typed from the blob, and the native Android plugin only receives
                    https URLs. Text shows at once; the cover follows when ready (stale covers are dropped).
- js/fullplayer.js  Lyrics view: colour gradient taken from the cover, active line sharp while other lines
                    are dimmed + blurred by distance, blur lifts while you scroll, tap a line to seek,
                    small cover (tap = back to artwork), compact controls, credit line in the player.
- js/visualizer.js  Resumes the audio context if the OS suspends it (screen lock / call), so sound is not lost.
- part2.css         Styles for all of the above.

NEW FILES
- js/network.js   Online/offline state, offline banner, fetch with timeout + retry.
- js/native.js    Media controls bridge: Capacitor "MediaSession" plugin on Android, Web Media Session in browsers.
- js/offline.js   Save Appwrite / Audius songs (audio + cover) to IndexedDB for offline playback.
- part2.css       Top search bar, safe areas, touch targets, online-search states, offline UI, credit footer.
- scripts/build-web.mjs, scripts/patch-android.mjs   APK build helpers.

CHANGED FILES
- index.html      Search bar moved to the top of the main column (below the header), offline banner,
                  permanent credit footer "Designed and Developed by Shaafi", Lyrics/Artwork label hook.
- js/search.js    Audius search (https://api.audius.co/v1, no key needed) with timeout, abort, retry,
                  60 s result cache, loading / empty / error (Try again) / offline states.
- js/player.js    Media controls + metadata + position state, offline-first playback,
                  auto-resume after a network drop or stall.
- js/library.js   Save-offline button (progress %, tap again to remove), "Offline" pill, no duplicate rows.
- js/storage.js   cacheRemoteTrack() also stores the cover; deleteOfflineCopy().
- js/util.js      Saved cover is used when the device is offline.
- js/fullplayer.js  The Lyrics pill switches to "Artwork" while lyrics are showing.
- script.js       Wires the above, 350 ms search debounce, Enter = search now, auto-retry when back online.
- package.json, capacitor.config.json   Capacitor 6 + media-session plugin, webDir "www".

OPTIONAL AUDIUS KEY
Search works without a key. For higher rate limits, in the app's console or code run:
  localStorage.setItem('soundwave_audius_api_key', 'YOUR_KEY')

BUILD THE APK (Acode terminal or any computer)
 1. npm install
 2. npm run android:add        (first time: builds ./www, adds android/, adds the permissions)
 3. npm run android:sync       (every time you change the web files)
 4. npm run android:open       (Android Studio) -> Build > Build APK(s)

BACKGROUND PLAYBACK - WHAT TO KNOW
- It relies on @jofr/capacitor-media-session, whose README pairs its 4.x version with Capacitor 6.
  That is why package.json uses Capacitor 6 instead of 7. This was NOT tested on a real phone here:
  test it on your device (play, press Home, lock the screen, use the notification buttons).
- Android 13+ asks for the notification permission after the first play. If you deny it,
  the notification controls will not show.
- Some phone brands (Xiaomi, Oppo, Vivo, Samsung power saving) kill background apps.
  If music stops after a while, set SoundWave's battery usage to "Unrestricted".
- In a normal browser, the Web Media Session API is used instead (works in Chrome on Android).

OFFLINE
- Tap the download icon on an Appwrite or Audius song to save it. Tap the green check to remove the copy.
- Saved songs play with no internet. Streaming songs pause and resume by themselves after a drop.
- Audius downloads need Audius to allow the request from the app; if a song fails to save, the error is shown.
