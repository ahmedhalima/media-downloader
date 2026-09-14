'use strict';

const { ipcMain, shell, dialog, Notification } = require('electron');
const { getLogger } = require('../utils/logger');

const log = getLogger();

function registerIpcHandlers({
  ytDlpWrap,
  providerManager,
  downloadManager,
  historyStore,
  settingsStore,
  getWindow
}) {
  ipcMain.handle('urls:analyze', async (_evt, url) => {
    const provider = providerManager.resolve(url);
    if (!provider) {
      throw new Error('Unsupported URL. MediaDownloader currently supports YouTube and Facebook links.');
    }
    try {
      const result = await provider.analyze(url, ytDlpWrap);
      return result;
    } catch (err) {
      log.error(`Analyze failed for ${url}`, err);
      throw new Error(humanizeAnalyzeError(err));
    }
  });

  ipcMain.handle('downloads:enqueue', async (_evt, payload) => {
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
    return downloadManager.enqueuePlaylist(entries, shared);
  });

  ipcMain.handle('downloads:enqueueLiveManifest', async (_evt, payload) => {
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

  ipcMain.handle('shell:openPath', async (_evt, filePath) => shell.openPath(filePath));
  ipcMain.handle('shell:showInFolder', async (_evt, filePath) => shell.showItemInFolder(filePath));

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

function humanizeAnalyzeError(err) {
  const msg = (err && err.message) || String(err);
  if (/Private video|Sign in|login/i.test(msg)) {
    return 'This video is private or requires login. MediaDownloader only analyzes public, authorized content.';
  }
  if (/Video unavailable/i.test(msg)) return 'This video is unavailable or has been removed.';
  if (/Unsupported URL/i.test(msg)) return 'This URL is not supported.';
  return 'Could not read this URL. Double check the link and try again.';
}

module.exports = { registerIpcHandlers };
