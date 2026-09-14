'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { getLogger } = require('../utils/logger');

const log = getLogger();

/**
 * MediaDownloader does not reimplement YouTube/Facebook extraction
 * itself. It drives the well-known, actively maintained `yt-dlp`
 * command-line tool (MIT licensed) for extraction/downloading, and
 * bundled `ffmpeg` for muxing/converting streams. This keeps the app
 * from having to reverse-engineer streaming sites and lets it inherit
 * yt-dlp's handling of only publicly accessible / authorized content.
 *
 * On first run, if no local yt-dlp binary is bundled, this manager
 * downloads the official release binary from GitHub via yt-dlp-wrap's
 * helper and caches it in the userData folder.
 */
class BinaryManager {
  constructor() {
    this.userDataDir = app.getPath('userData');
    this.binDir = path.join(this.userDataDir, 'bin');
    if (!fs.existsSync(this.binDir)) fs.mkdirSync(this.binDir, { recursive: true });
  }

  get ytDlpPath() {
    const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    return path.join(this.binDir, exe);
  }

  get ffmpegPath() {
    // ffmpeg-static resolves to the correct binary for the current
    // platform/arch and is unpacked next to the app in production
    // builds (see package.json "asarUnpack" equivalent via extraResources).
    try {
      // eslint-disable-next-line global-require
      let ffmpegStatic = require('ffmpeg-static');
      if (ffmpegStatic && ffmpegStatic.includes('app.asar')) {
        ffmpegStatic = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
      }
      return ffmpegStatic;
    } catch (err) {
      log.warn('ffmpeg-static not resolvable, falling back to system ffmpeg on PATH', err);
      return 'ffmpeg';
    }
  }

  async ensureYtDlp(onProgress) {
    if (fs.existsSync(this.ytDlpPath)) return this.ytDlpPath;

    log.info('yt-dlp binary not found locally, downloading latest release...');
    // eslint-disable-next-line global-require
    const YTDlpWrap = require('yt-dlp-wrap').default;
    await YTDlpWrap.downloadFromGithub(this.ytDlpPath, undefined, undefined);
    if (onProgress) onProgress(100);
    if (process.platform !== 'win32') {
      fs.chmodSync(this.ytDlpPath, 0o755);
    }
    log.info(`yt-dlp downloaded to ${this.ytDlpPath}`);
    return this.ytDlpPath;
  }
}

module.exports = { BinaryManager };
