# MediaDownloader

A Windows desktop app (Electron) for downloading **authorized/public** videos
from YouTube and Facebook, with quality selection, a real download queue,
history, and a provider architecture so more platforms can be added later.

> **Use responsibly.** MediaDownloader only downloads content that is
> genuinely public and does not require signing in. It never stores
> passwords, injects cookies, or attempts to bypass login walls, paywalls,
> or age/region restrictions. You are responsible for complying with the
> terms of service of any site you use this with and with applicable
> copyright law in your jurisdiction — only download videos you own, have
> permission for, or that are explicitly licensed for download/reuse.

## How it works under the hood

Rather than reverse-engineering YouTube/Facebook's private APIs (fragile
and against most platforms' terms), MediaDownloader drives two well-known,
actively maintained open-source tools as its engine:

- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — extraction and downloading.
  The app downloads the official yt-dlp binary on first run and calls it via
  the `yt-dlp-wrap` Node wrapper.
- **[ffmpeg](https://ffmpeg.org/)** (via `ffmpeg-static`) — merges separate
  video/audio streams and handles audio-only conversion.

This is the same architecture used by most reputable GUI downloaders. All
the "smarts" described below (quality fallback, provider routing, queueing)
are MediaDownloader's own code, orchestrating these two engines.

## Features

- Paste a YouTube or Facebook link → see title, thumbnail, duration, and
  available qualities before downloading.
- Individual videos **and** full YouTube playlists (pick which entries to
  queue).
- Quality picker (Best, 2160p, 1440p, 1080p, 720p, 480p, 360p, …) with
  automatic fallback to the next best available resolution.
- Video+audio or audio-only downloads (M4A/MP3/Opus/WAV).
- **Original audio only** — when a video has auto-dubbed audio tracks,
  MediaDownloader is configured (by default, toggleable in Settings) to
  keep the original spoken-language track instead of a dub.
- **Live streams** — analyze a live YouTube/Facebook stream and either
  record it normally, or resolve and save its HLS manifest as a `.m3u8`
  file for use with your own player/pipeline.
- Download queue: progress, pause/resume, cancel, retry, and a
  configurable concurrent-download limit.
- Automatic folder organization (by platform) + fully customizable
  filename templates (`{title}`, `{uploader}`, `{quality}`, `{playlist}`,
  `{playlist_index}`, `{id}`, `{date}`).
- Download history with duplicate detection (won't silently re-download
  the same video/quality twice without confirming).
- Desktop notifications, system tray (minimize/close to tray, quick
  status).
- Provider-based architecture (`src/main/providers/`) — add a new
  platform by implementing `BaseProvider` and registering it in
  `ProviderManager`.

## Project layout

```
src/
  main/                     Electron main process
    main.js                 App bootstrap, window, lifecycle
    preload.js               Secure IPC bridge (contextBridge)
    core/
      SettingsStore.js       Persisted user settings
      HistoryStore.js        Persisted download history + dedupe
      BinaryManager.js       Locates/downloads yt-dlp + ffmpeg
      ProviderManager.js     Routes a URL to the right provider
      DownloadManager.js     Queue engine: start/pause/resume/cancel/retry
      TrayManager.js         System tray icon + menu
    providers/
      BaseProvider.js        Provider contract
      metadataUtils.js       Shared yt-dlp JSON → UI metadata mapping
      YouTubeProvider.js
      FacebookProvider.js
    utils/
      filenameTemplate.js    {placeholder} → yt-dlp output template
      urlValidator.js
      logger.js
    ipc/
      handlers.js            All ipcMain.handle(...) wiring
  renderer/                  UI (plain HTML/CSS/JS, no bundler needed)
    index.html
    styles/main.css
    js/app.js, api.js
assets/                      App + tray icons
```

## Getting started

Requirements: Node.js 18+, npm, Windows (target platform; also runs on
macOS/Linux for development since Electron is cross-platform).

```bash
npm install
npm start
```

On first run the app downloads the `yt-dlp` binary into your user data
folder (an internet connection is required for this one-time step).
`ffmpeg` is bundled automatically via the `ffmpeg-static` dependency.

### Building a Windows installer

```bash
npm run dist
```

This uses `electron-builder` to produce an NSIS installer in `dist/`.
Replace `assets/icon.ico` with your own branding before shipping.

## Playlists

Playlist links (`youtube.com/playlist?list=...`) show a numbered,
checkbox list of entries so you can pick exactly what to queue. A
`watch?v=...&list=...` link is treated as a **single video**, since
that's a video being viewed in a playlist's context rather than a
request for the whole playlist.

Playlists are analyzed in two cheap stages rather than one expensive
call: a flat listing of entries first, then a format probe of the first
entry to populate the quality dropdown. Asking yt-dlp to fully resolve
every video up front takes minutes on a large playlist and frequently
fails outright.

Numbering flows all the way through: entries are numbered in the
picker, queued rows show `07/24 · Title`, and files on disk are
numbered too — the default filename template is
`{playlist}/{playlist_index} - {title}`, zero-padded to the playlist's
width (`007` in a 120-item playlist) so they sort correctly in a file
manager. Even if you've customized the template and dropped
`{playlist_index}` from it, playlist downloads still get the number
prepended to the filename automatically — a single video is never
affected.

Listing is capped at 500 entries; the picker says so when a playlist is
longer.

## History

History has its own page (the clock icon in the toolbar, next to
Settings) rather than sharing the downloads list — a full download log
doesn't belong mixed in with active/queued items. It supports deleting
individual entries or clearing everything, without touching the files
already saved to disk.

Queueing a playlist that includes videos you've already downloaded in
the same quality no longer fails outright: those entries are skipped
with a toast telling you how many, and the rest still queue normally.

## No browser sign-in / cookies

MediaDownloader deliberately does not offer a "sign in with your
browser" option. An earlier version did (passing yt-dlp
`--cookies-from-browser`), but Chromium-based browsers lock their
cookie database while running — and on Windows additionally encrypt it
with DPAPI — so reading it reliably failed unless the browser was
fully closed first. That made an optional, rarely-needed feature (only
relevant for private/members-only content) a recurring point of
failure for downloading ordinary public videos, which is the vast
majority of what this app is for. It's been removed rather than
patched further; the app only downloads public, unauthenticated
content, matching the "no bypassing access restrictions" principle
this project follows anyway.

## Notes on the "original audio" and "live → .m3u8" features

- **Original audio**: YouTube can offer a video with multiple dubbed audio
  tracks. MediaDownloader passes `--format-sort lang` to yt-dlp and never
  requests a specific dub via `--extractor-args`, which makes yt-dlp prefer
  the original-language track when multiple tracks are otherwise
  comparable in quality. This is controlled by the **"Original audio
  only"** toggle in Settings (on by default).
- **Live → .m3u8**: for a video flagged as live by the source site,
  MediaDownloader resolves the underlying HLS manifest URL (via
  `yt-dlp --get-url`) and saves its contents locally as a `.m3u8` file,
  instead of recording the stream to a single video file. It requests a
  **muxed** format for this, so the saved manifest carries video *and*
  audio — a `bestvideo+bestaudio` selector would print two separate URLs
  and saving only the first produced a silent stream. If a resolved
  manifest still advertises no audio track, the app flags it in the
  list rather than handing over a mute file. This only works for public
  live streams the app can already reach, and does not circumvent any
  access restriction.

## Filename templates

The default template is `{playlist}/{title}`. Quality is deliberately
**not** in the default filename: after automatic fallback, the delivered
resolution often differs from the requested one, so baking it in is
misleading. You can still add `{quality}` yourself if you want it.

Optional fields (`{playlist}`, `{playlist_index}`, `{quality}`,
`{date}`, `{year}`) render as empty rather than the literal `NA` when
they don't apply, and path segments that collapse to nothing are
dropped — so downloading a single video no longer creates a stray `NA`
folder.

## Speed and reliability

yt-dlp has no connection timeout by default — a stalled or slow-to-
respond connection can hang indefinitely with no error, which is what
made analyzing a video feel like it never finished. MediaDownloader now
sets an explicit socket timeout (15s for analyze, 20s for downloads)
so a stuck connection fails fast and can be retried, instead of sitting
there silently.

Downloads also fetch fragments (YouTube delivers video in segments)
four at a time in parallel instead of one at a time, and retry
individual failed fragments up to 10 times rather than failing the
whole download over one bad segment — both faster and less prone to
failing outright on an imperfect connection.

## Download engine

Downloads run through a direct, self-managed yt-dlp process rather than
a third-party wrapper library, for reasons that turned out to matter in
practice:

- **Real progress, redundantly.** A custom `--progress-template` prints
  one unambiguous line per update, parsed directly — no relying on a
  wrapper's regex against yt-dlp's default progress bar (which could
  silently produce no progress at all). As a safety net, yt-dlp's own
  standard `[download] 45.2% of 10.00MiB at 1.20MiB/s ETA 00:07` format
  is *also* parsed independently, so progress still shows even if one
  parsing path ever mismatches a yt-dlp version's exact field names.
- **A real Cancel/Pause.** Stopping a download kills the *whole*
  process tree (`taskkill /t /f` on Windows), not just the yt-dlp
  process — it spawns ffmpeg as a child for merging, and killing only
  the parent left that ffmpeg process running in the background.
- **File-path recovery.** The filename yt-dlp reports back isn't always
  the one that ends up on disk (a possible source of "file not found"
  when opening a completed download). If the reported path doesn't
  exist, MediaDownloader falls back to the most recently created media
  file in the download folder from that download attempt.

## Live videos

Live broadcasts are served as HLS and almost always only expose
already-muxed video+audio variants — there's usually no separate
audio-only stream to pair with a video-only one. The normal
`bestvideo+bestaudio` selector demanding that pairing is what produced
"Requested format is not available" for live videos specifically; live
downloads use a simpler, merge-free selector instead.

If a live stream's format still can't be matched even with that
simpler selector, MediaDownloader retries once more with no format
constraint at all — letting yt-dlp pick automatically — rather than
failing outright. A toast explains when this happens.

## Resuming after closing the app

If downloads were still queued, downloading, or paused when the app
last closed, it asks whether to resume them on the next launch. Under
the hood: on quit, any in-progress yt-dlp process is stopped (so
nothing keeps running orphaned in the background once the window and
tray icon are gone) but its partial `.part` file is left on disk;
resuming re-queues the same download to the same filename, and yt-dlp
picks up from where it left off rather than starting over.

## Right-click menus

The URL field and every queue/history row have a native right-click
menu (cut/copy/paste on the field; Copy Video Link — and Show in
Folder / Open File / Copy File Path once one exists — on a row).

## Clearing finished downloads

"Clear completed" only removes successfully completed and cancelled
entries. Failed downloads are left in place on purpose, since a failed
download is something to retry or investigate, not routine cleanup —
losing it on the next "clear" click would just discard the error
message you needed to see.

## Titles showing in the wrong language

YouTube can auto-translate a video's title/description server-side for
viewers based on a language hint sent with each request. Left unset,
that hint effectively defaults to English, so a video whose real title
is Arabic (or any non-English language) could display in English here
— while the downloaded *file* still used its correct original name,
since that's written by a separate part of yt-dlp.

Settings → **Title language** fixes this by sending that hint
explicitly and using the same value for both analyzing and downloading,
so the title shown in the app and the one in the filename always match.
**Automatic** (the default) matches this PC's Windows display language;
you can also pick a specific language if you're downloading content in
a language different from your system's.

## Application menu

The menu bar is intentionally minimal: **File** (paste/analyze, open
downloads folder, settings, quit), **Downloads** (pause/resume all,
clear completed), and **Help**. There's no separate Edit or View menu
— cut/copy/paste on the URL field works via its right-click menu, and
there's nothing else in the app that needs zooming or dev tools in
normal use.

## Security & privacy

- Renderer runs with `contextIsolation: true`, `nodeIntegration: false`,
  and `sandbox: true`; all privileged work happens in the main process and
  is exposed to the UI only through a narrow `contextBridge` API
  (`src/main/preload.js`).
- No user accounts, passwords, or cookies are collected, stored, or
  injected anywhere in the app.
- Settings and history are stored locally (via `electron-store`) in your
  Windows user profile — nothing is sent to a remote server.

## Known limitations

- "Pause" works by stopping and later restarting the yt-dlp process for
  that task; yt-dlp resumes the partial file itself (via `.part` files),
  so this is a true pause/resume rather than starting over, but very
  brief in-flight segments can occasionally need to be re-fetched.
- Facebook videos that require login (private, friends-only, or
  age-restricted posts) will fail analysis with a clear error —
  by design, MediaDownloader does not attempt to log in or bypass this.
