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
    return /(^|\.)facebook\.com$/i.test(hostOf(url)) || /^fb\.watch$/i.test(hostOf(url));
  }

  async analyze(url, ytDlpWrap) {
    let raw;
    try {
      raw = await ytDlpWrap.execPromise([url, '--dump-single-json', '--no-warnings']);
    } catch (err) {
      // Facebook frequently requires the viewer to be logged in for
      // private/friends-only/age-restricted posts. MediaDownloader
      // intentionally does not store credentials or inject cookies to
      // get around that — it only works for genuinely public videos.
      if (/login|cookies|private|permission/i.test(err.message || '')) {
        throw new Error(
          'This Facebook video is not publicly accessible (it may require login or be private). ' +
            'MediaDownloader only downloads public, authorized content and cannot bypass login walls.'
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

  buildFormatSelector(qualityId, audioOnly) {
    if (audioOnly) {
      return 'bestaudio/best';
    }
    if (!qualityId || qualityId === 'best') {
      return 'bestvideo*+bestaudio/best';
    }
    const height = parseInt(qualityId, 10);
    if (Number.isNaN(height)) return 'bestvideo*+bestaudio/best';
    return `bestvideo*[height<=${height}]+bestaudio/best[height<=${height}]`;
  }

  extraArgs(settings = {}) {
    const args = ['--no-warnings'];
    if (settings.preferOriginalAudio !== false) {
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

module.exports = { FacebookProvider };
