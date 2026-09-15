'use strict';

const Store = require('electron-store');

/**
 * Saves the set of not-yet-finished downloads when the app quits, so
 * they can be offered back to the user next launch instead of
 * silently vanishing. Only written at shutdown (not on every progress
 * tick) — the snapshot only ever needs to reflect "what was left
 * unfinished when the app closed".
 */
class QueueStore {
  constructor() {
    this.store = new Store({
      name: 'pending-queue',
      defaults: { items: [] }
    });
  }

  save(items) {
    this.store.set('items', items);
  }

  load() {
    return this.store.get('items') || [];
  }

  clear() {
    this.store.set('items', []);
  }
}

module.exports = { QueueStore };
