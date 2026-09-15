'use strict';

const { BaseProvider } = require('./BaseProvider');
const { normalizeAnalysis } = require('./metadataUtils');

class FacebookProvider extends BaseProvider {
  get id() {
    return 'facebook';
  }

  get displayName() {
    return 'Facebook';
  }

  canHandle(url) {
    const host = hostOf(url);
    return /(^|\.)facebook\.com$/i.test(host) || /^fb\.watch$/i.test(host);
  }

  async analyze(url, ytDlpWrap, options = {}) {
    const settings = options.settings || {};
    const run = options.run;
    let raw;
    try {
      raw = await run([url, '--dump-single-json', '--no-playlist', ...this.analyzeArgs(settings)]);
    } catch (err) {
      // Facebook requires a viewer session for private/friends-only or
      // age-restricted posts. This app never stores credentials; the
      // user can optionally point it at their own signed-in browser
      // (Settings -> "Use sign-in from browser") to reach content their
      // own account can already see.
      if (/login|cookies|private|permission|not available/i.test(err.message || '')) {
        throw new Error(
          'This Facebook video is not publicly accessible. If it is visible to your own account, ' +
            'enable "Use sign-in from browser" in Settings. MediaDownloader cannot bypass login walls.'
        );
      }
      throw err;
    }

    const info = JSON.parse(raw);
    const normalized = normalizeAnalysis(info);
    normalized.provider = this.id;
    normalized.sourceUrl = url;
    normalized.isPlaylist = false; // Facebook has no user-facing playlist concept here
    return normalized;
  }

  /** Metadata-extraction args (no download-time format sorting). */
  analyzeArgs(settings = {}) {
    const args = ['--no-warnings', '--ignore-config'];
    if (settings.cookiesFromBrowser && settings.cookiesFromBrowser !== 'none') {
      args.push('--cookies-from-browser', settings.cookiesFromBrowser);
    }
    return args;
  }

  buildFormatSelector(qualityId, audioOnly, { isLive = false } = {}) {
    if (audioOnly) {
      return 'bestaudio/best';
    }

    const height = qualityId && qualityId !== 'best' ? parseInt(qualityId, 10) : null;

    if (isLive) {
      return height && !Number.isNaN(height) ? `best[height<=${height}]/best` : 'best';
    }

    if (!height || Number.isNaN(height)) return 'bestvideo*+bestaudio/best';

    return [
      `bestvideo*[height<=${height}]+bestaudio`,
      `best[height<=${height}]`,
      'bestvideo*+bestaudio',
      'best'
    ].join('/');
  }

  extraArgs(settings = {}) {
    const args = ['--no-warnings'];
    if (settings.preferOriginalAudio !== false) {
      args.push('--format-sort', 'lang');
    }
    if (settings.cookiesFromBrowser && settings.cookiesFromBrowser !== 'none') {
      args.push('--cookies-from-browser', settings.cookiesFromBrowser);
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

module.exports = { FacebookProvider };
