'use strict';

const path = require('path');
const { app, BrowserWindow } = require('electron');

const { getLogger } = require('./utils/logger');
const { SettingsStore } = require('./core/SettingsStore');
const { HistoryStore } = require('./core/HistoryStore');
const { BinaryManager } = require('./core/BinaryManager');
const { ProviderManager } = require('./core/ProviderManager');
const { DownloadManager } = require('./core/DownloadManager');
const { TrayManager } = require('./core/TrayManager');
const { registerIpcHandlers } = require('./ipc/handlers');

let mainWindow = null;
let tray = null;
let log = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 600,
    show: false,
    backgroundColor: '#12151b',
    title: 'MediaDownloader',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    const settings = win.__settingsStore;
    if (!settings || !settings.get('startMinimized')) {
      win.show();
    }
  });

  win.on('close', (event) => {
    const settings = win.__settingsStore;
    if (!app.isQuitting && settings && settings.get('closeToTray')) {
      event.preventDefault();
      win.hide();
    }
  });

  return win;
}

async function bootstrap() {
  await app.whenReady();
  log = getLogger();
  log.info('MediaDownloader starting up');

  const settingsStore = new SettingsStore();
  const historyStore = new HistoryStore();
  const providerManager = new ProviderManager();
  const binaryManager = new BinaryManager();

  mainWindow = createWindow();
  mainWindow.__settingsStore = settingsStore;

  // Resolve yt-dlp (downloading it once if necessary) before wiring
  // up anything that depends on it, so the UI can show a clear
  // "preparing" state instead of failing analyze/download calls.
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('app:status', { stage: 'preparing-tools' });
  });

  let ytDlpPath;
  try {
    ytDlpPath = await binaryManager.ensureYtDlp();
  } catch (err) {
    log.error('Failed to prepare yt-dlp binary', err);
    mainWindow.webContents.send('app:status', {
      stage: 'error',
      message:
        'Could not download the yt-dlp engine required for downloads. Check your internet connection and restart the app.'
    });
    return;
  }

  // eslint-disable-next-line global-require
  const YTDlpWrap = require('yt-dlp-wrap').default;
  const ytDlpWrap = new YTDlpWrap(ytDlpPath);

  const downloadManager = new DownloadManager({
    ytDlpWrap,
    ffmpegPath: binaryManager.ffmpegPath,
    settingsStore,
    historyStore,
    providerManager
  });

  registerIpcHandlers({
    ytDlpWrap,
    providerManager,
    downloadManager,
    historyStore,
    settingsStore,
    getWindow: () => mainWindow
  });

  const trayManager = new TrayManager({
    getWindow: () => mainWindow,
    settingsStore,
    downloadManager
  });
  tray = trayManager.init();

  mainWindow.webContents.send('app:status', { stage: 'ready' });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      mainWindow.__settingsStore = settingsStore;
    } else {
      mainWindow.show();
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error', err);
});

module.exports = { getMainWindow: () => mainWindow, getTray: () => tray };
