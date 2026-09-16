'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');
const { v4: uuid } = require('uuid');
const { getLogger } = require('../utils/logger');
const { buildOutputPath } = require('../utils/filenameTemplate');
const { runYtDlp, spawnManaged, killProcessTree } = require('../utils/ytdlpRunner');

const log = getLogger();

// Marks our custom progress-template lines so they're unambiguous to
// find in a stream of otherwise-human-readable yt-dlp output.
const PROGRESS_MARK = 'MEDIADL_PROGRESS';

// yt-dlp's own default progress line, used as a redundant fallback
// parser — see the comment where it's used in _handleDownloadLine.
const STANDARD_PROGRESS_RE =
  /^\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*([\d.]+\s*\w+))?(?:\s+at\s+([\d.]+\s*\w+\/s|Unknown speed))?(?:\s+(?:ETA\s+([\d:]+|Unknown)|in\s+([\d:]+)))?/;

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
  constructor({ ytDlpWrap, ytDlpPath, ffmpegPath, settingsStore, historyStore, providerManager }) {
    super();
    this.ytDlpWrap = ytDlpWrap;
    this.ytDlpPath = ytDlpPath;
    this.ffmpegPath = ffmpegPath;
    this.settingsStore = settingsStore;
    this.historyStore = historyStore;
    this.providerManager = providerManager;

    /** @type {Map<string, object>} */
    this.tasks = new Map();
    this.activeCount = 0;
  }

  /**
   * Runs yt-dlp capturing stderr, so live-manifest failures report the
   * real cause rather than just the command that failed.
   */
  runYtDlp(args) {
    return runYtDlp(this.ytDlpPath, args, { timeoutMs: 120000 });
  }

  /**
   * Snapshot of not-yet-finished tasks, used to offer resuming them on
   * the next launch. Deliberately excludes completed/error/canceled —
   * only work that was still queued, downloading, or paused when the
   * app closed is worth asking about again.
   */
  getResumableSnapshot() {
    return Array.from(this.tasks.values())
      .filter((t) => [STATUS.QUEUED, STATUS.DOWNLOADING, STATUS.PAUSED].includes(t.status))
      .map((t) => ({
        mode: t.mode === 'm3u8' ? 'm3u8' : 'video',
        url: t.url,
        provider: t.provider,
        title: t.title,
        thumbnail: t.thumbnail,
        durationSeconds: t.durationSeconds,
        qualityId: t.qualityId,
        audioOnly: t.audioOnly,
        isLive: t.isLive,
        playlistIndex: t.playlistIndex,
        playlistTitle: t.playlistTitle,
        playlistTotal: t.playlistTotal
      }));
  }

  /**
   * Stops any in-flight yt-dlp process without touching history or
   * deleting partial files (unlike `cancel`, which does both) — used
   * only when the app itself is quitting, so a download that was mid-
   * flight resumes cleanly next launch via yt-dlp's own `.part`/
   * `--continue` handling instead of either restarting from scratch or
   * continuing to run orphaned in the background after the window and
   * tray icon are gone.
   */
  async killAllActiveForQuit() {
    const downloading = Array.from(this.tasks.values()).filter((t) => t.status === STATUS.DOWNLOADING);
    await Promise.all(downloading.map((t) => this._killProcess(t)));
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
   * Builds a task object without any duplicate check or side effects
   * (not added to the queue, no events fired) — callers decide that.
   */
  _buildTask(input, settings) {
    return {
      id: uuid(),
      url: input.url,
      title: input.title || input.url,
      thumbnail: input.thumbnail || null,
      durationSeconds: input.durationSeconds || null,
      provider: input.provider,
      qualityId: input.qualityId || settings.defaultQuality,
      audioOnly: !!input.audioOnly,
      playlistIndex: input.playlistIndex || null,
      playlistTitle: input.playlistTitle || null,
      playlistTotal: input.playlistTotal || null,
      isLive: !!input.isLive,
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

    const task = this._buildTask(input, settings);
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

  /**
   * Queues every selected playlist entry, skipping ones already in
   * history instead of throwing. A single duplicate used to abort the
   * whole batch (Array.map does not catch per-item), which is what
   * produced an "Error: DUPLICATE" for the entire playlist even when
   * only one of many videos had already been downloaded.
   *
   * @returns {{ queued: object[], skipped: { url, title }[] }}
   */
  enqueuePlaylist(entries, shared) {
    const settings = this.settingsStore.getAll();
    const queued = [];
    const skipped = [];

    entries.forEach((entry, i) => {
      const duplicate = this.historyStore.findDuplicate(entry.url, shared.qualityId, shared.audioOnly);
      if (duplicate && !shared.allowDuplicates) {
        skipped.push({ url: entry.url, title: entry.title });
        return;
      }

      const task = this._buildTask(
        {
          ...shared,
          url: entry.url,
          title: entry.title,
          thumbnail: entry.thumbnail,
          durationSeconds: entry.durationSeconds,
          // Position within the playlist, used for display and for the
          // {playlist_index} filename placeholder.
          playlistIndex: entry.index || i + 1,
          playlistTitle: shared.playlistTitle || null,
          playlistTotal: entries.length
        },
        settings
      );
      this.tasks.set(task.id, task);
      this._emitUpdate(task);
      queued.push(this._publicView(task));
    });

    this._tryStartNext();
    return { queued, skipped };
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

    const settings = this.settingsStore.getAll();

    try {
      await this._resolveAndSaveManifest(task, provider, settings);
    } catch (err) {
      log.error(`Live manifest download failed for ${task.url}`, err);
      task.status = STATUS.ERROR;
      task.error = humanizeError(err);
      this._emitUpdate(task);
      this.emit('task:error', this._publicView(task));
    }
  }

  async _resolveAndSaveManifest(task, provider, settings) {
    const raw = await this.runYtDlp(provider.buildManifestArgs(task.url, task.qualityId, settings));
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

    // Sanity check: a master playlist that advertises video but
    // declares no audio (no AUDIO= attribute and no audio media
    // group) would play silently. Flag it rather than silently
    // handing the user a mute stream.
    const isMaster = /#EXT-X-STREAM-INF/.test(manifestText);
    const hasAudio = /TYPE=AUDIO/.test(manifestText) || /AUDIO="/.test(manifestText) || !isMaster;
    if (!hasAudio) {
      task.warning = task.warning || 'This manifest contains no audio track.';
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
  }

  async _start(task) {
    const settings = this.settingsStore.getAll();
    await this._attemptDownload(task, settings);
  }

  /**
   * Runs one yt-dlp download attempt for a task, from spawn through to
   * the process closing. All outcomes (success, error, or the task
   * having been paused/cancelled mid-flight) are reflected directly on
   * the task object.
   */
  async _attemptDownload(task, settings) {
    task.status = STATUS.DOWNLOADING;
    task.error = null;
    task.rawError = null;
    this._emitUpdate(task);

    const attemptStartedAt = Date.now();

    const provider = this.providerManager.resolve(task.url);
    if (!provider) {
      task.status = STATUS.ERROR;
      task.error = 'No provider can handle this URL';
      this._emitUpdate(task);
      return 'done';
    }

    const downloadRoot = settings.organizeByProvider
      ? path.join(settings.downloadFolder, capitalize(provider.id))
      : settings.downloadFolder;
    fs.mkdirSync(downloadRoot, { recursive: true });

    // Each task downloads with --no-playlist, so yt-dlp has no idea of
    // the video's position in a playlist. Substitute the values we
    // recorded at enqueue time directly into the output template, and
    // zero-pad the index so files sort correctly in a file manager.
    const outputTemplate = applyPlaylistFields(
      buildOutputPath(downloadRoot, settings.filenameTemplate),
      task
    );
    const formatSelector = provider.buildFormatSelector(task.qualityId, task.audioOnly, {
      isLive: task.isLive
    });

    const args = [
      task.url,
      '-f', formatSelector,
      '-o', outputTemplate,
      '--ffmpeg-location', this.ffmpegPath,
      '--newline',
      '--no-mtime',
      // Each queued task is exactly one video — playlists are expanded
      // into individual tasks at enqueue time. Without this, a URL that
      // happens to carry &list= would pull down the entire playlist.
      '--no-playlist',
      // Ensures the "NA" placeholder never reaches a path segment even
      // if a template field resolves to nothing.
      '--output-na-placeholder', '',
      // A custom, unambiguous progress line we parse ourselves below,
      // instead of relying on a third-party library's regex against
      // yt-dlp's default human-readable progress bar (which is what
      // silently produced no progress updates at all).
      '--progress-template', `download:${PROGRESS_MARK}|%(progress.status)s|%(progress.percent)s|%(progress.downloaded_bytes)s|%(progress.total_bytes,progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`,
      '--print', 'after_move:MEDIADL_FILEPATH:%(filepath)s',
      ...(task.audioOnly ? ['-x', '--audio-format', settings.preferredAudioFormat] : []),
      ...(!task.audioOnly && !task.isLive ? ['--merge-output-format', 'mp4'] : []),
      ...provider.extraArgs(settings)
    ];
    task.ytArgs = args;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome) => {
        if (!settled) {
          settled = true;
          resolve(outcome);
        }
      };

      let child;
      try {
        child = spawnManaged(this.ytDlpPath, args);
      } catch (err) {
        task.status = STATUS.ERROR;
        task.error = humanizeError(err);
        this._emitUpdate(task);
        finish('done');
        return;
      }

      task.pid = child.pid;
      task.process = child; // internal only — stripped by _publicView

      let stdoutBuf = '';
      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split(/\r?\n/);
        stdoutBuf = lines.pop(); // keep the trailing partial line for next chunk
        for (const line of lines) this._handleDownloadLine(task, line);
      });

      let stderrBuf = '';
      child.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString();
        const lines = stderrBuf.split(/\r?\n/);
        stderrBuf = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          // Keep the most recent real yt-dlp error line so a failure
          // reports what actually went wrong rather than just an exit
          // code.
          if (/^ERROR[:\s]/i.test(trimmed)) task.rawError = trimmed;
        }
      });

      child.on('error', (err) => {
        log.error(`Download error for ${task.url}`, err);
        task.process = null;
        task.pid = null;
        if (task.status === STATUS.PAUSED || task.status === STATUS.CANCELED) {
          finish('done');
          return;
        }
        task.status = STATUS.ERROR;
        task.error = humanizeError(err);
        this._emitUpdate(task);
        this.emit('task:error', this._publicView(task));
        finish('done');
      });

      child.on('close', (code) => {
        task.process = null;
        task.pid = null;

        if (task.status === STATUS.PAUSED || task.status === STATUS.CANCELED) {
          finish('done');
          return;
        }

        // The path yt-dlp printed via --print doesn't always match
        // reality (this is what caused "Open File" to report the file
        // as missing even though the video had downloaded). If it's
        // missing, fall back to whatever media file was most recently
        // written into the download folder during this attempt.
        if (!task.filePath || !fs.existsSync(task.filePath)) {
          const recovered = findMostRecentMediaFile(downloadRoot, attemptStartedAt);
          if (recovered) task.filePath = recovered;
        }

        if (code === 0) {
          task.status = STATUS.COMPLETED;
          task.progressPercent = 100;
          this._emitUpdate(task);
          this._recordHistory(task, provider);
          this.emit('task:completed', this._publicView(task));
          finish('done');
          return;
        }

        // yt-dlp can occasionally fail late — after the video itself
        // already finished downloading and was moved to its final
        // filename — due to some unrelated post-step. Retrying from
        // scratch in that case would just re-download a video that's
        // already complete and waste bandwidth, so if the file is
        // genuinely there, this counts as success.
        if (task.filePath && fs.existsSync(task.filePath)) {
          task.status = STATUS.COMPLETED;
          task.progressPercent = 100;
          this._emitUpdate(task);
          this._recordHistory(task, provider);
          this.emit('task:completed', this._publicView(task));
          finish('done');
          return;
        }

        if (task.status !== STATUS.COMPLETED) {
          task.status = STATUS.ERROR;
          task.error =
            task.error || (task.rawError ? humanizeError(new Error(task.rawError)) : `yt-dlp exited with code ${code}`);
          this._emitUpdate(task);
          this.emit('task:error', this._publicView(task));
        }
        finish('done');
      });
    });
  }

  /** Parses one line of stdout from a running download. */
  _handleDownloadLine(task, rawLine) {
    const line = rawLine.trim();
    if (!line) return;

    if (line.startsWith('MEDIADL_FILEPATH:')) {
      task.filePath = line.slice('MEDIADL_FILEPATH:'.length).trim();
      return;
    }

    if (line.startsWith(PROGRESS_MARK)) {
      if (task.status !== STATUS.DOWNLOADING) return;
      const [, , percentRaw, downloadedRaw, totalRaw, speedRaw, etaRaw] = line.split('|');

      const percent = parseFloat(percentRaw);
      const downloaded = parseFloat(downloadedRaw);
      const total = parseFloat(totalRaw);

      if (!Number.isNaN(total) && total > 0) {
        task.totalSizeText = formatBytes(total);
        task.progressPercent = !Number.isNaN(downloaded)
          ? clamp((downloaded / total) * 100, 0, 100)
          : clamp(percent, 0, 100);
      } else if (!Number.isNaN(percent)) {
        task.progressPercent = clamp(percent, 0, 100);
      }

      const speed = parseFloat(speedRaw);
      if (!Number.isNaN(speed) && speed > 0) task.speed = `${formatBytes(speed)}/s`;

      const eta = parseFloat(etaRaw);
      if (!Number.isNaN(eta) && eta >= 0) task.eta = formatEta(eta);

      this._emitUpdate(task);
      return;
    }

    // Redundant fallback: parse yt-dlp's own standard, human-readable
    // progress line too (e.g. "[download]  45.2% of  10.00MiB at
    // 1.20MiB/s ETA 00:07"). This format has been stable for years and
    // is independent of the exact field names accepted by
    // --progress-template above — if that ever mismatches yt-dlp's
    // expectations for any reason, progress still updates via this
    // path instead of silently sitting at 0%.
    const standard = STANDARD_PROGRESS_RE.exec(line);
    if (standard && task.status === STATUS.DOWNLOADING) {
      const [, percentStr, sizeStr, speedStr, etaStr] = standard;
      const percent = parseFloat(percentStr);
      if (!Number.isNaN(percent)) task.progressPercent = clamp(percent, 0, 100);
      if (sizeStr) task.totalSizeText = task.totalSizeText || sizeStr.trim();
      if (speedStr && speedStr !== 'Unknown speed') task.speed = task.speed || speedStr.trim();
      if (etaStr && etaStr !== 'Unknown') task.eta = task.eta || etaStr.trim();
      this._emitUpdate(task);
      return;
    }

    if (/^ERROR[:\s]/i.test(line)) {
      task.rawError = line;
    }
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

  async pause(id) {
    const task = this.tasks.get(id);
    if (!task || task.status !== STATUS.DOWNLOADING) return this._publicView(task);
    task.status = STATUS.PAUSED;
    await this._killProcess(task);
    this._emitUpdate(task);
    // Do not touch activeCount/_tryStartNext here: the still-pending
    // _start() promise for this task resolves once the killed
    // process's 'close' event fires, and _tryStartNext's own
    // .finally() decrements activeCount and looks for the next queued
    // item at that point. Doing it here too double-decremented the
    // count, letting more downloads run than the configured limit.
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

  async cancel(id) {
    const task = this.tasks.get(id);
    if (!task) return null;
    task.status = STATUS.CANCELED;
    await this._killProcess(task);
    this._emitUpdate(task);
    // See the comment in pause() — activeCount is freed exclusively by
    // _tryStartNext's .finally() once _start()'s promise resolves.
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

  async remove(id) {
    const task = this.tasks.get(id);
    if (task && task.status === STATUS.DOWNLOADING) await this.cancel(id);
    this.tasks.delete(id);
    this.emit('task:removed', id);
  }

  /**
   * Kills the yt-dlp process AND any children it spawned (chiefly
   * ffmpeg, used for merging/remuxing). Previously this only called
   * `.kill()` on the immediate process via a property yt-dlp-wrap may
   * or may not have actually exposed — killing just that process left
   * ffmpeg running, so a "cancelled" download kept writing the output
   * file in the background. killProcessTree uses `taskkill /t` on
   * Windows (and a process-group kill elsewhere) to take down the
   * whole tree.
   */
  async _killProcess(task) {
    if (task.pid) {
      try {
        await killProcessTree(task.pid);
      } catch (err) {
        log.warn(`Failed to kill process tree for task ${task.id}`, err);
      }
    }
    task.process = null;
    task.pid = null;
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

/**
 * Replaces %(playlist)s / %(playlist_index)s in an output template
 * with the values captured at enqueue time, since the per-video
 * download runs with --no-playlist and yt-dlp can't supply them.
 *
 * The index is zero-padded to the width of the playlist's total count
 * (e.g. 007 in a 120-item playlist) so files sort naturally on disk.
 *
 * If the template has no {playlist_index} placeholder at all — e.g. a
 * filename template saved before this feature existed — the number is
 * still prepended to the filename automatically, so playlist downloads
 * are always numbered on disk regardless of a custom template.
 */
function applyPlaylistFields(template, task) {
  let out = template;
  const hadIndexPlaceholder = /%\(playlist_index\|?\)s/.test(template);

  if (task.playlistIndex) {
    const width = String(task.playlistTotal || task.playlistIndex).length;
    const padded = String(task.playlistIndex).padStart(Math.max(2, width), '0');
    out = out.replace(/%\(playlist_index\|?\)s/g, padded);

    if (!hadIndexPlaceholder) {
      // Prepend "NN - " to the filename (last path segment) only.
      const parts = out.split(path.sep);
      const last = parts.pop();
      parts.push(`${padded} - ${last}`);
      out = parts.join(path.sep);
    }
  } else {
    out = out.replace(/%\(playlist_index\|?\)s/g, '');
  }

  if (task.playlistTitle) {
    out = out.replace(/%\(playlist\|?\)s/g, sanitizeFilename(task.playlistTitle));
  } else {
    out = out.replace(/%\(playlist\|?\)s/g, '');
  }

  // Collapse any path segments that just became empty, so a single
  // video never lands in a blank or stray folder.
  const parts = out.split(path.sep);
  const cleaned = parts.filter((seg, i) => i === 0 || seg.trim().length > 0);
  out = cleaned.join(path.sep);

  // Tidy up separators/spaces left behind by a removed placeholder.
  return out.replace(/\s{2,}/g, ' ').replace(/(^|[\\/])[\s\-_.]+/g, '$1');
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

/** Formats a raw byte count as e.g. "12.4 MB". */
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

/** Formats a raw seconds count as e.g. "1:05" or "12s". */
function formatEta(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}:${String(rem).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return `${h}:${String(m % 60).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

const MEDIA_FILE_RE = /\.(mp4|mkv|webm|m4a|mp3|opus|ogg|wav|mov|flv|avi)$/i;

/**
 * Recursively finds the most recently modified media file under `dir`
 * that was written at or after `sinceMs`, skipping in-progress
 * (.part/.ytdl) files. Used as a fallback when the path yt-dlp printed
 * doesn't match anything on disk.
 */
function findMostRecentMediaFile(dir, sinceMs) {
  const best = findMostRecentMediaFileEntry(dir, sinceMs, 0);
  return best ? best.path : null;
}

function findMostRecentMediaFileEntry(dir, sinceMs, depth) {
  if (depth > 2) return null; // organize-by-provider + Live adds at most one extra level
  let best = null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return null;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findMostRecentMediaFileEntry(full, sinceMs, depth + 1);
      if (nested && (!best || nested.mtimeMs > best.mtimeMs)) best = nested;
      continue;
    }
    if (entry.name.endsWith('.part') || entry.name.endsWith('.ytdl')) continue;
    if (!MEDIA_FILE_RE.test(entry.name)) continue;
    let stat;
    try {
      stat = fs.statSync(full);
    } catch (_) {
      continue;
    }
    if (stat.mtimeMs < sinceMs) continue;
    if (!best || stat.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: stat.mtimeMs };
  }

  return best;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Matches yt-dlp's cookie-database-read failures, including the exact
 * "Could not copy X cookie database" message from
 * github.com/yt-dlp/yt-dlp/issues/7271 (typically because the browser
 * is currently running and has the file locked), as well as related
 * DPAPI/permission variants.
 */
function isCookieFailureMessage(msg) {
  if (!msg) return false;
  return /could not copy .*cookie|could not find .*cookies|unable to open cookie|cookie database|DPAPI|Permission denied.*[Cc]ookies/i.test(
    msg
  );
}

function humanizeError(err) {
  const msg = (err && err.message) || String(err);
  if (/Requested format is not available/i.test(msg)) {
    return 'That quality is not available for this video. Try "Best" or a lower resolution.';
  }
  if (/HTTP Error 403/i.test(msg)) return 'Access denied by the source site (403).';
  if (/Private video|login required|Sign in to confirm/i.test(msg)) {
    return 'This content is private or requires sign-in. If your own account can view it, enable "Use sign-in from browser" in Settings.';
  }
  if (isCookieFailureMessage(msg)) {
    return 'Could not read cookies from the selected browser (it may be running — close it fully and try again), or set "Use sign-in from browser" back to "None" in Settings.';
  }
  if (/Video unavailable/i.test(msg)) return 'This video is unavailable.';
  if (/is not a valid URL|Unsupported URL/i.test(msg)) return 'That link is not a supported video URL.';
  if (/network|ENOTFOUND|ECONNRESET|Temporary failure/i.test(msg)) {
    return 'Network error — check your internet connection.';
  }
  // Strip yt-dlp's noisy prefix but keep the substance of the message.
  return msg
    .split('\n')[0]
    .replace(/^ERROR:\s*/i, '')
    .slice(0, 300);
}

module.exports = { DownloadManager, STATUS, isCookieFailureMessage };
