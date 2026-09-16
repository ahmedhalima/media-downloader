'use strict';

const { BaseProvider } = require('./BaseProvider');
const { normalizeAnalysis, summarizeQualities, toEntryMetadata } = require('./metadataUtils');
const { resolveMetadataLanguage } = require('../utils/locale');

// Hard cap on how many playlist entries we'll list. Very large
// playlists otherwise make a single yt-dlp call run for minutes.
const MAX_PLAYLIST_ITEMS = 500;

class YouTubeProvider extends BaseProvider {
  get id() {
    return 'youtube';
  }

  get displayName() {
    return 'YouTube';
  }

  canHandle(url) {
    const host = hostOf(url);
    return /(^|\.)youtube\.com$/i.test(host) || /^youtu\.be$/i.test(host);
  }

  /**
   * A /watch?v=...&list=... URL is a *video being viewed in the
   * context of a playlist*, not a request to download the playlist.
   * Only an explicit /playlist URL (or an explicit caller request) is
   * treated as a playlist.
   */
  isPlaylistUrl(url, forcePlaylist = false) {
    try {
      const u = new URL(url);
      if (/\/playlist/i.test(u.pathname)) return true;
      if (forcePlaylist && u.searchParams.has('list')) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  async analyze(url, ytDlpWrap, options = {}) {
    const settings = options.settings || {};
    const run = options.run; // injected runner that captures stderr

    if (this.isPlaylistUrl(url, options.forcePlaylist)) {
      return this._analyzePlaylist(url, run, settings);
    }
    return this._analyzeSingle(url, run, settings);
  }

  async _analyzeSingle(url, run, settings) {
    const raw = await run([
      url,
      '--dump-single-json',
      '--no-playlist',
      ...this.analyzeArgs(settings)
    ]);

    const info = JSON.parse(raw);
    const normalized = normalizeAnalysis(info);
    normalized.provider = this.id;
    normalized.sourceUrl = url;
    normalized.playlistAvailable = /[?&]list=/.test(url);
    return normalized;
  }

  /**
   * Playlists are analyzed in two cheap stages instead of one
   * expensive call.
   *
   * Asking for --dump-single-json on a playlist WITHOUT
   * --flat-playlist makes yt-dlp fully resolve every single video
   * (formats, signatures, the lot). On a playlist of any real size
   * that takes minutes and frequently fails outright — which is what
   * produced the "Command failed" error.
   *
   * Stage 1 lists entries flat (fast, one request).
   * Stage 2 resolves formats for just the FIRST entry, which is
   * enough to populate the quality dropdown. Per-video fallback at
   * download time handles any entry whose formats differ.
   */
  async _analyzePlaylist(url, run, settings) {
    const listRaw = await run([
      url,
      '--dump-single-json',
      '--flat-playlist',
      '--yes-playlist',
      '--playlist-items',
      `1-${MAX_PLAYLIST_ITEMS}`,
      ...this.analyzeArgs(settings)
    ]);

    const info = JSON.parse(listRaw);
    const rawEntries = Array.isArray(info.entries) ? info.entries.filter(Boolean) : [];

    if (!rawEntries.length) {
      throw new Error(
        'This playlist appears to be empty, private, or unavailable. Public playlists only.'
      );
    }

    const entries = rawEntries.map((e, i) => {
      const meta = toEntryMetadata(e);
      // Flat entries sometimes carry only an id; rebuild a usable URL.
      if (!meta.url || !/^https?:/i.test(meta.url)) {
        meta.url = `https://www.youtube.com/watch?v=${e.id}`;
      }
      meta.index = i + 1; // 1-based position shown in the UI
      return meta;
    });

    // Stage 2: qualities from the first entry only. A failure here is
    // non-fatal — we fall back to the standard ladder so the user can
    // still queue the playlist.
    let qualities;
    try {
      const probeRaw = await run([
        entries[0].url,
        '--dump-single-json',
        '--no-playlist',
        ...this.analyzeArgs(settings)
      ]);
      qualities = summarizeQualities(JSON.parse(probeRaw).formats || []);
    } catch (_) {
      qualities = summarizeQualities([]);
    }

    return {
      isPlaylist: true,
      isLive: false,
      provider: this.id,
      sourceUrl: url,
      title: info.title || 'Untitled playlist',
      thumbnail: entries[0].thumbnail || null,
      uploader: info.uploader || info.channel || null,
      entryCount: entries.length,
      truncated: entries.length >= MAX_PLAYLIST_ITEMS,
      entries,
      qualities
    };
  }

  buildFormatSelector(qualityId, audioOnly, { isLive = false } = {}) {
    if (audioOnly) {
      return 'bestaudio/best';
    }

    const height = qualityId && qualityId !== 'best' ? parseInt(qualityId, 10) : null;

    if (isLive) {
      // Live broadcasts are served as HLS and almost always only
      // expose already-muxed video+audio variants — there is usually
      // no separate audio-only stream to pair with `bestvideo`.
      // Demanding a bestvideo+bestaudio merge here is exactly what
      // produced "Requested format is not available" for live
      // videos, so live downloads use a merge-free selector instead.
      return height && !Number.isNaN(height) ? `best[height<=${height}]/best` : 'best';
    }

    if (!height || Number.isNaN(height)) return 'bestvideo*+bestaudio/best';

    // Fallback chain, widest-to-narrowest. The trailing bare `best`
    // prevents "Requested format is not available" when a video has
    // no stream at or below the requested height.
    return [
      `bestvideo*[height<=${height}]+bestaudio`,
      `best[height<=${height}]`,
      'bestvideo*+bestaudio',
      'best'
    ].join('/');
  }

  /**
   * Args safe for metadata extraction. Notably this omits
   * --format-sort, which is a download-time concern and only adds a
   * failure surface to a JSON dump.
   */
  analyzeArgs(settings = {}) {
    return ['--no-warnings', '--ignore-config', ...this.metadataLangArgs(settings)];
  }

  /**
   * `--extractor-args "youtube:lang=XX"` tells YouTube which language
   * to serve translated metadata in when a translation exists. Left
   * unset, YouTube's response effectively defaults to English titles
   * for videos that have an English auto-translation available — which
   * is why an Arabic video's title could show in English here even
   * though the actual video stream (and its filename on disk) is
   * unaffected. Requesting the video's own language is what makes
   * YouTube hand back the un-translated original title, and using the
   * SAME language for analyze and download keeps the title shown in
   * the app and the one baked into the filename consistent with each
   * other.
   */
  metadataLangArgs(settings = {}) {
    // eslint-disable-next-line global-require
    const { app } = require('electron');
    const lang = resolveMetadataLanguage(settings.metadataLanguage, app.getLocale());
    return lang ? ['--extractor-args', `youtube:lang=${lang}`] : [];
  }

  extraArgs(settings = {}) {
    const args = ['--no-warnings', ...this.metadataLangArgs(settings)];

    if (settings.preferOriginalAudio !== false) {
      // YouTube auto-dubs many videos. Sorting on "lang" (and never
      // requesting a specific dub) makes yt-dlp prefer the original.
      args.push('--format-sort', 'lang');
    }

    return args;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return '';
  }
}

module.exports = { YouTubeProvider, MAX_PLAYLIST_ITEMS };
