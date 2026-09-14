'use strict';

const path = require('path');
const os = require('os');
const Store = require('electron-store');
const { DEFAULT_TEMPLATE } = require('../utils/filenameTemplate');

const DEFAULTS = {
  downloadFolder: path.join(os.homedir(), 'Downloads', 'MediaDownloader'),
  filenameTemplate: DEFAULT_TEMPLATE,
  organizeByProvider: true,
  defaultQuality: 'best',
  maxConcurrentDownloads: 3,
  maxRetries: 3,
  notificationsEnabled: true,
  minimizeToTray: true,
  startMinimized: false,
  closeToTray: true,
  theme: 'dark',
  preferredAudioFormat: 'm4a',
  deletePartialOnCancel: true,
  // When true, forces yt-dlp to prefer the original-language audio
  // track over any auto-dubbed tracks a video may offer.
  preferOriginalAudio: true
};

class SettingsStore {
  constructor() {
    this.store = new Store({
      name: 'settings',
      defaults: DEFAULTS
    });
  }

  getAll() {
    return this.store.store;
  }

  get(key) {
    return this.store.get(key);
  }

  set(key, value) {
    this.store.set(key, value);
    return this.store.get(key);
  }

  setMany(partial) {
    for (const [key, value] of Object.entries(partial)) {
      if (key in DEFAULTS) this.store.set(key, value);
    }
    return this.getAll();
  }

  resetToDefaults() {
    this.store.clear();
    for (const [key, value] of Object.entries(DEFAULTS)) {
      this.store.set(key, value);
    }
    return this.getAll();
  }
}

module.exports = { SettingsStore, DEFAULTS };
