'use strict';

const path = require('path');
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');

// yt-dlp.exe is a Python build; on Windows, a piped (non-console)
// stdout can silently fall back to the system's ANSI codepage instead
// of UTF-8, corrupting non-Latin titles (Arabic, CJK, etc.) in output
// we capture — even though the actual downloaded file, written via
// Windows' native filesystem APIs, ends up named correctly. Setting
// this before any child process is spawned forces Python's stdio to
// UTF-8 regardless of the console codepage. Must happen this early,
// before yt-dlp-wrap or anything else spawns the binary.
process.env.PYTHONUTF8 = '1';
process.env.PYTHONIOENCODING = 'utf-8';

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

/**
 * Electron installs a generic default menu (Help -> "Learn More",
 * Electron docs links, etc.) when none is set. Replace it with a menu
 * that actually belongs to this app.
 */
function buildApplicationMenu({ getWindow, settingsStore }) {
  const isMac = process.platform === 'darwin';

  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Paste Link & Analyze',
          accelerator: 'CmdOrCtrl+V',
          click: () => sendToRenderer('menu:pasteLink')
        },
        {
          label: 'Open Downloads Folder',
          click: () => {
            const folder = settingsStore.get('downloadFolder');
            if (folder) shell.openPath(folder);
          }
        },
        { type: 'separator' },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => sendToRenderer('menu:openSettings')
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Downloads',
      submenu: [
        { label: 'Pause All', click: () => sendToRenderer('menu:pauseAll') },
        { label: 'Resume All', click: () => sendToRenderer('menu:resumeAll') },
        { type: 'separator' },
        { label: 'Clear Completed', click: () => sendToRenderer('menu:clearCompleted') }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About MediaDownloader',
          click: () => {
            dialog.showMessageBox(getWindow(), {
              type: 'info',
              title: 'About MediaDownloader',
              message: `MediaDownloader ${app.getVersion()}`,
              detail:
                'Downloads public and authorized videos from YouTube and Facebook.\n\n' +
                'Powered by yt-dlp and FFmpeg. This app never stores your passwords ' +
                'and does not bypass access restrictions.',
              buttons: ['OK']
            });
          }
        },
        {
          label: 'Open Log Folder',
          click: () => shell.openPath(path.join(app.getPath('userData'), 'logs'))
        }
      ]
    }
  ];

  function sendToRenderer(channel) {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel);
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

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

  win.webContents.once('did-finish-load', () => {
    win.webContents.send('app:status', { stage: 'preparing-tools' });
  });

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

  // Build the yt-dlp wrapper against its *eventual* path immediately.
  // The binary itself may not exist on disk yet (it's fetched below on
  // first run) — that's fine, nothing here touches the filesystem
  // until a download/analyze call actually spawns it. This lets us
  // register every IPC handler up front instead of only after the
  // (network-dependent) binary download finishes, so things like
  // Settings' "Choose folder" work immediately even while the engine
  // is still preparing.
  // eslint-disable-next-line global-require
  const YTDlpWrap = require('yt-dlp-wrap').default;
  const ytDlpWrap = new YTDlpWrap(binaryManager.ytDlpPath);

  const downloadManager = new DownloadManager({
    ytDlpWrap,
    ytDlpPath: binaryManager.ytDlpPath,
    ffmpegPath: binaryManager.ffmpegPath,
    settingsStore,
    historyStore,
    providerManager
  });

  registerIpcHandlers({
    ytDlpWrap,
    binaryManager,
    providerManager,
    downloadManager,
    historyStore,
    settingsStore,
    getWindow: () => mainWindow
  });

  buildApplicationMenu({ getWindow: () => mainWindow, settingsStore });

  const trayManager = new TrayManager({
    getWindow: () => mainWindow,
    settingsStore,
    downloadManager
  });
  tray = trayManager.init();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      mainWindow.__settingsStore = settingsStore;
    } else {
      mainWindow.show();
    }
  });

  // Fetch the yt-dlp binary (one-time, needs internet) in the
  // background. Analyze/download calls made before this resolves get
  // a clear "still preparing" error instead of a broken IPC call.
  try {
    await binaryManager.ensureYtDlp();
    log.info('yt-dlp engine ready');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:status', { stage: 'ready' });
    }
  } catch (err) {
    log.error('Failed to prepare yt-dlp binary', err);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:status', {
        stage: 'error',
        message:
          'Could not download the yt-dlp engine required for downloads. Check your internet connection, then restart the app.'
      });
    }
  }
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
