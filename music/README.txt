SONGS THAT SHIP WITH YOUR WEBSITE (optional)
============================================

The "Import" button saves songs inside the visitor's own browser, so only
the person who imported them can hear them.

If you want EVERY visitor of your deployed website to hear some songs:

1. Copy your audio files into this "music" folder (same place as this file).
2. List them in tracks.json like this (title / artist / album / cover are optional):

[
  { "src": "music/Song One.mp3", "title": "Song One", "artist": "Artist Name", "album": "My Album" },
  { "src": "music/another-song.mp3" }
]

If title/artist are missing, SoundWave reads them from the file name
("Artist - Title.mp3" works nicely).

Keep the audio files on the SAME website as index.html (same domain),
otherwise the visualizer and playback can be blocked by the browser.
