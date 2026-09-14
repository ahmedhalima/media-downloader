'use strict';

const { BaseProvider } = require('./BaseProvider');
const { normalizeAnalysis } = require('./metadataUtils');

class YouTubeProvider extends BaseProvider {
  get id() {
    return 'youtube';
  }

  get displayName() {
    return 'YouTube';
  }

  canHandle(url) {
    return /(^|\.)youtube\.com$/i.test(hostOf(url)) || /^youtu\.be$/i.test(hostOf(url));
  }

  async analyze(url, ytDlpWrap) {
    // --dump-single-json gives one JSON object for a video, or one
    // object with an "entries" array for a playlist — no extra
    // branching needed for individual vs. playlist URLs.
    const raw = await ytDlpWrap.execPromise([
      url,
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist-reload',
      '--flat-playlist',
      '--playlist-items',
      '1-500'
    ]);
    const info = JSON.parse(raw);
    const normalized = normalizeAnalysis(info);
    normalized.provider = this.id;
    normalized.sourceUrl = url;
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
    // height<=N lets yt-dlp automatically fall back to the next best
    // resolution at or below the requested one when an exact match
    // isn't available.
    return `bestvideo*[height<=${height}]+bestaudio/best[height<=${height}]`;
  }

  extraArgs(settings = {}) {
    const args = ['--no-warnings'];
    if (settings.preferOriginalAudio !== false) {
      // YouTube auto-dubs many videos into other languages. Formats
      // for the original track carry the highest "language
      // preference" score internally; sorting on "lang" (and
      // deliberately never passing --extractor-args youtube:lang=...,
      // which would request a specific dub) makes yt-dlp pick that
      // original track instead of a same-bitrate dubbed one.
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

module.exports = { YouTubeProvider };
