'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');
const { v4: uuid } = require('uuid');
const { getLogger } = require('../utils/logger');
const { buildOutputPath } = require('../utils/filenameTemplate');

const log = getLogger();

const STATUS = Object.freeze({
  QUEUED: 'queued',
  DOWNLOADING: 'downloading',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  ERROR: 'error',
  CANCELED: 'canceled'
});

/**
 * Owns the entire download queue: turning a requested item into a
 * yt-dlp invocation, tracking progress, and enforcing the concurrent
 * download limit. Emits 'task:update' any time a task's state changes
 * so the renderer (via IPC) can reflect it live.
 *
 * Pause/resume works by stopping and restarting the underlying yt-dlp
 * process: yt-dlp writes partial downloads to a `.part` file and
 * resumes from where it left off by default (HTTP range requests), so
 * killing and re-launching the same command is a faithful pause/resume
 * rather than starting over.
 */
class DownloadManager extends EventEmitter {
  constructor({ ytDlpWrap, ffmpegPath, settingsStore, historyStore, providerManager }) {
    super();
    this.ytDlpWrap = ytDlpWrap;
    this.ffmpegPath = ffmpegPath;
    this.settingsStore = settingsStore;
    this.historyStore = historyStore;
    this.providerManager = providerManager;

    /** @type {Map<string, object>} */
    this.tasks = new Map();
    this.activeCount = 0;
  }

  getAll() {
    return Array.from(this.tasks.values()).map(this._publicView);
  }

  _publicView(task) {
    // Strip internal-only fields (process handles, raw args) before
    // sending to the renderer over IPC.
    const { process: _p, ytArgs: _a, ...rest } = task;
    return rest;
  }

  _emitUpdate(task) {
    this.emit('task:update', this._publicView(task));
  }

  /**
   * @param {object} input { url, provider, title, thumbnail, durationSeconds,
   *   qualityId, audioOnly, sourceId (video id from analyze, for dedupe) }
   */
  enqueue(input) {
    const settings = this.settingsStore.getAll();

    const duplicate = this.historyStore.findDuplicate(input.url, input.qualityId, input.audioOnly);
    if (duplicate && !input.allowDuplicate) {
      const err = new Error('DUPLICATE');
      err.code = 'DUPLICATE';
      err.existing = duplicate;
      throw err;
    }

    const task = {
      id: uuid(),
      url: input.url,
      title: input.title || input.url,
      thumbnail: input.thumbnail || null,
      durationSeconds: input.durationSeconds || null,
      provider: input.provider,
      qualityId: input.qualityId || settings.defaultQuality,
      audioOnly: !!input.audioOnly,
      status: STATUS.QUEUED,
      progressPercent: 0,
      speed: null,
      eta: null,
      totalSizeText: null,
      retries: 0,
      maxRetries: settings.maxRetries,
      filePath: null,
      error: null,
      createdAt: Date.now(),
      process: null
    };

    this.tasks.set(task.id, task);
    this._emitUpdate(task);
    this._tryStartNext();
    return this._publicView(task);
  }

  /**
   * Instead of downloading/remuxing the stream, resolve the live
   * broadcast's HLS manifest and save it locally as a .m3u8 file (for
   * users who want to hand the manifest to their own player/tooling
   * rather than record the stream to a single video file). Only
   * works for genuinely public live streams the chosen provider can
   * already reach.
   */
  enqueueLiveManifest(input) {
    const task = {
      id: uuid(),
      url: input.url,
      title: input.title || input.url,
      thumbnail: input.thumbnail || null,
      durationSeconds: null,
      provider: input.provider,
      qualityId: input.qualityId || 'best',
      audioOnly: false,
      mode: 'm3u8',
      status: STATUS.QUEUED,
      progressPercent: 0,
      speed: null,
      eta: null,
      totalSizeText: null,
      retries: 0,
      maxRetries: this.settingsStore.get('maxRetries'),
      filePath: null,
      error: null,
      createdAt: Date.now(),
      process: null
    };
    this.tasks.set(task.id, task);
    this._emitUpdate(task);
    this._tryStartNext();
    return this._publicView(task);
  }

  enqueuePlaylist(entries, shared) {
    return entries.map((entry) =>
      this.enqueue({
        ...shared,
        url: entry.url,
        title: entry.title,
        thumbnail: entry.thumbnail,
        durationSeconds: entry.durationSeconds
      })
    );
  }

  _tryStartNext() {
    const limit = this.settingsStore.get('maxConcurrentDownloads') || 3;
    if (this.activeCount >= limit) return;

    const next = Array.from(this.tasks.values()).find((t) => t.status === STATUS.QUEUED);
    if (!next) return;

    this.activeCount += 1;
    const runner = next.mode === 'm3u8' ? this._startManifest(next) : this._start(next);
    runner.finally(() => {
      this.activeCount -= 1;
      this._tryStartNext();
    });
  }

  async _startManifest(task) {
    task.status = STATUS.DOWNLOADING;
    task.error = null;
    this._emitUpdate(task);

    const provider = this.providerManager.resolve(task.url);
    if (!provider) {
      task.status = STATUS.ERROR;
      task.error = 'No provider can handle this URL';
      this._emitUpdate(task);
      return;
    }

    try {
      const settings = this.settingsStore.getAll();
      const raw = await this.ytDlpWrap.execPromise(provider.buildManifestArgs(task.url, task.qualityId));
      const manifestUrl = raw
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .find((l) => l.startsWith('http'));

      if (!manifestUrl) {
        throw new Error('Could not resolve a live manifest URL for this video.');
      }

      task.progressPercent = 50;
      this._emitUpdate(task);

      const manifestText = await fetchText(manifestUrl);
      if (!/^#EXTM3U/m.test(manifestText)) {
        throw new Error('The resolved stream is not an HLS (.m3u8) manifest.');
      }

      const downloadRoot = settings.organizeByProvider
        ? path.join(settings.downloadFolder, capitalize(provider.id), 'Live')
        : path.join(settings.downloadFolder, 'Live');
      fs.mkdirSync(downloadRoot, { recursive: true });

      const safeTitle = sanitizeFilename(task.title) || task.id;
      const filePath = path.join(downloadRoot, `${safeTitle}.m3u8`);
      fs.writeFileSync(filePath, manifestText, 'utf8');

      task.filePath = filePath;
      task.progressPercent = 100;
      task.status = STATUS.COMPLETED;
      this._emitUpdate(task);
      this._recordHistory(task, provider);
      this.emit('task:completed', this._publicView(task));
    } catch (err) {
      log.error(`Live manifest download failed for ${task.url}`, err);
      task.status = STATUS.ERROR;
      task.error = humanizeError(err);
      this._emitUpdate(task);
      this.emit('task:error', this._publicView(task));
    }
  }

  async _start(task) {
    task.status = STATUS.DOWNLOADING;
    task.error = null;
    this._emitUpdate(task);

    const provider = this.providerManager.resolve(task.url);
    if (!provider) {
      task.status = STATUS.ERROR;
      task.error = 'No provider can handle this URL';
      this._emitUpdate(task);
      return;
    }

    const settings = this.settingsStore.getAll();
    const downloadRoot = settings.organizeByProvider
      ? path.join(settings.downloadFolder, capitalize(provider.id))
      : settings.downloadFolder;
    fs.mkdirSync(downloadRoot, { recursive: true });

    const outputTemplate = buildOutputPath(downloadRoot, settings.filenameTemplate);
    const formatSelector = provider.buildFormatSelector(task.qualityId, task.audioOnly);

    const args = [
      task.url,
      '-f', formatSelector,
      '-o', outputTemplate,
      '--ffmpeg-location', this.ffmpegPath,
      '--newline',
      '--no-mtime',
      '--print', 'after_move:MEDIADL_FILEPATH:%(filepath)s',
      ...(task.audioOnly ? ['-x', '--audio-format', settings.preferredAudioFormat] : []),
      ...(!task.audioOnly ? ['--merge-output-format', 'mp4'] : []),
      ...provider.extraArgs(settings)
    ];
    task.ytArgs = args;

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      try {
        const emitter = this.ytDlpWrap.exec(args);
        task.process = emitter;

        emitter.on('progress', (p) => {
          if (task.status !== STATUS.DOWNLOADING) return;
          task.progressPercent = clamp(p.percent, 0, 100);
          task.speed = p.currentSpeed || null;
          task.eta = p.eta || null;
          task.totalSizeText = p.totalSize || null;
          this._emitUpdate(task);
        });

        emitter.on('ytDlpEvent', (eventType, eventData) => {
          if (typeof eventData === 'string' && eventData.includes('MEDIADL_FILEPATH:')) {
            task.filePath = eventData.split('MEDIADL_FILEPATH:')[1].trim();
          }
        });

        emitter.on('error', (err) => {
          log.error(`Download error for ${task.url}`, err);
          if (task.status === STATUS.PAUSED || task.status === STATUS.CANCELED) {
            // Expected: we killed the process ourselves.
            finish();
            return;
          }
          task.status = STATUS.ERROR;
          task.error = humanizeError(err);
          this._emitUpdate(task);
          this.emit('task:error', this._publicView(task));
          finish();
        });

        emitter.on('close', (code) => {
          if (task.status === STATUS.PAUSED || task.status === STATUS.CANCELED) {
            finish();
            return;
          }
          if (code === 0 || code === null) {
            task.status = STATUS.COMPLETED;
            task.progressPercent = 100;
            this._emitUpdate(task);
            this._recordHistory(task, provider);
            this.emit('task:completed', this._publicView(task));
          } else if (task.status !== STATUS.COMPLETED) {
            task.status = STATUS.ERROR;
            task.error = task.error || `yt-dlp exited with code ${code}`;
            this._emitUpdate(task);
            this.emit('task:error', this._publicView(task));
          }
          finish();
        });
      } catch (err) {
        task.status = STATUS.ERROR;
        task.error = humanizeError(err);
        this._emitUpdate(task);
        finish();
      }
    });
  }

  _recordHistory(task, provider) {
    let fileSizeBytes = null;
    try {
      if (task.filePath && fs.existsSync(task.filePath)) {
        fileSizeBytes = fs.statSync(task.filePath).size;
      }
    } catch (_) {
      /* ignore */
    }
    this.historyStore.add({
      id: task.id,
      title: task.title,
      url: task.url,
      provider: provider.id,
      quality: task.qualityId,
      audioOnly: task.audioOnly,
      filePath: task.filePath,
      fileSizeBytes,
      thumbnail: task.thumbnail
    });
  }

  pause(id) {
    const task = this.tasks.get(id);
    if (!task || task.status !== STATUS.DOWNLOADING) return this._publicView(task);
    task.status = STATUS.PAUSED;
    this._killProcess(task);
    this._emitUpdate(task);
    this.activeCount = Math.max(0, this.activeCount - 1);
    this._tryStartNext();
    return this._publicView(task);
  }

  resume(id) {
    const task = this.tasks.get(id);
    if (!task || task.status !== STATUS.PAUSED) return this._publicView(task);
    task.status = STATUS.QUEUED;
    this._emitUpdate(task);
    this._tryStartNext();
    return this._publicView(task);
  }

  cancel(id) {
    const task = this.tasks.get(id);
    if (!task) return null;
    const wasActive = task.status === STATUS.DOWNLOADING;
    task.status = STATUS.CANCELED;
    this._killProcess(task);
    this._emitUpdate(task);
    if (wasActive) {
      this.activeCount = Math.max(0, this.activeCount - 1);
      this._tryStartNext();
    }
    if (this.settingsStore.get('deletePartialOnCancel')) {
      this._cleanupPartialFiles(task);
    }
    return this._publicView(task);
  }

  retry(id) {
    const task = this.tasks.get(id);
    if (!task) return null;
    if (task.retries >= task.maxRetries) {
      task.error = 'Max retries reached';
      this._emitUpdate(task);
      return this._publicView(task);
    }
    task.retries += 1;
    task.status = STATUS.QUEUED;
    task.error = null;
    task.progressPercent = 0;
    this._emitUpdate(task);
    this._tryStartNext();
    return this._publicView(task);
  }

  remove(id) {
    const task = this.tasks.get(id);
    if (task && task.status === STATUS.DOWNLOADING) this.cancel(id);
    this.tasks.delete(id);
    this.emit('task:removed', id);
  }

  _killProcess(task) {
    try {
      if (task.process && task.process.ytDlpProcess && !task.process.ytDlpProcess.killed) {
        task.process.ytDlpProcess.kill();
      } else if (task.process && typeof task.process.abort === 'function') {
        task.process.abort();
      }
    } catch (err) {
      log.warn(`Failed to kill process for task ${task.id}`, err);
    }
    task.process = null;
  }

  _cleanupPartialFiles(task) {
    try {
      const dir = task.filePath ? path.dirname(task.filePath) : this.settingsStore.get('downloadFolder');
      if (!fs.existsSync(dir)) return;
      for (const file of fs.readdirSync(dir)) {
        if (file.endsWith('.part') || file.endsWith('.ytdl')) {
          try {
            fs.unlinkSync(path.join(dir, file));
          } catch (_) {
            /* best effort */
          }
        }
      }
    } catch (err) {
      log.warn('Partial cleanup failed', err);
    }
  }
}

/** Fetches a text resource (used for HLS manifests), following redirects. */
function fetchText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client
      .get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (MediaDownloader)' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          resolve(fetchText(new URL(res.headers.location, url).toString(), redirectsLeft - 1));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to fetch manifest (HTTP ${res.statusCode})`));
          res.resume();
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

function sanitizeFilename(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 150);
}

function clamp(n, min, max) {
  const num = Number(n);
  if (Number.isNaN(num)) return min;
  return Math.min(max, Math.max(min, num));
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function humanizeError(err) {
  const msg = (err && err.message) || String(err);
  if (/HTTP Error 403/i.test(msg)) return 'Access denied by the source site (403).';
  if (/Private video|login required/i.test(msg)) {
    return 'This content is private or requires login — MediaDownloader only downloads public content.';
  }
  if (/Video unavailable/i.test(msg)) return 'This video is unavailable.';
  if (/network|ENOTFOUND|ECONNRESET/i.test(msg)) return 'Network error — check your internet connection.';
  return msg.split('\n')[0].slice(0, 300);
}

module.exports = { DownloadManager, STATUS };
