'use strict';

const path = require('path');
const { Tray, Menu, nativeImage, app } = require('electron');

class TrayManager {
  constructor({ getWindow, settingsStore, downloadManager }) {
    this.getWindow = getWindow;
    this.settingsStore = settingsStore;
    this.downloadManager = downloadManager;
    this.tray = null;
  }

  init() {
    const iconPath = path.join(__dirname, '..', '..', '..', 'assets', 'tray-icon.png');
    let image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      image = nativeImage.createEmpty();
    }
    this.tray = new Tray(image);
    this.tray.setToolTip('MediaDownloader');
    this._buildMenu();

    this.tray.on('click', () => this._showWindow());
    this.downloadManager.on('task:update', () => this._buildMenu());
    this.downloadManager.on('task:completed', () => this._buildMenu());
    return this.tray;
  }

  _showWindow() {
    const win = this.getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  _buildMenu() {
    const active = this.downloadManager.getAll().filter((t) => t.status === 'downloading').length;
    const queued = this.downloadManager.getAll().filter((t) => t.status === 'queued').length;

    const menu = Menu.buildFromTemplate([
      { label: 'Open MediaDownloader', click: () => this._showWindow() },
      {
        label: `${active} downloading, ${queued} queued`,
        enabled: false
      },
      { type: 'separator' },
      {
        label: 'Quit MediaDownloader',
        click: () => {
          app.isQuitting = true;
          app.quit();
        }
      }
    ]);
    this.tray.setContextMenu(menu);
  }
}

module.exports = { TrayManager };
