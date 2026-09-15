'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mediaDownloader', {
  analyzeUrl: (url, options = {}) => ipcRenderer.invoke('urls:analyze', { url, ...options }),
  showInputContextMenu: (info) => ipcRenderer.invoke('ui:showInputContextMenu', info),
  showItemContextMenu: (info) => ipcRenderer.invoke('ui:showItemContextMenu', info),

  enqueueDownload: (payload) => ipcRenderer.invoke('downloads:enqueue', payload),
  enqueuePlaylist: (entries, shared) => ipcRenderer.invoke('downloads:enqueuePlaylist', { entries, shared }),
  enqueueLiveManifest: (payload) => ipcRenderer.invoke('downloads:enqueueLiveManifest', payload),
  listDownloads: () => ipcRenderer.invoke('downloads:list'),
  pauseDownload: (id) => ipcRenderer.invoke('downloads:pause', id),
  resumeDownload: (id) => ipcRenderer.invoke('downloads:resume', id),
  cancelDownload: (id) => ipcRenderer.invoke('downloads:cancel', id),
  retryDownload: (id) => ipcRenderer.invoke('downloads:retry', id),
  removeDownload: (id) => ipcRenderer.invoke('downloads:remove', id),
  onDownloadUpdate: (cb) => {
    const listener = (_evt, task) => cb(task);
    ipcRenderer.on('downloads:update', listener);
    return () => ipcRenderer.removeListener('downloads:update', listener);
  },
  onDownloadRemoved: (cb) => {
    const listener = (_evt, id) => cb(id);
    ipcRenderer.on('downloads:removed', listener);
    return () => ipcRenderer.removeListener('downloads:removed', listener);
  },

  listHistory: () => ipcRenderer.invoke('history:list'),
  removeHistory: (id) => ipcRenderer.invoke('history:remove', id),
  clearHistory: () => ipcRenderer.invoke('history:clear'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  chooseFolder: () => ipcRenderer.invoke('settings:chooseFolder'),

  openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
  showInFolder: (filePath) => ipcRenderer.invoke('shell:showInFolder', filePath),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),

  listProviders: () => ipcRenderer.invoke('providers:list'),

  onMenuCommand: (cb) => {
    const channels = [
      'menu:pasteLink',
      'menu:openSettings',
      'menu:pauseAll',
      'menu:resumeAll',
      'menu:clearCompleted'
    ];
    const listeners = channels.map((ch) => {
      const fn = () => cb(ch.replace('menu:', ''));
      ipcRenderer.on(ch, fn);
      return [ch, fn];
    });
    return () => listeners.forEach(([ch, fn]) => ipcRenderer.removeListener(ch, fn));
  },

  onAppStatus: (cb) => {
    const listener = (_evt, status) => cb(status);
    ipcRenderer.on('app:status', listener);
    return () => ipcRenderer.removeListener('app:status', listener);
  }
});
