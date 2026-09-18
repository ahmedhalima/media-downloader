'use strict';

/**
 * Contract every platform provider must implement. Adding a new site
 * (Vimeo, SoundCloud, etc.) means dropping in a new subclass here and
 * registering it in ProviderManager — nothing else in the app needs
 * to change.
 */
class BaseProvider {
  /** Unique lowercase id, e.g. 'youtube'. */
  get id() {
    throw new Error('Provider must implement id');
  }

  /** Human readable name shown in the UI. */
  get displayName() {
    throw new Error('Provider must implement displayName');
  }

  /** @param {string} url */
  canHandle(_url) {
    throw new Error('Provider must implement canHandle');
  }

  /**
   * Returns normalized metadata:
   * {
   *   isPlaylist, isLive, title, thumbnail, durationSeconds, uploader,
   *   qualities: [{ id, label, height, hasAudio, hasVideo, note }],
   *   entries: [ { url, title, thumbnail, durationSeconds } ] // playlists only
   * }
   */
  async analyze(_url, _ytDlp, _options) {
    throw new Error('Provider must implement analyze');
  }

  /**
   * Returns the yt-dlp format-selector string for a requested quality.
   * Implementations must end their selector chain with a permissive
   * fallback so a request never dies with "Requested format is not
   * available" when an exact match is missing. `opts.isLive` lets a
   * provider use a simpler, merge-free selector for live streams,
   * which almost always only expose already-muxed HLS variants —
   * demanding a separate bestvideo+bestaudio pair for those is what
   * causes live downloads to fail with that exact error.
   */
  buildFormatSelector(_qualityId, _audioOnly, _opts = {}) {
    throw new Error('Provider must implement buildFormatSelector');
  }

  /** Extra provider-specific yt-dlp CLI args. Receives app settings. */
  extraArgs(_settings) {
    return [];
  }

  /**
   * Network flags shared by analyze and download. yt-dlp has NO
   * connection timeout by default — a stalled or slow-to-respond
   * connection can hang indefinitely with no error and no way to tell
   * it's stuck, which is what made "analyzing" feel like it never
   * finished. A socket timeout turns a silent hang into a fast,
   * retryable failure instead.
   */
  networkArgs({ forDownload = false } = {}) {
    return forDownload
      ? [
          '--socket-timeout', '20',
          '--retries', '10',
          // Fragment-level retries matter more than whole-file retries
          // for YouTube's segmented (DASH/HLS) delivery — one bad
          // segment shouldn't fail the entire download.
          '--fragment-retries', '10',
          // Fetches multiple fragments in parallel instead of one at a
          // time, which is both faster and less likely to have the
          // whole download stall on a single slow segment.
          '--concurrent-fragments', '4'
        ]
      : [
          // Analyze is a quick metadata read — fail fast rather than
          // hang, since the user is actively waiting on this one.
          '--socket-timeout', '15',
          '--retries', '3'
        ];
  }

  /**
   * Args used to resolve a live stream's HLS manifest URL for the
   * "save as .m3u8" feature.
   *
   * This deliberately requests a *muxed* format rather than the
   * usual bestvideo+bestaudio pair. With --get-url, a split selector
   * prints two separate URLs (one video-only, one audio-only), and
   * saving just the first yields a silent stream — which is exactly
   * the "m3u8 without audio" bug. Asking for a combined format
   * returns a single manifest that already carries both tracks.
   */
  buildManifestArgs(url, qualityId, settings = {}) {
    const height = parseInt(qualityId, 10);
    const selector = Number.isNaN(height)
      ? 'best[protocol^=m3u8]/best'
      : `best[height<=${height}][protocol^=m3u8]/best[height<=${height}]/best`;
    return [url, '-f', selector, '--get-url', ...this.extraArgs(settings)];
  }
}

module.exports = { BaseProvider };
