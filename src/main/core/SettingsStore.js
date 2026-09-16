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
  preferOriginalAudio: true,
  // YouTube can auto-translate video titles/descriptions server-side
  // based on a language hint yt-dlp sends with each request; left
  // unset, that hint effectively defaults to English, which is why a
  // video with an Arabic title can display in English in this app even
  // though the file itself downloads under its correct original name.
  // 'auto' resolves to this PC's Windows display language at request
  // time; any other value is passed straight to yt-dlp.
  metadataLanguage: 'auto'
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
