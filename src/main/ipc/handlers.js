'use strict';

const { ipcMain, shell, dialog, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const { getLogger } = require('../utils/logger');
const { runYtDlp } = require('../utils/ytdlpRunner');

const log = getLogger();

function registerIpcHandlers({
  ytDlpWrap,
  binaryManager,
  providerManager,
  downloadManager,
  historyStore,
  settingsStore,
  getWindow
}) {
  const engineNotReadyMessage =
    'The download engine is still preparing itself (first-time setup). Please wait a few seconds and try again.';

  function assertEngineReady() {
    if (binaryManager && !fs.existsSync(binaryManager.ytDlpPath)) {
      throw new Error(engineNotReadyMessage);
    }
  }

  ipcMain.handle('urls:analyze', async (_evt, payload) => {
    assertEngineReady();
    const url = typeof payload === 'string' ? payload : payload.url;
    const forcePlaylist = typeof payload === 'object' && payload.forcePlaylist;

    const provider = providerManager.resolve(url);
    if (!provider) {
      throw new Error('Unsupported URL. MediaDownloader currently supports YouTube and Facebook links.');
    }

    // Providers receive a runner that captures yt-dlp's stderr, so a
    // failure reports what actually went wrong rather than just the
    // command line that failed.
    const run = (args) => runYtDlp(binaryManager.ytDlpPath, args, { timeoutMs: 180000 });
    const settings = settingsStore.getAll();

    try {
      return await provider.analyze(url, ytDlpWrap, { settings, forcePlaylist, run });
    } catch (err) {
      log.error(`Analyze failed for ${url}`, { message: err.message, stderr: err.stderr, args: err.args });
      throw new Error(humanizeAnalyzeError(err));
    }
  });

  ipcMain.handle('downloads:enqueue', async (_evt, payload) => {
    assertEngineReady();
    try {
      return downloadManager.enqueue(payload);
    } catch (err) {
      if (err.code === 'DUPLICATE') {
        return { duplicate: true, existing: err.existing };
      }
      throw err;
    }
  });

  ipcMain.handle('downloads:enqueuePlaylist', async (_evt, { entries, shared }) => {
    assertEngineReady();
    return downloadManager.enqueuePlaylist(entries, shared);
  });

  ipcMain.handle('downloads:enqueueLiveManifest', async (_evt, payload) => {
    assertEngineReady();
    return downloadManager.enqueueLiveManifest(payload);
  });

  ipcMain.handle('downloads:list', async () => downloadManager.getAll());
  ipcMain.handle('downloads:pause', async (_evt, id) => downloadManager.pause(id));
  ipcMain.handle('downloads:resume', async (_evt, id) => downloadManager.resume(id));
  ipcMain.handle('downloads:cancel', async (_evt, id) => downloadManager.cancel(id));
  ipcMain.handle('downloads:retry', async (_evt, id) => downloadManager.retry(id));
  ipcMain.handle('downloads:remove', async (_evt, id) => downloadManager.remove(id));

  ipcMain.handle('history:list', async () => historyStore.getAll());
  ipcMain.handle('history:remove', async (_evt, id) => historyStore.remove(id));
  ipcMain.handle('history:clear', async () => historyStore.clear());

  ipcMain.handle('settings:get', async () => settingsStore.getAll());
  ipcMain.handle('settings:set', async (_evt, partial) => settingsStore.setMany(partial));
  ipcMain.handle('settings:reset', async () => settingsStore.resetToDefaults());
  ipcMain.handle('settings:chooseFolder', async () => {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('shell:openPath', async (_evt, filePath) => {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(
        `Couldn't find "${path.basename(filePath || '')}". It may have been moved, renamed, or deleted.`
      );
    }
    const result = await shell.openPath(filePath);
    if (result) throw new Error(result); // shell.openPath resolves with an error string on failure, not a rejection
  });

  ipcMain.handle('shell:showInFolder', async (_evt, filePath) => {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(
        `Couldn't find "${path.basename(filePath || '')}". It may have been moved, renamed, or deleted.`
      );
    }
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle('clipboard:read', async () => {
    // eslint-disable-next-line global-require
    const { clipboard } = require('electron');
    return clipboard.readText() || '';
  });

  // Context menu for the URL field (cut/copy/paste/select all). Without
  // this, right-clicking an input in Electron does nothing at all.
  ipcMain.handle('ui:showInputContextMenu', async (evt, { hasSelection, canPaste }) => {
    // eslint-disable-next-line global-require
    const { Menu } = require('electron');
    const win = getWindow();
    const template = [
      { role: 'cut', enabled: !!hasSelection },
      { role: 'copy', enabled: !!hasSelection },
      { role: 'paste', enabled: !!canPaste },
      { type: 'separator' },
      { role: 'selectAll' }
    ];
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  // Right-click menu for a queue/history row: copy the source link,
  // and (once a file exists) copy its path / reveal it / open it.
  ipcMain.handle('ui:showItemContextMenu', async (_evt, { url, filePath, hasFile }) => {
    // eslint-disable-next-line global-require
    const { Menu, clipboard } = require('electron');
    const win = getWindow();
    const template = [
      {
        label: 'Copy Video Link',
        enabled: !!url,
        click: () => clipboard.writeText(url || '')
      }
    ];
    if (hasFile && filePath) {
      const fileStillExists = fs.existsSync(filePath);
      template.push(
        { type: 'separator' },
        { label: 'Copy File Path', click: () => clipboard.writeText(filePath) },
        {
          label: 'Show in Folder',
          enabled: fileStillExists,
          click: () => shell.showItemInFolder(filePath)
        },
        {
          label: 'Open File',
          enabled: fileStillExists,
          click: async () => {
            const result = await shell.openPath(filePath);
            if (result) {
              dialog.showErrorBox('Couldn\'t open file', result);
            }
          }
        }
      );
      if (!fileStillExists) {
        template.push({
          label: 'File not found (moved or deleted)',
          enabled: false
        });
      }
    }
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  ipcMain.handle('providers:list', async () => providerManager.list());

  // Forward download-manager events to the renderer as they happen.
  downloadManager.on('task:update', (task) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('downloads:update', task);
  });

  downloadManager.on('task:completed', (task) => {
    if (settingsStore.get('notificationsEnabled') && Notification.isSupported()) {
      new Notification({
        title: 'Download complete',
        body: task.title,
        silent: false
      }).show();
    }
  });

  downloadManager.on('task:error', (task) => {
    if (settingsStore.get('notificationsEnabled') && Notification.isSupported()) {
      new Notification({
        title: 'Download failed',
        body: `${task.title}: ${task.error}`,
        silent: false
      }).show();
    }
  });

  downloadManager.on('task:removed', (id) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('downloads:removed', id);
  });
}

/**
 * Maps known failures to friendly text, but — critically — falls
 * through to the ACTUAL yt-dlp message rather than a generic
 * "could not read this URL". Hiding the real cause made every
 * different failure look identical and impossible to diagnose.
 */
function humanizeAnalyzeError(err) {
  const raw = (err && err.message) || String(err);

  // yt-dlp puts the useful part on the line starting with ERROR:
  const errorLine =
    raw
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /^ERROR[:\s]/i.test(l)) || raw.split('\n')[0];

  const msg = errorLine.replace(/^ERROR:\s*/i, '').trim();

  if (/Private video|Sign in to confirm|login required|members-only/i.test(msg)) {
    return 'This video is private, age-restricted, or members-only. If your own account can view it, enable "Use sign-in from browser" in Settings.';
  }
  if (/Video unavailable|has been removed|no longer available/i.test(msg)) {
    return 'This video is unavailable or has been removed.';
  }
  if (/Requested format is not available/i.test(msg)) {
    return 'That quality is not available for this video. Try "Best" or a lower resolution.';
  }
  if (/is not a valid URL|Unsupported URL/i.test(msg)) {
    return 'That link is not a supported video URL.';
  }
  if (/could not find .* cookies|unable to open cookie|DPAPI/i.test(msg)) {
    return 'Could not read cookies from the selected browser. Close it fully and retry, or set it back to "None" in Settings.';
  }
  if (/ENOTFOUND|ECONNRESET|Temporary failure|getaddrinfo|Network is unreachable/i.test(msg)) {
    return 'Network error — check your internet connection.';
  }
  if (/ENOENT|spawn/i.test(msg)) {
    return 'The download engine could not be started. Restart the app so it can finish setting itself up.';
  }
  if (/Timed out waiting for yt-dlp/i.test(msg)) {
    return 'Reading this link took too long. Very large playlists can time out — try again, or use a smaller playlist.';
  }
  if (/does not have|The playlist does not exist|Unable to recognize playlist/i.test(msg)) {
    return 'That playlist could not be found. It may be private, deleted, or the link may be incomplete.';
  }

  return msg ? `Could not read this URL: ${msg.slice(0, 300)}` : 'Could not read this URL.';
}

module.exports = { registerIpcHandlers };
