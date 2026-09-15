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
   * available" when an exact match is missing.
   */
  buildFormatSelector(_qualityId, _audioOnly) {
    throw new Error('Provider must implement buildFormatSelector');
  }

  /** Extra provider-specific yt-dlp CLI args. Receives app settings. */
  extraArgs(_settings) {
    return [];
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
