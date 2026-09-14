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
   *   isPlaylist: boolean,
   *   title, thumbnail, durationSeconds, uploader,
   *   qualities: [{ id, label, height, hasAudio, hasVideo, note }],
   *   entries: [ { url, title, thumbnail, durationSeconds } ] // only if playlist
   * }
   */
  async analyze(_url, _ytDlp) {
    throw new Error('Provider must implement analyze');
  }

  /**
   * Returns the yt-dlp format-selector string for a requested quality,
   * with yt-dlp's own "best at or below this size" matching providing
   * automatic fallback when the exact quality isn't available.
   */
  buildFormatSelector(_qualityId, _audioOnly) {
    throw new Error('Provider must implement buildFormatSelector');
  }

  /**
   * Extra provider-specific yt-dlp CLI args (rate limiting, cookies
   * policy, language preferences, etc.). Receives the current app
   * settings so behavior like "prefer original audio" can be toggled.
   */
  extraArgs(_settings) {
    return [];
  }

  /**
   * Returns the yt-dlp args needed to resolve the direct/manifest
   * URL(s) for a format, used for the "save live stream as .m3u8"
   * feature. Default implementation works for any yt-dlp-backed
   * provider; override only if a provider needs special handling.
   */
  buildManifestArgs(url, qualityId) {
    return [url, '-f', this.buildFormatSelector(qualityId, false), '--get-url', '--no-warnings'];
  }
}

module.exports = { BaseProvider };
