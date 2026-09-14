'use strict';

const crypto = require('crypto');
const Store = require('electron-store');

/**
 * Lightweight JSON-backed history store (electron-store). A database
 * engine would be overkill for a per-user download log of this size,
 * and keeping it dependency-light avoids native build issues on
 * end-user machines.
 */
class HistoryStore {
  constructor() {
    this.store = new Store({
      name: 'history',
      defaults: { entries: [] }
    });
  }

  static fingerprint(url, quality, audioOnly) {
    return crypto
      .createHash('sha1')
      .update(`${url}|${quality}|${audioOnly ? 'audio' : 'video'}`)
      .digest('hex');
  }

  findDuplicate(url, quality, audioOnly) {
    const fp = HistoryStore.fingerprint(url, quality, audioOnly);
    const entries = this.store.get('entries');
    return entries.find((e) => e.fingerprint === fp) || null;
  }

  add(entry) {
    const entries = this.store.get('entries');
    const record = {
      id: entry.id,
      title: entry.title,
      url: entry.url,
      provider: entry.provider,
      quality: entry.quality,
      audioOnly: !!entry.audioOnly,
      filePath: entry.filePath,
      fileSizeBytes: entry.fileSizeBytes || null,
      thumbnail: entry.thumbnail || null,
      completedAt: new Date().toISOString(),
      fingerprint: HistoryStore.fingerprint(entry.url, entry.quality, entry.audioOnly)
    };
    entries.unshift(record);
    this.store.set('entries', entries.slice(0, 5000)); // keep history bounded
    return record;
  }

  remove(id) {
    const entries = this.store.get('entries').filter((e) => e.id !== id);
    this.store.set('entries', entries);
  }

  clear() {
    this.store.set('entries', []);
  }

  getAll() {
    return this.store.get('entries');
  }
}

module.exports = { HistoryStore };
