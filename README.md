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

## Notes on the "original audio" and "live → .m3u8" features

- **Original audio**: YouTube can offer a video with multiple dubbed audio
  tracks. MediaDownloader passes `--format-sort lang` to yt-dlp and never
  requests a specific dub via `--extractor-args`, which makes yt-dlp prefer
  the original-language track when multiple tracks are otherwise
  comparable in quality. This is controlled by the **"Original audio
  only"** toggle in Settings (on by default).
- **Live → .m3u8**: for a video flagged as live by the source site,
  MediaDownloader can resolve the underlying HLS manifest URL (via
  `yt-dlp --get-url`) and save its contents locally as a `.m3u8` file,
  instead of recording the stream to a single video file. This only works
  for public live streams the app can already reach, and does not attempt
  to circumvent any access restriction.

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
